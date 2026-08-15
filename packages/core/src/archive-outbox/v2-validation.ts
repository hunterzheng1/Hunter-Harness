import { randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";

import { normalizeArchivePackageRecord } from "../archive-package-builder/index.js";
import { sha256Bytes } from "../archive-package-builder/stable.js";
import { ArchiveOutboxError } from "./errors.js";
import { clone, deepFreeze, stableHash } from "./stable.js";
import {
  durableReceipt,
  enqueueIdentity,
  localZip,
  reasonCode,
  validPackageVerificationEvidence,
  validTime
} from "./validation.js";
import type {
  ArchiveOutboxEnqueueInput,
  ArchiveOutboxRecord,
  ArchiveOutboxState,
  LocalArchiveZipRef
} from "./types.js";
import type {
  ArchiveOutboxV2Capability,
  ArchiveOutboxV2Claim,
  ArchiveOutboxV2CleanupState,
  ArchiveOutboxV2Lease,
  ArchiveOutboxV2OperationId,
  ArchiveOutboxV2Record,
  ArchiveOutboxV2Sha256,
  ArchiveOutboxV2TransitionKind,
  ArchiveOutboxV2TransitionOperation,
  ArchiveOutboxV2TransitionSnapshot
} from "./v2-types.js";

export const V2_SHA256 = /^sha256:[a-f0-9]{64}$/u;
export const V2_ENTRY_ID = /^archive_outbox:[a-f0-9]{64}$/u;
export const V2_REQUEST_ID = /^archive_request:[a-f0-9]{64}$/u;
export const V2_OPERATION_ID = /^archive_outbox_transition:[a-z0-9][a-z0-9._:-]{0,255}$/u;
export const V2_CAPABILITY = /^archive_outbox_capability:[A-Za-z0-9_-]{43}$/u;
export const V2_IDEMPOTENCY_KEY = V2_SHA256;
export const V2_MAX_STRING_LENGTH = 4_096;
export const V2_MAX_SNAPSHOT_NODES = 100_000;
export const V2_MAX_SNAPSHOT_BYTES = 2_000_000;

type SnapshotBudget = { nodes: number; bytes: number };

function safeString(value: string): void {
  if (value.length > V2_MAX_STRING_LENGTH) throw new Error("unsafe string");
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error("unsafe string");
    }
  }
}

/**
 * Take a JSON-like descriptor snapshot without executing getters, Proxy traps,
 * custom prototypes, thenables, or user supplied methods. This is intentionally
 * separate from the v1 validator: v2 ports are a trust boundary.
 */
export function snapshotV2<T>(input: T): T {
  const budget: SnapshotBudget = { nodes: 0, bytes: 0 };
  const active = new Set<object>();

  function visit(value: unknown, depth: number): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      if (typeof value === "string") {
        safeString(value);
        budget.bytes += value.length * 2;
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("unsafe number");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || depth > 32 ||
        ++budget.nodes > V2_MAX_SNAPSHOT_NODES) throw new Error("unsafe value");
    if (active.has(value)) throw new Error("cycle");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > V2_MAX_SNAPSHOT_NODES) {
          throw new Error("unsafe array");
        }
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") {
          throw new Error("sparse array");
        }
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("array accessor");
          }
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error("custom prototype");
      }
      const keys = Reflect.ownKeys(value);
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== "string") throw new Error("symbol key");
        safeString(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("accessor");
        }
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  }

  const result = visit(input, 0);
  if (budget.bytes > V2_MAX_SNAPSHOT_BYTES) throw new Error("snapshot too large");
  return result as T;
}

export function safeSnapshot<T>(input: T, code = "ARCHIVE_OUTBOX_INPUT_INVALID"): T {
  try {
    return snapshotV2(input);
  } catch {
    throw new ArchiveOutboxError(code as "ARCHIVE_OUTBOX_INPUT_INVALID");
  }
}

export function v2CapabilityHash(capability: ArchiveOutboxV2Capability): ArchiveOutboxV2Sha256 {
  return sha256Bytes(new TextEncoder().encode(capability)) as ArchiveOutboxV2Sha256;
}

export function newV2Capability(): ArchiveOutboxV2Capability {
  return `archive_outbox_capability:${randomBytes(32).toString("base64url")}` as ArchiveOutboxV2Capability;
}

