export type ArchiveRemoteAdapterErrorCode =
  | "ARCHIVE_REMOTE_DEPENDENCY_INVALID"
  | "ARCHIVE_REMOTE_CLAIM_INVALID"
  | "ARCHIVE_REMOTE_SOURCE_INVALID"
  | "ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID";

export class ArchiveRemoteAdapterError extends Error {
  readonly code: ArchiveRemoteAdapterErrorCode;

  constructor(code: ArchiveRemoteAdapterErrorCode) {
    super(code);
    this.name = "ArchiveRemoteAdapterError";
    this.code = code;
  }
}
