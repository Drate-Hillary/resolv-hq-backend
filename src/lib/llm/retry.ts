// Exponential backoff for a single provider's call, used inside gateway.ts
// before it gives up on that provider and falls through to the next one.
// Only retries errors that are plausibly transient (rate limits, timeouts,
// 5xx) — anything else (bad API key, invalid request) fails immediately
// since retrying it would never succeed.
export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = { attempts: 3, baseDelayMs: 500 };

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  if (err instanceof Error && /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(err.message)) return true;
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === opts.attempts - 1;
      if (!isRetryable(err) || isLastAttempt) throw err;
      await wait(opts.baseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
