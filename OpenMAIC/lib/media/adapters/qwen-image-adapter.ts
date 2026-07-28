/**
 * Qwen Image (Alibaba Cloud / DashScope) Image Generation Adapter
 *
 * Primary path: DashScope multimodal generation API (synchronous, no polling needed).
 *   Endpoint: https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *   API docs: https://help.aliyun.com/zh/model-studio/developer-reference/text-to-image
 *
 * Fallback path: OpenAI-compatible `/v1/images/generations` endpoint. Some third-party
 *   platforms that host Qwen-Image (siliconflow, modelers, etc.) only expose an
 *   OpenAI-compatible endpoint, not DashScope. We detect this from the baseUrl
 *   path and switch protocol automatically so the same `qwen-image` provider
 *   can be used in both cases. See `usesOpenAICompatibleEndpoint` for the
 *   heuristic.
 *
 * Supported models (DashScope): qwen-image-max, z-image-turbo
 * Supported models (OpenAI-compat): any vendor-prefixed name like `Qwen/Qwen-Image`.
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { probeAuth } from '../probe-auth';

const DEFAULT_MODEL = 'qwen-image-max';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';

/**
 * Detect whether the configured baseUrl points at an OpenAI-compatible endpoint
 * (e.g. `https://api.siliconflow.cn/v1`) versus a native DashScope endpoint
 * (e.g. `https://dashscope.aliyuncs.com`). The two protocols are incompatible:
 * - DashScope: ${baseUrl}/api/v1/services/aigc/multimodal-generation/generation
 * - OpenAI:    ${baseUrl}/images/generations
 *
 * Heuristic: any baseUrl whose normalized path is `/v1`, `/v1/images`, or
 * `/v1/images/generations` is treated as OpenAI-compatible. This matches how
 * siliconflow, OpenRouter, etc. expose their chat-compatible image endpoints.
 * A bare host or a path containing `/services/aigc/` stays on DashScope.
 *
 * Also normalizes the baseUrl by stripping a trailing `/images/generations`
 * (or any deeper suffix) so the caller can paste either the bare host
 * (`https://api.siliconflow.cn/v1`) or the full endpoint
 * (`https://api.siliconflow.cn/v1/images/generations`) without double-suffixing.
 * Returns `{ openai, baseUrl }` so the caller uses a single normalized URL.
 */
function resolveEndpoint(
  rawBaseUrl: string,
): { openai: boolean; baseUrl: string } {
  const trimmed = (rawBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let openai = false;
  let baseUrl = trimmed;
  try {
    const u = new URL(trimmed);
    const p = u.pathname.replace(/\/+$/, '');
    if (p === '/v1' || p === '/v1/images' || p === '/v1/images/generations') {
      openai = true;
      // Strip the trailing path so we can re-append `/images/generations`
      // uniformly below. The bare host + `/v1` is what we want.
      baseUrl = `${u.protocol}//${u.host}`;
    }
  } catch {
    // not a URL — fall through to DashScope
  }
  return { openai, baseUrl };
}

/**
 * Map our width x height to DashScope size format "WxH".
 * Common sizes: 1024*1024, 1280*720, 1664*928, 1120*1440, etc.
 */
function resolveDashScopeSize(options: ImageGenerationOptions): string {
  const w = options.width || 1024;
  const h = options.height || 576;
  return `${w}*${h}`;
}

/**
 * OpenAI-compat size format: "WxH" (e.g. "1024x576"). Different separator from
 * DashScope (which uses "*").
 */
function resolveOpenAISize(options: ImageGenerationOptions): string {
  const w = options.width || 1024;
  const h = options.height || 576;
  return `${w}x${h}`;
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request. 401/403 means key invalid; other errors mean key is valid.
 */
export async function testQwenImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const { openai, baseUrl } = resolveEndpoint(config.baseUrl);
  if (openai) {
    return probeAuth({
      providerName: 'Qwen Image (OpenAI-compat)',
      request: () =>
        fetch(`${baseUrl}/v1/images/generations`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model || DEFAULT_MODEL,
            prompt: 'test',
            n: 1,
            size: '256x256',
          }),
        }),
    });
  }
  return probeAuth({
    providerName: 'Qwen Image',
    request: () =>
      fetch(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL,
          input: { messages: [{ role: 'user', content: [{ text: '' }] }] },
          parameters: { size: '1*1' },
        }),
      }),
  });
}

export async function generateWithQwenImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const { openai, baseUrl } = resolveEndpoint(config.baseUrl);

  if (openai) {
    // OpenAI-compat path: ${baseUrl}/v1/images/generations
    // Used by siliconflow and other Qwen-Image hosts that only expose an
    // OpenAI-style endpoint. baseUrl is normalized to the bare host so we
    // always re-append `/v1/images/generations` here — works whether the
    // user pasted `https://api.siliconflow.cn` or `https://api.siliconflow.cn/v1`
    // or even `https://api.siliconflow.cn/v1/images/generations`.
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: options.prompt,
        n: 1,
        size: resolveOpenAISize(options),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qwen Image (OpenAI-compat) generation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const imageData = data.data?.[0];
    if (!imageData?.url && !imageData?.b64_json) {
      throw new Error('Qwen Image (OpenAI-compat) returned empty image response');
    }
    return {
      url: imageData.url,
      base64: imageData.b64_json,
      width: options.width || 1024,
      height: options.height || 576,
    };
  }

  // DashScope native path.
  const response = await fetch(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      input: {
        messages: [
          {
            role: 'user',
            content: [
              {
                text: options.prompt,
              },
            ],
          },
        ],
      },
      parameters: {
        negative_prompt: options.negativePrompt || undefined,
        prompt_extend: true,
        watermark: false,
        size: resolveDashScopeSize(options),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qwen Image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // DashScope multimodal generation response format:
  // { output: { choices: [{ message: { content: [{ image: "url" }] } }] } }
  const choices = data.output?.choices;
  if (!choices || choices.length === 0) {
    // Check for error in response
    if (data.code || data.message) {
      throw new Error(`Qwen Image error: ${data.code} - ${data.message}`);
    }
    throw new Error('Qwen Image returned empty response');
  }

  const content = choices[0]?.message?.content;
  const imageContent = content?.find((c: { image?: string }) => c.image);

  if (!imageContent?.image) {
    throw new Error('Qwen Image response missing image URL');
  }

  return {
    url: imageContent.image,
    width: options.width || 1024,
    height: options.height || 576,
  };
}
