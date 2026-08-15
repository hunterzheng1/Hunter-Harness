export const REMOTE_ARCHIVE_V2_MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export const REMOTE_ARCHIVE_V2_MAX_LEASE_TTL_MS = 10 * 60_000;

export type RemoteArchiveV2Sha256 = `sha256:${string}`;
export type RemoteArchiveV2OperationId = `remote_archive_operation:${string}`;
export type RemoteArchiveV2PrepareId = `remote_archive_prepare:sha256:${string}`;
export type RemoteArchiveV2Capability = `remote_archive_capability:${string}`;
export type RemoteArchiveV2State = "pending" | "prepared" | "committing" | "committed" | "failed" | "unknown";

export type RemoteArchiveV2ErrorCode =
  | "REMOTE_ARCHIVE_INPUT_INVALID"
  | "REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH"
  | "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT"
  | "REMOTE_ARCHIVE_PREPARE_NOT_FOUND"
  | "REMOTE_ARCHIVE_PREPARE_EXPIRED"
  | "REMOTE_ARCHIVE_LEASE_FENCED"
  | "REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH"
  | "REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE"
  | "REMOTE_ARCHIVE_COMMIT_AMBIGUOUS"
  | "REMOTE_ARCHIVE_RECORD_INVALID"
  | "REMOTE_ARCHIVE_LEGACY_READ_ONLY";

export interface RemoteArchiveV2Source {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
  readonly commit_sha?: string | undefined;
  readonly client_id?: string | undefined;
  readonly change_key?: string | undefined;
}

export interface RemoteArchiveV2UploadRef {
  readonly ref_id: string;
  readonly sha256: RemoteArchiveV2Sha256;
  readonly size_bytes: number;
}

export interface RemoteArchiveV2Identities {
  readonly package_sha256: RemoteArchiveV2Sha256;
  readonly package_size_bytes: number;
  readonly archive_schema_version: 1;
  readonly trusted_package_receipt_hash: RemoteArchiveV2Sha256;
  readonly local_archive_receipt_hash: RemoteArchiveV2Sha256;
  readonly manifest_hash: RemoteArchiveV2Sha256;
  readonly inventory_hash: RemoteArchiveV2Sha256;
  readonly core_v2_projection_hash: RemoteArchiveV2Sha256;
}

export interface RemoteArchiveV2CanonicalMetadata {
  readonly schema_version: 2;
  readonly source: RemoteArchiveV2Source;
  readonly archive_id: string;
  readonly identities: RemoteArchiveV2Identities;
  readonly upload_ref: RemoteArchiveV2UploadRef;
}

export interface RemoteArchiveV2PrepareInput {
  readonly schema_version: 2;
  readonly operation_id: RemoteArchiveV2OperationId;
  readonly idempotency_key: RemoteArchiveV2Sha256;
  readonly payload_hash: RemoteArchiveV2Sha256;
  readonly lease_ttl_ms: number;
  readonly metadata: RemoteArchiveV2CanonicalMetadata;
}

export interface RemoteArchiveV2Lease {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
  readonly capability_hash: RemoteArchiveV2Sha256;
  readonly fencing_token: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface RemoteArchiveV2Receipt {
  readonly schema_version: 2;
  readonly receipt_id: `remote_archive_receipt:sha256:${string}`;
  readonly operation_id: RemoteArchiveV2OperationId;
  readonly prepare_id: RemoteArchiveV2PrepareId;
  readonly idempotency_key: RemoteArchiveV2Sha256;
  readonly payload_hash: RemoteArchiveV2Sha256;
  readonly source: RemoteArchiveV2Source;
  readonly archive_id: string;
  readonly package_sha256: RemoteArchiveV2Sha256;
  readonly package_size_bytes: number;
  readonly manifest_hash: RemoteArchiveV2Sha256;
  readonly trusted_package_receipt_hash: RemoteArchiveV2Sha256;
  readonly local_archive_receipt_hash: RemoteArchiveV2Sha256;
  readonly inventory_hash: RemoteArchiveV2Sha256;
  readonly core_v2_projection_hash: RemoteArchiveV2Sha256;
  readonly stored_at: string;
  readonly receipt_hash: RemoteArchiveV2Sha256;
}

export interface RemoteArchiveV2Record {
  readonly schema_version: 2;
  readonly operation_id: RemoteArchiveV2OperationId;
  readonly prepare_id: RemoteArchiveV2PrepareId;
  readonly idempotency_key: RemoteArchiveV2Sha256;
  readonly payload_hash: RemoteArchiveV2Sha256;
  readonly source: RemoteArchiveV2Source;
  readonly archive_id: string;
  readonly identities: RemoteArchiveV2Identities;
  readonly upload_ref: RemoteArchiveV2UploadRef;
  readonly state: Exclude<RemoteArchiveV2State, "unknown">;
  readonly generation: number;
  readonly lease: RemoteArchiveV2Lease | null;
  readonly receipt: RemoteArchiveV2Receipt | null;
  readonly failure_code: RemoteArchiveV2ErrorCode | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly record_hash: RemoteArchiveV2Sha256;
}

export interface RemoteArchiveV2Claim {
  readonly operation_id: RemoteArchiveV2OperationId;
  readonly prepare_id: RemoteArchiveV2PrepareId;
  readonly source: RemoteArchiveV2Source;
  readonly generation: number;
  readonly fencing_token: number;
  readonly capability: RemoteArchiveV2Capability;
}

export type RemoteArchiveV2PrepareResult =
  | { readonly outcome: "new"; readonly claim: RemoteArchiveV2Claim; readonly record: RemoteArchiveV2Record }
  | { readonly outcome: "replay"; readonly claim: null; readonly record: RemoteArchiveV2Record };

export interface RemoteArchiveV2CommitResult {
  readonly outcome: "new" | "replay";
  readonly record: RemoteArchiveV2Record;
  readonly receipt: RemoteArchiveV2Receipt;
}

export interface RemoteArchiveV2Status {
  readonly operation_id: RemoteArchiveV2OperationId;
  readonly state: RemoteArchiveV2State;
  readonly record: RemoteArchiveV2Record | null;
}

export interface RemoteArchiveV2 {
  prepare(input: RemoteArchiveV2PrepareInput): Promise<RemoteArchiveV2PrepareResult>;
  commit(input: { readonly claim: RemoteArchiveV2Claim }): Promise<RemoteArchiveV2CommitResult>;
  status(input: { readonly operation_id: RemoteArchiveV2OperationId; readonly source: RemoteArchiveV2Source }): Promise<RemoteArchiveV2Status>;
  receipt(input: { readonly operation_id: RemoteArchiveV2OperationId; readonly source: RemoteArchiveV2Source }): Promise<RemoteArchiveV2Receipt | null>;
}

export type RemoteArchiveV2RecordReadResult =
  | { readonly ok: true; readonly source_schema_version: 2; readonly readiness: "ready"; readonly record: RemoteArchiveV2Record }
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "legacy_read_only";
      readonly legacy: { readonly request_id: string; readonly package_sha256: RemoteArchiveV2Sha256; readonly archive_status: string };
      readonly reason_codes: readonly ["LEGACY_ARCHIVE_OPERATION_UNKNOWN", "LEGACY_ARCHIVE_PAYLOAD_HASH_UNKNOWN"] }
  | { readonly ok: false; readonly reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" | "REMOTE_ARCHIVE_RECORD_VERSION_UNSUPPORTED" };
