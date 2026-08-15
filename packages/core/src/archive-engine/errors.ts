import type { ArchiveFailureClassification, ArchiveReasonCode } from "./types.js";

export class ArchiveEngineError extends Error {
  constructor(
    readonly code: ArchiveReasonCode,
    readonly classification: ArchiveFailureClassification,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ArchiveEngineError";
  }
}
