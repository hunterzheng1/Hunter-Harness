import { deepFreeze } from "./stable.js";
import type {
  ArchiveRecordReadResult,
  ArchiveIntent,
  ClosureDisposition,
  LocalArchiveReceipt,
  Sha256
} from "./types.js";

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const operationId = /^archive_operation:[a-f0-9]{64}$/u;
const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const receiptKeys = new Set([
  "schema_version", "operation_id", "change_identity", "closure_disposition",
  "archive_intent", "source_snapshot_hash", "archive_schema_version", "archive_path",
  "archive_manifest_hash", "completed_at"
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function canonicalChangeIdentity(value: unknown): value is string {
  if (!nonempty(value) || value !== value.trim() || value !== value.normalize("NFC") ||
      value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." &&
    !Array.from(segment).some((character) => character.charCodeAt(0) <= 31));
}

function canonicalArchivePath(value: unknown): value is string {
  return typeof value === "string" &&
    /^\.harness\/archive\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    value === value.normalize("NFC");
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = rfc3339.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    Number.isFinite(Date.parse(value));
}

function validReceipt(value: Record<string, unknown>): value is Record<string, unknown> &
  LocalArchiveReceipt {
  return Object.keys(value).every((key) => receiptKeys.has(key)) &&
    Object.keys(value).length === receiptKeys.size && value.schema_version === 1 &&
    typeof value.operation_id === "string" && operationId.test(value.operation_id) &&
    canonicalChangeIdentity(value.change_identity) &&
    (["completed", "abandoned", "superseded"] as ClosureDisposition[])
      .includes(value.closure_disposition as ClosureDisposition) &&
    (["release_candidate", "record_only"] as ArchiveIntent[])
      .includes(value.archive_intent as ArchiveIntent) &&
    typeof value.source_snapshot_hash === "string" && sha256.test(value.source_snapshot_hash) &&
    value.archive_schema_version === 1 &&
    canonicalArchivePath(value.archive_path) &&
    typeof value.archive_manifest_hash === "string" && sha256.test(value.archive_manifest_hash) &&
    validTimestamp(value.completed_at);
}

export function normalizeArchiveRecord(input: unknown): ArchiveRecordReadResult {
  if (!record(input)) return { ok: false, reason_code: "ARCHIVE_RECORD_INVALID" };
  if (input.schema_version === 1) {
    if (!validReceipt(input)) return { ok: false, reason_code: "ARCHIVE_RECORD_INVALID" };
    return deepFreeze({
      ok: true,
      source_schema_version: 1,
      readiness: "ready",
      receipt: {
        schema_version: 1,
        operation_id: input.operation_id,
        change_identity: input.change_identity,
        closure_disposition: input.closure_disposition,
        archive_intent: input.archive_intent,
        source_snapshot_hash: input.source_snapshot_hash,
        archive_schema_version: 1,
        archive_path: input.archive_path,
        archive_manifest_hash: input.archive_manifest_hash,
        completed_at: input.completed_at
      }
    });
  }
  if (input.schemaVersion === 0) {
    if (!nonempty(input.changeName) || !nonempty(input.archivePath) ||
        !validTimestamp(input.archivedAt)) {
      return { ok: false, reason_code: "ARCHIVE_RECORD_INVALID" };
    }
    return {
      ok: true,
      source_schema_version: 0,
      readiness: "unavailable",
      legacy: {
        change_identity: input.changeName,
        archive_path: input.archivePath,
        completed_at: input.archivedAt
      },
      reason_codes: [
        "LEGACY_OPERATION_ID_UNKNOWN",
        "LEGACY_SOURCE_SNAPSHOT_UNKNOWN",
        "LEGACY_CLOSURE_POLICY_UNKNOWN",
        "LEGACY_MANIFEST_IDENTITY_UNKNOWN"
      ]
    };
  }
  return { ok: false, reason_code: "ARCHIVE_RECORD_VERSION_UNSUPPORTED" };
}

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && sha256.test(value);
}
