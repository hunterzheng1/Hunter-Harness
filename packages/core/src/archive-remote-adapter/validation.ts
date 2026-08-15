import { isProxy } from "node:util/types";

import {
  canonicalJson,
  readArchiveIngestReceipt
} from "@hunter-harness/contracts";

import { sha256Bytes } from "../archive-package-builder/index.js";
import { normalizeArchiveOutboxRecord, stableHash } from "../archive-outbox/index.js";
import type {
  ArchiveRemotePublishResult,
} from "./types.js";
import type {
  ArchiveOutboxAck,
  ArchiveOutboxClaim,
  ArchiveOutboxNack,
  ArchiveRetentionPolicy
} from "../archive-outbox/index.js";
import type { ArchiveSyncReceipt, SourceRef } from "../remote-sync/types.js";

const sha = /^sha256:[a-f0-9]{64}$/u;
const time = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u;
const SNAPSHOT_MAX_DEPTH = 32;
const SNAPSHOT_MAX_NODES = 100_000;
const SNAPSHOT_MAX_ARRAY_LENGTH = 16_384;
const SNAPSHOT_MAX_OBJECT_KEYS = 4_096;
const SNAPSHOT_MAX_STRING_CODE_UNITS = 1_048_576;
const SNAPSHOT_MAX_STRING_BYTES = 1_048_576;
const SNAPSHOT_MAX_TOTAL_STRING_CODE_UNITS = 8_388_608;
const SNAPSHOT_MAX_TOTAL_STRING_BYTES = 8_388_608;

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    });
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

interface SnapshotBudget {
  count: number;
  string_code_units: number;
  string_utf8_bytes: number;
}

function safeSnapshot(value: unknown, depth = 0, budget: SnapshotBudget = {
  count: 0,
  string_code_units: 0,
  string_utf8_bytes: 0
}): unknown {
  budget.count += 1;
  if (depth > SNAPSHOT_MAX_DEPTH || budget.count > SNAPSHOT_MAX_NODES) {
    throw new Error("unsafe snapshot");
  }
  if (typeof value === "string") {
    if (value.length > SNAPSHOT_MAX_STRING_CODE_UNITS ||
        budget.string_code_units + value.length > SNAPSHOT_MAX_TOTAL_STRING_CODE_UNITS) {
      throw new Error("unsafe snapshot");
    }
    budget.string_code_units += value.length;
    const utf8Bytes = Buffer.byteLength(value, "utf8");
    if (utf8Bytes > SNAPSHOT_MAX_STRING_BYTES ||
        budget.string_utf8_bytes + utf8Bytes > SNAPSHOT_MAX_TOTAL_STRING_BYTES) {
      throw new Error("unsafe snapshot");
    }
    budget.string_utf8_bytes += utf8Bytes;
    return value;
  }
  if (value === null || value === undefined || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || isProxy(value)) throw new Error("unsafe snapshot");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("unsafe prototype");
  }
  const lengthDescriptor = array ? Object.getOwnPropertyDescriptor(value, "length") : undefined;
  const arrayLength = lengthDescriptor !== undefined && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown : undefined;
  if (array && (!Number.isSafeInteger(arrayLength) || (arrayLength as number) < 0 ||
      (arrayLength as number) > SNAPSHOT_MAX_ARRAY_LENGTH)) throw new Error("array length");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol property");
  if (keys.length > (array ? SNAPSHOT_MAX_ARRAY_LENGTH + 1 : SNAPSHOT_MAX_OBJECT_KEYS)) {
    throw new Error("snapshot budget");
  }
  if (array) {
    const childCount = arrayLength as number;
    if (keys.length !== childCount + 1 || keys[childCount] !== "length") {
      throw new Error("array length");
    }
    for (let index = 0; index < childCount; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (keys[index] !== key || descriptor === undefined || !("value" in descriptor) ||
          !descriptor.enumerable) {
        throw new Error("sparse array");
      }
    }
    if (budget.count + childCount > SNAPSHOT_MAX_NODES) throw new Error("snapshot budget");
    const result = new Array<unknown>(childCount);
    for (let index = 0; index < childCount; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse array");
      result[index] = safeSnapshot(descriptor.value, depth + 1, budget);
    }
    return result;
  }
  if (budget.count + keys.length > SNAPSHOT_MAX_NODES) throw new Error("snapshot budget");
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("accessor or hidden property");
    }
    result[key] = safeSnapshot(descriptor.value, depth + 1, budget);
  }
  return result;
}

