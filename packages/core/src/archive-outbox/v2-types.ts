import type {
  ArchivePackageReceipt
} from "../archive-package-builder/index.js";
import type { ArchiveSyncReceipt } from "../remote-sync/types.js";
import type {
  ArchiveOutboxEnqueueInput,
  ArchiveOutboxPackageVerificationEvidence,
  ArchiveOutboxState,
  ArchiveRetentionPolicy,
  LocalArchiveZipRef
} from "./types.js";

export const ARCHIVE_OUTBOX_V2_SCHEMA_VERSION = 2 as const;
export const ARCHIVE_OUTBOX_V2_MAX_PAGE_SIZE = 100 as const;
export const ARCHIVE_OUTBOX_V2_MAX_LEASE_TTL_MS = 86_400_000 as const;
export const ARCHIVE_OUTBOX_V2_MAX_ATTEMPTS = 100 as const;

export type ArchiveOutboxV2EntryId = `archive_outbox:${string}`;
export type ArchiveOutboxV2OperationId = `archive_outbox_transition:${string}`;
export type ArchiveOutboxV2Capability = `archive_outbox_capability:${string}`;
export type ArchiveOutboxV2Sha256 = `sha256:${string}`;

export type ArchiveOutboxV2TransitionKind =
  | "enqueue"
  | "claim"
  | "renew"
  | "nack"
  | "ack"
  | "reap"
  | "cleanup_claim"
  | "cleanup_complete"
  | "cleanup_tombstone";

export type ArchiveOutboxV2TransitionState = "committed" | "ambiguous";

