export type ExternalBusinessState =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

export type ExternalObservationState = "PENDING" | "TERMINAL" | "UNKNOWN";
export type ObservationFreshness = "FRESH" | "STALE" | "UNKNOWN";

export interface AuthoritativeObservation<T = unknown> {
  subjectIdentity: string;
  businessState: ExternalBusinessState;
  observationState: ExternalObservationState;
  freshness: ObservationFreshness;
  retryable: boolean;
  reasonCode: string;
  observedAt: string;
  payload?: T;
}

export type ConvergenceStatus =
  | "CONVERGED"
  | "TERMINAL_FAILURE"
  | "EXHAUSTED"
  | "IDENTITY_MISMATCH"
  | "OBSERVATION_FAILED";

export interface ConvergenceResult<T = unknown> {
  status: ConvergenceStatus;
  reasonCode: string;
  attempts: number;
  elapsedMs: number;
  lastObservation: AuthoritativeObservation<T> | null;
  history: AuthoritativeObservation<T>[];
}

export interface ConvergenceOptions<T = unknown> {
  expectedSubjectIdentity: string;
  observe(attempt: number): Promise<AuthoritativeObservation<T>>;
  maxAttempts?: number;
  maxElapsedMs?: number;
  retryScheduleMs?: readonly number[];
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class ExternalObservationError extends Error {
  readonly reasonCode: string;
  readonly retryable: boolean;

  constructor(reasonCode: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ExternalObservationError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

const DEFAULT_RETRY_SCHEDULE_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function delayFor(schedule: readonly number[], attempt: number): number {
  if (schedule.length === 0) return 0;
  return schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 0;
}

export async function convergeAuthoritativeState<T = unknown>(
  options: ConvergenceOptions<T>
): Promise<ConvergenceResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const maxElapsedMs = Math.max(0, options.maxElapsedMs ?? 5 * 60_000);
  const retryScheduleMs = options.retryScheduleMs ?? DEFAULT_RETRY_SCHEDULE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const history: AuthoritativeObservation<T>[] = [];
  let lastObservation: AuthoritativeObservation<T> | null = null;

  const result = (
    status: ConvergenceStatus,
    reasonCode: string,
    attempts: number
  ): ConvergenceResult<T> => ({
    status,
    reasonCode,
    attempts,
    elapsedMs: Math.max(0, now() - startedAt),
    lastObservation,
    history
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastObservation = await options.observe(attempt);
      history.push(lastObservation);
    } catch (error) {
      const typed = error instanceof ExternalObservationError ? error : null;
      if (typed === null || !typed.retryable) {
        return result(
          "OBSERVATION_FAILED",
          typed?.reasonCode ?? "OBSERVATION_FAILED",
          attempt
        );
      }
      if (attempt >= maxAttempts) {
        return result("EXHAUSTED", "OBSERVATION_ATTEMPTS_EXHAUSTED", attempt);
      }
      const delay = delayFor(retryScheduleMs, attempt);
      if (now() - startedAt + delay > maxElapsedMs) {
        return result("EXHAUSTED", "OBSERVATION_BUDGET_EXHAUSTED", attempt);
      }
      await sleep(delay);
      continue;
    }

    if (lastObservation.subjectIdentity !== options.expectedSubjectIdentity) {
      return result("IDENTITY_MISMATCH", "SUBJECT_IDENTITY_MISMATCH", attempt);
    }

    if (
      lastObservation.observationState === "TERMINAL" &&
      lastObservation.freshness === "FRESH"
    ) {
      if (lastObservation.businessState === "SUCCEEDED") {
        return result("CONVERGED", lastObservation.reasonCode, attempt);
      }
      if (
        lastObservation.businessState === "FAILED" ||
        lastObservation.businessState === "CANCELLED"
      ) {
        return result("TERMINAL_FAILURE", lastObservation.reasonCode, attempt);
      }
      return result("OBSERVATION_FAILED", "TERMINAL_STATE_INVALID", attempt);
    }

    if (!lastObservation.retryable) {
      return result("EXHAUSTED", "OBSERVATION_NOT_RETRYABLE", attempt);
    }
    if (attempt >= maxAttempts) {
      return result("EXHAUSTED", "OBSERVATION_ATTEMPTS_EXHAUSTED", attempt);
    }
    const delay = delayFor(retryScheduleMs, attempt);
    if (now() - startedAt + delay > maxElapsedMs) {
      return result("EXHAUSTED", "OBSERVATION_BUDGET_EXHAUSTED", attempt);
    }
    await sleep(delay);
  }

  return result("EXHAUSTED", "OBSERVATION_ATTEMPTS_EXHAUSTED", maxAttempts);
}
