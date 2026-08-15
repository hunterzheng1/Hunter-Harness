import type { ArchiveRemoteRequestReadResult } from "./types.js";
import { dataSnapshot, snapshotCurrentClaim, snapshotSource, validRetention } from "./validation.js";

export function normalizeArchiveRemoteRequest(input: unknown): ArchiveRemoteRequestReadResult {
  const version = dataSnapshot(input, ["schema_version", "claim", "source_ref", "retention_policy"]);
  if (version !== undefined && version.schema_version === 1) {
    const claim = snapshotCurrentClaim(version.claim);
    if (claim === undefined) return { ok: false, reason_code: "ARCHIVE_REMOTE_REQUEST_INVALID" };
    const source = snapshotSource(version.source_ref, claim);
    if (source === undefined || !validRetention(version.retention_policy)) {
      return { ok: false, reason_code: "ARCHIVE_REMOTE_REQUEST_INVALID" };
    }
    return Object.freeze({ ok: true, source_schema_version: 1 as const, readiness: "ready" as const,
      claim, source_ref: source, retention_policy: version.retention_policy });
  }
  const legacy = dataSnapshot(input, ["schemaVersion", "entryId", "localZipPath"]);
  if (legacy !== undefined && legacy.schemaVersion === 0 &&
      typeof legacy.entryId === "string" && legacy.entryId.length > 0 &&
      typeof legacy.localZipPath === "string" && legacy.localZipPath.length > 0) {
    return Object.freeze({ ok: true, source_schema_version: 0 as const,
      readiness: "legacy_read_only" as const,
      legacy: Object.freeze({ entry_id: legacy.entryId, local_zip_path: legacy.localZipPath }),
      reason_codes: ["LEGACY_ARCHIVE_LEASE_UNKNOWN",
        "LEGACY_ARCHIVE_RECEIPT_BINDING_UNKNOWN"] as const });
  }
  const tagged = dataSnapshot(input, ["schema_version"]) ?? dataSnapshot(input, ["schemaVersion"]);
  return { ok: false, reason_code: tagged === undefined
    ? "ARCHIVE_REMOTE_REQUEST_INVALID" : "ARCHIVE_REMOTE_REQUEST_VERSION_UNSUPPORTED" };
}
