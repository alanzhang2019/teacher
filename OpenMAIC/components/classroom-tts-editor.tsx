'use client';

/**
 * ClassroomTtsEditor — quick TTS-per-line editor for the classroom player.
 *
 * Why this exists: EditShell's SpeechClip / SpeechTtsBar already supports
 * in-place text edits + per-line re-synthesis, but the user has to leave
 * playback and enter "edit mode" to use it. When a single line has a typo
 * the TTS butchered (e.g. the TTS engine reads out a punctuation glyph), or
 * one line accidentally routed through `voxcpm:auto` while the rest of the
 * scene used the teacher's clone, bouncing into the editor for a one-line
 * fix is too much friction. This drawer surfaces the same operations
 * without leaving the classroom.
 *
 * Per-line voice pick: each row carries its own <Select> for
 * "克隆音色 <name>" vs "auto 音色". Re-generation enqueues through
 * `/api/generate/tts-background` with `ttsProviderOptions.voicePrompt` +
 * `referenceAudioBase64` for clone, or a default fast-auto shape for auto.
 * The persistent queue worker (lib/server/tts-queue.ts) writes the WAV to
 * `public/audio-cache/<taskId>.wav`; audio-player.ts will then resolve
 * the IndexedDB miss, fetch the file, write it to IDB, fire
 * `tts-audio-ready`, and the next click on the line will play the new
 * take with no manual refresh.
 *
 * Voice list source: `useVoxCPMVoiceProfiles` (the same hook AgentBar uses
 * to render the voice picker). So adding/removing a profile in AgentBar
 * instantly appears here too.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  PencilLine,
  RefreshCw,
  Loader2,
  Volume2,
  Mic,
  Check,
  X,
  ChevronRight,
} from 'lucide-react';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useVoxCPMVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const log = createLogger('ClassroomTtsEditor');

type VoiceChoice =
  | { kind: 'auto' }
  | { kind: 'clone'; profileId: string; name: string };

interface LineState {
  /** Action id, used as the per-line React key. */
  actionId: string;
  /** Current text (commit on blur, not per keystroke). */
  draft: string;
  /** Original text from the action — used to detect unsaved edits. */
  originalText: string;
  /** Stamped audioId (or undefined if the line has never been voiced). */
  audioId: string | undefined;
  /** Per-line voice pick. */
  voice: VoiceChoice;
  /** True while a re-generation POST is in flight for this line. */
  regenerating: boolean;
  /** Last error message (cleared on next successful regen). */
  error: string | null;
  /** Set once the queue task is in `processing`. */
  taskId: string | null;
  /** Set once the per-line TTS is written to IDB (from `tts-audio-ready`). */
  ready: boolean;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Build the `ttsProviderOptions` payload for `/api/generate/tts-background`.
 * Mirrors the shape the route handler in app/api/generate/tts-background/route.ts
 * forwards to `postVoxCPMPythonAPI`.
 */
async function buildProviderOptions(
  voice: VoiceChoice,
  profile: { referenceAudio?: Blob; voicePrompt?: string; referenceAudioName?: string; referenceAudioMimeType?: string } | null,
): Promise<Record<string, unknown>> {
  if (voice.kind === 'auto') {
    // Auto: cheapest pass, no reference audio. Same shape as tts-queue
    // "fast" mode, but exposed as a per-line user choice (not an admin
    // override) so it shows up in the queue diagnostics honestly.
    return {
      cfgValue: 2.0,
      inferenceTimesteps: 10,
      normalize: true,
      denoise: false,
    };
  }
  if (!profile?.referenceAudio) {
    throw new Error('克隆音色已丢失 reference audio（请到 AgentBar 重新录制）');
  }
  const base64 = await blobToBase64(profile.referenceAudio);
  return {
    cfgValue: 2.0,
    inferenceTimesteps: 10,
    normalize: true,
    denoise: false,
    referenceAudioBase64: base64,
    referenceAudioMimeType: profile.referenceAudioMimeType ?? profile.referenceAudio.type ?? 'audio/wav',
    referenceAudioName: profile.referenceAudioName ?? 'reference.wav',
    voicePrompt: profile.voicePrompt,
  };
}

