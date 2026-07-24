/**
 * Server-side TTS queue.
 *
 * Decouples the HTTP request lifetime from the VoxCPM synthesis lifetime.
 * A client POSTs a TTS job and immediately gets back a `taskId`; the actual
 * VoxCPM call happens on the Next.js dev server process (or a dedicated
 * worker) and survives the client closing the browser tab.
 *
 * Persistence: jobs are mirrored to a JSON file in `.next/tts-queue.json`
 * so that dev-server restarts re-enqueue any still-pending work. Completed
 * audio blobs are written to `public/audio-cache/<taskId>.wav` (served as
 * a static file by Next.js) so the client can play them on demand via a
 * simple GET, without re-running VoxCPM.
 *
 * Concurrency: a single worker drains the FIFO queue — VoxCPM python-api
 * is single-threaded and serializes requests via its own inference lock, so
 * launching multiple workers would only queue up behind it. The worker is
 * a long-lived async loop started lazily on the first enqueue.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { postVoxCPMPythonAPI } from '@/lib/audio/tts-providers';

/**
 * Cancel a pending task. If the task is already processing, marks it for
 * abandonment (the worker checks the flag at the top of the inference
 * callback) — the in-flight VoxCPM run will complete but the result will
 * be discarded and the task transitions to `cancelled`.
 *
 * Returns true if the task was found and cancelled, false otherwise.
 *
 * Used by FixMissingTts "fast reset" to clear 30+ hour queue tails that
 * were enqueued with the high-timesteps clone profile so a fresh
 * low-timesteps pass can start immediately.
 */
export async function cancelTTSTask(id: string): Promise<boolean> {
  const task = tasks.get(id);
  if (!task) return false;
  if (task.status === 'completed' || task.status === 'failed') return false;
  task.status = 'cancelled' as TTSTaskStatus;
  task.completedAt = nowMs();
  dedupeTail(id);
  await persist();
  return true;
}

/**
 * Mark every pending/processing task as cancelled. Returns the number of
 * tasks actually cancelled. Safe to call from dev reset tooling.
 */
export async function cancelAllPendingTTS(): Promise<number> {
  let n = 0;
  for (const task of tasks.values()) {
    if (task.status === 'pending' || task.status === 'processing') {
      task.status = 'cancelled' as TTSTaskStatus;
      task.completedAt = nowMs();
      n += 1;
    }
  }
  g.__ttsQueue!.queueTail = [];
  await persist();
  return n;
}

export type TTSTaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface TTSTaskInput {
  audioId: string;
  text: string;
  ttsProviderId: string;
  ttsModelId?: string;
  ttsVoice: string;
  ttsSpeed?: number;
  ttsApiKey?: string;
  ttsBaseUrl?: string;
  ttsProviderOptions?: Record<string, unknown>;
  /**
   * Admin-only fast mode: forces 10 inference steps, no denoise, no
   * reference audio / prompt. The resulting voice is auto-derived
   * (per-persona), not the user's clone. Trade the clone timbre for a
   * 30x speedup on CPU (single inference 60-120s vs 26-50 min).
   *
   * The flag is intentionally NOT settable from public client traffic —
   * the route handler sanitizes it out, so only the in-process admin
   * helper `enqueueTTSFast()` (and dev tooling) can set it.
   */
  fast?: boolean;
}

export interface TTSTask {
  id: string;
  input: TTSTaskInput;
  status: TTSTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  // Path under public/ where the audio was written.
  audioPath?: string; // e.g. "/audio-cache/<id>.wav"
  bytes?: number;
}

const PUBLIC_CACHE_DIR = path.join(process.cwd(), 'public', 'audio-cache');
const PERSISTENCE_FILE = path.join(process.cwd(), '.next', 'tts-queue.json');

