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
  Pause,
} from 'lucide-react';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useVoxCPMVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import { db } from '@/lib/utils/database';
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
 * Best-effort ASR transcription of a clone voice's reference audio.
 *
 * The user-facing symptom: a clone profile was recorded with reference
 * audio but the "参考音频对应文本" and "音色描述" fields were left empty
 * (or never shown — the recorder UI doesn't always gate on them). When
 * that profile is reused for "重新生成" VoxCPM is fed only `reference_audio`
 * and falls into `reference-only` mode, whose timbre drifts toward the
 * model's auto default and the user concludes "还是 auto".
 *
 * The cheapest fix is to pull the text that the user *actually said* in
 * the reference audio out of the audio itself. If we can supply
 * `promptText` to VoxCPM the worker switches to `prompt-continuation`
 * mode (`prompt_wav_path` + `prompt_text` together), which is the
 * strongest of the three VoxCPM clone paths and gives a markedly
 * tighter match to the recorded voice. The ASR pass is best-effort —
 * if it fails or the provider isn't configured, we still POST the
 * request and let the worker fall back to reference-only.
 */
async function transcribeReferenceAudio(
  audio: Blob,
  audioName: string,
  asrConfig: { providerId: string; modelId?: string; apiKey?: string; baseUrl?: string; language?: string } | null,
): Promise<string | null> {
  if (!asrConfig) {
    // eslint-disable-next-line no-console
    console.log('[ClassroomTtsEditor] ASR auto-fill skipped: no ASR provider configured.');
    return null;
  }
  try {
    const form = new FormData();
    form.set('audio', audio, audioName);
    form.set('providerId', asrConfig.providerId);
    if (asrConfig.modelId) form.set('modelId', asrConfig.modelId);
    if (asrConfig.apiKey) form.set('apiKey', asrConfig.apiKey);
    if (asrConfig.baseUrl) form.set('baseUrl', asrConfig.baseUrl);
    if (asrConfig.language) form.set('language', asrConfig.language);
    const resp = await fetch('/api/transcription', { method: 'POST', body: form });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ClassroomTtsEditor] ASR auto-fill failed: ${resp.status} ${resp.statusText}. VoxCPM will run in reference-only mode.`,
      );
      return null;
    }
    const json = (await resp.json()) as { success?: boolean; data?: { text?: string } } | { text?: string };
    const text = (json as { data?: { text?: string } }).data?.text ?? (json as { text?: string }).text;
    const trimmed = (text ?? '').trim();
    if (!trimmed) return null;
    // eslint-disable-next-line no-console
    console.log(
      `[ClassroomTtsEditor] ASR auto-fill -> promptText(${trimmed.length} chars)="${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}"`,
    );
    return trimmed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ClassroomTtsEditor] ASR auto-fill threw; reference-only fallback', err);
    return null;
  }
}

/**
 * Build the `ttsProviderOptions` payload for `/api/generate/tts-background`.
 * Mirrors the shape the route handler in app/api/generate/tts-background/route.ts
 * forwards to `postVoxCPMPythonAPI`.
 */
async function buildProviderOptions(
  voice: VoiceChoice,
  profile: { referenceAudio?: Blob; voicePrompt?: string; promptText?: string; referenceAudioName?: string; referenceAudioMimeType?: string } | null,
  asrConfig: { providerId: string; modelId?: string; apiKey?: string; baseUrl?: string; language?: string } | null = null,
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
  // If the clone profile was recorded without the optional `promptText`
  // (the words the user said in the reference clip), try to recover it
  // by ASR-transcribing the reference audio. This puts VoxCPM into
  // `prompt-continuation` mode and gives a much tighter timbre match
  // than `reference-only` — see transcribeReferenceAudio docstring.
  let effectivePromptText = profile.promptText?.trim() || '';
  if (!effectivePromptText) {
    const asrText = await transcribeReferenceAudio(
      profile.referenceAudio,
      profile.referenceAudioName ?? 'reference.wav',
      asrConfig,
    );
    if (asrText) effectivePromptText = asrText;
  }
  const base64 = await blobToBase64(profile.referenceAudio);
  // Diagnose what we are about to POST so the user can confirm in the
  // browser console whether the clone voice options (voicePrompt,
  // promptText, reference audio) are actually being sent. The previous
  // "TTS 重生成音色没变" bug had three independent failure modes
  // (worker dropped voicePrompt, editor dropped promptText, IDB held
  // the old blob) and the only signal was the eventual audio — this
  // log makes the *intent* visible before the network round-trip.
  // eslint-disable-next-line no-console
  console.log(
    `[ClassroomTtsEditor] buildProviderOptions(clone) -> ` +
      `voicePrompt=${JSON.stringify(profile.voicePrompt || null)} ` +
      `promptText=${JSON.stringify(effectivePromptText.slice(0, 40) || null)} ` +
      `(promptTextSource=${profile.promptText ? 'profile' : effectivePromptText ? 'asr-autofill' : 'none'}) ` +
      `refAudioBytes=${Math.round(base64.length * 0.75)} ` +
      `mimeType=${profile.referenceAudioMimeType ?? profile.referenceAudio?.type ?? 'audio/wav'}`,
  );
  if (!profile.voicePrompt && !effectivePromptText) {
    // Reference-only fallback. Loud warning so the operator can see why
    // the output may sound auto-ish even though the clone profile is
    // selected. See the transcribeReferenceAudio docstring for context.
    // eslint-disable-next-line no-console
    console.warn(
      '[ClassroomTtsEditor] clone profile is missing BOTH voicePrompt and promptText (ASR auto-fill also failed). ' +
        'VoxCPM will run in reference-only mode. Re-record the voice in Settings → TTS → VoxCPM → 录制音色 and fill in: ' +
        '(1) a voice design description (e.g. "a calm female teacher speaking standard Mandarin"), AND ' +
        '(2) the exact words you said in the reference audio. Both fields are required for prompt-continuation mode.',
    );
  }
  return {
    cfgValue: 2.0,
    inferenceTimesteps: 10,
    normalize: true,
    denoise: false,
    referenceAudioBase64: base64,
    referenceAudioMimeType: profile.referenceAudioMimeType ?? profile.referenceAudio.type ?? 'audio/wav',
    referenceAudioName: profile.referenceAudioName ?? 'reference.wav',
    // Voice design description (e.g. "a calm female teacher"). The queue
    // worker reads this and wraps the text as `(voicePrompt)text` so VoxCPM
    // uses the inline voice-design path; without it, the reference audio
    // is sent but the voice design is dropped, and VoxCPM produces a
    // different-sounding person.
    voicePrompt: profile.voicePrompt,
    // The literal words the user said in the reference audio. When
    // present together with `referenceAudioBase64`, VoxCPM's python-api
    // backend switches to "prompt continuation" mode (text is sent as-is
    // and `prompt_text` is uploaded alongside `prompt_audio`) which
    // generally gives a stronger clone timbre than the inline-prefix
    // path. The agent-bar recorder writes this when the user records a
    // voice with reference text, so always forward it.
    promptText: effectivePromptText || undefined,
  };
}

export function ClassroomTtsEditor() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const currentScene = useStageStore((s) => s.getCurrentScene());
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsProviderConfig = useSettingsStore((s) => s.ttsProvidersConfig?.[ttsProviderId]);
  // ASR config used as a fallback for the auto-fill of `promptText` when a
  // clone profile was recorded without "参考音频对应文本". See
  // transcribeReferenceAudio() in this file for the rationale. We only
  // forward providerId/modelId/apiKey/baseUrl (everything the
  // /api/transcription route actually consumes) — `language` defaults to
  // 'auto' on the server when omitted, so we let the server pick.
  const asrProviderId = useSettingsStore((s) => s.asrProviderId);
  const asrProviderConfig = useSettingsStore((s) => s.asrProvidersConfig?.[asrProviderId]);
  const asrLanguage = useSettingsStore((s) => s.asrLanguage);
  const asrConfig = asrProviderId
    ? {
        providerId: asrProviderId,
        modelId: asrProviderConfig?.modelId,
        apiKey: asrProviderConfig?.apiKey,
        baseUrl: asrProviderConfig?.baseUrl,
        language: asrLanguage,
      }
    : null;
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
  //
  // Also auto-play the new take when the audio-player is idle. The user's
  // typical "重新生成" flow is: click regenerate, wait 1-2 min for the
  // worker, then *expect* to hear the new voice. Forcing them to click
  // the preview button again after every regen breaks the flow. The
  // preflight (see regenerate) already cleared the IDB blob and stopped
  // any in-flight audio, so auto-playing now will land on the fresh take
  // and the user immediately hears the new voice — which is the whole
  // point of the regenerate button.
  //
  // We skip auto-play when something else is already playing (a different
  // line, or the main playback engine driving through the scene) to
  // avoid stomping on the user's intent.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ audioId: string }>).detail;
      const audioId = detail?.audioId;
      if (!audioId) return;
      const player = createAudioPlayer();
      const wasIdle = !player.isPlaying() && !player.hasActiveAudio();
      // First, find which (if any) local line matches this audioId and was
      // regenerating. We need this BEFORE we mutate state so the auto-play
      // decision is based on the previous snapshot. Doing the read outside
      // the setLines updater also keeps the updater pure (no setState
      // inside another setState, which React 18 will warn about).
      let autoPlayKey: string | null = null;
      setLines((prev) => {
        let mutated = false;
        const next = { ...prev };
        for (const [key, line] of Object.entries(prev)) {
          if (line.audioId === audioId) {
            next[key] = { ...line, ready: true, regenerating: false };
            mutated = true;
            if (line.regenerating) autoPlayKey = key;
          }
        }
        return mutated ? next : prev;
      });
      if (wasIdle && autoPlayKey) {
        const key = autoPlayKey;
        setPreviewingKey(key);
        void player.play(audioId).catch((playErr) => {
          log.warn('[ClassroomTtsEditor] auto-play after regen failed', playErr);
          setPreviewingKey(null);
        });
        schedulePreviewTimeout(key);
      }
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
      let profile: { referenceAudio?: Blob; voicePrompt?: string; promptText?: string; referenceAudioName?: string; referenceAudioMimeType?: string } | null = null;
      if (line.voice.kind === 'clone') {
        const profileId = line.voice.profileId;
        const hit = profiles.find((p) => p.id === profileId);
        profile = hit
          ? {
              referenceAudio: hit.referenceAudio,
              voicePrompt: hit.voicePrompt,
              promptText: hit.promptText,
              referenceAudioName: hit.referenceAudioName,
              referenceAudioMimeType: hit.referenceAudioMimeType,
            }
          : null;
      }
      let options: Record<string, unknown>;
      try {
        options = await buildProviderOptions(line.voice, profile, asrConfig);
      } catch (err) {
        updateLine(key, {
          error: err instanceof Error ? err.message : String(err),
          regenerating: false,
        });
        return;
      }
      updateLine(key, { regenerating: true, error: null, ready: false });
      // CRITICAL — invalidate the cached old take BEFORE the new take lands.
      // Background TTS takes 1-2 minutes on CPU; if the user clicks the
      // preview button during that window, `player.play(audioId)` resolves
      // the blob from IndexedDB — which still holds the previous (auto) take
      // — and the audio element pins that blob via a blob URL. Even after
      // the worker writes the new clone take and `schedulePendingWait`
      // overwrites the IDB record, the audio element keeps streaming the
      // stale blob because the snapshot is held by reference. The visible
      // symptom: the user clicks "重新生成", waits, hears… the old auto
      // voice, and concludes the clone switch never took. Verified against
      // the 2026-07-24 repro on the "原本 auto 改克隆重新生成" path.
      //
      // Deleting the IDB row first forces the next `play(audioId)` to miss
      // IndexedDB, fall through to `tryRecoverFromServerQueue` /
      // `schedulePendingWait`, and either fetch the new take as soon as it
      // lands on disk or simply wait. We also `player.stop()` so any audio
      // element already pinned to the old blob releases its reference and
      // the queue / ready toast can flow through to the next play attempt.
      try {
        createAudioPlayer().stop();
        // The audio-player module already statically imports `db` from
        // `@/lib/utils/database`, so the Dexie instance is guaranteed to be
        // initialized here too. Drop the cached blob so the next play()
        // either hits the freshly-written on-disk WAV (via
        // tryRecoverFromServerQueue) or polls via schedulePendingWait
        // until the worker finishes — never the stale auto take.
        await db.audioFiles.delete(audioId);
      } catch (preflightErr) {
        // Non-fatal: the worst case is the user keeps hearing the old
        // blob on the in-flight audio element. Log so the operator can
        // see the preflight failed.
        log.warn('[ClassroomTtsEditor] preflight invalidate failed', preflightErr);
      }
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
        //
        // Also clear audioUrl. classroom-media-generation.ts sets BOTH
        // `audioId` and `audioUrl` on the speech action when the orchestrator
        // synthesizes TTS during scene creation. lib/utils/audio-player.ts
        // resolves audio via `play(audioId, audioUrl)` and the URL wins
        // over the IDB lookup, so if we don't drop the URL here, the
        // player keeps streaming the *original* (auto-voice) WAV from the
        // server even after the new clone take is written to IDB. The
        // signature symptom is "originally-auto line switched to clone
        // still sounds like auto on next play" — confirmed in the
        // 2026-07-24 repro.
        const nextActions = actions.map((a) => {
          if (a?.id !== line.actionId || a.type !== 'speech') return a;
          const beforeUrl = (a as { audioUrl?: string }).audioUrl;
          const next = { ...a, audioId } as typeof a;
          delete (next as { audioUrl?: string }).audioUrl;
          if (beforeUrl) {
            // eslint-disable-next-line no-console
            console.log(
              `[ClassroomTtsEditor] regenerate: cleared stale audioUrl on action ${line.actionId} (was ${beforeUrl.slice(0, 80)}…)`,
            );
          }
          return next;
        });
        updateScene(sceneId, { actions: nextActions });
        updateLine(key, { taskId, audioId, regenerating: false });
        // Hand the audioId to the player's pending-wait poller. The
        // background worker will eventually write the regenerated WAV to
        // `/audio-cache/<audioId>.wav`; without this, the play() path would
        // short-circuit on the old blob still cached in IndexedDB and the
        // user would keep hearing the previous (wrong-voice) take even
        // though the new file is already on disk. The poller fetches the
        // fresh file as soon as it lands, overwrites the IDB entry, and
        // fires `tts-audio-ready` so this row flips to "已就绪".
        createAudioPlayer().schedulePendingWait(audioId, line.draft);
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

  /**
   * Play the current take for a single line from inside the editor drawer.
   * Mirrors what the main classroom player does, but scoped to one
   * audioId — so the user can immediately verify the cloned voice after
   * a regenerate, without leaving the drawer or letting the rest of the
   * scene play out. Goes through the same audio-player singleton (which
   * hits IndexedDB first, falls back to the on-disk WAV), so any byte
   * difference between the old and new takes shows up audibly here too.
   *
   * Toggle semantics: if the player is already playing THIS line, the
   * click pauses; if it's playing a different line or nothing, the
   * click switches to (or starts) this line. Tracks the active key in
   * `previewingKey` so the LineRow can flip its icon between Volume2
   * and Pause.
   */
  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  // Auto-clear previewingKey when the audio finishes naturally. We can't
  // listen for the audio element's 'ended' event directly (the audio-player
  // is a singleton shared with the main classroom view, and its
  // onEndedCallback is a single function), so we use a timer scheduled
  // at play() time and cancelled on pause / scene change. The 60s ceiling
  // is well past any TTS line and the timer is always cancelled as soon
  // as the user toggles again, so this is a worst-case fallback.
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPreviewTimeout = useCallback(() => {
    if (previewTimeoutRef.current !== null) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => {
    // Scene / drawer swap => any in-flight preview belongs to the
    // previous context. Reset.
    setPreviewingKey(null);
    clearPreviewTimeout();
  }, [sceneId, sceneOrder, clearPreviewTimeout]);
  useEffect(() => () => clearPreviewTimeout(), [clearPreviewTimeout]);
  const previewLine = useCallback(
    async (key: string) => {
      const line = lines[key];
      if (!line || !sceneId) return;
      const audioId = line.audioId ?? `tts_s${sceneOrder}_${line.actionId}`;
      // Diagnostic — surfaces the resolved audioId in the browser console
      // so we can correlate the preview click with the IDB record and the
      // on-disk WAV. The user's earlier "still hears auto after
      // regenerate" symptom was traced to a stale audioUrl winning over
      // this exact IDB lookup, so logging it makes the resolution path
      // explicit.
      // eslint-disable-next-line no-console
      console.log(
        `[ClassroomTtsEditor] preview ${key}: audioId=${audioId} (line.audioId=${line.audioId ?? 'unset'})`,
      );
      const player = createAudioPlayer();
      try {
        // Same audioId already loaded and actively playing -> pause it.
        // Same audioId loaded but paused -> resume.
        // Different audioId (or nothing loaded) -> play fresh.
        const currentId = player.getCurrentAudioId();
        // eslint-disable-next-line no-console
        console.log(
          `[ClassroomTtsEditor] preview ${key}: branch-decide currentId=${currentId ?? 'null'} audioId=${audioId} isPlaying=${player.isPlaying()}`,
        );
        if (currentId === audioId) {
          if (player.isPlaying()) {
            // eslint-disable-next-line no-console
            console.log(`[ClassroomTtsEditor] preview ${key}: -> pause()`);
            player.pause();
            setPreviewingKey(null);
            clearPreviewTimeout();
          } else {
            // eslint-disable-next-line no-console
            console.log(`[ClassroomTtsEditor] preview ${key}: -> resume()`);
            await player.resume();
            setPreviewingKey(key);
            schedulePreviewTimeout(key);
          }
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[ClassroomTtsEditor] preview ${key}: -> play(audioId) (fresh)`,
          );
          // Starting a fresh play stops any in-flight audio (the
          // singleton's play() calls stopAudioElement() internally), so
          // the previously-previewing line, if any, is no longer
          // playing — clear its key too.
          const ok = await player.play(audioId);
          if (!ok) {
            updateLine(key, {
              error: '没有可播放的音频（先生成 / 等队列写盘）',
            });
            setPreviewingKey(null);
            clearPreviewTimeout();
          } else {
            updateLine(key, { error: null });
            setPreviewingKey(key);
            schedulePreviewTimeout(key);
          }
        }
      } catch (err) {
        log.warn('[ClassroomTtsEditor] preview failed', err);
        updateLine(key, {
          error: err instanceof Error ? err.message : String(err),
        });
        setPreviewingKey(null);
        clearPreviewTimeout();
      }
    },
    [lines, sceneId, sceneOrder, updateLine, clearPreviewTimeout],
  );
  const schedulePreviewTimeout = useCallback((key: string) => {
    clearPreviewTimeout();
    previewTimeoutRef.current = setTimeout(() => {
      // Only clear if the key still matches — user might have started
      // a different preview in the meantime (already handled by the
      // fresh-play branch above, but this guards against races).
      setPreviewingKey((cur) => (cur === key ? null : cur));
      previewTimeoutRef.current = null;
    }, 60_000);
  }, [clearPreviewTimeout]);

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

          <div className="flex-1 overflow-y-auto px-3 pb-[220px] pt-3">
            {/* pb-[220px] leaves clearance for the FixMissingTts widget
                (fixed bottom-4 right-4, roughly 180-200px tall). Without
                it, the last speech action gets visually clipped by the
                widget. 220px is a safe upper bound — when no missing
                TTS, the widget is hidden and the padding is just dead
                space at the bottom of the scroll area. */}
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
                      isPreviewing={previewingKey === key}
                      onTextChange={(text) => updateLine(key, { draft: text })}
                      onCommit={() => commitText(key, line.draft)}
                      onVoiceChange={(voice) => updateLine(key, { voice })}
                      onRegenerate={() => void regenerate(key)}
                      onPreview={() => void previewLine(key)}
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
  /** True when the audio-player is currently playing this row's take
   *  (and the click would therefore pause rather than start fresh). */
  isPreviewing: boolean;
  onTextChange: (text: string) => void;
  onCommit: () => void;
  onVoiceChange: (voice: VoiceChoice) => void;
  onRegenerate: () => void;
  onPreview: () => void;
}

