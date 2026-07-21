'use client';

/**
 * FixMissingTts — scans the current classroom for any speech action whose
 * canonical `tts_s<sceneOrder>_<actionId>` audio is missing from IndexedDB
 * and re-submits it to the background TTS queue.
 *
 * Designed for the failure mode where the user previously hit the silent-skip
 * path in `use-scene-generator` (clone voice not resolvable, then early
 * return) and now sees TTS-missing "play" icons on scenes that were generated
 * before the fail-fast fallback was added. Scanning + regenerating on mount
 * means the user just opens the classroom and the gaps fill in.
 *
 * Also self-heals stages that were generated under the legacy `tts_<actionId>`
 * audioId scheme: in that scheme the key had no scene prefix, so the
 * `classroom` player and `FixMissingTTS` scanned two different keys and the
 * user heard silence despite `.wav`s being on disk. We rewrite the audioId
 * in-memory, copy any cached blob to the new key, and persist the rewrite via
 * `stageStore.saveToStorage()`. Subsequent loads stay on the new key.
 *
 * On mount, the panel also subscribes to the `tts-audio-ready` window event
 * and polls `/api/dev/audio-status` so the user can see live queue progress
 * (pending / on-disk counts) and gets a "ready" toast every time a TTS the
 * player was waiting on finishes — no manual refresh required to know that
 * the audio is now playable.
 */

import { useEffect, useRef, useState } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import {
  audioExistsBulk,
  regenerateSpeechAudio,
  resolveSpeechAudioId,
  speechAudioId,
} from '@/lib/audio/regenerate-speech-tts';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('FixMissingTTS');

type FixStatus = 'idle' | 'scanning' | 'fixing' | 'done' | 'error';

/** Matches the legacy audioId scheme (`tts_<actionId>` without a scene prefix). */
const LEGACY_AUDIO_ID_RE = /^tts_(?!s\d+_)/;

interface SpeechActionLike {
  id?: string;
  type?: string;
  text?: string;
  audioId?: string;
}

interface SceneLike {
  order?: number;
  actions?: SpeechActionLike[];
}

interface QueueStatus {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  onDisk: number;
}

function isLegacyAudioId(audioId: string | undefined): boolean {
  return !!audioId && LEGACY_AUDIO_ID_RE.test(audioId);
}

