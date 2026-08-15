import { isProxy } from "node:util/types";

import { remoteArchiveV2StableHash } from "./stable.js";
import {
  REMOTE_ARCHIVE_V2_MAX_LEASE_TTL_MS,
  REMOTE_ARCHIVE_V2_MAX_PACKAGE_BYTES,
  type RemoteArchiveV2CanonicalMetadata,
  type RemoteArchiveV2Claim,
  type RemoteArchiveV2PrepareInput,
  type RemoteArchiveV2Record,
  type RemoteArchiveV2RecordReadResult,
  type RemoteArchiveV2Source
} from "./types.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const MAX_BYTES = 65_536;

export function remoteArchiveV2Snapshot(value: unknown): unknown {
  const seen = new WeakSet<object>(); let nodes = 0; let text = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") { text += input.length; if (input.length > 8_192 || text > 32_768) throw new Error(); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error(); return input; }
    if (typeof input !== "object" || isProxy(input) || depth > 16 || ++nodes > 2_048 || seen.has(input)) throw new Error();
    seen.add(input); const array = Array.isArray(input); const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    for (const key of keys as string[]) { const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          (array && key === "length" ? false : descriptor.enumerable !== true)) throw new Error(); }
    if (array) { const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 128 || keys.length !== length + 1) throw new Error();
      return Array.from({ length }, (_, index) => copy((descriptors[String(index)] as PropertyDescriptor).value, depth + 1)); }
    return Object.fromEntries((keys as string[]).map((key) => [key, copy((descriptors[key] as PropertyDescriptor).value, depth + 1)]));
  };
  const result = copy(value, 0); if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES) throw new Error(); return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value); return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function bounded(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    [...value].every((character) => { const point = character.codePointAt(0) ?? 0; return point > 0x1f && point !== 0x7f; });
}
function sha(value: unknown): boolean { return typeof value === "string" && SHA.test(value); }
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function validRemoteArchiveV2Source(value: unknown): value is RemoteArchiveV2Source {
  return record(value) && exact(value, ["project_id", "branch_name", "actor_id"], ["commit_sha", "client_id", "change_key"]) &&
    bounded(value.project_id) && bounded(value.branch_name) && bounded(value.actor_id) &&
    (value.commit_sha === undefined || bounded(value.commit_sha)) && (value.client_id === undefined || bounded(value.client_id)) &&
    (value.change_key === undefined || bounded(value.change_key));
}

export function validRemoteArchiveV2Metadata(value: unknown): value is RemoteArchiveV2CanonicalMetadata {
  if (!record(value) || !exact(value, ["schema_version", "source", "archive_id", "identities", "upload_ref"]) ||
      value.schema_version !== 2 || !validRemoteArchiveV2Source(value.source) || !bounded(value.archive_id) ||
      !record(value.identities) || !exact(value.identities, ["package_sha256", "package_size_bytes", "archive_schema_version",
        "trusted_package_receipt_hash", "local_archive_receipt_hash", "manifest_hash", "inventory_hash", "core_v2_projection_hash"]) ||
      !sha(value.identities.package_sha256) || !Number.isSafeInteger(value.identities.package_size_bytes) ||
      Number(value.identities.package_size_bytes) < 1 || Number(value.identities.package_size_bytes) > REMOTE_ARCHIVE_V2_MAX_PACKAGE_BYTES ||
      value.identities.archive_schema_version !== 1 || !sha(value.identities.trusted_package_receipt_hash) ||
      !sha(value.identities.local_archive_receipt_hash) || !sha(value.identities.manifest_hash) ||
      !sha(value.identities.inventory_hash) || !sha(value.identities.core_v2_projection_hash) ||
      !record(value.upload_ref) || !exact(value.upload_ref, ["ref_id", "sha256", "size_bytes"]) ||
      !bounded(value.upload_ref.ref_id, 240) || !sha(value.upload_ref.sha256) || !Number.isSafeInteger(value.upload_ref.size_bytes)) return false;
  return value.upload_ref.sha256 === value.identities.package_sha256 && value.upload_ref.size_bytes === value.identities.package_size_bytes;
}

