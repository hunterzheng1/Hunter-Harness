import { isProxy } from "node:util/types";

import { stableLocalArchiveAuthorityHash } from "./stable.js";
import type { LocalArchiveAuthorityLease, LocalArchiveAuthorityRecord, LocalArchiveAuthorityRecordReadResult } from "./types.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_KINDS = ["register", "claim", "acknowledge", "cleanup_claim", "cleanup_complete", "recover"] as const;
const RECORD_KEYS = ["schema_version", "entry_id", "authority_id", "project_id", "ref_id", "package_sha256", "size_bytes",
  "archive_id", "trusted_package_receipt_hash", "local_archive_receipt_hash", "manifest_hash", "inventory_hash",
  "core_v2_projection_hash", "verification_hash",
  "storage_kind", "binding_hash", "state", "generation", "lease", "durable_receipt_hash", "cleanup", "last_operation",
  "created_at", "updated_at", "record_hash"] as const;
const encoder = new TextEncoder();
const MAX_KEY_BYTES = 512;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_SERIALIZED_BYTES = 2_097_152;

function snapshotBoundedData(value: unknown): unknown {
  const seen = new WeakSet<object>(); let nodes = 0; let textBytes = 0;
  const accountText = (input: string, maximum: number): void => {
    if (input.length > maximum) throw new Error();
    const bytes = encoder.encode(input).byteLength;
    if (bytes > maximum || (textBytes += bytes) > MAX_TEXT_BYTES) throw new Error();
  };
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      accountText(input, 65_536);
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error();
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || depth > 24 || ++nodes > 8_192 || seen.has(input)) throw new Error();
    seen.add(input);
    const array = Array.isArray(input); const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    for (const key of keys as string[]) {
      if (key.length === 0 || key.length > MAX_KEY_BYTES || !/^[\x20-\x7e]+$/u.test(key)) throw new Error();
      accountText(key, MAX_KEY_BYTES);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          (array && key === "length" ? false : descriptor.enumerable !== true)) throw new Error();
    }
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 4_096 || keys.length !== length + 1) throw new Error();
      return Array.from({ length }, (_, index) => copy((descriptors[String(index)] as PropertyDescriptor).value, depth + 1));
    }
    return Object.fromEntries((keys as string[]).map((key) =>
      [key, copy((descriptors[key] as PropertyDescriptor).value, depth + 1)]));
  };
  const result = copy(value, 0);
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_SERIALIZED_BYTES) throw new Error();
  const freeze = (input: unknown): void => {
    if (input !== null && typeof input === "object") {
      for (const child of Object.values(input)) freeze(child);
      Object.freeze(input);
    }
  };
  freeze(result);
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function plainDataRecord(value: unknown, exactKeys?: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) return false;
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return false;
  }
  return exactKeys === undefined || keys.length === exactKeys.length && exactKeys.every((key) => Object.hasOwn(descriptors, key));
}

