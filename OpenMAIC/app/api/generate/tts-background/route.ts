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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  enqueueTTS,
  getTTSTask,
  listTTSTasks,
  renameCachedAudio,
  type TTSTaskInput,
} from '@/lib/server/tts-queue';
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
    if (task) {
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
    // Fallback: in-memory task not found (e.g. dev server restarted after the
    // worker wrote the WAV but before `task.status = 'completed'` was
    // persisted). The audio file on disk is the source of truth for the
    // "is the clip done" question, so promote it to completed and let the
    // client fetch it.
    try {
      const audioPath = `/audio-cache/${id}.wav`;
      const filePath = path.join(process.cwd(), 'public', audioPath);
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        return apiSuccess({
          id,
          status: 'completed',
          audioPath,
          bytes: stat.size,
          createdAt: stat.mtimeMs,
          completedAt: stat.mtimeMs,
        });
      }
    } catch {
      // file truly missing — fall through to 404
    }
    return apiError('NOT_FOUND', 404, `No TTS task with id ${id}`);
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

/**
 * PATCH /api/generate/tts-background
 * Body: { from: string, to: string } — rename `public/audio-cache/<from>.wav`
 * to `public/audio-cache/<to>.wav` so the classroom player (which fetches
 * `/audio-cache/<audioId>.wav` based on the stage's `action.audioId`) can
 * reach a file the legacy code already produced. Used by FixMissingTts after
 * rewriting legacy `tts_<actionId>` audioIds to the canonical
 * `tts_s<sceneOrder>_<actionId>` form.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { from?: string; to?: string };
    const { from, to } = body;
    if (!from || !to) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'from and to are required');
    }
    const result = await renameCachedAudio(from, to);
    if (!result.ok) {
      // 'missing' is not a server fault — surface as 404 to keep the client
      // logic simple; the client will then enqueue a fresh TTS under the new
      // key.
      if (result.reason === 'missing') {
        return apiError('NOT_FOUND', 404, `No cached audio for ${from}.wav`);
      }
      return apiError('INTERNAL_ERROR', 500, result.error ?? 'rename failed');
    }
    return apiSuccess({ from, to, reason: result.reason });
  } catch (err) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      err instanceof Error ? err.message : String(err),
    );
  }
}
