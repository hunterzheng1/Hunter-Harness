import { deepFreeze } from "./stable.js";
import type { ArchiveOutboxRecordReadResult } from "./types.js";
import { exactKeys, plainRecord, sha, validRecord } from "./validation.js";

export function normalizeArchiveOutboxRecord(input: unknown): ArchiveOutboxRecordReadResult {
  if (!plainRecord(input)) return { ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID" };
  const schemaVersion = Object.getOwnPropertyDescriptor(input, "schema_version")?.value as unknown;
  if (schemaVersion === 1) {
    if (!validRecord(input)) return { ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID" };
    return deepFreeze({ ok: true, source_schema_version: 1, readiness: "ready", record: input });
  }
  const legacyVersion = Object.getOwnPropertyDescriptor(input, "schemaVersion")?.value as unknown;
  if (legacyVersion === 0) {
    if (!exactKeys(input, ["schemaVersion", "packageSha256", "localZipRef"]) ||
        typeof input.packageSha256 !== "string" || !sha.test(input.packageSha256) ||
        typeof input.localZipRef !== "string" || !/^local_zip:[a-z0-9._:-]+$/u.test(input.localZipRef)) {
      return { ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID" };
    }
    return deepFreeze({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        package_sha256: input.packageSha256 as `sha256:${string}`,
        local_zip_ref: input.localZipRef
      },
      reason_codes: ["LEGACY_OUTBOX_LEASE_UNKNOWN", "LEGACY_OUTBOX_DURABLE_ACK_UNKNOWN"]
    });
  }
  return schemaVersion !== undefined || legacyVersion !== undefined
    ? { ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_VERSION_UNSUPPORTED" }
    : { ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID" };
}