function LineRow({
  line,
  profiles,
  profilesLoading,
  isPreviewing,
  onTextChange,
  onCommit,
  onVoiceChange,
  onRegenerate,
  onPreview,
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
        {/* Per-line "试听" / pause toggle — when `isPreviewing` is true the
            row is currently playing through the audio-player singleton, so
            the click pauses and the icon flips to a Pause glyph. Disabled
            when the line is mid-regenerate (no committed audio yet) or has
            no audioId. */}
        <button
          type="button"
          onClick={onPreview}
          disabled={!line.audioId || line.regenerating}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-md border px-1.5 py-1 transition-colors disabled:opacity-40',
            isPreviewing
              ? 'border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-200'
              : 'border-sky-300 bg-sky-100 text-sky-800 hover:bg-sky-200 dark:border-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
          )}
          title={
            !line.audioId
              ? '还没有可播放的音频（先重新生成）'
              : line.regenerating
                ? '生成中，无法试听'
                : isPreviewing
                  ? '暂停这一行 TTS'
                  : '只播放这一行 TTS（用于核对克隆音色）'
          }
          aria-label={isPreviewing ? '暂停这一行' : '试听这一行'}
        >
          {isPreviewing ? <Pause className="size-3" /> : <Volume2 className="size-3" />}
        </button>
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
