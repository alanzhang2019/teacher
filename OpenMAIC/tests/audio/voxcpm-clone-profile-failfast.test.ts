/**
 * Verify getVoxCPMProviderOptions fails fast (throws) when a clone voice
 * profile exists in IndexedDB but its reference audio blob is missing.
 *
 * The previous behavior was to silently fall back to voiceMode: 'prompt',
 * which produced a completely different-sounding voice — the "TTS 突然换了个人"
 * bug. Loud error is the only correct behavior here: the caller can then
 * log it and skip the TTS turn, and the user gets a clear signal to
 * re-record the voice in AgentBar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const voiceProfilesGet = vi.fn();
vi.mock('@/lib/utils/database', () => ({
  db: { voiceProfiles: { get: voiceProfilesGet } },
}));

import { getVoxCPMProviderOptions } from '@/lib/audio/voxcpm-voices';
import { getVoxCPMProfileVoiceId } from '@/lib/audio/voxcpm';

describe('getVoxCPMProviderOptions — clone profile integrity', () => {
  beforeEach(() => {
    voiceProfilesGet.mockReset();
  });

  it('returns clone options with referenceAudioBase64 when both profile and audio blob exist', async () => {
    const profileId = 'clone-ok';
    voiceProfilesGet.mockResolvedValue({
      id: profileId,
      providerId: 'voxcpm-tts',
      kind: 'clone',
      name: 'My Clone',
      voicePrompt: 'a calm female voice',
      promptText: 'hello',
      referenceAudio: new Blob(['fake-audio-bytes'], { type: 'audio/wav' }),
      referenceAudioMimeType: 'audio/wav',
      referenceAudioName: 'my-clone.wav',
    });
    const opts = await getVoxCPMProviderOptions(
      getVoxCPMProfileVoiceId(profileId),
      { persona: 'teacher' },
    );
    expect(opts.voiceMode).toBe('clone');
    expect(typeof opts.referenceAudioBase64).toBe('string');
    // base64 of 'fake-audio-bytes' = 'ZmFrZS1hdWRpby1ieXRlcw=='
    expect(opts.referenceAudioBase64).toBe('ZmFrZS1hdWRpby1ieXRlcw==');
    expect(opts.referenceAudioMimeType).toBe('audio/wav');
    expect(opts.referenceAudioName).toBe('my-clone.wav');
    expect(opts.promptText).toBe('hello');
  });

  it('THROWS when clone profile exists but referenceAudio is missing (the bug fix)', async () => {
    const profileId = 'clone-broken';
    voiceProfilesGet.mockResolvedValue({
      id: profileId,
      providerId: 'voxcpm-tts',
      kind: 'clone',
      name: 'Broken Clone',
      voicePrompt: 'a calm voice',
      promptText: 'hello',
      // referenceAudio intentionally missing — simulates the IndexedDB
      // data-loss bug where the profile record survives but the blob is gone.
    });
    await expect(
      getVoxCPMProviderOptions(getVoxCPMProfileVoiceId(profileId), { persona: 'teacher' }),
    ).rejects.toThrow(/missing its reference audio blob/i);
  });

  it('still falls back to auto when the profile does not exist at all', async () => {
    voiceProfilesGet.mockResolvedValue(undefined);
    const opts = await getVoxCPMProviderOptions(
      getVoxCPMProfileVoiceId('nonexistent-id'),
      { persona: 'teacher' },
    );
    expect(opts.voiceMode).toBe('auto');
    expect(opts.voicePrompt).toBeTruthy();
  });

  it('returns prompt-mode for prompt-only profiles (no reference audio expected)', async () => {
    const profileId = 'prompt-only';
    voiceProfilesGet.mockResolvedValue({
      id: profileId,
      providerId: 'voxcpm-tts',
      kind: 'prompt',
      name: 'Calm',
      voicePrompt: 'a calm, clear voice',
    });
    const opts = await getVoxCPMProviderOptions(
      getVoxCPMProfileVoiceId(profileId),
      { persona: 'teacher' },
    );
    expect(opts.voiceMode).toBe('prompt');
    expect(opts.voicePrompt).toBe('a calm, clear voice');
    expect(opts.referenceAudioBase64).toBeUndefined();
  });
});
