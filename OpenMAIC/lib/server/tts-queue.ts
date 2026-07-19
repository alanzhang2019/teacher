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

export type TTSTaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

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
    input,
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

export function getTTSTask(id: string): TTSTask | undefined {
  return tasks.get(id);
}

export function listTTSTasks(): TTSTask[] {
  return Array.from(tasks.values());
}

async function processTask(task: TTSTask): Promise<void> {
  task.status = 'processing';
  task.startedAt = nowMs();
  await persist();

  try {
    const { text, ttsProviderId, ttsModelId, ttsVoice, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = task.input;
    const result = await postVoxCPMPythonAPI(
      ttsBaseUrl || process.env.TTS_VOXCPM_BASE_URL || 'http://localhost:8000',
      {
        targetText: text,
        cfgValue: typeof ttsProviderOptions?.cfgValue === 'number' ? (ttsProviderOptions.cfgValue as number) : 2.0,
        inferenceTimesteps:
          typeof ttsProviderOptions?.inferenceTimesteps === 'number'
            ? (ttsProviderOptions.inferenceTimesteps as number)
            : 10,
        normalize:
          typeof ttsProviderOptions?.normalize === 'boolean'
            ? (ttsProviderOptions.normalize as boolean)
            : false,
        denoise:
          typeof ttsProviderOptions?.denoise === 'boolean'
            ? (ttsProviderOptions.denoise as boolean)
            : false,
        referenceAudioBase64:
          typeof ttsProviderOptions?.referenceAudioBase64 === 'string'
            ? (ttsProviderOptions.referenceAudioBase64 as string)
            : undefined,
        referenceAudioMimeType:
          typeof ttsProviderOptions?.referenceAudioMimeType === 'string'
            ? (ttsProviderOptions.referenceAudioMimeType as string)
            : undefined,
        referenceAudioName:
          typeof ttsProviderOptions?.referenceAudioName === 'string'
            ? (ttsProviderOptions.referenceAudioName as string)
            : undefined,
        promptText:
          typeof ttsProviderOptions?.promptText === 'string'
            ? (ttsProviderOptions.promptText as string)
            : undefined,
        apiKey: ttsApiKey,
      },
    );

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
      }s`,
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
    if (!task || task.status !== 'pending') continue;
    await processTask(task);
  }
  setWorkerRunning(false);
  // eslint-disable-next-line no-console
  console.log('[tts-queue] worker idle');
}
