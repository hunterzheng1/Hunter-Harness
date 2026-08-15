import type { LocalArchiveReceipt, Sha256 } from "../archive-engine/index.js";

export type ArchivePackageReasonCode =
  | "ARCHIVE_PACKAGE_INPUT_INVALID"
  | "ARCHIVE_PACKAGE_SOURCE_INVALID"
  | "ARCHIVE_PACKAGE_PATH_INVALID"
  | "ARCHIVE_PACKAGE_CANDIDATE_INVALID"
  | "ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT"
  | "ARCHIVE_PACKAGE_PORT_INVALID"
  | "ARCHIVE_PACKAGE_RECEIPT_INVALID"
  | "ARCHIVE_PACKAGE_VERIFICATION_FAILED";

export interface PublishedArchiveInventoryEntry {
  readonly path: string;
  readonly content_hash: Sha256;
  readonly size_bytes: number;
  read_content(): Promise<Uint8Array> | AsyncIterable<Uint8Array>;
}

/** Immutable inventory projected by the local archive Adapter after publication. */
export interface PublishedArchiveInventory extends Omit<LocalArchiveReceipt, "schema_version"> {
  readonly schema_version: 1;
  readonly files: readonly PublishedArchiveInventoryEntry[];
}

/** Independently supplied core-v2 projection; 06B1 is not required to create these files. */
export interface CoreV2Projection {
  readonly schema_version: 2;
  readonly project_id: string;
  readonly project_version: string;
  readonly archive_id: string;
  readonly files: readonly PublishedArchiveInventoryEntry[];
}

export interface ArchivePackageEntry {
  readonly path: string;
  readonly content: Uint8Array;
  readonly content_hash: Sha256;
  readonly size_bytes: number;
}

export interface DeterministicZipConfig {
  readonly entry_mtime: "1980-01-01T00:00:00.000Z";
  readonly file_mode: 0o100644;
  readonly compression: "deflate";
  readonly compression_level: 9;
}

export interface InspectedArchivePackage {
  readonly zip_config: DeterministicZipConfig;
  readonly entries: readonly ArchivePackageEntry[];
}

export interface ArchivePackageCompletionEvidence {
  readonly schema_version: 1;
  readonly package_operation_id: `archive_package_operation:${string}`;
  readonly operation_id: LocalArchiveReceipt["operation_id"];
  readonly immutable_identity: Sha256;
  readonly receipt_hash: Sha256;
  readonly completed_at: string;
}

export interface ArchivePackagePort {
  build(entries: readonly ArchivePackageEntry[], config: DeterministicZipConfig): Promise<Uint8Array>;
  inspect(package_bytes: Uint8Array): Promise<InspectedArchivePackage>;
  persistCompletion(
    evidence: ArchivePackageCompletionEvidence
  ): Promise<ArchivePackageCompletionEvidence>;
  readCompletion(
    package_operation_id: ArchivePackageCompletionEvidence["package_operation_id"]
  ): Promise<ArchivePackageCompletionEvidence | undefined>;
}

export interface ArchivePackageReceipt {
  readonly schema_version: 2;
  readonly package_operation_id: `archive_package_operation:${string}`;
  readonly operation_id: LocalArchiveReceipt["operation_id"];
  readonly change_identity: string;
  readonly closure_disposition: LocalArchiveReceipt["closure_disposition"];
  readonly archive_intent: LocalArchiveReceipt["archive_intent"];
  readonly source_snapshot_hash: Sha256;
  readonly source_manifest_hash: Sha256;
  readonly source_receipt_hash: Sha256;
  readonly local_inventory_hash: Sha256;
  readonly projection_hash: Sha256;
  readonly archive_schema_version: 1;
  readonly archive_path: string;
  readonly local_archive_completed_at: string;
  readonly project_id: string;
  readonly project_version: string;
  readonly archive_id: string;
  readonly package_schema_version: 2;
  readonly package_sha256: Sha256;
  readonly manifest_sha256: Sha256;
  readonly package_size_bytes: number;
  readonly entry_count: number;
  readonly entry_paths: readonly string[];
  readonly uncompressed_size_bytes: number;
  readonly source_read_count: number;
  readonly source_bytes_read: number;
  readonly zip_config: DeterministicZipConfig;
  readonly completed_at: string;
  readonly receipt_hash: Sha256;
}

export interface ArchivePackageBuildResult {
  readonly package_bytes: Uint8Array;
  readonly manifest_bytes: Uint8Array;
  readonly receipt: ArchivePackageReceipt;
}

export interface PackageVerification {
  readonly valid: boolean;
  readonly reason_codes: readonly ArchivePackageReasonCode[];
}

export interface ArchivePackageBuilder {
  buildPackage(
    local_receipt: LocalArchiveReceipt,
    inventory: PublishedArchiveInventory,
    projection: CoreV2Projection,
    package_schema_version: 2
  ): Promise<ArchivePackageBuildResult>;
  verifyPackage(
    receipt: ArchivePackageReceipt,
    package_bytes: Uint8Array,
    expected: {
      readonly local_receipt: LocalArchiveReceipt;
      readonly inventory: PublishedArchiveInventory;
      readonly projection: CoreV2Projection;
    }
  ): Promise<PackageVerification>;
}

export type ArchivePackageRecordReadResult =
  | {
    readonly ok: true;
    readonly source_package_schema_version: 2;
    readonly readiness: "ready";
    readonly receipt: ArchivePackageReceipt;
  }
  | {
    readonly ok: true;
    readonly source_package_schema_version: 1;
    readonly readiness: "legacy_read_only";
    readonly legacy: { readonly package_sha256: Sha256; readonly manifest_sha256: Sha256 };
    readonly reason_codes: readonly [
      "LEGACY_PACKAGE_OPERATION_ID_UNKNOWN",
      "LEGACY_SOURCE_RECEIPT_BINDING_UNKNOWN",
      "LEGACY_DETERMINISTIC_ZIP_CONFIG_UNKNOWN"
    ];
  }
  | { readonly ok: false; readonly reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID" | "ARCHIVE_PACKAGE_RECORD_VERSION_UNSUPPORTED" };