function normalizeSafeRecord(value: unknown) {
  try {
    return normalizeArchiveOutboxRecord(safeSnapshot(value));
  } catch {
    return undefined;
  }
}

function trySafeSnapshot(value: unknown): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
  try {
    return Object.freeze({ ok: true as const, value: safeSnapshot(value) });
  } catch {
    return Object.freeze({ ok: false as const });
  }
}

function dataSnapshot(value: unknown, required: readonly string[], optional: readonly string[] = []):
Record<string, unknown> | undefined {
  if (!plain(value)) return undefined;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length < required.length ||
        required.some((key) => !(key in descriptors)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))) return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string" || !time.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month &&
    calendar.getUTCDate() === day;
}

function sameLease(left: Record<string, unknown>, right: ArchiveOutboxClaim["lease"]): boolean {
  const lease = dataSnapshot(left, ["token", "owner_id", "generation", "acquired_at", "expires_at"]);
  return lease !== undefined && lease.token === right.token && lease.owner_id === right.owner_id &&
    lease.generation === right.generation && lease.acquired_at === right.acquired_at &&
    lease.expires_at === right.expires_at;
}

export function snapshotCurrentClaim(value: unknown): ArchiveOutboxClaim | undefined {
  const outer = dataSnapshot(value, ["entry_id", "lease", "record"]);
  if (outer === undefined) return undefined;
  const normalized = normalizeSafeRecord(outer.record);
  if (normalized === undefined || !normalized.ok || normalized.readiness !== "ready") return undefined;
  const record = normalized.record;
  if (record.state !== "leased" || record.lease === null || outer.entry_id !== record.entry_id ||
      !plain(outer.lease) || !sameLease(outer.lease, record.lease)) return undefined;
  return Object.freeze({
    entry_id: record.entry_id,
    lease: Object.freeze({ ...record.lease }),
    record
  });
}

export function snapshotSource(value: unknown, claim: ArchiveOutboxClaim): SourceRef | undefined {
  const source = dataSnapshot(value, ["project_id", "branch_name", "commit_sha", "client_id"], ["change_key"]);
  if (source === undefined || source.project_id !== claim.record.project_id ||
      source.change_key !== claim.record.change_identity ||
      !/^prj_[a-z0-9._:-]+$/u.test(String(source.project_id)) || !bounded(source.branch_name) ||
      !bounded(source.commit_sha) || !/^cli_[a-z0-9._:-]+$/u.test(String(source.client_id))) return undefined;
  return Object.freeze({
    project_id: source.project_id as string,
    branch_name: source.branch_name as string,
    commit_sha: source.commit_sha as string,
    client_id: source.client_id as string,
    change_key: source.change_key as string
  });
}

export function validRetention(value: unknown): value is ArchiveRetentionPolicy {
  return value === "retain" || value === "cleanup_after_durable_ack";
}

