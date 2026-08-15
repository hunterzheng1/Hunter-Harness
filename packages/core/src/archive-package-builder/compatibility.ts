import { deepFreeze, stableHash } from "./stable.js";
import type {
  ArchivePackageReceipt,
  ArchivePackageRecordReadResult
} from "./types.js";
import {
  canonicalPackagePath,
  denseCanonicalStrings,
  exactOwnDataKeys,
  ownDataValue,
  plainOwnDataRecord,
  strictRfc3339
} from "./validation.js";

const sha = /^sha256:[a-f0-9]{64}$/u;

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && sha.test(value);
}

function safeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function record(value: unknown): value is Record<string, unknown> {
  return plainOwnDataRecord(value);
}

function current(value: Record<string, unknown>): boolean {
  const expectedKeys = [
    "schema_version", "package_operation_id", "operation_id", "change_identity",
    "closure_disposition", "archive_intent", "source_snapshot_hash", "source_manifest_hash",
    "source_receipt_hash", "local_inventory_hash", "projection_hash", "archive_schema_version", "archive_path", "local_archive_completed_at",
    "project_id", "project_version", "archive_id", "package_schema_version", "package_sha256",
    "manifest_sha256", "package_size_bytes", "entry_count", "entry_paths",
    "uncompressed_size_bytes", "source_read_count", "source_bytes_read", "zip_config",
    "completed_at", "receipt_hash"
  ];
  const entryPaths = denseCanonicalStrings(value.entry_paths);
  if (!exactOwnDataKeys(value, expectedKeys) ||
      value.schema_version !== 2 || value.package_schema_version !== 2 ||
      typeof value.package_operation_id !== "string" ||
      !/^archive_package_operation:[a-f0-9]{64}$/u.test(value.package_operation_id) ||
      typeof value.operation_id !== "string" || !/^archive_operation:[a-f0-9]{64}$/u.test(value.operation_id) ||
      typeof value.change_identity !== "string" || value.change_identity.trim() === "" ||
      typeof value.closure_disposition !== "string" ||
      !["completed", "abandoned", "superseded"].includes(value.closure_disposition) ||
      typeof value.archive_intent !== "string" ||
      !["release_candidate", "record_only"].includes(value.archive_intent) ||
      !sha256(value.source_snapshot_hash) || !sha256(value.source_manifest_hash) ||
      !sha256(value.source_receipt_hash) || !sha256(value.local_inventory_hash) ||
      !sha256(value.projection_hash) || value.archive_schema_version !== 1 ||
      !canonicalPackagePath(value.archive_path) || !value.archive_path.startsWith(".harness/archive/") ||
      !strictRfc3339(value.local_archive_completed_at) ||
      typeof value.project_id !== "string" || !/^prj_[a-z0-9._:-]+$/u.test(value.project_id) ||
      typeof value.project_version !== "string" || !/^pv_[a-z0-9._:-]+$/u.test(value.project_version) ||
      typeof value.archive_id !== "string" || !/^arc_[a-z0-9._:-]+$/u.test(value.archive_id) ||
      !sha256(value.package_sha256) || !sha256(value.manifest_sha256) ||
      !sha256(value.receipt_hash) ||
      !safeIntegerAtLeast(value.package_size_bytes, 1) ||
      !safeIntegerAtLeast(value.entry_count, 1) ||
      entryPaths === undefined || entryPaths.length !== value.entry_count ||
      entryPaths.some((path) => !canonicalPackagePath(path)) ||
      new Set(entryPaths.map((path) => path.normalize("NFC").toLowerCase())).size !== entryPaths.length ||
      !safeIntegerAtLeast(value.uncompressed_size_bytes, 0) ||
      !safeIntegerAtLeast(value.source_read_count, 1) ||
      !safeIntegerAtLeast(value.source_bytes_read, 0) ||
      !strictRfc3339(value.completed_at) ||
      !record(value.zip_config) || !exactOwnDataKeys(value.zip_config,
        ["compression", "compression_level", "entry_mtime", "file_mode"]) ||
      value.zip_config.entry_mtime !== "1980-01-01T00:00:00.000Z" ||
      value.zip_config.file_mode !== 0o100644 || value.zip_config.compression !== "deflate" ||
      value.zip_config.compression_level !== 9) return false;
  const { receipt_hash: receiptHash, ...payload } = value;
  const expectedOperationId = `archive_package_operation:${stableHash({
    source_receipt_hash: value.source_receipt_hash,
    local_inventory_hash: value.local_inventory_hash,
    projection_hash: value.projection_hash,
    package_schema_version: value.package_schema_version
  }).slice("sha256:".length)}`;
  return stableHash(payload) === receiptHash && value.package_operation_id === expectedOperationId;
}

export function normalizeArchivePackageRecord(input: unknown): ArchivePackageRecordReadResult {
  if (!record(input)) return { ok: false, reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID" };
  if (ownDataValue(input, "schema_version") === 2) {
    if (!current(input)) return { ok: false, reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID" };
    return deepFreeze({
      ok: true,
      source_package_schema_version: 2,
      readiness: "ready",
      receipt: input as unknown as ArchivePackageReceipt
    });
  }
  if (ownDataValue(input, "packageSchemaVersion") === 1) {
    if (!exactOwnDataKeys(input, ["manifestSha256", "packageSchemaVersion", "packageSha256"]) ||
        !sha256(input.packageSha256) || !sha256(input.manifestSha256)) {
      return { ok: false, reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID" };
    }
    return deepFreeze({
      ok: true,
      source_package_schema_version: 1,
      readiness: "legacy_read_only",
      legacy: {
        package_sha256: input.packageSha256 as `sha256:${string}`,
        manifest_sha256: input.manifestSha256 as `sha256:${string}`
      },
      reason_codes: [
        "LEGACY_PACKAGE_OPERATION_ID_UNKNOWN",
        "LEGACY_SOURCE_RECEIPT_BINDING_UNKNOWN",
        "LEGACY_DETERMINISTIC_ZIP_CONFIG_UNKNOWN"
      ]
    });
  }
  return ownDataValue(input, "schema_version") !== undefined ||
    ownDataValue(input, "packageSchemaVersion") !== undefined
    ? { ok: false, reason_code: "ARCHIVE_PACKAGE_RECORD_VERSION_UNSUPPORTED" }
    : { ok: false, reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID" };
}