export function isV2Capability(value: unknown): value is ArchiveOutboxV2Capability {
  return typeof value === "string" && V2_CAPABILITY.test(value);
}

export function isV2Sha(value: unknown): value is ArchiveOutboxV2Sha256 {
  return typeof value === "string" && V2_SHA256.test(value);
}

export function isV2EntryId(value: unknown): value is ArchiveOutboxV2Record["entry_id"] {
  return typeof value === "string" && V2_ENTRY_ID.test(value);
}

export function isV2OperationId(value: unknown): value is ArchiveOutboxV2OperationId {
  return typeof value === "string" && V2_OPERATION_ID.test(value);
}

export function strictV2Time(value: unknown): value is string {
  return validTime(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function validId(value: unknown, pattern: RegExp, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && pattern.test(value);
}

function validOwner(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(value);
}

function validState(value: unknown): value is ArchiveOutboxState {
  return value === "pending" || value === "leased" || value === "retry_wait" ||
    value === "acknowledged" || value === "dead_letter";
}

function validTransitionSnapshot(value: unknown): value is ArchiveOutboxV2TransitionSnapshot {
  if (value === null) return true;
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  const candidate = value as Record<string, unknown>;
  return exactKeys(candidate, ["operation_id", "kind", "state", "idempotency_key", "payload_hash", "committed_at"]) &&
    isV2OperationId(candidate.operation_id) && isTransitionKind(candidate.kind) &&
    (candidate.state === "committed" || candidate.state === "ambiguous") &&
    isV2Sha(candidate.idempotency_key) && isV2Sha(candidate.payload_hash) && validTime(candidate.committed_at);
}

export function isTransitionKind(value: unknown): value is ArchiveOutboxV2TransitionKind {
  return value === "enqueue" || value === "claim" || value === "renew" || value === "nack" ||
    value === "ack" || value === "reap" || value === "cleanup_claim" ||
    value === "cleanup_complete" || value === "cleanup_tombstone";
}

function validLease(value: unknown, recordGeneration: number): value is ArchiveOutboxV2Lease {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  const lease = value as Record<string, unknown>;
  return exactKeys(lease, ["capability_hash", "owner_id", "generation", "acquired_at", "expires_at"]) &&
    isV2Sha(lease.capability_hash) && validOwner(lease.owner_id) && Number.isSafeInteger(lease.generation) &&
    lease.generation === recordGeneration && validTime(lease.acquired_at) && validTime(lease.expires_at) &&
    new Date(lease.expires_at).getTime() > new Date(lease.acquired_at).getTime();
}

function validCleanup(value: unknown, record: ArchiveOutboxV2Record): value is ArchiveOutboxV2CleanupState {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  const cleanup = value as Record<string, unknown>;
  if (!exactKeys(cleanup, ["status", "record_generation", "local_zip_ref", "claim_operation_id", "completed_operation_id"]) ||
      !["not_allowed", "allowed", "claimed", "completed", "tombstoned"].includes(cleanup.status as string) ||
      !Number.isSafeInteger(cleanup.record_generation) || cleanup.record_generation !== record.generation ||
      !localZip(cleanup.local_zip_ref as LocalArchiveZipRef) ||
      stableHash(cleanup.local_zip_ref) !== stableHash(record.local_zip_ref)) return false;
  if (cleanup.claim_operation_id !== null && !isV2OperationId(cleanup.claim_operation_id)) return false;
  if (cleanup.completed_operation_id !== null && !isV2OperationId(cleanup.completed_operation_id)) return false;
  if (cleanup.status === "not_allowed" || cleanup.status === "allowed") {
    return cleanup.claim_operation_id === null && cleanup.completed_operation_id === null;
  }
  if (cleanup.status === "claimed") return cleanup.claim_operation_id !== null && cleanup.completed_operation_id === null;
  return cleanup.claim_operation_id !== null && cleanup.completed_operation_id !== null;
}

export function sealV2Record(value: Omit<ArchiveOutboxV2Record, "record_hash">): ArchiveOutboxV2Record {
  return deepFreeze({ ...clone(value), record_hash: stableHash(value) as ArchiveOutboxV2Sha256 });
}

export function validV2Record(value: unknown): value is ArchiveOutboxV2Record {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try { snapshotV2(value); } catch { return false; }
  const record = value as Record<string, unknown>;
  const required = [
    "schema_version", "entry_id", "request_id", "idempotency_key", "immutable_identity",
    "package_receipt", "package_verification_evidence", "package_operation_id", "operation_id",
    "change_identity", "archive_schema_version", "project_id", "project_version", "archive_id",
    "package_sha256", "manifest_sha256", "receipt_hash", "local_zip_ref", "state", "attempt_count",
    "generation", "lease", "next_attempt_at", "last_reason_code", "durable_receipt", "cleanup",
    "last_transition", "created_at", "updated_at", "record_hash"
  ];
  const typed = record as unknown as ArchiveOutboxV2Record;
  if (!exactKeys(record, required) || record.schema_version !== 2 ||
      !validId(record.entry_id, V2_ENTRY_ID) || !validId(record.request_id, V2_REQUEST_ID) ||
      !isV2Sha(record.idempotency_key) || !isV2Sha(record.immutable_identity) ||
      !isV2Sha(record.package_sha256) || !isV2Sha(record.manifest_sha256) || !isV2Sha(record.receipt_hash) ||
      !isV2Sha(record.record_hash) || !validState(record.state) || !validOwner(record.project_id) ||
      typeof record.change_identity !== "string" || record.change_identity.length === 0 ||
      record.change_identity.length > V2_MAX_STRING_LENGTH || record.archive_schema_version !== 1 ||
      !/^pv_[a-z0-9._:-]{1,255}$/u.test(String(record.project_version)) ||
      !/^arc_[a-z0-9._:-]{1,255}$/u.test(String(record.archive_id)) ||
       !Number.isSafeInteger(typed.attempt_count) || typed.attempt_count < 0 || typed.attempt_count > 100 ||
       !Number.isSafeInteger(typed.generation) || typed.generation < 1 ||
      !validTime(record.created_at) || !validTime(record.updated_at) ||
      new Date(record.updated_at as string).getTime() < new Date(record.created_at as string).getTime() ||
      !localZip(record.local_zip_ref as LocalArchiveZipRef) ||
      (record.next_attempt_at !== null && !validTime(record.next_attempt_at)) ||
      (record.last_reason_code !== null && !reasonCode.test(String(record.last_reason_code))) ||
      !validTransitionSnapshot(record.last_transition)) return false;
  const packageRecord = normalizeArchivePackageRecord(typed.package_receipt);
  if (!packageRecord.ok || packageRecord.source_package_schema_version !== 2 || packageRecord.readiness !== "ready") return false;
  const identityInput = { package_receipt: typed.package_receipt, local_zip_ref: typed.local_zip_ref } as ArchiveOutboxEnqueueInput;
  let identity: ReturnType<typeof enqueueIdentity>;
  try { identity = enqueueIdentity(identityInput); } catch { return false; }
  if (typed.entry_id !== identity.entry_id || typed.request_id !== identity.request_id ||
      typed.idempotency_key !== identity.idempotency_key || typed.immutable_identity !== identity.immutable_identity ||
      typed.package_operation_id !== typed.package_receipt.package_operation_id ||
      typed.operation_id !== typed.package_receipt.operation_id || typed.change_identity !== typed.package_receipt.change_identity ||
      typed.project_id !== typed.package_receipt.project_id || typed.project_version !== typed.package_receipt.project_version ||
      typed.archive_id !== typed.package_receipt.archive_id || typed.package_sha256 !== typed.package_receipt.package_sha256 ||
      typed.manifest_sha256 !== typed.package_receipt.manifest_sha256 || typed.receipt_hash !== typed.package_receipt.receipt_hash ||
      !validPackageVerificationEvidence(typed.package_verification_evidence, identityInput, identity.immutable_identity)) return false;
  const cleanup = typed.cleanup as ArchiveOutboxV2CleanupState;
  if (!validCleanup(cleanup, typed)) return false;
  const leaseOkay = typed.lease === null || validLease(typed.lease, typed.generation);
  if (!leaseOkay) return false;
  if (typed.state === "pending" && (typed.attempt_count !== 0 || typed.generation !== 1 || typed.lease !== null ||
      typed.next_attempt_at !== null || typed.last_reason_code !== null || typed.durable_receipt !== null ||
      cleanup.status !== "not_allowed")) return false;
  if (typed.state === "leased" && (typed.attempt_count < 1 || typed.lease === null ||
      typed.next_attempt_at !== null || typed.durable_receipt !== null || cleanup.status !== "not_allowed")) return false;
  if (typed.state === "retry_wait" && (typed.attempt_count < 1 || typed.lease !== null ||
      typed.next_attempt_at === null || typed.last_reason_code === null || typed.durable_receipt !== null || cleanup.status !== "not_allowed")) return false;
  if (typed.state === "acknowledged" && (typed.attempt_count < 1 || typed.lease !== null ||
      typed.next_attempt_at !== null || typed.last_reason_code !== null ||
      !durableReceipt(typed.durable_receipt, typed as unknown as ArchiveOutboxRecord))) return false;
  if (typed.state === "dead_letter" && (typed.attempt_count < 1 || typed.lease !== null ||
      typed.next_attempt_at !== null || typed.last_reason_code === null || typed.durable_receipt !== null || cleanup.status !== "not_allowed")) return false;
  const { record_hash: hash, ...payload } = typed;
  return stableHash(payload) === hash;
}

export function snapshotV2Claim(value: unknown): ArchiveOutboxV2Claim | undefined {
  try {
    const claim = snapshotV2(value) as Record<string, unknown>;
    if (!claim || typeof claim !== "object" || !exactKeys(claim, ["entry_id", "capability", "lease", "record"]) ||
        !isV2Capability(claim.capability) || !validV2Record(claim.record)) return undefined;
    const record = claim.record as ArchiveOutboxV2Record;
    if (record.state !== "leased" || record.lease === null || record.entry_id !== claim.entry_id ||
        record.lease.owner_id !== (claim.lease as Record<string, unknown>).owner_id ||
        stableHash(claim.lease) !== stableHash(record.lease) ||
        v2CapabilityHash(claim.capability) !== record.lease.capability_hash) return undefined;
    return deepFreeze(clone(claim) as unknown as ArchiveOutboxV2Claim);
  } catch {
    return undefined;
  }
}

export function validTransitionOperation(value: unknown): value is ArchiveOutboxV2TransitionOperation {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  const operation = value as Record<string, unknown>;
  const typed = operation as unknown as ArchiveOutboxV2TransitionOperation;
  return exactKeys(operation, ["schema_version", "operation_id", "entry_id", "kind", "expected_generation",
    "idempotency_key", "payload_hash", ...(operation.owner_id === undefined ? [] : ["owner_id"]),
    ...(operation.capability_hash === undefined ? [] : ["capability_hash"])]) &&
    operation.schema_version === 2 && isV2OperationId(operation.operation_id) &&
    validId(operation.entry_id, V2_ENTRY_ID) && isTransitionKind(operation.kind) &&
    Number.isSafeInteger(typed.expected_generation) && typed.expected_generation >= 0 &&
    isV2Sha(operation.idempotency_key) && isV2Sha(operation.payload_hash) &&
    (operation.owner_id === undefined || validOwner(operation.owner_id)) &&
    (operation.capability_hash === undefined || isV2Sha(operation.capability_hash));
}

export function transitionOperation(input: {
  operation_id: ArchiveOutboxV2OperationId;
  entry_id: ArchiveOutboxV2Record["entry_id"];
  kind: ArchiveOutboxV2TransitionKind;
  expected_generation: number;
  payload: unknown;
  owner_id?: string;
  capability_hash?: ArchiveOutboxV2Sha256;
}): ArchiveOutboxV2TransitionOperation {
  const payloadHash = stableHash(input.payload) as ArchiveOutboxV2Sha256;
  return deepFreeze({
    schema_version: 2,
    operation_id: input.operation_id,
    entry_id: input.entry_id,
    kind: input.kind,
    expected_generation: input.expected_generation,
    idempotency_key: stableHash({ operation_id: input.operation_id, entry_id: input.entry_id,
      kind: input.kind, payload_hash: payloadHash }) as ArchiveOutboxV2Sha256,
    payload_hash: payloadHash,
    ...(input.owner_id === undefined ? {} : { owner_id: input.owner_id }),
    ...(input.capability_hash === undefined ? {} : { capability_hash: input.capability_hash })
  });
}

export function cloneV2Record(record: ArchiveOutboxV2Record): ArchiveOutboxV2Record {
  return deepFreeze(clone(record));
}