export function projectIngestReceipt(value: unknown, claim: ArchiveOutboxClaim):
ArchiveSyncReceipt | undefined {
  const stage02Required = ["request_id", "idempotency_key", "project_id", "change_key", "archive_id",
    "package_sha256", "archive_status", "project_version", "stored_at", "retryable"];
  const stage02 = dataSnapshot(value, stage02Required, ["reason_code"]);
  const parsedIngest = stage02 === undefined ? readArchiveIngestReceipt(value) : undefined;
  const ingest = parsedIngest?.ok === true ? parsedIngest.value : undefined;
  const remoteIdempotency = sha256Bytes(new TextEncoder().encode(canonicalJson({
    project_id: claim.record.project_id,
    change_key: claim.record.change_identity,
    archive_schema_version: claim.record.archive_schema_version,
    package_sha256: claim.record.package_sha256,
    archive_id: claim.record.archive_id
  })));
  if (ingest !== undefined) {
    if (ingest.request_id !== claim.record.request_id || ingest.project_id !== claim.record.project_id ||
        ingest.idempotency_key !== claim.record.idempotency_key ||
        ingest.change_key !== claim.record.change_identity || ingest.archive_id !== claim.record.archive_id ||
        ingest.package_sha256 !== claim.record.package_sha256 ||
        ingest.manifest_sha256 !== claim.record.manifest_sha256 ||
        !/^pv_[a-z0-9._:-]+$/u.test(ingest.project_version) || !validTime(ingest.stored_at) ||
        ingest.archive_status.status !== "stored" || ingest.archive_status.retryable !== false ||
        ingest.retryable !== false) return undefined;
    return Object.freeze({
      request_id: ingest.request_id,
      idempotency_key: claim.record.idempotency_key,
      project_id: ingest.project_id,
      archive_id: ingest.archive_id,
      change_key: ingest.change_key,
      package_sha256: ingest.package_sha256,
      archive_status: "stored" as const,
      project_version: ingest.project_version,
      stored_at: ingest.stored_at,
      retryable: false
    });
  }
  if (stage02 === undefined || stage02.request_id !== claim.record.request_id ||
      stage02.idempotency_key !== remoteIdempotency || stage02.project_id !== claim.record.project_id ||
      stage02.change_key !== claim.record.change_identity || stage02.archive_id !== claim.record.archive_id ||
      stage02.package_sha256 !== claim.record.package_sha256 || !sha.test(String(stage02.package_sha256)) ||
      !/^pv_[a-z0-9._:-]+$/u.test(String(stage02.project_version)) || !validTime(stage02.stored_at)) {
    return undefined;
  }
  const stored = stage02.archive_status === "stored" && stage02.retryable === false &&
    stage02.reason_code === undefined;
  const failed = stage02.archive_status === "failed" && stage02.retryable === true &&
    (stage02.reason_code === "REMOTE_UNAVAILABLE" || stage02.reason_code === "ARCHIVE_PUBLISH_FAILED");
  if (!stored && !failed) return undefined;
  return Object.freeze({
    request_id: stage02.request_id as string,
    idempotency_key: claim.record.idempotency_key,
    project_id: stage02.project_id as string,
    archive_id: stage02.archive_id as string,
    change_key: stage02.change_key as string,
    package_sha256: stage02.package_sha256 as string,
    archive_status: stored ? "stored" as const : "failed" as const,
    project_version: stage02.project_version as string,
    stored_at: stage02.stored_at,
    retryable: stored ? false : true,
    ...(stage02.reason_code === undefined ? {} : {
      reason_code: stage02.reason_code as "REMOTE_UNAVAILABLE" | "ARCHIVE_PUBLISH_FAILED"
    })
  });
}

const transitionFields = new Set([
  "state", "generation", "lease", "next_attempt_at", "last_reason_code", "durable_receipt",
  "updated_at", "record_hash"
]);

function stableBase(value: Record<string, unknown>): `sha256:${string}` {
  return stableHash(Object.fromEntries(Object.entries(value).filter(([key]) => !transitionFields.has(key))));
}

function validRecordSuccessor(value: unknown, claim: ArchiveOutboxClaim):
ArchiveOutboxAck["record"] | undefined {
  const normalized = normalizeSafeRecord(value);
  if (normalized === undefined || !normalized.ok || normalized.readiness !== "ready" ||
      stableBase(normalized.record as unknown as Record<string, unknown>) !==
        stableBase(claim.record as unknown as Record<string, unknown>) ||
      normalized.record.generation !== claim.record.generation + 1 ||
      normalized.record.attempt_count !== claim.record.attempt_count ||
      normalized.record.created_at !== claim.record.created_at) return undefined;
  return normalized.record;
}

