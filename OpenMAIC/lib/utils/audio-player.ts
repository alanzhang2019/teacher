/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 *
 */

import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('AudioPlayer');

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private requestToken: number = 0;

  private stopAudioElement(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
  }

  /**
   * The audioId of the audio currently loaded in `this.audio`. Lets callers
   * (e.g. the per-line preview button in ClassroomTtsEditor) tell whether
   * the player is already playing the audio they want, so they can toggle
   * pause/resume instead of starting a fresh playback each click. Reset
   * to `null` whenever the underlying audio element is replaced or
   * explicitly stopped.
   */
  private currentAudioId: string | null = null;

  /** Returns the audioId of the audio currently loaded for playback, or
   *  null if no audio is loaded. */
  public getCurrentAudioId(): string | null {
    return this.currentAudioId;
  }

  /**
   * Play audio (from URL or IndexedDB pre-generated cache)
   * @param audioId Audio ID
   * @param audioUrl Optional server-generated audio URL (takes priority over IndexedDB)
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string, audioUrl?: string): Promise<boolean> {
    const requestToken = ++this.requestToken;
    try {
      this.currentAudioId = audioId;
      // 1. Try audioUrl first (server-generated TTS)
      if (audioUrl) {
        this.stopAudioElement();
        if (requestToken !== this.requestToken) return false;
        this.audio = new Audio();
        this.audio.src = audioUrl;
        if (this.muted) this.audio.volume = 0;
        else this.audio.volume = this.volume;
        this.audio.defaultPlaybackRate = this.playbackRate;
        this.audio.playbackRate = this.playbackRate;
        this.audio.addEventListener('ended', () => {
          this.onEndedCallback?.();
        });
        await this.audio.play();
        if (requestToken !== this.requestToken) return false;
        this.audio.playbackRate = this.playbackRate;
        return true;
      }

      // 2. Fall back to IndexedDB (client-generated TTS)
      const audioRecord = await db.audioFiles.get(audioId);
      if (requestToken !== this.requestToken) return false;

      if (!audioRecord) {
        // 3. Last resort: the server-side TTS queue may have already finished
        // this audio while the client was offline (tab closed, etc.). The
        // queue stores completed audio under /audio-cache/<audioId>.wav and
        // is reachable via the status endpoint. Probe it once; if the audio
        // is there, fetch and cache it in IndexedDB for next time, then play.
        //
        // If that probe also misses, hand off to schedulePendingWait(): the
        // server may still be synthesizing this audioId and the file will
        // land on disk in the next few minutes. We fire-and-forget a poll
        // and dispatch a `tts-audio-ready` window event the moment the file
        // shows up, so the classroom UI can surface a "ready" toast without
        // a hard refresh.
        const recovered = await this.tryRecoverFromServerQueue(audioId);
        if (!recovered) {
          this.schedulePendingWait(audioId);
          // No pre-generated audio available anywhere; skip silently.
          return false;
        }
        // Use the freshly-stored record for playback.
        const stored = await db.audioFiles.get(audioId);
        if (!stored || requestToken !== this.requestToken) return false;
        this.stopAudioElement();
        if (requestToken !== this.requestToken) return false;
        this.audio = new Audio();
        this.audio.src = URL.createObjectURL(stored.blob);
        this.audio.playbackRate = this.playbackRate;
        if (this.muted) this.audio.muted = true;
        if (this.volume !== 1) this.audio.volume = this.volume;
        if (this.onEndedCallback) this.audio.onended = this.onEndedCallback;
        await this.audio.play();
        if (requestToken !== this.requestToken) return false;
        return true;
      }

      // Stop current playback
      this.stopAudioElement();
      if (requestToken !== this.requestToken) return false;

      // Create audio element
      this.audio = new Audio();

      // Set audio source
      const blobUrl = URL.createObjectURL(audioRecord.blob);
      this.audio.src = blobUrl;
      if (this.muted) this.audio.volume = 0;
      else this.audio.volume = this.volume;

      // Apply playback rate
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;

      // Set ended callback
      this.audio.addEventListener('ended', () => {
        URL.revokeObjectURL(blobUrl);
        this.currentAudioId = null;
        this.onEndedCallback?.();
      });

      // Play. If play() rejects (autoplay policy, decode error, interrupted
      // load) the 'ended' listener never fires, so revoke the blob URL here to
      // avoid leaking it for the lifetime of the document.
      try {
        await this.audio.play();
      } catch (playError) {
        URL.revokeObjectURL(blobUrl);
        throw playError;
      }
      if (requestToken !== this.requestToken) {
        URL.revokeObjectURL(blobUrl);
        return false;
      }
      // Re-apply after play() — some browsers reset during load
      this.audio.playbackRate = this.playbackRate;
      return true;
    } catch (error) {
      log.error('Failed to play audio:', error);
      throw error;
    }
  }

  /**
   * Audio IDs we've already been asked to play but which had no audio on
   * disk yet. We poll `/audio-cache/<id>.wav` in the background and fire
   * a `tts-audio-ready` window event the moment one shows up, so the
   * classroom UI can surface "audio ready — click to play" without
   * forcing the user to refresh the page.
   */
  private readonly pendingWaits: Map<string, { timer: ReturnType<typeof setTimeout>; text?: string } > = new Map();

  private static readonly PENDING_POLL_FIRST_MS = 5_000;
  private static readonly PENDING_POLL_INTERVAL_MS = 30_000;
  private static readonly PENDING_POLL_MAX_TRIES = 60; // ~30 min upper bound

  /**
   * Try to pull a missing audio from the server-side TTS queue's on-disk
   * cache and persist it into IndexedDB. Returns true if a playable blob
   * is now in IndexedDB; false otherwise (still being synthesized, or no
   * record at all).
   *
   * The status endpoint is best-effort: if the queue's in-memory state is
   * out of sync (e.g. dev hot-reload reset the worker but VoxCPM is still
   * running on disk), we fall back to probing `/audio-cache/<id>.wav`
   * directly via ranged GET — once the file is on disk it is playable
   * regardless of what the queue says.
   */
  private async tryRecoverFromServerQueue(audioId: string): Promise<boolean> {
    // 1) Probe the cache file directly. If it exists, fetch it and store
    // it in IndexedDB. This is the source of truth — once the .wav is on
    // disk, it doesn't matter what the queue's status field says.
    //
    // Note: we use a ranged GET (bytes=0-0) instead of HEAD because Next.js
    // dev server's static-file handler returns 404 for HEAD on /public/*
    // even when the file exists, while GET works. The 1-byte body tells us
    // the file is there without paying the full audio download cost.
    //
    // CRITICAL: pass `cache: 'no-store'` on every fetch here. The audioId
    // is stable across regenerations (the editor reuses `tts_s<N>_<id>`),
    // so the URL never changes — without this hint, the browser happily
    // hands back the previous take from HTTP cache, the recovery path
    // writes THAT blob into IDB, and the user keeps hearing the old voice
    // even after the queue worker wrote a new WAV to disk.
    try {
      const head = await fetch(`/audio-cache/${encodeURIComponent(audioId)}.wav?_=${Date.now()}`, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
      });
      if (head.ok || head.status === 206) {
        const audioResp = await fetch(`/audio-cache/${encodeURIComponent(audioId)}.wav?_=${Date.now()}`, {
          cache: 'no-store',
        });
        if (audioResp.ok) {
          const bytes = new Uint8Array(await audioResp.arrayBuffer());
          if (bytes.length) {
            const blob = new Blob([bytes], { type: 'audio/wav' });
            await db.audioFiles.put({
              id: audioId,
              blob,
              duration: undefined,
              format: 'wav',
              createdAt: Date.now(),
            });
            log.info(`[AudioPlayer] recovered ${audioId} from /audio-cache/ (${bytes.length} bytes)`);
            this.cancelPendingWait(audioId);
            return true;
          }
        }
      }
    } catch (err) {
      log.warn(`[AudioPlayer] audio-cache probe failed for ${audioId}:`, err);
    }

    // 2) Fallback: ask the queue's status endpoint. If it says "completed"
    // with an audioPath, fetch that. This is useful if the file was ever
    // written under a different name.
    try {
      const statusResp = await fetch(
        `/api/generate/tts-background?id=${encodeURIComponent(audioId)}`,
      );
      if (!statusResp.ok) return false;
      const status = (await statusResp.json()) as {
        success?: boolean;
        status?: string;
        audioPath?: string;
      };
      if (status.status !== 'completed' || !status.audioPath) return false;
      const audioResp = await fetch(status.audioPath);
      if (!audioResp.ok) return false;
      const bytes = new Uint8Array(await audioResp.arrayBuffer());
      if (!bytes.length) return false;
      const fmt = status.audioPath.endsWith('.wav') ? 'wav' : 'bin';
      const blob = new Blob([bytes], { type: `audio/${fmt}` });
      await db.audioFiles.put({
        id: audioId,
        blob,
        duration: undefined,
        format: fmt,
        createdAt: Date.now(),
      });
      log.info(`[AudioPlayer] recovered ${audioId} from server queue (${bytes.length} bytes)`);
      this.cancelPendingWait(audioId);
      return true;
    } catch (err) {
      log.warn(`[AudioPlayer] server-queue recovery failed for ${audioId}:`, err);
      return false;
    }
  }

  /**
   * Background-poll `/audio-cache/<id>.wav` until it shows up (or we hit
   * the timeout). The moment the file is reachable, fetch it into IndexedDB
   * and dispatch a `tts-audio-ready` event on `window` so the classroom UI
   * can show a "ready — click to play" affordance. This keeps the user
   * from having to refresh the page every time a TTS finishes.
   *
   * Safe to call repeatedly: the Map de-dupes by audioId, and
   * cancelPendingWait() runs from the success path to clean up.
   */
  public schedulePendingWait(audioId: string, text?: string): void {
    if (!audioId) return;
    if (this.pendingWaits.has(audioId)) {
      if (text) this.pendingWaits.get(audioId)!.text = text;
      return;
    }
    let tries = 0;
    const tick = async () => {
      if (this.pendingWaits.size === 0) return;
      const entry = this.pendingWaits.get(audioId);
      if (!entry) return;
      tries += 1;
      try {
        // Cache-bust the probe: the editor reuses the same audioId
        // (tts_s<N>_<actionId>) across regenerations, so the URL is
        // identical. Without `cache: 'no-store'` (and the timestamp
        // query param as belt-and-suspenders) the browser would happily
        // return the previous take from its HTTP cache, the pending-wait
        // path would dutifully overwrite IDB with the OLD blob, and the
        // user would keep hearing the previous (wrong-voice) audio even
        // though the queue worker just wrote a fresh WAV to disk.
        const head = await fetch(`/audio-cache/${encodeURIComponent(audioId)}.wav?_=${Date.now()}`, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
        });
        if (head.ok || head.status === 206) {
          // File is on disk. Pull the full blob into IndexedDB so the next
          // play() hits the fast path. Then notify the UI.
          try {
            const audioResp = await fetch(
              `/audio-cache/${encodeURIComponent(audioId)}.wav?_=${Date.now()}`,
              { cache: 'no-store' },
            );
            if (audioResp.ok) {
              const bytes = new Uint8Array(await audioResp.arrayBuffer());
              if (bytes.length) {
                // Compare against the previously-cached IDB record so the
                // operator can see in the dev console whether the new take
                // is byte-for-byte identical to the previous one (model
                // produced the same output — usually a voice-prompt config
                // issue) or genuinely different (cache-stale fix worked).
                let previousBytes: number | null = null;
                try {
                  const existing = await db.audioFiles.get(audioId);
                  previousBytes = existing?.blob?.size ?? null;
                } catch {
                  // IDB read failure is non-fatal — log the bytes anyway.
                }
                const blob = new Blob([bytes], { type: 'audio/wav' });
                await db.audioFiles.put({
                  id: audioId,
                  blob,
                  duration: undefined,
                  format: 'wav',
                  createdAt: Date.now(),
                });
                log.info(
                  `[AudioPlayer] pending-wait resolved: ${audioId} ` +
                    `(new=${bytes.length} bytes, prev=${previousBytes ?? 'none'}, tried ${tries}x)`,
                );
                this.cancelPendingWait(audioId);
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(
                    new CustomEvent('tts-audio-ready', {
                      detail: { audioId, bytes: bytes.length, text: entry.text },
                    }),
                  );
                }
                return;
              }
            }
          } catch (innerErr) {
            log.warn(
              `[AudioPlayer] pending-wait fetch failed for ${audioId}:`,
              innerErr,
            );
          }
        }
      } catch (err) {
        log.warn(`[AudioPlayer] pending-wait probe failed for ${audioId}:`, err);
      }
      if (tries >= AudioPlayer.PENDING_POLL_MAX_TRIES) {
        log.warn(
          `[AudioPlayer] pending-wait giving up on ${audioId} after ${tries} tries`,
        );
        this.cancelPendingWait(audioId);
        return;
      }
      const timer = setTimeout(() => {
        void tick();
      }, AudioPlayer.PENDING_POLL_INTERVAL_MS);
      this.pendingWaits.set(audioId, { timer, text: entry.text });
    };
    const timer = setTimeout(() => {
      void tick();
    }, AudioPlayer.PENDING_POLL_FIRST_MS);
    this.pendingWaits.set(audioId, { timer, text });
    log.info(
      `[AudioPlayer] pending-wait scheduled for ${audioId} (first poll in ${AudioPlayer.PENDING_POLL_FIRST_MS}ms)`,
    );
  }

  private cancelPendingWait(audioId: string): void {
    const entry = this.pendingWaits.get(audioId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingWaits.delete(audioId);
  }

  /**
   * Cancel all background polls. Called on `destroy()` so the page can
   * tear down without leaving dangling timers.
   */
  public cancelAllPendingWaits(): void {
    for (const audioId of Array.from(this.pendingWaits.keys())) {
      this.cancelPendingWait(audioId);
    }
  }

  /**
   * Pause playback
   */
  public pause(): void {
    this.requestToken += 1;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    this.requestToken += 1;
    this.stopAudioElement();
    this.currentAudioId = null;
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.cancelAllPendingWaits();
    this.stop();
    this.onEndedCallback = null;
  }
}

/**
 * Audio-player factory.
 *
 * Singleton by design. The classroom page (PlaybackChromeRoot) and the
 * per-line preview button in ClassroomTtsEditor both call createAudioPlayer()
 * freely — without a shared instance, each call would return a fresh
 * `AudioPlayer` whose `currentAudioId` is `null`, and the preview toggle
 * could never reach the `pause()` branch (the precondition `currentId ===
 * audioId` would never hold, so every click would route to the "fresh
 * play" branch and the audio would keep restarting instead of pausing).
 *
 * PlaybackChromeRoot wraps the call in `useRef(createAudioPlayer())` —
 * that pattern still works with a singleton (the ref just keeps a stable
 * reference to the same shared instance) and avoids the React 18 strict
 * mode double-invocation cost of running the constructor twice.
 */
let _singleton: AudioPlayer | null = null;
export function createAudioPlayer(): AudioPlayer {
  if (!_singleton) _singleton = new AudioPlayer();
  return _singleton;
}
