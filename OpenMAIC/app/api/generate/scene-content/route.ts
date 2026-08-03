/**
 * Scene Content Generation API (SSE)
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 *
 * Implemented as Server-Sent Events (matching `scene-actions` and
 * `scene-outlines-stream`) so the LLM response can be arbitrarily long
 * without hitting a hard per-call timeout. The route keeps the connection
 * alive (heartbeat) and aborts the upstream LLM call the moment the client
 * disconnects or no chunks arrive for the stall window.
 *
 * SSE events emitted:
 *   { type: 'progress', length: number }
 *   { type: 'result', content, effectiveOutline }
 *   { type: 'error', errorCode: string, error: string, statusCode: number }
 */

import { NextRequest } from 'next/server';
import { streamLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';

const log = createLogger('Scene Content API');

/**
 * 5-minute ceiling matches `scene-actions`. There is no per-call timeout —
 * instead we detect stalls (no chunks for STALL_TIMEOUT_MS) so a slow model
 * can stream as long as it keeps producing output.
 */
export const maxDuration = 300;

/** No chunk received for this long → abort the upstream LLM call. */
const STALL_TIMEOUT_MS = 240_000;

/** SSE comment cadence to keep proxies / load balancers from closing the socket. */
const HEARTBEAT_INTERVAL_MS = 15_000;

interface SceneContentErrorBody {
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
        pdfImages?: PdfImage[];
        imageMapping?: ImageMapping;
        stageInfo: { name: string; description?: string; style?: string };
        stageId: string;
        agents?: AgentInfo[];
        languageDirective?: string;
        requirements?: UserRequirements;
      }
    | undefined;

  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_JSON', 400, 'Request body must be valid JSON');
  }

  const {
    outline: rawOutline,
    allOutlines,
    pdfImages,
    imageMapping,
    stageInfo: _stageInfo,
    stageId,
    agents,
    languageDirective,
    requirements,
  } = body;

  // Validate required fields
  if (!rawOutline) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
  }
  if (!allOutlines || allOutlines.length === 0) {
    return apiError(
      'MISSING_REQUIRED_FIELD',
      400,
      'allOutlines is required and must not be empty',
    );
  }
  if (!stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  }

  const outline: SceneOutline = { ...rawOutline };
  outlineTitle = rawOutline?.title;

  // Model resolution (sync, fails fast with 4xx for bad config)
  let modelResolution: Awaited<ReturnType<typeof resolveModelFromRequest>>;
  try {
    const stage = outline.type ? (`scene-content:${outline.type}` as const) : 'scene-content';
    modelResolution = await resolveModelFromRequest(req, body, stage);
  } catch (error) {
    log.error(
      `Scene content model resolution failed [scene="${outlineTitle}"]`,
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

      // ── Stall detection ──
      const abortController = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          log.warn(
            `Scene content stall (no chunks for ${STALL_TIMEOUT_MS / 1000}s) — aborting upstream`,
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

      // ── Client disconnect ──
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

        // ── Streaming LLM call ──
        const aiCall = async (
          systemPrompt: string,
          userPrompt: string,
          images?: Array<{ id: string; src: string }>,
        ): Promise<string> => {
          const baseParams = {
            model: languageModel,
            system: systemPrompt,
            maxOutputTokens: modelInfo?.outputWindow,
            // AI SDK built-in retry DISABLED. The previous `maxRetries: 2`
            // burned quota on rate-limit errors (TPM/TPD) that don't reset
            // within a single generation — generating 8 scenes × 3 attempts
            // = 24 wasted calls when the provider 429s on attempt 5.
            // Transient network/5xx errors are rare enough that surfacing
            // them immediately to the user (who can click Retry) is cheaper
            // than re-trying automatically. The SSE stall detector (240s no
            // chunk → abort) still handles true stuck connections.
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
            'scene-content',
            thinkingConfig,
          ).textStream;

          let fullText = '';
          for await (const chunk of textStream) {
            if (req.signal?.aborted || abortController.signal.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            fullText += chunk;
            armStallTimer();
            send({ type: 'progress', length: fullText.length });
          }
          disarmStallTimer();
          return fullText;
        };

        // ── Apply fallbacks ──
        const vocationalActive = resolveVocationalActive(requirements);
        const effectiveOutline = applyOutlineFallbacks(outline, !!languageModel, {
          allowProceduralSkill: vocationalActive,
        });

        // ── Filter images assigned to this outline ──
        let assignedImages: PdfImage[] | undefined;
        if (
          pdfImages &&
          pdfImages.length > 0 &&
          effectiveOutline.suggestedImageIds &&
          effectiveOutline.suggestedImageIds.length > 0
        ) {
          const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
          assignedImages = sortDocumentImagesForVision(
            pdfImages.filter((img) => suggestedIds.has(img.id)),
          );
        }

        // Media generation is handled client-side in parallel.
        const generatedMediaMapping: ImageMapping = {};

        log.info(
          `Generating content (SSE): "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
        );

        const userLocale = req.headers?.get('x-user-locale') ?? '';

        const content = await generateSceneContent(effectiveOutline, aiCall, {
          assignedImages,
          imageMapping,
          languageModel: effectiveOutline.type === 'pbl' ? languageModel : undefined,
          visionEnabled: hasVision,
          generatedMediaMapping,
          agents,
          languageDirective,
          thinkingConfig,
          targetLanguage: userLocale || undefined,
          userRequirements: requirements,
          allowProceduralSkill: vocationalActive,
        });

        if (req.signal?.aborted) {
          stopHeartbeat();
          return;
        }

        if (!content) {
          log.error(`Failed to generate content for: "${effectiveOutline.title}"`);
          send({
            type: 'error',
            errorCode: 'GENERATION_FAILED',
            error: `Failed to generate content: ${effectiveOutline.title}`,
            statusCode: 500,
          });
          stopHeartbeat();
          controller.close();
          return;
        }

        log.info(`Content generated successfully: "${effectiveOutline.title}"`);

        send({ type: 'result', content, effectiveOutline });
        stopHeartbeat();
        controller.close();
      } catch (error) {
        stopHeartbeat();
        disarmStallTimer();
        req.signal?.removeEventListener('abort', onClientAbort);

        if (req.signal?.aborted) {
          try {
            controller.close();
          } catch {}
          return;
        }

        log.error(
          `Scene content generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
          error,
        );

        const errorResponse = llmApiError(error);
        let errorCode = 'INTERNAL_ERROR';
        let errorMessage = error instanceof Error ? error.message : String(error);
        let statusCode = 500;
        try {
          const errBody = (await errorResponse.json()) as SceneContentErrorBody;
          errorCode = errBody.errorCode || errorCode;
          errorMessage = errBody.error || errBody.details || errorMessage;
          statusCode = errorResponse.status;
        } catch {
          // Fall back to the raw error message.
        }
        send({ type: 'error', errorCode, error: errorMessage, statusCode });
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      // Caller (client) cancelled — start() will see req.signal.aborted.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
