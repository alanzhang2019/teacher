/**
 * Dev-only admin endpoint to reset the TTS queue for fast re-enqueueing.
 *
 * POST /api/dev/reset-fast
 * Body:
 *   {
 *     "action": "cancel-all",
 *     "cancelledTaskIds": string[]   // optional: explicit ids; if omitted,
 *                                   // cancels every non-terminal task
 *   }
 *   — or —
 *   {
 *     "action": "enqueue-fast-batch",
 *     "tasks": Array<{
 *       audioId: string,
 *       text: string,
 *       ttsProviderId: string,
 *       ttsModelId?: string,
 *       ttsVoice: string,
 *       ttsApiKey?: string,
 *       ttsBaseUrl?: string,
 *       ttsProviderOptions?: Record<string, unknown>,
 *     }>
 *   }
 *
 * The "fast" flag forces 10 inference steps, no denoise, no reference
 * audio / prompt on the worker. Trade the clone timbre for a 30x speedup
 * on CPU (60-120s per inference instead of 26-50 min).
 *
 * Idempotent: enqueuing a task with the same audioId replaces any
 * existing pending task for that id. Use action: "enqueue-fast-batch"
 * after a "cancel-all" to clear a slow queue and start over.
 */
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  cancelAllPendingTTS,
  cancelTTSTask,
  enqueueTTSFast,
  listTTSTasks,
  type TTSTaskInput,
} from '@/lib/server/tts-queue';

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    cancelledTaskIds?: string[];
    tasks?: TTSTaskInput[];
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'JSON body required');
  }

  const { action } = body;
  if (action === 'cancel-all') {
    const cancelled = await cancelAllPendingTTS();
    return apiSuccess({ cancelled });
  }
  if (action === 'cancel-one') {
    if (!body.cancelledTaskIds?.length) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'cancelledTaskIds required');
    }
    let n = 0;
    for (const id of body.cancelledTaskIds) {
      if (await cancelTTSTask(id)) n += 1;
    }
    return apiSuccess({ cancelled: n });
  }
  if (action === 'enqueue-fast-batch') {
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'tasks array required');
    }
    const taskIds: string[] = [];
    for (const t of body.tasks) {
      if (!t.audioId || !t.text || !t.ttsProviderId || !t.ttsVoice) {
        return apiError(
          'MISSING_REQUIRED_FIELD',
          400,
          'each task needs audioId, text, ttsProviderId, ttsVoice',
        );
      }
      // Strip `fast` from client-supplied input — only this admin path may
      // set it, and we set it ourselves in enqueueTTSFast.
      const { fast: _ignored, ...rest } = t as TTSTaskInput & { fast?: boolean };
      const id = await enqueueTTSFast(rest);
      taskIds.push(id);
    }
    return apiSuccess({ enqueued: taskIds.length, taskIds });
  }
  if (action === 'list') {
    return apiSuccess({
      total: listTTSTasks().length,
      // ...and a small per-status breakdown so the UI can show progress
      // without having to import the queue module.
      pending: listTTSTasks().filter((t) => t.status === 'pending').length,
      processing: listTTSTasks().filter((t) => t.status === 'processing').length,
      completed: listTTSTasks().filter((t) => t.status === 'completed').length,
      failed: listTTSTasks().filter((t) => t.status === 'failed').length,
      cancelled: listTTSTasks().filter((t) => t.status === 'cancelled').length,
    });
  }
  return apiError('INVALID_REQUEST', 400, `unknown action: ${action ?? '<none>'}`);
}
