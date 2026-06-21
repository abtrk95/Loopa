/**
 * Bounded retry policy. Every retry path in the engine consults this module, so
 * there is no way to loop forever: attempts are capped, and the backoff is
 * computed deterministically (jitter derived from the attempt number) so tests are
 * stable without real randomness.
 */

export function maxAttempts(maxRetries: number): number {
  return maxRetries + 1; // initial attempt + retries
}

export function canRetry(attempt: number, maxRetries: number): boolean {
  return attempt < maxAttempts(maxRetries);
}

/** Exponential backoff with deterministic jitter, capped. attempt is 1-based. */
export function backoffDelayMs(attempt: number, baseMs: number, jitterMs: number, capMs = 60_000): number {
  if (baseMs <= 0) return 0;
  const exp = baseMs * 2 ** (attempt - 1);
  const jitter = jitterMs > 0 ? (attempt * 2654435761) % (jitterMs + 1) : 0;
  return Math.min(capMs, exp + jitter);
}

/** Abortable sleep. Resolves early (false) if aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    // NOTE: do NOT unref this timer — a backoff is real work and must keep the
    // event loop alive until it elapses.
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        resolve(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
