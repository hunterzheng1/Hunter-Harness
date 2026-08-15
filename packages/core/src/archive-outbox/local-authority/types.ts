import type {
  ArchivePackageReceipt,
  CoreV2Projection,
  PublishedArchiveInventory
} from "../../archive-package-builder/index.js";
import type { LocalArchiveReceipt } from "../../archive-engine/index.js";
import type { RemoteArchiveV2Receipt } from "../../remote-sync/archive/index.js";
import type { LocalArchiveZipRef } from "../types.js";

export type LocalArchiveAuthoritySha256 = `sha256:${string}`;
export type LocalArchiveAuthorityEntryId = `local_archive_authority_entry:${string}`;
export type LocalArchiveAuthorityOperationId = `local_archive_authority_operation:${string}`;
export type LocalArchiveAuthorityCapability = `local_archive_authority_capability:${string}`;

export interface LocalArchiveAuthorityLease {
  readonly owner_id: string;
  readonly capability_hash: LocalArchiveAuthoritySha256;
  readonly fencing_token: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface LocalArchiveAuthorityCleanupState {
  readonly state: "not_allowed" | "allowed" | "claimed" | "pending_retry" | "completed";
  readonly generation: number;
  readonly lease: LocalArchiveAuthorityLease | null;
}

export interface LocalArchiveAuthorityOperationSnapshot {
  readonly operation_id: LocalArchiveAuthorityOperationId;
  readonly kind: "register" | "claim" | "acknowledge" | "cleanup_claim" | "cleanup_complete" | "recover";
  readonly intent_hash: LocalArchiveAuthoritySha256;
}

/** Exact durable wire record. It intentionally contains no filesystem path. */
export interface LocalArchiveAuthorityRecord {
  readonly schema_version: 2;
  readonly entry_id: LocalArchiveAuthorityEntryId;
  readonly authority_id: string;
  readonly project_id: string;
  readonly ref_id: string;
  readonly package_sha256: LocalArchiveAuthoritySha256;
  readonly size_bytes: number;
  readonly archive_id: string;
  readonly trusted_package_receipt_hash: LocalArchiveAuthoritySha256;
  readonly local_archive_receipt_hash: LocalArchiveAuthoritySha256;
  readonly manifest_hash: LocalArchiveAuthoritySha256;
  readonly inventory_hash: LocalArchiveAuthoritySha256;
  readonly core_v2_projection_hash: LocalArchiveAuthoritySha256;
  readonly verification_hash: LocalArchiveAuthoritySha256;
  readonly storage_kind: "project_state_cas";
  readonly binding_hash: LocalArchiveAuthoritySha256;
  readonly state: "available" | "leased" | "acknowledged";
  readonly generation: number;
  readonly lease: LocalArchiveAuthorityLease | null;
  readonly durable_receipt_hash: LocalArchiveAuthoritySha256 | null;
  readonly cleanup: LocalArchiveAuthorityCleanupState;
  readonly last_operation: LocalArchiveAuthorityOperationSnapshot | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly record_hash: LocalArchiveAuthoritySha256;
}

export interface LocalArchiveAuthorityVerificationInput {
  readonly trusted_package_receipt: ArchivePackageReceipt;
  readonly local_archive_receipt: LocalArchiveReceipt;
  readonly inventory: PublishedArchiveInventory;
  readonly core_v2_projection: CoreV2Projection;
  readonly local_zip_ref: LocalArchiveZipRef;
}

export interface LocalArchiveAuthorityVerificationEvidence {
  readonly schema_version: 1;
  readonly verdict: "verified";
  readonly verification_hash: LocalArchiveAuthoritySha256;
}

export interface LocalArchiveAuthorityVerifierBridge {
  verify(input: LocalArchiveAuthorityVerificationInput): Promise<LocalArchiveAuthorityVerificationEvidence>;
}

export interface LocalArchiveAuthorityRegisterInput extends LocalArchiveAuthorityVerificationInput {
  readonly operation_id: LocalArchiveAuthorityOperationId;
  readonly authority_id: string;
  readonly project_id: string;
  readonly package_bytes: Uint8Array;
}

export interface LocalArchiveAuthorityClaimInput {
  readonly operation_id: LocalArchiveAuthorityOperationId;
  readonly entry_id: LocalArchiveAuthorityEntryId;
  readonly expected_generation: number;
  readonly owner_id: string;
  readonly lease_ttl_ms: number;
}

export interface LocalArchiveAuthorityClaim {
  readonly outcome: "new" | "replay";
  readonly entry_id: LocalArchiveAuthorityEntryId;
  readonly generation: number;
  /** Raw capabilities are returned only for a newly granted authorization, never reconstructed on replay. */
  readonly capability: LocalArchiveAuthorityCapability | null;
  readonly fencing_token: number;
  readonly record: LocalArchiveAuthorityRecord;
}

export interface LocalArchiveAuthorityCleanupClaim {
  readonly outcome: "new" | "replay";
  readonly entry_id: LocalArchiveAuthorityEntryId;
  readonly generation: number;
  readonly capability: LocalArchiveAuthorityCapability | null;
  readonly fencing_token: number;
  readonly record: LocalArchiveAuthorityRecord;
}

export interface LocalArchiveAuthorityPortOperation {
  readonly operation_id: LocalArchiveAuthorityOperationId;
  readonly kind: LocalArchiveAuthorityOperationSnapshot["kind"];
  readonly intent_hash: LocalArchiveAuthoritySha256;
  readonly entry_id: LocalArchiveAuthorityEntryId;
  readonly expected_generation: number | null;
}

export type LocalArchiveAuthorityCommitResult =
  | { readonly outcome: "committed" | "replayed"; readonly record: LocalArchiveAuthorityRecord }
  | { readonly outcome: "conflict"; readonly record: LocalArchiveAuthorityRecord | null };

export interface LocalArchiveAuthorityPort {
  clock(): Date;
  read(entry_id: LocalArchiveAuthorityEntryId): Promise<LocalArchiveAuthorityRecord | undefined>;
  findBinding(project_id: string, ref_id: string): Promise<LocalArchiveAuthorityRecord | undefined>;
  inspectOperation(operation_id: LocalArchiveAuthorityOperationId): Promise<{
    readonly operation: LocalArchiveAuthorityPortOperation;
    readonly record: LocalArchiveAuthorityRecord;
  } | undefined>;
  commit(operation: LocalArchiveAuthorityPortOperation, next: LocalArchiveAuthorityRecord): Promise<LocalArchiveAuthorityCommitResult>;
  putBlob(project_id: string, ref_id: string, package_sha256: LocalArchiveAuthoritySha256,
    size_bytes: number, bytes: Uint8Array): Promise<void>;
  readBlob(project_id: string, ref_id: string, package_sha256: LocalArchiveAuthoritySha256,
    size_bytes: number): Promise<Uint8Array | undefined>;
  deleteBlob(project_id: string, ref_id: string, package_sha256: LocalArchiveAuthoritySha256,
    size_bytes: number): Promise<void>;
}

export interface LocalArchiveAuthority {
  register(input: LocalArchiveAuthorityRegisterInput): Promise<LocalArchiveAuthorityRecord>;
  claim(input: LocalArchiveAuthorityClaimInput): Promise<LocalArchiveAuthorityClaim>;
  acknowledge(input: { readonly operation_id: LocalArchiveAuthorityOperationId; readonly claim: LocalArchiveAuthorityClaim;
    readonly durable_receipt: RemoteArchiveV2Receipt }): Promise<LocalArchiveAuthorityRecord>;
  claimCleanup(input: Omit<LocalArchiveAuthorityClaimInput, "lease_ttl_ms">): Promise<LocalArchiveAuthorityCleanupClaim>;
  completeCleanup(input: { readonly operation_id: LocalArchiveAuthorityOperationId;
    readonly claim: LocalArchiveAuthorityCleanupClaim }): Promise<LocalArchiveAuthorityRecord>;
  recoverExpired(input: { readonly operation_id: LocalArchiveAuthorityOperationId;
    readonly entry_id: LocalArchiveAuthorityEntryId; readonly expected_generation: number }): Promise<LocalArchiveAuthorityRecord>;
  resolve(project_id: string, ref_id: string): Promise<Uint8Array | undefined>;
}

export type LocalArchiveAuthorityRecordReadResult =
  | { readonly ok: true; readonly source_schema_version: 2; readonly readiness: "ready"; readonly record: LocalArchiveAuthorityRecord }
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "legacy_read_only";
      readonly legacy: { readonly project_id: string; readonly ref_id: string; readonly package_sha256: LocalArchiveAuthoritySha256 };
      readonly reason_codes: readonly ["LEGACY_LOCAL_AUTHORITY_FENCE_UNKNOWN", "LEGACY_LOCAL_AUTHORITY_CLEANUP_UNKNOWN"] }
  | { readonly ok: false; readonly reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" |
      "LOCAL_ARCHIVE_AUTHORITY_RECORD_VERSION_UNSUPPORTED" };
