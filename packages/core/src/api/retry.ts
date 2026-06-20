export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  shouldRetry(error: unknown, attempt: number): boolean;
}

export async function withRetry<T>(
  action: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? (async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !options.shouldRetry(error, attempt)) {
        throw error;
      }
      await sleep((options.baseDelayMs ?? 100) * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
