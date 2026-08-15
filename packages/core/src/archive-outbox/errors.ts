export type ArchiveOutboxErrorCode =
  | "ARCHIVE_OUTBOX_INPUT_INVALID"
  | "ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED"
  | "ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT"
  | "ARCHIVE_OUTBOX_NOT_FOUND"
  | "ARCHIVE_OUTBOX_NOT_CLAIMABLE"
  | "ARCHIVE_OUTBOX_LEASE_STALE"
  | "ARCHIVE_OUTBOX_ACK_INVALID"
  | "ARCHIVE_OUTBOX_PORT_CONFLICT"
  | "ARCHIVE_OUTBOX_PORT_INVALID"
  | "ARCHIVE_OUTBOX_CAPABILITY_UNAVAILABLE"
  | "ARCHIVE_OUTBOX_V2_RECORD_INVALID"
  | "ARCHIVE_OUTBOX_V2_RECORD_VERSION_UNSUPPORTED";

export class ArchiveOutboxError extends Error {
  readonly code: ArchiveOutboxErrorCode;
  readonly retryable: boolean;

  constructor(code: ArchiveOutboxErrorCode, retryable = false) {
    super(code);
    this.name = "ArchiveOutboxError";
    this.code = code;
    this.retryable = retryable;
  }
}