export function ClassroomTtsEditor() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const currentScene = useStageStore((s) => s.getCurrentScene());
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsProviderConfig = useSettingsStore((s) => s.ttsProvidersConfig?.[ttsProviderId]);
  const updateScene = useStageStore((s) => s.updateScene);
  const { profiles, loading: profilesLoading } = useVoxCPMVoiceProfiles();

  // Per-line state, keyed by `${sceneId}:${actionId}` so a scene switch
  // doesn't bleed unsaved drafts.
  const [lines, setLines] = useState<Record<string, LineState>>({});

  // Stable refs / module-level singletons so the hydration effect doesn't
  // see a "new" value every render. Without these, the effect would
  // fire `setLines({})` with a fresh `{}` on every render and trip
  // "Maximum update depth exceeded".
  const EMPTY_LINES: Record<string, LineState> = useMemo(() => ({}), []);
  const sceneId = currentScene?.id ?? null;
  const sceneOrder = currentScene?.order ?? 0;
  const actions = useMemo(
    () =>
      (currentScene?.actions ?? []).filter(
        (a): a is {
          id: string;
          type: 'speech';
          text: string;
          audioId?: string;
          audioUrl?: string;
        } => a?.type === 'speech' && typeof a.id === 'string',
      ),
    [currentScene?.actions],
  );

  // Re-hydrate per-line state from the current scene's actions. We only
  // overwrite a line if its `originalText` matches what we last snapshot'd,
  // so an in-progress edit isn't clobbered by a scene re-render.
  const lastSceneIdRef = useRef<string | null>(null);
  // Hash the speech action list so the effect re-runs only when the
  // underlying text/audioId stamps change — not on every parent re-render
  // (which would otherwise hand us a new `actions` array reference each time).
  const actionsStamp = useMemo(
    () => actions.map((a) => `${a.id}:${a.text ?? ''}:${a.audioId ?? ''}`).join('|'),
    [actions],
  );
  useEffect(() => {
    if (!sceneId) {
      // Don't pass a fresh `{}` here — that creates a new object every
      // render and the effect would loop on `Maximum update depth`.
      if (lastSceneIdRef.current !== null) {
        lastSceneIdRef.current = null;
        setLines(EMPTY_LINES);
      }
      return;
    }
    if (lastSceneIdRef.current !== sceneId) {
      lastSceneIdRef.current = sceneId;
      const next: Record<string, LineState> = {};
      for (const action of actions) {
        const key = `${sceneId}:${action.id}`;
        next[key] = {
          actionId: action.id,
          draft: action.text ?? '',
          originalText: action.text ?? '',
          audioId: action.audioId,
          voice: { kind: 'auto' },
          regenerating: false,
          error: null,
          taskId: null,
          ready: false,
        };
      }
      setLines(next);
      return;
    }
    // Same scene, but the underlying text/audioId stamps may have been
    // edited elsewhere (e.g. the global EditShell). Re-sync only when the
    // stamp actually changes; the per-line dirty draft is preserved by
    // skipping lines whose `originalText` already matches the new stamp.
    setLines((prev) => {
      let mutated = false;
      const next: Record<string, LineState> = { ...prev };
      for (const action of actions) {
        const key = `${sceneId}:${action.id}`;
        const existing = next[key];
        if (!existing) {
          next[key] = {
            actionId: action.id,
            draft: action.text ?? '',
            originalText: action.text ?? '',
            audioId: action.audioId,
            voice: { kind: 'auto' },
            regenerating: false,
            error: null,
            taskId: null,
            ready: false,
          };
          mutated = true;
          continue;
        }
        if (existing.originalText === (action.text ?? '')) continue;
        if (existing.draft !== existing.originalText) continue; // user is editing
        next[key] = {
          ...existing,
          originalText: action.text ?? '',
          draft: action.text ?? '',
          audioId: action.audioId,
        };
        mutated = true;
      }
      return mutated ? next : prev;
    });
  }, [sceneId, actionsStamp, actions, EMPTY_LINES]);

  // When a `tts-audio-ready` event fires for a line we own, mark it ready
  // so the per-line "试听" / regen button can flip to "✅ ready" state.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ audioId: string }>).detail;
      const audioId = detail?.audioId;
      if (!audioId) return;
      setLines((prev) => {
        let mutated = false;
        const next = { ...prev };
        for (const [key, line] of Object.entries(prev)) {
          if (line.audioId === audioId) {
            next[key] = { ...line, ready: true, regenerating: false };
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
    };
    window.addEventListener('tts-audio-ready', handler);
    return () => window.removeEventListener('tts-audio-ready', handler);
  }, []);

  const updateLine = useCallback((key: string, patch: Partial<LineState>) => {
    setLines((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));
  }, []);

  /** Commit a per-line text edit back to the stage store. */
  const commitText = useCallback(
    (key: string, text: string) => {
      const line = lines[key];
      if (!line || !sceneId || !currentScene) return;
      if (text === line.originalText) return;
      // Snapshot the actions array locally so TS narrows the union and the
      // `.map` callback doesn't have to re-narrow `currentScene` on every
      // iteration. Reusing the snapshot also means a concurrent stage
      // store update mid-loop can't splice under us.
      const actions: typeof currentScene.actions = currentScene.actions ?? [];
      // Patch the action inside the scene's actions array. We rebuild the
      // actions array (immutable) and feed it through updateScene so the
      // IndexedDB write goes through the same `debouncedSave` path as any
      // other scene edit.
      const nextActions = actions.map((a) => {
        if (a?.id !== line.actionId || a.type !== 'speech') return a;
        // Clear the audioId so the player re-resolves the blob under the
        // new text (the audioId is the cache key, but the blob is keyed by
        // sceneOrder+actionId, so the OLD audio is technically still
        // resolvable — clear the stamp so the UI shows "未配音" and the
        // user explicitly re-synthesizes with the new text).
        const next = { ...a, text } as unknown as typeof a;
        delete (next as { audioId?: string }).audioId;
        delete (next as { audioUrl?: string }).audioUrl;
        return next;
      });
      updateScene(sceneId, { actions: nextActions });
      updateLine(key, { draft: text, originalText: text, ready: false });
    },
    [lines, sceneId, currentScene, updateScene, updateLine],
  );

  /** Re-enqueue a single line for TTS synthesis with the chosen voice. */
  const regenerate = useCallback(
    async (key: string) => {
      const line = lines[key];
      if (!line || !sceneId || !currentScene) return;
      const actions: typeof currentScene.actions = currentScene.actions ?? [];
      const settings = useSettingsStore.getState();
      if (settings.ttsProviderId === 'browser-native-tts') {
        updateLine(key, { error: '当前使用浏览器内置 TTS，无法重新生成' });
        return;
      }
      const audioId = `tts_s${sceneOrder}_${line.actionId}`;
      // Resolve clone profile (if chosen) so we can attach reference audio
      // + voicePrompt to the enqueue payload. The discriminated union narrows
      // `line.voice` to {kind:'clone', profileId, name} on the first check.
      let profile: { referenceAudio?: Blob; voicePrompt?: string; referenceAudioName?: string; referenceAudioMimeType?: string } | null = null;
      if (line.voice.kind === 'clone') {
        const profileId = line.voice.profileId;
        const hit = profiles.find((p) => p.id === profileId);
        profile = hit
          ? {
              referenceAudio: hit.referenceAudio,
              voicePrompt: hit.voicePrompt,
              referenceAudioName: hit.referenceAudioName,
              referenceAudioMimeType: hit.referenceAudioMimeType,
            }
          : null;
      }
      let options: Record<string, unknown>;
      try {
        options = await buildProviderOptions(line.voice, profile);
      } catch (err) {
        updateLine(key, {
          error: err instanceof Error ? err.message : String(err),
          regenerating: false,
        });
        return;
      }
      updateLine(key, { regenerating: true, error: null, ready: false });
      try {
        const resp = await fetch('/api/generate/tts-background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioId,
            text: line.draft,
            ttsProviderId: settings.ttsProviderId,
            ttsModelId: ttsProviderConfig?.modelId,
            ttsVoice:
              line.voice.kind === 'clone'
                ? `voxcpm:profile:${(line.voice as { profileId: string }).profileId}`
                : 'voxcpm:auto',
            ttsSpeed: settings.ttsSpeed ?? 1.0,
            ttsApiKey: ttsProviderConfig?.apiKey || undefined,
            ttsBaseUrl:
              ttsProviderConfig?.baseUrl ||
              ttsProviderConfig?.customDefaultBaseUrl ||
              undefined,
            ttsProviderOptions: options,
          }),
        });
        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          throw new Error(
            (errBody as { error?: { message?: string }; message?: string })?.error?.message ??
              (errBody as { message?: string })?.message ??
              `HTTP ${resp.status}`,
          );
        }
        const json = (await resp.json()) as { data?: { taskId?: string; audioId?: string }; taskId?: string; audioId?: string };
        const taskId = json?.data?.taskId ?? json?.taskId ?? null;
        // Stamp the new audioId onto the action so the player can resolve it
        // as soon as audio-player writes the WAV to IDB.
        const nextActions = actions.map((a) => {
          if (a?.id !== line.actionId || a.type !== 'speech') return a;
          return { ...a, audioId } as typeof a;
        });
        updateScene(sceneId, { actions: nextActions });
        updateLine(key, { taskId, audioId, regenerating: false });
        log.info(`[ClassroomTtsEditor] enqueued ${audioId} (taskId=${taskId})`);
      } catch (err) {
        updateLine(key, {
          error: err instanceof Error ? err.message : String(err),
          regenerating: false,
        });
      }
    },
    [lines, sceneId, sceneOrder, profiles, ttsProviderConfig, currentScene, updateScene, updateLine],
  );

  const linesList = useMemo(() => {
    if (!sceneId) return [];
    return actions.map((a) => ({ key: `${sceneId}:${a.id}`, action: a }));
  }, [sceneId, actions]);

  const busyCount = useMemo(
    () => Object.values(lines).filter((l) => l.regenerating).length,
    [lines],
  );

  return (
    <>
      {/* Floating button — only render on the client after hydration so it
          doesn't appear during the SSR pass and confuse the layout.
          z-[60] so it always sits on top of the FixMissingTts widget
          (which uses z-50 in the same bottom-right corner). */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={cn(
                'pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border shadow-lg transition-all',
                open
                  ? 'border-violet-300 bg-violet-500 text-white shadow-violet-500/30'
                  : 'border-border/60 bg-white text-foreground/80 hover:border-violet-300 hover:text-violet-600 dark:bg-slate-800',
              )}
              aria-label={open ? '关闭 TTS 编辑器' : '打开 TTS 编辑器'}
            >
              {open ? <X className="size-4" /> : <PencilLine className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <div className="text-xs">
              {open ? '关闭 TTS 编辑器' : '编辑本页 TTS（文字 / 音色）'}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Drawer */}
      <div
        className={cn(
          'fixed inset-y-0 right-0 z-30 w-[420px] max-w-[100vw] border-l border-border/60 bg-white/95 shadow-2xl backdrop-blur transition-transform duration-200 dark:bg-slate-900/95',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
        aria-hidden={!open}
      >
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
            <Volume2 className="size-4 text-violet-500" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">本页 TTS</div>
              <div className="text-[11px] text-muted-foreground">
                {sceneId ? `Scene ${sceneOrder + 1} · ${actions.length} 条` : '无当前 scene'}
                {busyCount > 0 && ` · ${busyCount} 生成中`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {linesList.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-xs text-muted-foreground">
                <Mic className="mb-2 size-8 opacity-30" />
                当前 scene 没有 speech action。
                <div className="mt-1">切到其他 scene 试试。</div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {linesList.map(({ key, action }) => {
                  const line = lines[key];
                  if (!line) return null;
                  return (
                    <LineRow
                      key={key}
                      line={line}
                      profiles={profiles}
                      profilesLoading={profilesLoading}
                      onTextChange={(text) => updateLine(key, { draft: text })}
                      onCommit={() => commitText(key, line.draft)}
                      onVoiceChange={(voice) => updateLine(key, { voice })}
                      onRegenerate={() => void regenerate(key)}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
            完成后 audio-player 自动写入 IndexedDB，下一次播放即生效。
            <br />
            克隆音色需在 AgentBar 先录制。
          </div>
        </div>
      </div>
    </>
  );
}

interface LineRowProps {
  line: LineState;
  profiles: ReadonlyArray<{
    id: string;
    name: string;
    referenceAudio?: Blob;
    voicePrompt?: string;
  }>;
  profilesLoading: boolean;
  onTextChange: (text: string) => void;
  onCommit: () => void;
  onVoiceChange: (voice: VoiceChoice) => void;
  onRegenerate: () => void;
}

function LineRow({
  line,
  profiles,
  profilesLoading,
  onTextChange,
  onCommit,
  onVoiceChange,
  onRegenerate,
}: LineRowProps) {
  const isDirty = line.draft !== line.originalText;
  const voiceSummary =
    line.voice.kind === 'auto'
      ? 'auto 音色'
      : `克隆：${profiles.find((p) => p.id === (line.voice as { profileId: string }).profileId)?.name ?? '...'}`;
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-white/70 p-2.5 shadow-sm transition-colors dark:bg-slate-800/50',
        isDirty && 'border-amber-300/80 bg-amber-50/50 dark:bg-amber-900/10',
        line.regenerating && 'opacity-70',
        line.error && 'border-rose-300/80 bg-rose-50/40 dark:bg-rose-900/10',
      )}
    >
      <textarea
        value={line.draft}
        onChange={(e) => onTextChange(e.target.value)}
        onBlur={onCommit}
        rows={3}
        className="w-full resize-none rounded-md border border-border/50 bg-white/80 px-2 py-1.5 text-[12.5px] leading-relaxed outline-none focus:border-violet-400 dark:bg-slate-900/50"
        placeholder="(空文本不会合成 TTS)"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <select
          value={line.voice.kind === 'clone' ? `clone:${(line.voice as { profileId: string }).profileId}` : 'auto'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'auto') onVoiceChange({ kind: 'auto' });
            else if (v.startsWith('clone:')) {
              const profileId = v.slice('clone:'.length);
              const profile = profiles.find((p) => p.id === profileId);
              onVoiceChange({ kind: 'clone', profileId, name: profile?.name ?? profileId });
            }
          }}
          disabled={profilesLoading}
          className="min-w-0 flex-1 rounded-md border border-border/50 bg-white/80 px-1.5 py-1 text-[11px] outline-none focus:border-violet-400 disabled:opacity-50 dark:bg-slate-900/50"
        >
          <option value="auto">auto 音色（无参考音）</option>
          {profiles.map((p) => (
            <option key={p.id} value={`clone:${p.id}`}>
              克隆：{p.name}
              {p.referenceAudio ? '' : '（缺 reference audio）'}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={line.regenerating || !line.draft.trim() || isDirty}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            'border border-violet-300 bg-violet-100 text-violet-800 hover:bg-violet-200 disabled:opacity-40 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-200',
          )}
          title={
            isDirty
              ? '请先在文本框外失焦提交修改，再重新生成'
              : !line.draft.trim()
                ? '空文本不会合成'
                : '用所选音色重新生成这段 TTS'
          }
        >
          {line.regenerating ? (
            <Loader2 className="size-3 animate-spin" />
          ) : line.ready ? (
            <Check className="size-3" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {line.regenerating ? '生成中' : line.ready ? '已就绪' : '重新生成'}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10.5px] text-muted-foreground">
        <ChevronRight className="size-3" />
        <span className="truncate">当前：{voiceSummary}</span>
        {line.audioId && (
          <span className="ml-auto font-mono opacity-60">{line.audioId}</span>
        )}
      </div>
      {line.error && (
        <div className="mt-1 text-[10.5px] text-rose-600 dark:text-rose-400">
          ⚠ {line.error}
        </div>
      )}
    </div>
  );
}
