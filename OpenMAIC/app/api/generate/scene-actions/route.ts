/**
 * Scene Actions Generation API (SSE)
 *
 * Generates actions for a scene given its outline and content, then assembles
 * the complete Scene object. This is the second half of the two-step scene
 * generation pipeline.
 *
 * Implemented as Server-Sent Events (matching `scene-outlines-stream`) so the
 * LLM response can be arbitrarily long without hitting a hard per-call
 * timeout. The route keeps the connection alive (heartbeat) and aborts the
 * upstream LLM call the moment the client disconnects or no chunks arrive
 * for the stall window.
 *
 * SSE events emitted:
 *   { type: 'progress', length: number }                 — optional, per chunk
 *   { type: 'result', scene: Scene, previousSpeeches: string[] }
 *   { type: 'error', errorCode: string, error: string, statusCode: number }
 */

import { NextRequest } from 'next/server';
import { streamLLM } from '@/lib/ai/llm';
import {
  generateSceneActions,
  buildCompleteScene,
  buildVisionUserContent,
  type SceneGenerationContext,
  type AgentInfo,
} from '@/lib/generation/generation-pipeline';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

const log = createLogger('Scene Actions API');

/**
 * 5-minute ceiling matches `scene-content`. In dev mode this is effectively
 * unbounded; in production (Vercel Pro) it's the platform limit. There is no
 * per-call timeout — instead we detect stalls (no chunks for STALL_TIMEOUT_MS)
 * so a slow model can stream as long as it keeps producing output.
 */
export const maxDuration = 300;

/**
 * No chunk received for this long → abort the upstream LLM call. Set to
 * 240s (4 min) so models with very long prefill / thinking time (e.g. reasoning
 * models that deliberate before the first token) have headroom. The 5-minute
 * `maxDuration` above remains the absolute backstop.
 */
const STALL_TIMEOUT_MS = 240_000;

/** SSE comment cadence to keep proxies / load balancers from closing the socket. */
const HEARTBEAT_INTERVAL_MS = 15_000;