export function snapshotRemoteArchiveV2Prepare(value: unknown): RemoteArchiveV2PrepareInput {
  let safe: unknown; try { safe = remoteArchiveV2Snapshot(value); } catch { throw new Error("REMOTE_ARCHIVE_INPUT_INVALID"); }
  if (!record(safe) || !exact(safe, ["schema_version", "operation_id", "idempotency_key", "payload_hash", "lease_ttl_ms", "metadata"]) ||
      safe.schema_version !== 2 || !bounded(safe.operation_id, 240) || !String(safe.operation_id).startsWith("remote_archive_operation:") ||
      !sha(safe.idempotency_key) || !sha(safe.payload_hash) || !Number.isSafeInteger(safe.lease_ttl_ms) ||
      Number(safe.lease_ttl_ms) < 1 || Number(safe.lease_ttl_ms) > REMOTE_ARCHIVE_V2_MAX_LEASE_TTL_MS ||
      !validRemoteArchiveV2Metadata(safe.metadata)) throw new Error("REMOTE_ARCHIVE_INPUT_INVALID");
  return safe as unknown as RemoteArchiveV2PrepareInput;
}

export function snapshotRemoteArchiveV2Claim(value: unknown): RemoteArchiveV2Claim {
  let safe: unknown; try { safe = remoteArchiveV2Snapshot(value); } catch { throw new Error("REMOTE_ARCHIVE_INPUT_INVALID"); }
  if (!record(safe) || !exact(safe, ["operation_id", "prepare_id", "source", "generation", "fencing_token", "capability"]) ||
      !bounded(safe.operation_id, 240) || !bounded(safe.prepare_id, 240) || !validRemoteArchiveV2Source(safe.source) ||
      !Number.isSafeInteger(safe.generation) || !Number.isSafeInteger(safe.fencing_token) || !bounded(safe.capability, 240))
    throw new Error("REMOTE_ARCHIVE_INPUT_INVALID");
  return safe as unknown as RemoteArchiveV2Claim;
}

export function remoteArchiveV2PayloadHash(metadata: RemoteArchiveV2CanonicalMetadata): `sha256:${string}` {
  let safe: unknown; try { safe = remoteArchiveV2Snapshot(metadata); } catch { throw new Error("REMOTE_ARCHIVE_INPUT_INVALID"); }
  if (!validRemoteArchiveV2Metadata(safe)) throw new Error("REMOTE_ARCHIVE_INPUT_INVALID");
  return remoteArchiveV2StableHash(safe);
}

export function sameRemoteArchiveV2Source(left: RemoteArchiveV2Source, right: RemoteArchiveV2Source): boolean {
  return remoteArchiveV2StableHash(left) === remoteArchiveV2StableHash(right);
}

