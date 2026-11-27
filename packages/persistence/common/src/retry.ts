import { isPersistenceError } from "./errors.js";

export interface RetryPolicy {
  maxRetryAttempts: number;
  retryBaseDelayMs: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Retries transient database conflicts (`TRANSIENT_CONFLICT`) with bounded backoff.
 * Non-transient persistence errors and business errors are thrown immediately.
 */
export async function executeWithTransientRetry<T>(
  policy: RetryPolicy,
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(0, policy.maxRetryAttempts);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isPersistenceError(error, "TRANSIENT_CONFLICT") || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = policy.retryBaseDelayMs * (attempt + 1);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}