// Module-level state must survive Next.js dev hot-reload. Stash it on
// globalThis so a re-import of this module re-uses the same Map/array.
const g = globalThis as unknown as {
  __ttsQueue?: {
    tasks: Map<string, TTSTask>;
    queueTail: string[];
    workerRunning: boolean;
  };
};
if (!g.__ttsQueue) {
  g.__ttsQueue = { tasks: new Map(), queueTail: [], workerRunning: false };
}
const tasks = g.__ttsQueue.tasks;
// All queue state lives on globalThis directly — reassigning queueTail
// via .filter() or .push() mutates the same array reference both here
// and in any future hot-reloaded copy of this module.
function pushTail(id: string): void {
  g.__ttsQueue!.queueTail.push(id);
}
function dedupeTail(id: string): void {
  g.__ttsQueue!.queueTail = g.__ttsQueue!.queueTail.filter((q) => q !== id);
}
function shiftTail(): string | undefined {
  return g.__ttsQueue!.queueTail.shift();
}
function getTailLength(): number {
  return g.__ttsQueue!.queueTail.length;
}
function getWorkerRunning(): boolean {
  return g.__ttsQueue!.workerRunning;
}
function setWorkerRunning(v: boolean): void {
  g.__ttsQueue!.workerRunning = v;
}

function nowMs(): number {
  return Date.now();
}

function generateTaskId(audioId: string): string {
  // Use the caller's audioId as the taskId so that re-enqueueing the same
  // audio overwrites the existing task and the client can always re-poll
  // with the same id after a tab reload. Strip any whitespace defensively
  // so the id is safe to use in a file path.
  return audioId.trim().replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128) || generateRandomId();
}

