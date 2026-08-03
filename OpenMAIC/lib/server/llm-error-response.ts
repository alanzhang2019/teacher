import { APICallError, RetryError } from 'ai';
import { apiError } from '@/lib/server/api-response';
import { isAbortError } from '@/lib/generation/generation-retry';

const HTTP_ERROR_MIN = 400;
const HTTP_ERROR_MAX = 599;

/** Shared user-facing message for upstream call timeouts. */
const TIMEOUT_MESSAGE = 'Scene generation timed out. Please try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toHttpErrorStatus(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed >= HTTP_ERROR_MIN && parsed <= HTTP_ERROR_MAX
    ? parsed
    : undefined;
}

function statusFromError(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (!error || seen.has(error)) return undefined;
  seen.add(error);

  if (APICallError.isInstance(error)) {
    return toHttpErrorStatus(error.statusCode);
  }

  if (RetryError.isInstance(error)) {
    return (
      statusFromError(error.lastError, seen) ??
      error.errors
        .map((nested) => statusFromError(nested, seen))
        .find((status): status is number => status !== undefined)
    );
  }

  if (!isRecord(error)) return undefined;

  const status = toHttpErrorStatus(error.statusCode ?? error.status ?? error.status_code);
  if (status !== undefined) return status;

  return statusFromError(error.cause, seen) ?? statusFromError(error.lastError, seen);
}

function messageForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'Upstream authentication or authorization failed.';
  }
  if (status === 404) return 'Upstream endpoint not found.';
  if (status === 429) return 'Upstream rate limit reached. Please try again shortly.';
  if (status >= 500) return 'Upstream model provider is temporarily unavailable. Please try again.';
  return 'Upstream provider rejected the request.';
}

function extractErrorMessage(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!error || seen.has(error)) return undefined;
  seen.add(error);

  if (!isRecord(error)) {
    if (error instanceof Error) {
      const direct = error.message?.trim();
      if (direct) return direct;
    }
    return undefined;
  }

  // Prefer the deepest specific message: a generic wrapper like
  // "Request failed" or "fetch failed" usually wraps a cause that
  // contains the real diagnostic (ECONNREFUSED, DNS error, etc.).
  if (typeof error.cause !== 'undefined') {
    const nested = extractErrorMessage(error.cause, seen);
    if (nested) return nested;
  }
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const msg = extractErrorMessage(nested, seen);
      if (msg) return msg;
    }
  }
  if (typeof error.lastError !== 'undefined') {
    const nested = extractErrorMessage(error.lastError, seen);
    if (nested) return nested;
  }

  if (error instanceof Error) {
    const direct = error.message?.trim();
    if (direct) return direct;
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error.error === 'string' && error.error.trim()) {
    return error.error.trim();
  }
  if (isRecord(error.error) && typeof error.error.message === 'string' && error.error.message.trim()) {
    return error.error.message.trim();
  }

  return undefined;
}

/**
 * Preserve a provider's HTTP semantics for client retry classification without
 * exposing provider response bodies, URLs, or credential-adjacent details.
 *
 * AbortError is treated as a server-side timeout: we map it to HTTP 504 with a
 * dedicated `TIMEOUT` code so the UI can show a friendly "timed out" message
 * instead of the raw "This operation was aborted" string.
 *
 * When no HTTP status can be recovered from the error chain we still surface the
 * underlying message (e.g. "fetch failed", "ECONNREFUSED") so the UI can show
 * a specific cause instead of a generic "please try again".
 */
export function llmApiError(error: unknown) {
  // AbortError → timeout. Check before statusFromError because the AbortError
  // never carries a useful HTTP status.
  if (isAbortError(error)) {
    return apiError('TIMEOUT', 504, TIMEOUT_MESSAGE);
  }

  const status = statusFromError(error);
  if (status === undefined) {
    const detail = extractErrorMessage(error) ?? 'Scene generation failed. Please try again.';
    return apiError('INTERNAL_ERROR', 500, detail);
  }

  return apiError(
    status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
    status,
    messageForStatus(status),
  );
}