/** The durable lease stores only a hash; the CSPRNG capability is returned once to the worker. */
export interface ArchiveOutboxV2Lease {
  readonly capability_hash: ArchiveOutboxV2Sha256;
  readonly owner_id: string;
  readonly generation: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface ArchiveOutboxV2Claim {
  readonly entry_id: ArchiveOutboxV2EntryId;
  readonly capability: ArchiveOutboxV2Capability;
  readonly lease: ArchiveOutboxV2Lease;
  readonly record: ArchiveOutboxV2Record;
}

export interface ArchiveOutboxV2TransitionOperation {
  readonly schema_version: 2;
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly entry_id: ArchiveOutboxV2EntryId;
  readonly kind: ArchiveOutboxV2TransitionKind;
  readonly expected_generation: number;
  readonly idempotency_key: ArchiveOutboxV2Sha256;
  readonly payload_hash: ArchiveOutboxV2Sha256;
  readonly owner_id?: string | undefined;
  readonly capability_hash?: ArchiveOutboxV2Sha256 | undefined;
}

export interface ArchiveOutboxV2TransitionSnapshot {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly kind: ArchiveOutboxV2TransitionKind;
  readonly state: ArchiveOutboxV2TransitionState;
  readonly idempotency_key: ArchiveOutboxV2Sha256;
  readonly payload_hash: ArchiveOutboxV2Sha256;
  readonly committed_at: string;
}

export type ArchiveOutboxV2CleanupStatus =
  | "not_allowed"
  | "allowed"
  | "claimed"
  | "completed"
  | "tombstoned";

/** Cleanup is a fenced descriptor; this contract never deletes ZIP bytes itself. */
export interface ArchiveOutboxV2CleanupState {
  readonly status: ArchiveOutboxV2CleanupStatus;
  readonly record_generation: number;
  readonly local_zip_ref: LocalArchiveZipRef;
  readonly claim_operation_id: ArchiveOutboxV2OperationId | null;
  readonly completed_operation_id: ArchiveOutboxV2OperationId | null;
}

/**
 * v2 is additive. It preserves the v1 payload identity but adds durable
 * transition and cleanup evidence; v1 records are never upgraded in place.
 */
export interface ArchiveOutboxV2Record {
  readonly schema_version: 2;
  readonly entry_id: ArchiveOutboxV2EntryId;
  readonly request_id: `archive_request:${string}`;
  readonly idempotency_key: ArchiveOutboxV2Sha256;
  readonly immutable_identity: ArchiveOutboxV2Sha256;
  readonly package_receipt: ArchivePackageReceipt;
  readonly package_verification_evidence: ArchiveOutboxPackageVerificationEvidence;
  readonly package_operation_id: ArchivePackageReceipt["package_operation_id"];
  readonly operation_id: ArchivePackageReceipt["operation_id"];
  readonly change_identity: string;
  readonly archive_schema_version: 1;
  readonly project_id: string;
  readonly project_version: string;
  readonly archive_id: string;
  readonly package_sha256: ArchiveOutboxV2Sha256;
  readonly manifest_sha256: ArchiveOutboxV2Sha256;
  readonly receipt_hash: ArchiveOutboxV2Sha256;
  readonly local_zip_ref: LocalArchiveZipRef;
  readonly state: ArchiveOutboxState;
  readonly attempt_count: number;
  readonly generation: number;
  readonly lease: ArchiveOutboxV2Lease | null;
  readonly next_attempt_at: string | null;
  readonly last_reason_code: string | null;
  readonly durable_receipt: ArchiveSyncReceipt | null;
  readonly cleanup: ArchiveOutboxV2CleanupState;
  readonly last_transition: ArchiveOutboxV2TransitionSnapshot | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly record_hash: ArchiveOutboxV2Sha256;
}

export interface ArchiveOutboxV2EnqueueInput extends ArchiveOutboxEnqueueInput {
  readonly operation_id?: ArchiveOutboxV2OperationId | undefined;
}

export interface ArchiveOutboxV2PackageVerifierPort {
  verify(input: {
    readonly package_receipt: ArchivePackageReceipt;
    readonly local_zip_ref: LocalArchiveZipRef;
  }): Promise<ArchiveOutboxPackageVerificationEvidence>;
}

export interface ArchiveOutboxV2ClaimDueInput {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly owner_id: string;
  readonly lease_ttl_ms: number;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ArchiveOutboxV2ClaimDueResult {
  readonly claims: readonly ArchiveOutboxV2Claim[];
  readonly inspected_count: number;
  readonly next_cursor?: string | undefined;
}

export interface ArchiveOutboxV2ReapInput {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ArchiveOutboxV2ReapResult {
  readonly inspected_count: number;
  readonly reaped_entry_ids: readonly ArchiveOutboxV2EntryId[];
  readonly next_cursor?: string | undefined;
}

export interface ArchiveOutboxV2CleanupClaimInput {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly entry_id: ArchiveOutboxV2EntryId;
  readonly expected_generation: number;
}

export interface ArchiveOutboxV2CleanupClaim {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly entry_id: ArchiveOutboxV2EntryId;
  readonly record_generation: number;
  readonly local_zip_ref: LocalArchiveZipRef;
  readonly record: ArchiveOutboxV2Record;
}

export interface ArchiveOutboxV2CleanupCompleteInput {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly entry_id: ArchiveOutboxV2EntryId;
  readonly expected_generation: number;
  readonly tombstone: boolean;
}

export interface ArchiveOutboxV2CleanupResult {
  readonly outcome: "completed" | "tombstoned" | "replayed" | "conflict";
  readonly record: ArchiveOutboxV2Record;
}

export type ArchiveOutboxV2TransitionResult =
  | { readonly outcome: "new" | "replayed"; readonly operation_id: ArchiveOutboxV2OperationId;
      readonly record: ArchiveOutboxV2Record }
  | { readonly outcome: "conflict"; readonly operation_id: ArchiveOutboxV2OperationId; readonly record: null }
  | { readonly outcome: "ambiguous"; readonly operation_id: ArchiveOutboxV2OperationId; readonly record: null };

export interface ArchiveOutboxV2TransitionInspection {
  readonly operation_id: ArchiveOutboxV2OperationId;
  readonly state: "unknown" | "prepared" | "committed" | "ambiguous" | "conflict";
  readonly entry_id: ArchiveOutboxV2EntryId | null;
  readonly kind: ArchiveOutboxV2TransitionKind | null;
  readonly idempotency_key: ArchiveOutboxV2Sha256 | null;
  readonly payload_hash: ArchiveOutboxV2Sha256 | null;
  readonly record: ArchiveOutboxV2Record | null;
}

export interface ArchiveOutboxV2Page {
  readonly records: readonly ArchiveOutboxV2Record[];
  readonly next_cursor?: string | undefined;
}

export interface ArchiveOutboxV2Port {
  /** Storage is authoritative for all due/expiry decisions. */
  clock(): Date;
  put(record: ArchiveOutboxV2Record): Promise<ArchiveOutboxV2Record>;
  read(entry_id: ArchiveOutboxV2EntryId): Promise<ArchiveOutboxV2Record | undefined>;
  list(cursor: string | undefined, limit: number): Promise<ArchiveOutboxV2Page>;
  commitTransition(
    operation: ArchiveOutboxV2TransitionOperation,
    next: ArchiveOutboxV2Record
  ): Promise<ArchiveOutboxV2TransitionResult>;
  inspectTransition(operation_id: ArchiveOutboxV2OperationId): Promise<ArchiveOutboxV2TransitionInspection>;
}

export interface ArchiveOutboxV2 {
  enqueue(input: ArchiveOutboxV2EnqueueInput): Promise<ArchiveOutboxV2Record>;
  claimDue(input: ArchiveOutboxV2ClaimDueInput): Promise<ArchiveOutboxV2ClaimDueResult>;
  renew(claim: ArchiveOutboxV2Claim, input: {
    readonly operation_id: ArchiveOutboxV2OperationId;
    readonly lease_ttl_ms: number;
  }): Promise<ArchiveOutboxV2Claim>;
  ack(claim: ArchiveOutboxV2Claim, receipt: ArchiveSyncReceipt, policy: ArchiveRetentionPolicy,
    operation_id: ArchiveOutboxV2OperationId): Promise<ArchiveOutboxV2Record>;
  nack(claim: ArchiveOutboxV2Claim, reason_code: string, retryable: boolean,
    operation_id: ArchiveOutboxV2OperationId): Promise<ArchiveOutboxV2Record>;
  reap(input: ArchiveOutboxV2ReapInput): Promise<ArchiveOutboxV2ReapResult>;
  claimCleanup(input: ArchiveOutboxV2CleanupClaimInput): Promise<ArchiveOutboxV2CleanupClaim>;
  completeCleanup(input: ArchiveOutboxV2CleanupCompleteInput): Promise<ArchiveOutboxV2CleanupResult>;
  inspect(entry_id: ArchiveOutboxV2EntryId): Promise<ArchiveOutboxV2TransitionInspection | ArchiveOutboxV2Record>;
}

export type ArchiveOutboxV2RecordReadResult =
  | { readonly ok: true; readonly source_schema_version: 2; readonly readiness: "ready";
      readonly record: ArchiveOutboxV2Record }
  | { readonly ok: true; readonly source_schema_version: 0 | 1; readonly readiness: "legacy_read_only";
      readonly legacy: { readonly entry_id: string; readonly package_sha256: ArchiveOutboxV2Sha256 };
      readonly reason_codes: readonly ["LEGACY_OUTBOX_TRANSITIONS_UNKNOWN", "LEGACY_OUTBOX_CLEANUP_UNKNOWN"] }
  | { readonly ok: false; readonly reason_code: "ARCHIVE_OUTBOX_V2_RECORD_INVALID" |
      "ARCHIVE_OUTBOX_V2_RECORD_VERSION_UNSUPPORTED" };