interface SceneActionsErrorBody {
  errorCode?: string;
  error?: string;
  details?: string;
}

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;

  let body:
    | {
        outline: SceneOutline;
        allOutlines: SceneOutline[];
        content:
          | GeneratedSlideContent
          | GeneratedQuizContent
          | GeneratedInteractiveContent
          | GeneratedPBLContent;
        stageId: string;
        agents?: AgentInfo[];
        previousSpeeches?: string[];
        userProfile?: string;
        languageDirective?: string;
      }
    | undefined;

  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_JSON', 400, 'Request body must be valid JSON');
  }

  const {
    outline,
    allOutlines,
    content,
    stageId,
    agents,
    previousSpeeches: incomingPreviousSpeeches,
    userProfile,
    languageDirective,
  } = body;

  // Validate required fields (sync, return plain JSON error)
  if (!outline) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
  }
  if (!allOutlines || allOutlines.length === 0) {
    return apiError(
      'MISSING_REQUIRED_FIELD',
      400,
      'allOutlines is required and must not be empty',
    );
  }
  if (!content) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'content is required');
  }
  if (!stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  }

  outlineTitle = outline?.title;

  // Resolve model up-front (outside the stream so the route returns 4xx/5xx
  // synchronously for bad config, rather than mid-stream).
  let modelResolution: Awaited<ReturnType<typeof resolveModelFromRequest>>;
  try {
    modelResolution = await resolveModelFromRequest(req, body, 'scene-actions');
  } catch (error) {
    log.error(
      `Scene actions model resolution failed [scene="${outlineTitle}"]`,
      error,
    );
    return llmApiError(error);
  }
  const { model: languageModel, modelInfo, modelString, thinkingConfig } = modelResolution;
  resolvedModelString = modelString;
  const hasVision = !!modelInfo?.capabilities?.vision;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // ── Heartbeat: keep the socket alive past proxy idle timeouts ──
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const startHeartbeat = () => {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            // Controller already closed — stop heartbeating.
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
          }
        }, HEARTBEAT_INTERVAL_MS);
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      // ── Stall detection: if no LLM chunks for STALL_TIMEOUT_MS, abort ──
      const abortController = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          log.warn(
            `Scene actions stall (no chunks for ${STALL_TIMEOUT_MS / 1000}s) — aborting upstream`,
          );
          abortController.abort();
        }, STALL_TIMEOUT_MS);
      };
      const disarmStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      // ── Client disconnect: stop burning tokens for a dead connection ──
      const onClientAbort = () => abortController.abort();
      req.signal?.addEventListener('abort', onClientAbort);

      const send = (event: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Controller closed mid-flight — ignore.
        }
      };

      try {
        startHeartbeat();
        armStallTimer();

        // ── Streaming LLM call. Returns the full assembled text once the
        // stream completes; throws on abort/error. ──
        const aiCall = async (
          systemPrompt: string,
          userPrompt: string,
          images?: Array<{ id: string; src: string }>,
        ): Promise<string> => {
          const baseParams = {
            model: languageModel,
            system: systemPrompt,
            maxOutputTokens: modelInfo?.outputWindow,
            // AI SDK retry disabled — see scene-content/route.ts for the
            // rationale. Rate-limit 429s do not reset within a single
            // generation, so re-trying only burns quota faster.
            maxRetries: 0,
            abortSignal: abortController.signal,
          };
          const streamParams = images?.length && hasVision
            ? {
                ...baseParams,
                messages: [
                  {
                    role: 'user' as const,
                    content: buildVisionUserContent(userPrompt, images),
                  },
                ],
              }
            : {
                ...baseParams,
                prompt: userPrompt,
              };

          const textStream = streamLLM(
            streamParams,
            'scene-actions',
            thinkingConfig,
          ).textStream;

          let fullText = '';
          for await (const chunk of textStream) {
            if (req.signal?.aborted || abortController.signal.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            fullText += chunk;
            armStallTimer(); // chunk arrived → reset stall window
            send({ type: 'progress', length: fullText.length });
          }
          disarmStallTimer();
          return fullText;
        };

        // ── Build cross-scene context ──
        const allTitles = allOutlines.map((o) => o.title);
        const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
        const ctx: SceneGenerationContext = {
          allTitles,
          pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
          totalPages: allOutlines.length,
          previousSpeeches: incomingPreviousSpeeches ?? [],
        };

        log.info(
          `Generating actions (SSE): "${outline.title}" (${outline.type}) [model=${modelString}]`,
        );

        const actions = await generateSceneActions(outline, content, aiCall, {
          ctx,
          agents,
          userProfile,
          languageDirective,
        });

        if (req.signal?.aborted) {
          stopHeartbeat();
          return;
        }

        log.info(`Generated ${actions.length} actions for: "${outline.title}"`);

        const scene = buildCompleteScene(outline, content, actions, stageId);
        if (!scene) {
          log.error(`Failed to build scene: "${outline.title}"`);
          send({
            type: 'error',
            errorCode: 'GENERATION_FAILED',
            error: `Failed to build scene: ${outline.title}`,
            statusCode: 500,
          });
          stopHeartbeat();
          controller.close();
          return;
        }

        const outputPreviousSpeeches = (scene.actions || [])
          .filter((a): a is SpeechAction => a.type === 'speech')
          .map((a) => a.text);

        log.info(
          `Scene assembled successfully: "${outline.title}" — ${scene.actions?.length ?? 0} actions`,
        );

        send({
          type: 'result',
          scene,
          previousSpeeches: outputPreviousSpeeches,
        });
        stopHeartbeat();
        controller.close();
      } catch (error) {
        stopHeartbeat();
        disarmStallTimer();
        req.signal?.removeEventListener('abort', onClientAbort);

        if (req.signal?.aborted) {
          // Client went away — nothing useful to send. Just close.
          try {
            controller.close();
          } catch {}
          return;
        }

        log.error(
          `Scene actions generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
          error,
        );

        // Reuse the central error mapper so the SSE `error` event carries the
        // same errorCode/statusCode a non-streaming response would.
        // llmApiError returns a Response, so we just copy its body fields.
        const errorResponse = llmApiError(error);
        let errorCode = 'INTERNAL_ERROR';
        let errorMessage = error instanceof Error ? error.message : String(error);
        let statusCode = 500;
        try {
          const errBody = (await errorResponse.json()) as SceneActionsErrorBody;
          errorCode = errBody.errorCode || errorCode;
          errorMessage = errBody.error || errBody.details || errorMessage;
          statusCode = errorResponse.status;
        } catch {
          // Fall back to the raw error message if the mapper's body is opaque.
        }
        send({ type: 'error', errorCode, error: errorMessage, statusCode });
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      // Caller (client) cancelled — the start() handler will see
      // req.signal.aborted on the next chunk and bail.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable buffering on proxies that respect this (nginx, etc.).
      'X-Accel-Buffering': 'no',
    },
  });
}
