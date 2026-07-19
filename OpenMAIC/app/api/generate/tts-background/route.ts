/**
 * Server-side persistent TTS queue API.
 *
 * POST /api/generate/tts-background
 *   Enqueues a TTS job. Returns immediately with `{ taskId }` so the caller
 *   (typically a client hook firing during scene generation) can move on.
 *   The actual VoxCPM synthesis happens on the Next.js server process and
 *   survives the client tab being closed.
 *
 *   On completion the synthesized audio is written to
 *   `public/audio-cache/<taskId>.wav` and served as a static file by
 *   Next.js (so the classroom can play it via a simple GET).
 *
 * GET /api/generate/tts-background?id=<taskId>
 *   Returns the current status of a task:
 *     { id, status: 'pending'|'processing'|'completed'|'failed', audioPath?, error? }
 *   When `status === 'completed'`, `audioPath` is the URL to fetch the
 *   finished WAV from.
 */

import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { enqueueTTS, getTTSTask, listTTSTasks, type TTSTaskInput } from '@/lib/server/tts-queue';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import type { TTSProviderId } from '@/lib/audio/types';

// Re-use the long ceiling we set on the synchronous route. The queue worker
// runs on the server process and is not subject to the route handler's
// 60-min cap, but the ceiling here is a defensive guard in case someone
// ever POSTs and then awaits a stream.
export const maxDuration = 3600;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      text: string;
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsModelId?: string;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsProviderOptions?: Record<string, unknown>;
    };

    const {
      text,
      audioId,
      ttsProviderId,
      ttsModelId,
      ttsVoice,
      ttsSpeed,
      ttsApiKey,
      ttsBaseUrl,
      ttsProviderOptions,
    } = body;

    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
      );
    }

    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    if (isServerTTSProviderDisabled(ttsProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
    }

    // Apply the same VoxCPM backend override as the synchronous route so
    // client store defaults don't get routed to the wrong endpoint.
    let resolvedOptions = ttsProviderOptions;
    if (ttsProviderId === VOXCPM_TTS_PROVIDER_ID) {
      const envBackend = process.env.TTS_VOXCPM_BACKEND?.trim() || '';
      if (envBackend) {
        resolvedOptions = {
          ...(ttsProviderOptions || {}),
          backend: envBackend,
        };
      }
    }

    const managed = isServerConfiguredProvider('tts', ttsProviderId);
    const apiKey = resolveTTSApiKey(ttsProviderId, managed ? undefined : ttsApiKey || undefined);
    const baseUrl = resolveTTSBaseUrl(
      ttsProviderId,
      managed ? undefined : ttsBaseUrl || undefined,
    );
    const modelId = resolveTTSModel(ttsProviderId, ttsModelId);

    const input: TTSTaskInput = {
      audioId,
      text,
      ttsProviderId,
      ttsModelId: modelId,
      ttsVoice,
      ttsSpeed: ttsSpeed ?? 1.0,
      ttsApiKey: apiKey,
      ttsBaseUrl: baseUrl,
      ttsProviderOptions: resolvedOptions,
    };

    const taskId = await enqueueTTS(input);
    return apiSuccess({ taskId, audioId });
  } catch (err) {
    return apiError(
      'ENQUEUE_FAILED',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const task = getTTSTask(id);
    if (!task) {
      return apiError('NOT_FOUND', 404, `No TTS task with id ${id}`);
    }
    return apiSuccess({
      id: task.id,
      status: task.status,
      audioPath: task.audioPath,
      bytes: task.bytes,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    });
  }
  // No id: list a small summary so dev can confirm what's queued.
  const all = listTTSTasks();
  return apiSuccess({
    count: all.length,
    pending: all.filter((t) => t.status === 'pending' || t.status === 'processing').length,
    completed: all.filter((t) => t.status === 'completed').length,
    failed: all.filter((t) => t.status === 'failed').length,
  });
}