export function FixMissingTts() {
  const [status, setStatus] = useState<FixStatus>('idle');
  const [migrated, setMigrated] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  const [done, setDone] = useState(0);
  const [errored, setErrored] = useState(0);
  const [readyCount, setReadyCount] = useState(0);
  const [lastReady, setLastReady] = useState<{ audioId: string; text?: string } | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState<{ enqueued: number; cancelled: number } | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    void scanFixMigrateAndRegen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to per-audio "ready" events fired by AudioPlayer when a
  // background poll on /audio-cache/<id>.wav finally succeeds. The user
  // gets a toast every time a TTS the player was waiting on finishes.
  useEffect(() => {
    const onReady = (ev: Event) => {
      const detail = (ev as CustomEvent<{ audioId: string; bytes: number; text?: string }>).detail;
      if (!detail?.audioId) return;
      setReadyCount((n) => n + 1);
      setLastReady({ audioId: detail.audioId, text: detail.text });
      log.info(
        `[FixMissingTTS] tts-audio-ready: ${detail.audioId} (${detail.bytes} bytes)`,
      );
    };
    window.addEventListener('tts-audio-ready', onReady);
    return () => window.removeEventListener('tts-audio-ready', onReady);
  }, []);

  // Poll /api/dev/audio-status every 5s so the user can see how many of the
  // 33 re-enqueued TTS jobs are pending, processing, completed, and how many
  // .wav files are actually on disk. Without this the user has no idea if the
  // pipeline is making progress.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/dev/audio-status', { cache: 'no-store' });
        if (!r.ok) return;
        const d = (await r.json()) as QueueStatus;
        if (!cancelled) setQueue(d);
      } catch {
        // network blip — try again next tick
      }
    };
    void tick();
    const t = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  async function scanFixMigrateAndRegen() {
    // Defer one frame so the stage store has time to populate from the load
    // class call kicked off by the classroom page.
    await new Promise((r) => setTimeout(r, 1500));

    const scenes = ((useStageStore.getState() as unknown as { scenes?: SceneLike[] })
      .scenes ?? []) as SceneLike[];
    if (scenes.length === 0) {
      log.info('[FixMissingTTS] no scenes in current stage');
      return;
    }

    // ----- Phase 1: rewrite legacy audioIds in the in-memory stage and copy
    // any cached blob from the old IndexedDB key to the new one. -----
    let migratedCount = 0;
    const renames: Array<{ from: string; to: string }> = [];
    for (const scene of scenes) {
      if (typeof scene.order !== 'number') continue;
      for (const action of scene.actions ?? []) {
        if (!action.id) continue;
        const desired = speechAudioId(scene.order, action.id);
        if (action.audioId === desired) continue;
        if (!isLegacyAudioId(action.audioId)) continue;
        // Move the cached blob to the new key before we change the stage field
        // so even a mid-migration reload still resolves the audio. If the
        // legacy blob is missing (e.g. the user already tried to regen), the
        // Phase-2 pass below will synthesize a new one under the new key.
        try {
          const oldRec = await db.audioFiles.get(action.audioId!);
          if (oldRec && oldRec.format) {
            await db.audioFiles.put({
              id: desired,
              blob: oldRec.blob,
              duration: oldRec.duration,
              format: oldRec.format,
              createdAt: oldRec.createdAt ?? Date.now(),
            });
          }
        } catch (err) {
          log.warn(`[FixMissingTTS] failed to copy legacy blob for ${action.audioId}:`, err);
        }
        renames.push({ from: action.audioId!, to: desired });
        action.audioId = desired;
        migratedCount += 1;
      }
    }
    if (renames.length > 0) {
      // Also rename the on-disk WAV (Next.js serves /public/audio-cache/ as a
      // static dir, so the player would otherwise fall back to IndexedDB only
      // — which is fine, but renaming keeps the two stores in lockstep and
      // makes a clean re-render or new tab work without a recovery probe).
      await Promise.all(
        renames.map(async ({ from, to }) => {
          try {
            const r = await fetch('/api/generate/tts-background', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from, to }),
            });
            if (!r.ok) {
              log.info(
                `[FixMissingTTS] rename ${from} -> ${to} returned ${r.status} (will re-enqueue TTS)`,
              );
            }
          } catch (err) {
            log.warn(`[FixMissingTTS] rename ${from} -> ${to} failed:`, err);
          }
        }),
      );
    }
    if (migratedCount > 0) {
      try {
        await useStageStore.getState().saveToStorage();
        log.info(`[FixMissingTTS] rewrote ${migratedCount} legacy audioId(s) and persisted stage`);
      } catch (err) {
        log.warn('[FixMissingTTS] saveToStorage after migrate failed:', err);
      }
    }
    setMigrated(migratedCount);

    // ----- Phase 2: gather canonical audioIds and figure out which are still
    // missing from IndexedDB; enqueue TTS for each of them. -----
    const audioIds: string[] = [];
    const lookup: Array<{ sceneOrder: number; action: { id: string; text: string } }> = [];
    for (const scene of scenes) {
      if (typeof scene.order !== 'number') continue;
      for (const action of scene.actions ?? []) {
        if (action.type !== 'speech' || !action.text || !action.id) continue;
        audioIds.push(resolveSpeechAudioId(scene.order, action));
        lookup.push({ sceneOrder: scene.order, action: { id: action.id, text: action.text } });
      }
    }

    if (audioIds.length === 0) {
      log.info('[FixMissingTTS] no speech actions in current stage');
      setStatus('done');
      return;
    }

    setStatus('scanning');
    const have = await audioExistsBulk(audioIds);
    const missingIds = audioIds.filter((id) => !have.has(id));
    log.info(
      `[FixMissingTTS] scanned ${audioIds.length} speech actions, ${missingIds.length} missing`,
    );
    setMissing(missingIds);

    if (missingIds.length === 0) {
      setStatus('done');
      return;
    }

    setStatus('fixing');
    let ok = 0;
    let fail = 0;
    for (const { sceneOrder, action } of lookup) {
      const aid = speechAudioId(sceneOrder, action.id);
      if (!missingIds.includes(aid)) continue;
      try {
        await regenerateSpeechAudio(sceneOrder, action);
        ok++;
        setDone(ok);
      } catch (err) {
        fail++;
        setErrored(fail);
        log.warn(`[FixMissingTTS] regen failed for ${aid}:`, err);
      }
    }
    setStatus('done');
  }

  /**
   * Fast reset: cancel every non-terminal task currently in the queue
   * (this includes the long-running clone-mode synthesis that would
   * otherwise burn 30+ hours) and re-enqueue every speech action in the
   * current stage under fast mode (10 inference steps, no denoise, no
   * reference audio / prompt). Fast mode drops the clone timbre in favor
   * of the auto-derived VoxCPM voice, but a 30-100s synthesis per clip
   * means 74 clips finish in roughly 1-2 hours instead of 16-28.
   *
   * Safe to call repeatedly: cancelling is a no-op on tasks that already
   * completed, and re-enqueuing the same audioId replaces the pending
   * task rather than duplicating it.
   */
  async function handleFastReset() {
    if (resetting) return;
    setResetting(true);
    setResetDone(null);
    try {
      // 1) Cancel everything currently in the queue.
      const cancelResp = await fetch('/api/dev/reset-fast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel-all' }),
      });
      const cancelJson = cancelResp.ok ? await cancelResp.json() : { cancelled: 0 };
      const cancelled: number = cancelJson.cancelled ?? 0;

      // 2) Collect every speech action in the current stage.
      const scenes = ((useStageStore.getState() as unknown as { scenes?: SceneLike[] })
        .scenes ?? []) as SceneLike[];
      const settings = useSettingsStore.getState();
      const ttsProviderId = settings.ttsProviderId;
      const ttsProviderConfig = settings.ttsProvidersConfig?.[ttsProviderId];
      const tasks: Array<{
        audioId: string;
        text: string;
        ttsProviderId: string;
        ttsModelId?: string;
        ttsVoice: string;
        ttsSpeed: number;
        ttsApiKey?: string;
        ttsBaseUrl?: string;
        ttsProviderOptions?: Record<string, unknown>;
      }> = [];
      for (const scene of scenes) {
        if (typeof scene.order !== 'number') continue;
        for (const action of scene.actions ?? []) {
          if (action.type !== 'speech' || !action.text || !action.id) continue;
          tasks.push({
            audioId: speechAudioId(scene.order, action.id),
            text: action.text,
            ttsProviderId,
            ttsModelId: ttsProviderConfig?.modelId,
            ttsVoice: settings.ttsVoice,
            ttsSpeed: settings.ttsSpeed ?? 1.0,
            ttsApiKey: ttsProviderConfig?.apiKey || undefined,
            ttsBaseUrl:
              ttsProviderConfig?.baseUrl ||
              ttsProviderConfig?.customDefaultBaseUrl ||
              undefined,
            // intentionally no ttsProviderOptions — the server-side fast
            // path drops referenceAudioBase64 / promptText anyway, and
            // omitting them client-side keeps the request payload small.
          });
        }
      }
      if (tasks.length === 0) {
        setResetDone({ enqueued: 0, cancelled });
        return;
      }

      // 3) Re-enqueue in fast mode.
      const enqResp = await fetch('/api/dev/reset-fast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enqueue-fast-batch', tasks }),
      });
      const enqJson = enqResp.ok ? await enqResp.json() : { enqueued: 0 };
      setResetDone({ enqueued: enqJson.enqueued ?? 0, cancelled });
      log.info(
        `[FixMissingTTS] fast reset: cancelled ${cancelled}, enqueued ${enqJson.enqueued}`,
      );
    } catch (err) {
      log.error('[FixMissingTTS] fast reset failed:', err);
    } finally {
      setResetting(false);
    }
  }

  if (
    status === 'idle' ||
    status === 'scanning' ||
    (status === 'done' && migrated === 0 && missing.length === 0 && readyCount === 0 && !queue)
  ) {
    return null;
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">TTS 补救</div>
        {queue ? (
          <div className="text-xs text-amber-800">
            队列 {queue.pending + queue.processing} 待跑 · {queue.onDisk} 已就绪
          </div>
        ) : null}
      </div>
      {migrated > 0 ? (
        <div className="text-xs text-amber-800">迁移了 {migrated} 条旧 audioId 记录</div>
      ) : null}
      {status === 'fixing' ? (
        <div>
          重新生成中… {done}/{missing.length}
          {errored > 0 ? `（${errored} 失败）` : null}
        </div>
      ) : (
        <div>
          ✅ 补救完成：{done}/{missing.length} 已重新入队
          {errored > 0 ? `（${errored} 失败）` : null}
        </div>
      )}
      {readyCount > 0 ? (
        <div className="mt-1 text-xs text-amber-800">
          🆕 {readyCount} 条 TTS 已就绪
          {lastReady?.text ? `：${lastReady.text.slice(0, 14)}…` : null}
          <button
            type="button"
            className="ml-2 rounded border border-amber-400 px-1.5 py-0.5 text-amber-900 hover:bg-amber-100"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload();
            }}
          >
            刷新
          </button>
        </div>
      ) : null}
      {/* Fast reset: cancels the current 30+h clone-mode queue and
          re-enqueues every speech action in fast mode (10 steps, no
          denoise, no reference audio). Trade clone timbre for 1-2 hour
          queue tail. Hidden until the user has actually seen a queue
          state, so the button isn't a footgun on first run. */}
      {queue && (queue.pending > 5 || queue.processing > 0) ? (
        <div className="mt-2 border-t border-amber-300 pt-2">
          <div className="text-xs text-amber-800">
            ⏳ 当前队列 16-28 小时（克隆模式）。加速 = 放弃克隆音色，换 1-2 小时跑完（auto 音色）。
          </div>
          <button
            type="button"
            disabled={resetting}
            className="mt-1 w-full rounded border border-amber-500 bg-amber-200 px-2 py-1 text-amber-900 hover:bg-amber-300 disabled:opacity-50"
            onClick={() => {
              void handleFastReset();
            }}
          >
            {resetting ? '加速中…' : '⚡ 加速：清空重入队（auto 音色）'}
          </button>
          {resetDone ? (
            <div className="mt-1 text-xs text-amber-800">
              ✅ 已清空 {resetDone.cancelled} 条，已入队 {resetDone.enqueued} 条（fast 模式）
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