export function validateAckTransition(value: unknown, claim: ArchiveOutboxClaim,
  receipt: ArchiveSyncReceipt, policy: ArchiveRetentionPolicy): ArchiveOutboxAck | undefined {
  const result = dataSnapshot(value, ["record", "retention"]);
  if (result === undefined) return undefined;
  const record = validRecordSuccessor(result.record, claim);
  if (record === undefined || record.state !== "acknowledged" || record.lease !== null ||
      record.next_attempt_at !== null || record.last_reason_code !== null ||
      record.durable_receipt === null || stableHash(record.durable_receipt) !== stableHash(receipt) ||
      !validTime(record.updated_at) ||
      new Date(record.updated_at).getTime() < new Date(claim.record.updated_at).getTime()) return undefined;
  const retention = dataSnapshot(result.retention, ["schema_version", "entry_id", "record_generation",
    "disposition", "reason_code", "local_zip_ref", "evaluated_at"]);
  const local = retention === undefined ? undefined : dataSnapshot(retention.local_zip_ref,
    ["ref_id", "package_sha256", "size_bytes"]);
  const cleanup = policy === "cleanup_after_durable_ack";
  if (retention === undefined || local === undefined || retention.schema_version !== 1 ||
      retention.entry_id !== claim.entry_id || retention.record_generation !== record.generation ||
      retention.disposition !== (cleanup ? "cleanup_allowed" : "retain") ||
      retention.reason_code !== (cleanup ? "OUTBOX_DURABLE_ACKNOWLEDGED" : "OUTBOX_POLICY_RETAINS_ZIP") ||
      retention.evaluated_at !== record.updated_at || stableHash(local) !== stableHash(claim.record.local_zip_ref)) {
    return undefined;
  }
  const projectedRetention = Object.freeze({
    schema_version: 1 as const,
    entry_id: claim.entry_id,
    record_generation: record.generation,
    disposition: cleanup ? "cleanup_allowed" as const : "retain" as const,
    reason_code: cleanup ? "OUTBOX_DURABLE_ACKNOWLEDGED" as const : "OUTBOX_POLICY_RETAINS_ZIP" as const,
    local_zip_ref: Object.freeze({ ...claim.record.local_zip_ref }),
    evaluated_at: record.updated_at
  });
  return Object.freeze({ record, retention: projectedRetention });
}

export function validateNackTransition(value: unknown, claim: ArchiveOutboxClaim,
  reasonCode: string, retryable: boolean): ArchiveOutboxNack | undefined {
  const result = dataSnapshot(value, ["record", "retry_at"]);
  if (result === undefined) return undefined;
  const record = validRecordSuccessor(result.record, claim);
  if (record === undefined || record.lease !== null || record.durable_receipt !== null ||
      record.last_reason_code !== reasonCode || !validTime(record.updated_at) ||
      new Date(record.updated_at).getTime() < new Date(claim.record.updated_at).getTime()) return undefined;
  if (record.state === "retry_wait") {
    if (!retryable || typeof result.retry_at !== "string" || result.retry_at !== record.next_attempt_at ||
        !validTime(result.retry_at) || new Date(result.retry_at).getTime() <= new Date(record.updated_at).getTime()) {
      return undefined;
    }
  } else if (record.state === "dead_letter") {
    if (result.retry_at !== null || record.next_attempt_at !== null) return undefined;
  } else {
    return undefined;
  }
  return Object.freeze({ record, retry_at: result.retry_at as string | null });
}

/** Snapshots and validates the complete result emitted by an ArchiveRemoteAdapter. */
export function snapshotArchiveRemotePublishResult(
  value: unknown,
  claimValue: ArchiveOutboxClaim,
  policy: ArchiveRetentionPolicy
): ArchiveRemotePublishResult | undefined {
  const claim = snapshotCurrentClaim(claimValue);
  if (claim === undefined || !validRetention(policy)) return undefined;
  let safeValue: unknown;
  try {
    safeValue = safeSnapshot(value);
  } catch {
    return undefined;
  }
  const outer = dataSnapshot(safeValue,
    ["outcome", "sync_receipt", "ack", "cleanup_intent"]);
  if (outer !== undefined && outer.outcome === "stored") {
    const receipt = projectIngestReceipt(outer.sync_receipt, claim);
    const ack = receipt === undefined ? undefined : validateAckTransition(outer.ack, claim, receipt, policy);
    if (receipt === undefined || ack === undefined ||
        stableHash(outer.cleanup_intent) !== stableHash(ack.retention)) return undefined;
    return Object.freeze({ outcome: "stored", sync_receipt: receipt, ack,
      cleanup_intent: ack.retention });
  }
  const rejected = dataSnapshot(safeValue, ["outcome", "reason_code", "nack", "cleanup_intent"]);
  if (rejected === undefined ||
      (rejected.outcome !== "retry_scheduled" && rejected.outcome !== "dead_letter") ||
      !bounded(rejected.reason_code) || rejected.cleanup_intent !== null) return undefined;
  const nack = validateNackTransition(rejected.nack, claim, rejected.reason_code,
    rejected.outcome === "retry_scheduled");
  if (nack === undefined || (nack.retry_at === null) !== (rejected.outcome === "dead_letter")) return undefined;
  return Object.freeze({ outcome: rejected.outcome, reason_code: rejected.reason_code, nack,
    cleanup_intent: null });
}

export { dataSnapshot };

export const archiveRemoteValidationInternals = Object.freeze({ trySafeSnapshot });
