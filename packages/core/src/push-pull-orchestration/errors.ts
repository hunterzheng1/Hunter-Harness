export type PushPullOrchestrationErrorCode =
  | "PUSH_PULL_INPUT_INVALID"
  | "PUSH_PULL_SCOPE_INVALID"
  | "PUSH_PULL_SOURCE_REQUIRED"
  | "PUSH_PULL_PREVIEW_NOT_FOUND"
  | "PUSH_PULL_DECISION_REQUIRED"
  | "PUSH_PULL_RESTORE_SOURCE_REQUIRED"
  | "PUSH_PULL_SENSITIVE_CONFIRMATION_REQUIRED"
  | "PUSH_PULL_NOT_CONFIRMED"
  | "PUSH_PULL_DIRECTION_MISMATCH"
  | "PUSH_PULL_RECEIPT_INVALID";

export class PushPullOrchestrationError extends Error {
  constructor(
    readonly code: PushPullOrchestrationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PushPullOrchestrationError";
  }
}
