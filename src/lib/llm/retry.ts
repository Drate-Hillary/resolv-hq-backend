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

/** Out of credit or quota: retrying within a request cannot help, so fail over at once. */
export function isExhaustedError(err: unknown): boolean {
  const code = (err as { code?: string; error?: { code?: string } } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "insufficient_quota" ||
    code === "credit_balance_exhausted" ||
    /no credits|credit balance|insufficient[_ ]quota|billing|resource_exhausted|exceeded your current quota/i.test(message)
  );
}

function isRetryable(err: unknown): boolean {
  if (isExhaustedError(err)) return false;
  // A call that already waited out the full timeout would only wait again; move to the next provider.
  if (err instanceof Error && err.name === "TimeoutError") return false;
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