function generateRandomId(): string {
  return `tts_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(PUBLIC_CACHE_DIR, { recursive: true });
  await fs.mkdir(path.dirname(PERSISTENCE_FILE), { recursive: true });
}

async function persist(): Promise<void> {
  try {
    await ensureDirs();
    const snapshot = {
      tasks: Array.from(tasks.entries()),
      queueTail: g.__ttsQueue!.queueTail,
      savedAt: nowMs(),
    };
    await fs.writeFile(
      PERSISTENCE_FILE,
      JSON.stringify(snapshot),
      'utf8',
    );
  } catch (err) {
    // Persistence is best-effort; in-memory state still drives execution.
    // eslint-disable-next-line no-console
    console.warn('[tts-queue] persist failed:', err);
  }
}

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(PERSISTENCE_FILE, 'utf8');
    const snapshot = JSON.parse(raw) as {
      tasks: Array<[string, TTSTask]>;
      queueTail: string[];
    };
    tasks.clear();
    for (const [id, task] of snapshot.tasks) {
      // Reset in-flight tasks so a worker restart picks them up cleanly.
      if (task.status === 'processing') {
        task.status = 'pending';
        delete task.startedAt;
      }
      tasks.set(id, task);
    }
    g.__ttsQueue!.queueTail = snapshot.queueTail.filter(
      (id) => tasks.get(id)?.status === 'pending',
    );
  } catch {
    // File missing or unreadable — start fresh.
  }
}

/**
 * Enqueue a TTS job. Returns the taskId immediately; the actual synthesis
 * happens in the background worker.
 */
export async function enqueueTTS(input: TTSTaskInput): Promise<string> {
  if (tasks.size === 0 && getTailLength() === 0) {
    // First call on this process — restore any persisted pending work.
    await loadFromDisk();
  }
  // The route hands us the audioId inside the input; reuse it as the taskId
  // so a client can always look up an audio by its audioId.
  const id = generateTaskId(input.audioId || generateRandomId());
  const task: TTSTask = {
    id,
    input: { ...input, fast: false }, // route handler is the canonical path; force false
    status: 'pending',
    createdAt: nowMs(),
  };
  tasks.set(id, task);
  // If a previous task with the same id is still in the queue tail, replace
  // it so this enqueue becomes the active one.
  dedupeTail(id);
  pushTail(id);
  await persist();
  startWorker();
  return id;
}

/**
 * Admin-only fast enqueue: same as enqueueTTS but with `fast: true` so the
 * worker drops the reference audio / prompt and uses the cheapest VoxCPM
 * pass. Called from the in-process admin route (`/api/dev/reset-fast`)
 * after cancelling any high-cost pending tasks for the same audioIds.
 */
export async function enqueueTTSFast(
  input: Omit<TTSTaskInput, 'fast'>,
): Promise<string> {
  if (tasks.size === 0 && getTailLength() === 0) {
    await loadFromDisk();
  }
  const id = generateTaskId(input.audioId || generateRandomId());
  const task: TTSTask = {
    id,
    input: { ...input, fast: true },
    status: 'pending',
    createdAt: nowMs(),
  };
  tasks.set(id, task);
  dedupeTail(id);
  pushTail(id);
  await persist();
  startWorker();
  return id;
}

export function getTTSTask(id: string): TTSTask | undefined {
  return tasks.get(id);
}

export function listTTSTasks(): TTSTask[] {
  return Array.from(tasks.values());
}

/**
 * Rename (or copy) a cached audio file in the public cache directory. Used by
 * the client to migrate legacy `tts_<actionId>.wav` entries to the canonical
 * `tts_s<sceneOrder>_<actionId>.wav` form after rewriting the stage's
 * `action.audioId` — without this, the classroom player (which reads
 * `/audio-cache/<audioId>.wav`) cannot reach a file the old code already
 * produced.
 *
 * Behavior:
 *  - If `<from>.wav` is missing → returns `{ ok: false, reason: 'missing' }`.
 *  - If `<to>.wav` already exists → no-op returns `{ ok: true, reason:
 *    'already-there' }` so re-running the migration is idempotent.
 *  - Otherwise moves the file. On Windows `rename` over an existing file
 *    throws, hence the explicit "already-there" guard.
 *  - If the move itself fails (e.g. cross-device), falls back to copy+delete.
 */
export async function renameCachedAudio(
  from: string,
  to: string,
): Promise<{ ok: true; reason: 'moved' | 'already-there' | 'copied' } | { ok: false; reason: 'missing' | 'error'; error?: string }> {
  if (!from || !to || from === to) {
    return { ok: false, reason: 'error', error: 'from and to must differ and be non-empty' };
  }
  const fromPath = path.join(PUBLIC_CACHE_DIR, `${from}.wav`);
  const toPath = path.join(PUBLIC_CACHE_DIR, `${to}.wav`);
  try {
    await fs.access(fromPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    await fs.access(toPath);
    return { ok: true, reason: 'already-there' };
  } catch {
    // target not present — fall through to the move
  }
  try {
    await fs.rename(fromPath, toPath);
    return { ok: true, reason: 'moved' };
  } catch (renameErr) {
    try {
      const buf = await fs.readFile(fromPath);
      await fs.writeFile(toPath, buf);
      await fs.unlink(fromPath);
      return { ok: true, reason: 'copied' };
    } catch (copyErr) {
      return {
        ok: false,
        reason: 'error',
        error: copyErr instanceof Error ? copyErr.message : String(copyErr),
      };
    }
  }
}

async function processTask(task: TTSTask): Promise<void> {
  // Honor a cancellation that happened after enqueue but before the worker
  // picked the task up. Without this check, a "fast reset" that calls
  // cancelAllPendingTTS() while we're sleeping at the bottom of the loop
  // would still drain this task.
  if (task.status === 'cancelled' as TTSTaskStatus) {
    return;
  }
  task.status = 'processing';
  task.startedAt = nowMs();
  await persist();

  try {
    const { text, ttsProviderId, ttsModelId, ttsVoice, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = task.input;
    // CRITICAL diagnostic — log the raw input the worker ACTUALLY received
    // for this task, BEFORE the voicePrompt / promptText extraction. The
    // browser-side [ClassroomTtsEditor] buildProviderOptions log shows the
    // client's intent, but if a profile was recorded without a
    // `voicePrompt` description (the user's first clone profile had
    // voicePrompt=null promptText=null), the rendered output sounds like
    // the auto voice even though reference_audio is being sent. Without
    // this log line, the only signal is the eventual audio — and on
    // reference-only mode VoxCPM's timbre can drift enough that the user
    // can't tell clone from auto. Pinning the wire shape to the console
    // makes the regression mode ("voicePrompt missing → fall back to
    // reference-only → timbre drifts") self-evident.
    // eslint-disable-next-line no-console
    console.log(
      `[tts-queue] ${task.id} input: ` +
        `ttsVoice=${ttsVoice} ` +
        `provider=${ttsProviderId} ` +
        `voicePrompt=${JSON.stringify((ttsProviderOptions as { voicePrompt?: string } | undefined)?.voicePrompt || null)} ` +
        `promptText=${JSON.stringify(((ttsProviderOptions as { promptText?: string } | undefined)?.promptText || '').slice(0, 30) || null)} ` +
        `refAudioBytes=${typeof (ttsProviderOptions as { referenceAudioBase64?: string } | undefined)?.referenceAudioBase64 === 'string' ? Math.round(((ttsProviderOptions as { referenceAudioBase64: string }).referenceAudioBase64.length) * 0.75) : 0}`,
    );
    // The `voicePrompt` is the inline voice-design description (e.g. "a calm
    // female teacher"). VoxCPM needs it prepended to the text as `(voice
    // prompt)text` for the inline-prompt path. Without this wrapping the
    // reference audio is sent but the voice design is ignored — VoxCPM falls
    // back to an auto-derived voice from the text content, which sounds like a
    // completely different person (the "TTS 突然换了个人" bug).
    //
    // When `promptText` (the actual words in the reference audio) is provided
    // alongside the reference audio, the python-api backend switches to
    // "prompt continuation" mode: text is sent as-is, the reference audio is
    // uploaded as `prompt_audio` with `prompt_text`, and the inline prefix is
    // not needed. So the inline wrapping only applies when we are NOT in that
    // mode (i.e. no prompt continuation).
    const fastMode =
      typeof (task.input as { fast?: unknown }).fast === 'boolean' &&
      (task.input as { fast?: boolean }).fast === true;
    const effectiveOptions = fastMode ? undefined : ttsProviderOptions;
    const voicePrompt =
      !fastMode && typeof effectiveOptions?.voicePrompt === 'string'
        ? (effectiveOptions.voicePrompt as string)
        : undefined;
    const referenceAudioBase64 =
      !fastMode && typeof effectiveOptions?.referenceAudioBase64 === 'string'
        ? (effectiveOptions.referenceAudioBase64 as string)
        : undefined;
    const referenceAudioMimeType =
      !fastMode && typeof effectiveOptions?.referenceAudioMimeType === 'string'
        ? (effectiveOptions.referenceAudioMimeType as string)
        : undefined;
    const referenceAudioName =
      !fastMode && typeof effectiveOptions?.referenceAudioName === 'string'
        ? (effectiveOptions.referenceAudioName as string)
        : undefined;
    const promptText =
      !fastMode && typeof effectiveOptions?.promptText === 'string'
        ? (effectiveOptions.promptText as string)
        : undefined;
    // Mirrors `buildVoxCPMTargetText` in lib/audio/tts-providers.ts so the
    // queue path produces the same `(voice prompt)text` shape that the
    // synchronous /api/generate/tts route sends. Duplicated rather than
    // imported to keep this server module free of the (browser-aware)
    // tts-providers dependency.
    const cleanedVoicePrompt = voicePrompt
      ?.replace(/[\p{C}]+/gu, ' ')
      .replace(/[()（）]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    const usePromptContinuation = Boolean(
      referenceAudioBase64 && promptText?.trim(),
    );
    const finalTargetText = usePromptContinuation || !cleanedVoicePrompt
      ? text
      : `(${cleanedVoicePrompt})${text}`;

    const result = await postVoxCPMPythonAPI(
      ttsBaseUrl || process.env.TTS_VOXCPM_BASE_URL || 'http://localhost:8000',
      {
        targetText: finalTargetText,
        cfgValue: typeof effectiveOptions?.cfgValue === 'number' ? (effectiveOptions.cfgValue as number) : 2.0,
        inferenceTimesteps: fastMode
          ? 10
          : typeof effectiveOptions?.inferenceTimesteps === 'number'
            ? (effectiveOptions.inferenceTimesteps as number)
            : 10,
        normalize: fastMode
          ? true
          : typeof effectiveOptions?.normalize === 'boolean'
            ? (effectiveOptions.normalize as boolean)
            : false,
        denoise: fastMode
          ? false
          : typeof effectiveOptions?.denoise === 'boolean'
            ? (effectiveOptions.denoise as boolean)
            : false,
        referenceAudioBase64,
        referenceAudioMimeType,
        referenceAudioName,
        promptText,
      },
      ttsApiKey,
    );
    // Surface the dispatch shape in the server log so the operator can
    // confirm the inline-prompt / prompt-continuation path is being taken
    // for a clone voice — without this, a stuck "wrong-voice" output looks
    // identical to a correct one and the only signal is the eventual audio.
    if (!fastMode && (voicePrompt || promptText || referenceAudioBase64)) {
      // eslint-disable-next-line no-console
      console.log(
        `[tts-queue] ${task.id} dispatch: ` +
          `mode=${usePromptContinuation ? 'prompt-continuation' : cleanedVoicePrompt ? 'inline-prompt' : 'plain'}, ` +
          `textLen=${finalTargetText.length}, ` +
          `hasRefAudio=${!!referenceAudioBase64}, ` +
          `hasPromptText=${!!promptText}, ` +
          `voicePrompt=${cleanedVoicePrompt ? '"' + cleanedVoicePrompt.slice(0, 40) + (cleanedVoicePrompt.length > 40 ? '…' : '') + '"' : 'none'}`,
      );
    }

    // Honor a cancellation that landed while the long inference was in
    // flight. Discard the bytes — the task is already marked cancelled and
    // the file is not written, so a follow-up fast re-enqueue won't see a
    // stale partial on disk.
    if (task.status === 'cancelled' as TTSTaskStatus) {
      return;
    }

    if (!result.ok) {
      const errText = await result.text();
      throw new Error(`VoxCPM returned ${result.status}: ${errText.slice(0, 300)}`);
    }
    const audioBuffer = Buffer.from(await result.arrayBuffer());
    await ensureDirs();
    const filePath = path.join(PUBLIC_CACHE_DIR, `${task.id}.wav`);
    await fs.writeFile(filePath, audioBuffer);

    task.audioPath = `/audio-cache/${task.id}.wav`;
    task.bytes = audioBuffer.length;
    task.status = 'completed';
    task.completedAt = nowMs();
    await persist();
    // eslint-disable-next-line no-console
    console.log(
      `[tts-queue] ${task.id} completed: ${audioBuffer.length} bytes in ${
        ((task.completedAt - (task.startedAt || task.createdAt)) / 1000).toFixed(1)
      }s${fastMode ? ' (fast)' : ''}`,
    );
  } catch (err) {
    task.status = 'failed';
    task.error = err instanceof Error ? err.message : String(err);
    task.completedAt = nowMs();
    await persist();
    // eslint-disable-next-line no-console
    console.error(`[tts-queue] ${task.id} failed:`, task.error);
  }
}

function startWorker(): void {
  if (getWorkerRunning()) return;
  setWorkerRunning(true);
  // eslint-disable-next-line no-console
  console.log(`[tts-queue] worker started; ${getTailLength()} pending task(s)`);
  void drainLoop();
}

async function drainLoop(): Promise<void> {
  while (getTailLength() > 0) {
    const nextId = shiftTail();
    if (!nextId) break;
    const task = tasks.get(nextId);
    // Skip tasks that were cancelled (status changed to 'cancelled' while
    // they were in the queue tail) or that have somehow progressed past
    // pending. Without this guard a fast reset would let the worker
    // continue draining a cancelled tail.
    if (!task || task.status !== 'pending') continue;
    await processTask(task);
  }
  setWorkerRunning(false);
  // eslint-disable-next-line no-console
  console.log('[tts-queue] worker idle');
}
