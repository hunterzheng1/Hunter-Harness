import type { ArchivePackageReasonCode } from "./types.js";

export class ArchivePackageBuilderError extends Error {
  readonly code: ArchivePackageReasonCode;
  readonly retryable: boolean;

  constructor(code: ArchivePackageReasonCode, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = "ArchivePackageBuilderError";
    this.code = code;
    this.retryable = retryable;
  }
}

