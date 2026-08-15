import { deepFreeze, clone } from "./stable.js";
import { normalizeArchiveOutboxRecord } from "./compatibility.js";
import { safeSnapshot, validV2Record, cloneV2Record } from "./v2-validation.js";
import type { ArchiveOutboxV2RecordReadResult } from "./v2-types.js";

/**
 * v2 normalization is deliberately read-only for v1/v0 data. A persistence
 * adapter must explicitly migrate with a new enqueue operation; this reader
 * never synthesizes a lease hash, transition log, or cleanup state.
 */
export function normalizeArchiveOutboxV2Record(input: unknown): ArchiveOutboxV2RecordReadResult {
  let snapshot: unknown;
  try { snapshot = safeSnapshot(input, "ARCHIVE_OUTBOX_V2_RECORD_INVALID"); } catch {
    return { ok: false, reason_code: "ARCHIVE_OUTBOX_V2_RECORD_INVALID" };
  }
  if (validV2Record(snapshot)) {
    return deepFreeze({ ok: true, source_schema_version: 2, readiness: "ready", record: cloneV2Record(snapshot) });
  }
  const legacy = normalizeArchiveOutboxRecord(clone(snapshot));
  if (legacy.ok && (legacy.source_schema_version === 1 || legacy.source_schema_version === 0)) {
    return deepFreeze({
      ok: true,
      source_schema_version: legacy.source_schema_version,
      readiness: "legacy_read_only",
      legacy: {
        entry_id: legacy.source_schema_version === 1 ? legacy.record.entry_id :
          `archive_outbox:legacy_${legacy.legacy.package_sha256.slice("sha256:".length)}`,
        package_sha256: legacy.source_schema_version === 1 ? legacy.record.package_sha256 : legacy.legacy.package_sha256
      },
      reason_codes: ["LEGACY_OUTBOX_TRANSITIONS_UNKNOWN", "LEGACY_OUTBOX_CLEANUP_UNKNOWN"]
    });
  }
  return { ok: false, reason_code: "ARCHIVE_OUTBOX_V2_RECORD_VERSION_UNSUPPORTED" };
}
