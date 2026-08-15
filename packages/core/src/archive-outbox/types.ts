import type {
  ArchivePackageReceipt
} from "../archive-package-builder/index.js";
import type { ArchiveSyncReceipt } from "../remote-sync/types.js";

export type ArchiveOutboxState =
  | "pending"
  | "leased"
  | "retry_wait"
  | "acknowledged"
  | "dead_letter";

export interface LocalArchiveZipRef {
  readonly ref_id: string;
  readonly package_sha256: `sha256:${string}`;
  readonly size_bytes: number;
}

export interface ArchiveOutboxLease {
  readonly token: `archive_outbox_lease:${string}`;
  readonly owner_id: string;
  readonly generation: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface ArchiveOutboxRecord {
  readonly schema_version: 1;
  readonly entry_id: `archive_outbox:${string}`;
  readonly request_id: `archive_request:${string}`;
  readonly idempotency_key: `sha256:${string}`;
  readonly immutable_identity: `sha256:${string}`;
  readonly package_receipt: ArchivePackageReceipt;
  readonly package_verification_evidence: ArchiveOutboxPackageVerificationEvidence;
  readonly package_operation_id: ArchivePackageReceipt["package_operation_id"];
  readonly operation_id: ArchivePackageReceipt["operation_id"];
  readonly change_identity: string;
  readonly archive_schema_version: 1;
  readonly project_id: string;
  readonly project_version: string;
  readonly archive_id: string;
  readonly package_sha256: `sha256:${string}`;
  readonly manifest_sha256: `sha256:${string}`;
  readonly receipt_hash: `sha256:${string}`;
  readonly local_zip_ref: LocalArchiveZipRef;
  readonly state: ArchiveOutboxState;
  readonly attempt_count: number;
  readonly generation: number;
  readonly lease: ArchiveOutboxLease | null;
  readonly next_attempt_at: string | null;
  readonly last_reason_code: string | null;
  readonly durable_receipt: ArchiveSyncReceipt | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly record_hash: `sha256:${string}`;
}

export interface ArchiveOutboxPackageVerificationEvidence {
  readonly schema_version: 1;
  readonly verification_id: `archive_outbox_package_verification:${string}`;
  readonly verdict: "verified";
  readonly package_operation_id: ArchivePackageReceipt["package_operation_id"];
  readonly receipt_hash: `sha256:${string}`;
  readonly package_sha256: `sha256:${string}`;
  readonly manifest_sha256: `sha256:${string}`;
  readonly local_zip_ref_id: string;
  readonly local_zip_size_bytes: number;
  readonly expected_immutable_identity: `sha256:${string}`;
  readonly verified_at: string;
  readonly evidence_hash: `sha256:${string}`;
}

export type ArchiveOutboxPackageVerificationResult = ArchiveOutboxPackageVerificationEvidence | {
  readonly schema_version: 1;
  readonly verdict: "rejected";
  readonly reason_codes: readonly string[];
  readonly verified_at: string;
};

export interface ArchiveOutboxPackageVerifierPort {
  verify(input: {
    readonly package_receipt: ArchivePackageReceipt;
    readonly local_zip_ref: LocalArchiveZipRef;
  }): Promise<ArchiveOutboxPackageVerificationResult>;
}

export interface ArchiveOutboxPage {
  readonly records: readonly ArchiveOutboxRecord[];
  readonly next_cursor?: string | undefined;
}

export interface ArchiveOutboxCasResult {
  readonly swapped: boolean;
  readonly record: ArchiveOutboxRecord;
}

export interface ArchiveOutboxPort {
  clock(): Date;
  put(record: ArchiveOutboxRecord): Promise<ArchiveOutboxRecord>;
  read(entry_id: ArchiveOutboxRecord["entry_id"]): Promise<ArchiveOutboxRecord | undefined>;
  compareAndSwap(
    entry_id: ArchiveOutboxRecord["entry_id"],
    expected_generation: number,
    next: ArchiveOutboxRecord
  ): Promise<ArchiveOutboxCasResult>;
  list(cursor: string | undefined, limit: number): Promise<ArchiveOutboxPage>;
}

export interface ArchiveOutboxEnqueueInput {
  readonly package_receipt: ArchivePackageReceipt;
  readonly local_zip_ref: LocalArchiveZipRef;
}

export interface ArchiveOutboxClaim {
  readonly entry_id: ArchiveOutboxRecord["entry_id"];
  readonly lease: ArchiveOutboxLease;
  readonly record: ArchiveOutboxRecord;
}

export type ArchiveRetentionPolicy = "retain" | "cleanup_after_durable_ack";

export interface ArchiveRetentionDecision {
  readonly schema_version: 1;
  readonly entry_id: ArchiveOutboxRecord["entry_id"];
  readonly record_generation: number;
  readonly disposition: "retain" | "cleanup_allowed";
  readonly reason_code: "OUTBOX_NOT_ACKNOWLEDGED" | "OUTBOX_POLICY_RETAINS_ZIP" | "OUTBOX_DURABLE_ACKNOWLEDGED";
  readonly local_zip_ref: LocalArchiveZipRef;
  readonly evaluated_at: string;
}

export interface ArchiveOutboxInspection {
  readonly record: ArchiveOutboxRecord;
  readonly retention: ArchiveRetentionDecision;
}

export interface ArchiveOutboxAck {
  readonly record: ArchiveOutboxRecord;
  readonly retention: ArchiveRetentionDecision;
}

export interface ArchiveOutboxNack {
  readonly record: ArchiveOutboxRecord;
  readonly retry_at: string | null;
}

export interface ArchiveOutboxReapResult {
  readonly inspected_count: number;
  readonly reaped_entry_ids: readonly ArchiveOutboxRecord["entry_id"][];
  readonly next_cursor?: string | undefined;
}

export interface ArchiveOutbox {
  enqueue(input: ArchiveOutboxEnqueueInput): Promise<ArchiveOutboxRecord>;
  claim(entry_id: ArchiveOutboxRecord["entry_id"], owner_id: string, lease_ttl_ms: number): Promise<ArchiveOutboxClaim>;
  renew(claim: ArchiveOutboxClaim, lease_ttl_ms: number): Promise<ArchiveOutboxClaim>;
  ack(claim: ArchiveOutboxClaim, receipt: ArchiveSyncReceipt,
    retention_policy: ArchiveRetentionPolicy): Promise<ArchiveOutboxAck>;
  nack(claim: ArchiveOutboxClaim, reason_code: string, retryable: boolean): Promise<ArchiveOutboxNack>;
  reap(limit?: number, cursor?: string): Promise<ArchiveOutboxReapResult>;
  inspect(entry_id: ArchiveOutboxRecord["entry_id"],
    retention_policy: ArchiveRetentionPolicy): Promise<ArchiveOutboxInspection>;
}

export type ArchiveOutboxRecordReadResult =
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "ready";
    readonly record: ArchiveOutboxRecord }
  | { readonly ok: true; readonly source_schema_version: 0; readonly readiness: "legacy_read_only";
    readonly legacy: { readonly package_sha256: `sha256:${string}`; readonly local_zip_ref: string };
    readonly reason_codes: readonly ["LEGACY_OUTBOX_LEASE_UNKNOWN", "LEGACY_OUTBOX_DURABLE_ACK_UNKNOWN"] }
  | { readonly ok: false; readonly reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID" |
    "ARCHIVE_OUTBOX_RECORD_VERSION_UNSUPPORTED" };
