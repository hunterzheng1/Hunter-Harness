export type PushPullCliAdapterErrorCode =
  | "PUSH_PULL_CLI_INPUT_INVALID"
  | "PUSH_PULL_CLI_OUTPUT_INVALID"
  | "PUSH_PULL_CLI_DEPENDENCY_INVALID"
  | "PUSH_PULL_CLI_UNAVAILABLE";

export class PushPullCliAdapterError extends Error {
  readonly code: PushPullCliAdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: PushPullCliAdapterErrorCode, retryable = false) {
    super(code);
    this.name = "PushPullCliAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}
