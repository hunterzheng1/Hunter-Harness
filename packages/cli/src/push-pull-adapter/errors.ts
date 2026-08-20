export type PushPullCliAdapterErrorCode =
  | "PUSH_PULL_CLI_INPUT_INVALID"
  | "PUSH_PULL_CLI_OUTPUT_INVALID"
  | "PUSH_PULL_CLI_DEPENDENCY_INVALID"
  | "PUSH_PULL_CLI_UNAVAILABLE";

export interface PushPullCliAdapterViolation {
  readonly violated: string;
  readonly detail: string;
}

export class PushPullCliAdapterError extends Error {
  readonly code: PushPullCliAdapterErrorCode;
  readonly retryable: boolean;
  /** Which invariant failed — absent when the caller had nothing to attach. */
  readonly violation: PushPullCliAdapterViolation | undefined;

  constructor(
    code: PushPullCliAdapterErrorCode,
    retryable = false,
    violation?: PushPullCliAdapterViolation | undefined
  ) {
    super(violation === undefined ? code : `${code}: ${violation.violated} — ${violation.detail}`);
    this.name = "PushPullCliAdapterError";
    this.code = code;
    this.retryable = retryable;
    this.violation = violation;
  }
}
