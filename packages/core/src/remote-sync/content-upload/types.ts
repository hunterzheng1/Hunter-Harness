import type { RemoteSyncContentChunk } from "../v1.js";

export const REMOTE_CONTENT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
export const REMOTE_CONTENT_UPLOAD_MAX_EXPIRY_MS = 15 * 60_000;

export type RemoteContentUploadSha256 = `sha256:${string}`;
export type RemoteContentUploadState = "stored" | "expired" | "unknown";
export type RemoteContentUploadErrorCode =
  | "REMOTE_CONTENT_UPLOAD_INPUT_INVALID"
  | "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT"
  | "REMOTE_CONTENT_UPLOAD_STREAM_INVALID"
  | "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH"
  | "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH"
  | "REMOTE_CONTENT_UPLOAD_TOO_LARGE"
  | "REMOTE_CONTENT_UPLOAD_ABORTED"
  | "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH"
  | "REMOTE_CONTENT_UPLOAD_NOT_FOUND"
  | "REMOTE_CONTENT_UPLOAD_EXPIRED";

export interface RemoteContentUploadSource {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
  readonly commit_sha?: string | undefined;
  readonly client_id?: string | undefined;
  readonly change_key?: string | undefined;
}

export interface RemoteContentUploadRequest {
  readonly schema_version: 1;
  readonly source: RemoteContentUploadSource;
  readonly idempotency_key: RemoteContentUploadSha256;
  readonly purpose: "remote_archive";
  readonly content_sha256: RemoteContentUploadSha256;
  readonly size_bytes: number;
  readonly expires_in_ms: number;
}

export interface RemoteContentUploadRef {
  readonly ref_id: `bounded_upload:${string}`;
  readonly sha256: RemoteContentUploadSha256;
  readonly size_bytes: number;
}

export interface RemoteContentUploadRecord {
  readonly schema_version: 1;
  readonly upload_id: `remote_content_upload:${string}`;
  readonly source: RemoteContentUploadSource;
  readonly idempotency_key: RemoteContentUploadSha256;
  readonly purpose: "remote_archive";
  readonly content_sha256: RemoteContentUploadSha256;
  readonly size_bytes: number;
  readonly upload_ref: RemoteContentUploadRef;
  readonly state: "stored";
  readonly created_at: string;
  readonly expires_at: string;
  readonly record_hash: RemoteContentUploadSha256;
}

export interface RemoteContentUploadResult {
  readonly outcome: "new" | "replay";
  readonly upload_ref: RemoteContentUploadRef;
  readonly record: RemoteContentUploadRecord;
}

export interface RemoteContentUploadStatus {
  readonly state: RemoteContentUploadState;
  readonly record: RemoteContentUploadRecord | null;
}

export interface RemoteContentUploadStaging {
  stage(
    request: RemoteContentUploadRequest,
    content: AsyncIterable<RemoteSyncContentChunk>,
    signal?: AbortSignal
  ): Promise<RemoteContentUploadResult>;
  status(input: {
    readonly source: RemoteContentUploadSource;
    readonly idempotency_key: RemoteContentUploadSha256;
  }): Promise<RemoteContentUploadStatus>;
  read(ref: RemoteContentUploadRef, source: RemoteContentUploadSource): Promise<Uint8Array>;
}

export type RemoteContentUploadRecordReadResult =
  | { readonly ok: true; readonly record: RemoteContentUploadRecord }
  | { readonly ok: false; readonly reason_code: "REMOTE_CONTENT_UPLOAD_INPUT_INVALID" };
