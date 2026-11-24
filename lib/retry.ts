"use client";

/**
 * Retry policy for "the service is busy" failures.
 *
 * A provider returning 429/5xx, a dropped connection or a timeout is temporary:
 * the work should pause and continue, not end the run. Permanent problems (bad
 * key, no credits, signed out) are reported immediately because retrying can
 * never fix them.
 */

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const PERMANENT_PATTERNS = [
  /insufficient credits/i,
  /invalid api key/i,
  /api key was rejected/i,
  /no ai api key is configured/i,
  /sign in with google/i,
  /not connected/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /empty settings payload/i,
  /supabase is not configured/i,
];

const TRANSIENT_PATTERNS = [
  /temporarily busy/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /overloaded/i,
  /timed out/i,
  /took too long/i,
  /could not reach/i,
  /failed to fetch/i,
  /network ?error/i,
  /rate.?limit/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  /http (408|425|429|500|502|503|504)/i,
];

export function isTransientError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!message) {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" && TRANSIENT_STATUSES.has(status);
  }
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return false;

  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && TRANSIENT_STATUSES.has(status)) return true;

  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryEvent {
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (event: RetryEvent) => void;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Runs `fn`, waiting and trying again when the failure looks temporary.
 * Delay grows exponentially with a little jitter so parallel runs do not
 * hammer the provider in lockstep.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const shouldRetry = options.shouldRetry ?? isTransientError;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts - 1 && shouldRetry(error);
      if (!canRetry) throw error;
      const base = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      // Jitter stays proportional so each wait is still longer than the last.
      const delayMs = base + Math.round(Math.random() * base * 0.25);
      options.onRetry?.({ attempt: attempt + 1, attempts, delayMs, error });
      await pause(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed after retrying.");
}