export function normalizeRemoteArchiveV2Record(value: unknown): RemoteArchiveV2RecordReadResult {
  let safe: unknown; try { safe = remoteArchiveV2Snapshot(value); } catch { return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" }; }
  if (!record(safe)) return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  if (safe.schema_version === 1) {
    if (!exact(safe, ["schema_version", "request_id", "package_sha256", "archive_status"]) ||
        !bounded(safe.request_id, 240) || !sha(safe.package_sha256) || !bounded(safe.archive_status))
      return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
    return { ok: true, source_schema_version: 1, readiness: "legacy_read_only",
      legacy: { request_id: safe.request_id, package_sha256: safe.package_sha256 as `sha256:${string}`, archive_status: safe.archive_status },
      reason_codes: ["LEGACY_ARCHIVE_OPERATION_UNKNOWN", "LEGACY_ARCHIVE_PAYLOAD_HASH_UNKNOWN"] };
  }
  if (safe.schema_version !== 2) return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_VERSION_UNSUPPORTED" };
  const keys = ["schema_version", "operation_id", "prepare_id", "idempotency_key", "payload_hash", "source", "archive_id",
    "identities", "upload_ref", "state", "generation", "lease", "receipt", "failure_code", "created_at", "updated_at", "record_hash"];
  const metadata = { schema_version: 2 as const, source: safe.source, archive_id: safe.archive_id,
    identities: safe.identities, upload_ref: safe.upload_ref };
  if (!exact(safe, keys) || !bounded(safe.operation_id, 240) || !String(safe.operation_id).startsWith("remote_archive_operation:") ||
      !bounded(safe.prepare_id, 240) || !String(safe.prepare_id).startsWith("remote_archive_prepare:sha256:") ||
      !sha(safe.idempotency_key) || !sha(safe.payload_hash) || !validRemoteArchiveV2Metadata(metadata) ||
      safe.payload_hash !== remoteArchiveV2StableHash(metadata) ||
      !["pending", "prepared", "committing", "committed", "failed"].includes(String(safe.state)) ||
      !Number.isSafeInteger(safe.generation) || Number(safe.generation) < 0 || !instant(safe.created_at) ||
      !instant(safe.updated_at) || Date.parse(safe.updated_at) < Date.parse(safe.created_at) || !sha(safe.record_hash))
    return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  const prepareHash = remoteArchiveV2StableHash({ operation_id: safe.operation_id, idempotency_key: safe.idempotency_key,
    payload_hash: safe.payload_hash });
  if (safe.prepare_id !== `remote_archive_prepare:${prepareHash}`) return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  if (safe.lease !== null) {
    if (!record(safe.lease) || !exact(safe.lease, ["project_id", "branch_name", "actor_id", "capability_hash", "fencing_token",
      "acquired_at", "expires_at"]) || safe.lease.project_id !== metadata.source.project_id ||
        safe.lease.branch_name !== metadata.source.branch_name || safe.lease.actor_id !== metadata.source.actor_id ||
        !sha(safe.lease.capability_hash) || !Number.isSafeInteger(safe.lease.fencing_token) || Number(safe.lease.fencing_token) < 1 ||
        !instant(safe.lease.acquired_at) || !instant(safe.lease.expires_at) ||
        Date.parse(safe.lease.acquired_at) < Date.parse(safe.created_at) ||
        Date.parse(safe.lease.expires_at) <= Date.parse(safe.lease.acquired_at) ||
        Date.parse(safe.lease.expires_at) - Date.parse(safe.lease.acquired_at) > REMOTE_ARCHIVE_V2_MAX_LEASE_TTL_MS)
      return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  } else if (["prepared", "committing", "committed"].includes(String(safe.state))) {
    return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  }
  if (safe.receipt !== null) {
    if (!record(safe.receipt) || !exact(safe.receipt, ["schema_version", "receipt_id", "operation_id", "prepare_id", "idempotency_key",
      "payload_hash", "source", "archive_id", "package_sha256", "package_size_bytes", "manifest_hash",
      "trusted_package_receipt_hash", "local_archive_receipt_hash", "inventory_hash", "core_v2_projection_hash", "stored_at", "receipt_hash"]))
      return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
    const { receipt_hash: receiptHash, receipt_id: receiptId, ...receiptBody } = safe.receipt;
    const expectedReceiptHash = remoteArchiveV2StableHash(receiptBody);
    if (safe.state !== "committed" || receiptHash !== expectedReceiptHash || receiptId !== `remote_archive_receipt:${expectedReceiptHash}` ||
        safe.receipt.operation_id !== safe.operation_id || safe.receipt.prepare_id !== safe.prepare_id ||
        safe.receipt.idempotency_key !== safe.idempotency_key || safe.receipt.payload_hash !== safe.payload_hash ||
        remoteArchiveV2StableHash(safe.receipt.source) !== remoteArchiveV2StableHash(metadata.source) ||
        safe.receipt.archive_id !== safe.archive_id || safe.receipt.package_sha256 !== metadata.identities.package_sha256 ||
        safe.receipt.package_size_bytes !== metadata.identities.package_size_bytes ||
        safe.receipt.manifest_hash !== metadata.identities.manifest_hash ||
        safe.receipt.trusted_package_receipt_hash !== metadata.identities.trusted_package_receipt_hash ||
        safe.receipt.local_archive_receipt_hash !== metadata.identities.local_archive_receipt_hash ||
        safe.receipt.inventory_hash !== metadata.identities.inventory_hash ||
        safe.receipt.core_v2_projection_hash !== metadata.identities.core_v2_projection_hash || !instant(safe.receipt.stored_at) ||
        Date.parse(safe.receipt.stored_at) < Date.parse(safe.created_at) || Date.parse(safe.receipt.stored_at) > Date.parse(safe.updated_at))
      return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  } else if (safe.state === "committed") return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  if ((safe.state === "failed") !== (safe.failure_code !== null) ||
      safe.state === "failed" && safe.failure_code !== "REMOTE_ARCHIVE_PREPARE_EXPIRED" ||
      safe.state === "pending" && (safe.lease !== null || safe.receipt !== null || safe.generation !== 0) ||
      safe.state === "prepared" && (safe.receipt !== null || Number(safe.generation) < 1) ||
      safe.state === "committing" && (safe.receipt !== null || Number(safe.generation) < 2) ||
      safe.state === "committed" && Number(safe.generation) < 3 ||
      safe.state === "failed" && (safe.lease !== null || safe.receipt !== null || Number(safe.generation) < 2))
    return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  const { record_hash: recordHash, ...body } = safe;
  if (recordHash !== remoteArchiveV2StableHash(body)) return { ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" };
  return { ok: true, source_schema_version: 2, readiness: "ready", record: safe as unknown as RemoteArchiveV2Record };
}