function lease(value: unknown): boolean {
  return value === null || plainDataRecord(value, ["owner_id", "capability_hash", "fencing_token", "acquired_at", "expires_at"]) &&
    typeof value.owner_id === "string" && value.owner_id.length > 0 && value.owner_id.length <= 160 &&
    typeof value.capability_hash === "string" && SHA.test(value.capability_hash) &&
    typeof value.fencing_token === "number" && Number.isSafeInteger(value.fencing_token) && value.fencing_token > 0 &&
    instant(value.acquired_at) && instant(value.expires_at) &&
    Date.parse(value.expires_at) > Date.parse(value.acquired_at);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validRecord(value: unknown): value is LocalArchiveAuthorityRecord {
  if (!plainDataRecord(value, RECORD_KEYS) || value.schema_version !== 2 ||
      typeof value.entry_id !== "string" || !value.entry_id.startsWith("local_archive_authority_entry:") || value.entry_id.length > 240 ||
      typeof value.authority_id !== "string" || value.authority_id.length === 0 || value.authority_id.length > 240 ||
      typeof value.project_id !== "string" || value.project_id.length === 0 || value.project_id.length > 240 ||
      typeof value.ref_id !== "string" || value.ref_id.length === 0 || value.ref_id.length > 240 ||
      typeof value.package_sha256 !== "string" || !SHA.test(value.package_sha256) || typeof value.size_bytes !== "number" ||
      !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0 || value.size_bytes > 536_870_912 ||
      typeof value.archive_id !== "string" || value.archive_id.length === 0 || value.archive_id.length > 240 ||
      typeof value.trusted_package_receipt_hash !== "string" || !SHA.test(value.trusted_package_receipt_hash) ||
      typeof value.local_archive_receipt_hash !== "string" || !SHA.test(value.local_archive_receipt_hash) ||
      typeof value.manifest_hash !== "string" || !SHA.test(value.manifest_hash) ||
      typeof value.inventory_hash !== "string" || !SHA.test(value.inventory_hash) ||
      typeof value.core_v2_projection_hash !== "string" || !SHA.test(value.core_v2_projection_hash) ||
      typeof value.verification_hash !== "string" || !SHA.test(value.verification_hash) ||
      value.storage_kind !== "project_state_cas" || typeof value.binding_hash !== "string" || !SHA.test(value.binding_hash) ||
      !["available", "leased", "acknowledged"].includes(value.state as string) ||
      typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0 || !lease(value.lease) ||
      value.durable_receipt_hash !== null && (typeof value.durable_receipt_hash !== "string" || !SHA.test(value.durable_receipt_hash)) ||
      !plainDataRecord(value.cleanup, ["state", "generation", "lease"]) ||
      !["not_allowed", "allowed", "claimed", "pending_retry", "completed"].includes(value.cleanup.state as string) ||
      typeof value.cleanup.generation !== "number" || !Number.isSafeInteger(value.cleanup.generation) || !lease(value.cleanup.lease) ||
      !instant(value.created_at) || !instant(value.updated_at) ||
      Date.parse(value.updated_at) < Date.parse(value.created_at) || typeof value.record_hash !== "string" || !SHA.test(value.record_hash)) return false;
  const operationValid = value.last_operation === null || plainDataRecord(value.last_operation, ["operation_id", "kind", "intent_hash"]) &&
    typeof value.last_operation.operation_id === "string" && value.last_operation.operation_id.startsWith("local_archive_authority_operation:") &&
    value.last_operation.operation_id.length <= 248 && OPERATION_KINDS.includes(value.last_operation.kind as never) &&
    typeof value.last_operation.intent_hash === "string" && SHA.test(value.last_operation.intent_hash);
  if (!operationValid) return false;
  const lastOperation = value.last_operation as LocalArchiveAuthorityRecord["last_operation"];
  const bindingHash = stableLocalArchiveAuthorityHash({ authority_id: value.authority_id, project_id: value.project_id,
    ref_id: value.ref_id, package_sha256: value.package_sha256, size_bytes: value.size_bytes,
    verification_hash: value.verification_hash });
  if (value.binding_hash !== bindingHash || value.entry_id !== `local_archive_authority_entry:${bindingHash.slice(7)}`) return false;
  if ((value.state === "leased") !== (value.lease !== null) ||
      value.lease !== null && value.generation !== (value.lease as LocalArchiveAuthorityLease).fencing_token ||
      (value.state === "acknowledged") !== (value.durable_receipt_hash !== null) ||
      (value.state !== "acknowledged" && value.cleanup.state !== "not_allowed") ||
      (["claimed", "pending_retry"].includes(String(value.cleanup.state))) !== (value.cleanup.lease !== null) ||
      value.cleanup.lease !== null && value.cleanup.generation !== (value.cleanup.lease as LocalArchiveAuthorityLease).fencing_token ||
      (["not_allowed", "allowed"].includes(String(value.cleanup.state)) && value.cleanup.generation !== 0) ||
      (["claimed", "pending_retry", "completed"].includes(String(value.cleanup.state)) && value.cleanup.generation < 1)) return false;
  if (lastOperation !== null) {
    const closed = lastOperation.kind === "register" && value.state === "available" ||
      lastOperation.kind === "claim" && value.state === "leased" ||
      lastOperation.kind === "recover" && value.state === "available" ||
      lastOperation.kind === "acknowledge" && value.state === "acknowledged" && value.cleanup.state === "allowed" ||
      lastOperation.kind === "cleanup_claim" && value.state === "acknowledged" && value.cleanup.state === "claimed" ||
      lastOperation.kind === "cleanup_complete" && value.state === "acknowledged" &&
        ["pending_retry", "completed"].includes(String(value.cleanup.state));
    if (!closed) return false;
  }
  const { record_hash: recordHash, ...body } = value;
  return recordHash === stableLocalArchiveAuthorityHash(body);
}

export function normalizeLocalArchiveAuthorityRecord(value: unknown): LocalArchiveAuthorityRecordReadResult {
  let snapshot: unknown;
  try { snapshot = snapshotBoundedData(value); }
  catch { return deepFreeze({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" }); }
  if (!plainDataRecord(snapshot)) return deepFreeze({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
  if (snapshot.schema_version === 1) {
    if (!plainDataRecord(snapshot, ["schema_version", "project_id", "ref_id", "package_sha256"]) ||
        typeof snapshot.project_id !== "string" || snapshot.project_id.length === 0 || snapshot.project_id.length > 240 ||
        typeof snapshot.ref_id !== "string" || snapshot.ref_id.length === 0 || snapshot.ref_id.length > 240 ||
        typeof snapshot.package_sha256 !== "string" || !SHA.test(snapshot.package_sha256))
      return deepFreeze({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
    return deepFreeze({ ok: true, source_schema_version: 1, readiness: "legacy_read_only",
      legacy: { project_id: snapshot.project_id, ref_id: snapshot.ref_id, package_sha256: snapshot.package_sha256 as `sha256:${string}` },
      reason_codes: ["LEGACY_LOCAL_AUTHORITY_FENCE_UNKNOWN", "LEGACY_LOCAL_AUTHORITY_CLEANUP_UNKNOWN"] as const });
  }
  if (snapshot.schema_version !== 2) return deepFreeze({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_VERSION_UNSUPPORTED" });
  return validRecord(snapshot) ? deepFreeze({ ok: true, source_schema_version: 2, readiness: "ready", record: snapshot }) :
    deepFreeze({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
}

export function serializeLocalArchiveAuthorityRecord(record: LocalArchiveAuthorityRecord): string {
  const normalized = normalizeLocalArchiveAuthorityRecord(record);
  if (!normalized.ok || normalized.readiness !== "ready") throw new Error("LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID");
  return `${JSON.stringify(normalized.record)}\n`;
}
