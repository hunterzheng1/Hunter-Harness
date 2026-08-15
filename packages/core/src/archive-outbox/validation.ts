import { normalizeArchivePackageRecord } from "../archive-package-builder/index.js";
import { ArchiveOutboxError } from "./errors.js";
import { clone, deepFreeze, stableHash } from "./stable.js";
import type { ArchiveSyncReceipt } from "../remote-sync/types.js";
import type {
  ArchiveOutboxEnqueueInput,
  ArchiveOutboxClaim,
  ArchiveOutboxLease,
  ArchiveOutboxPackageVerificationEvidence,
  ArchiveOutboxRecord,
  LocalArchiveZipRef
} from "./types.js";

export const sha = /^sha256:[a-f0-9]{64}$/u;
export const identifier = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
export const reasonCode = /^[A-Z][A-Z0-9_]{0,127}$/u;

export function plainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

export function exactKeys(value: Record<string, unknown>, required: readonly string[],
  optional: readonly string[] = []): boolean {
  try {
    const keys = Object.keys(value);
    return required.every((key) => Object.hasOwn(value, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key)) &&
      keys.length >= required.length;
  } catch {
    return false;
  }
}

export function denseArray(value: unknown): value is readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
    return value.every((_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

export function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u
    .exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

export function strictTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
  }
  return value.toISOString();
}

export function durableReceipt(value: unknown, record: ArchiveOutboxRecord): value is ArchiveSyncReceipt {
  if (!plainRecord(value) || !exactKeys(value, [
    "request_id", "idempotency_key", "project_id", "archive_id", "change_key",
    "package_sha256", "archive_status", "project_version", "stored_at", "retryable"
  ], ["reason_code"])) return false;
  return value.request_id === record.request_id && value.idempotency_key === record.idempotency_key &&
    value.project_id === record.project_id && value.archive_id === record.archive_id &&
    value.change_key === record.change_identity && value.package_sha256 === record.package_sha256 &&
    value.archive_status === "stored" && value.retryable === false && value.reason_code === undefined &&
    typeof value.project_version === "string" && /^pv_[a-z0-9._:-]+$/u.test(value.project_version) &&
    validTime(value.stored_at);
}

export function localZip(value: LocalArchiveZipRef): boolean {
  return plainRecord(value) && exactKeys(value, ["package_sha256", "ref_id", "size_bytes"]) &&
    typeof value.ref_id === "string" && identifier.test(value.ref_id) && sha.test(value.package_sha256) &&
    Number.isSafeInteger(value.size_bytes) && value.size_bytes > 0;
}

export function enqueueIdentity(input: ArchiveOutboxEnqueueInput): {
  readonly immutable_identity: `sha256:${string}`;
  readonly entry_id: ArchiveOutboxRecord["entry_id"];
  readonly request_id: ArchiveOutboxRecord["request_id"];
  readonly idempotency_key: ArchiveOutboxRecord["idempotency_key"];
} {
  if (!plainRecord(input) || !exactKeys(input,
    ["package_receipt", "local_zip_ref"])) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
  }
  const normalized = normalizeArchivePackageRecord(input.package_receipt);
  if (!normalized.ok || normalized.source_package_schema_version !== 2 || normalized.readiness !== "ready" ||
      normalized.receipt.receipt_hash !== input.package_receipt.receipt_hash) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
  }
  if (!localZip(input.local_zip_ref) ||
      input.local_zip_ref.package_sha256 !== input.package_receipt.package_sha256 ||
      input.local_zip_ref.size_bytes !== input.package_receipt.package_size_bytes) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
  }
  const immutableIdentity = stableHash({
    package_receipt: input.package_receipt,
    local_zip_ref: input.local_zip_ref
  });
  const suffix = stableHash({ package_operation_id: input.package_receipt.package_operation_id })
    .slice("sha256:".length);
  return deepFreeze({
    immutable_identity: immutableIdentity,
    entry_id: `archive_outbox:${suffix}` as const,
    request_id: `archive_request:${suffix}` as const,
    idempotency_key: stableHash({
      project_id: input.package_receipt.project_id,
      change_key: input.package_receipt.change_identity,
      archive_schema_version: input.package_receipt.archive_schema_version,
      package_sha256: input.package_receipt.package_sha256
    })
  });
}

export function validPackageVerificationEvidence(value: unknown, input: ArchiveOutboxEnqueueInput,
  expectedImmutableIdentity: string): value is ArchiveOutboxPackageVerificationEvidence {
  if (!plainRecord(value) || !exactKeys(value, ["schema_version", "verification_id", "verdict",
    "package_operation_id", "receipt_hash", "package_sha256", "manifest_sha256", "local_zip_ref_id",
    "local_zip_size_bytes", "expected_immutable_identity", "verified_at", "evidence_hash"]) ||
      value.schema_version !== 1 || value.verdict !== "verified" ||
      typeof value.verification_id !== "string" ||
      !/^archive_outbox_package_verification:[a-f0-9]{64}$/u.test(value.verification_id) ||
      value.package_operation_id !== input.package_receipt.package_operation_id ||
      value.receipt_hash !== input.package_receipt.receipt_hash ||
      value.package_sha256 !== input.package_receipt.package_sha256 ||
      value.manifest_sha256 !== input.package_receipt.manifest_sha256 ||
      value.local_zip_ref_id !== input.local_zip_ref.ref_id ||
      value.local_zip_size_bytes !== input.local_zip_ref.size_bytes ||
      value.expected_immutable_identity !== expectedImmutableIdentity || !validTime(value.verified_at)) return false;
  const { verification_id: ignoredId, evidence_hash: ignoredHash, ...body } = value;
  void ignoredId; void ignoredHash;
  const evidenceHash = stableHash(body);
  return value.evidence_hash === evidenceHash &&
    value.verification_id === `archive_outbox_package_verification:${evidenceHash.slice("sha256:".length)}`;
}

type UnhashedOutboxRecord = Omit<ArchiveOutboxRecord, "record_hash">;

export function sealRecord(value: UnhashedOutboxRecord): ArchiveOutboxRecord {
  return deepFreeze({ ...value, record_hash: stableHash(value) });
}

function lease(value: unknown, record: ArchiveOutboxRecord): value is ArchiveOutboxLease {
  if (!plainRecord(value) || !exactKeys(value,
    ["token", "owner_id", "generation", "acquired_at", "expires_at"]) ||
      typeof value.token !== "string" || !/^archive_outbox_lease:[a-f0-9]{64}$/u.test(value.token) ||
      typeof value.owner_id !== "string" || !identifier.test(value.owner_id) ||
      !Number.isSafeInteger(value.generation) || value.generation !== record.generation ||
      !validTime(value.acquired_at) || !validTime(value.expires_at) ||
      new Date(value.expires_at).getTime() <= new Date(value.acquired_at).getTime()) return false;
  const expectedToken = `archive_outbox_lease:${stableHash({
    entry_id: record.entry_id,
    owner_id: value.owner_id,
    generation: value.generation,
    acquired_at: value.acquired_at
  }).slice("sha256:".length)}`;
  return value.token === expectedToken;
}

export function validRecord(value: unknown): value is ArchiveOutboxRecord {
  if (!plainRecord(value) || !exactKeys(value, [
    "schema_version", "entry_id", "request_id", "idempotency_key", "immutable_identity",
    "package_receipt", "package_verification_evidence", "package_operation_id", "operation_id", "change_identity",
    "archive_schema_version", "project_id", "project_version", "archive_id", "package_sha256",
    "manifest_sha256", "receipt_hash", "local_zip_ref", "state", "attempt_count", "generation",
    "lease", "next_attempt_at", "last_reason_code", "durable_receipt", "created_at", "updated_at",
    "record_hash"
  ])) return false;
  const record = value as unknown as ArchiveOutboxRecord;
  const normalized = normalizeArchivePackageRecord(record.package_receipt);
  if (!normalized.ok || normalized.source_package_schema_version !== 2 || normalized.readiness !== "ready" ||
      !localZip(record.local_zip_ref) || !Number.isSafeInteger(record.attempt_count) ||
      record.attempt_count < 0 || record.attempt_count > 100 ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 || !validTime(record.created_at) ||
      !validTime(record.updated_at) || new Date(record.updated_at).getTime() < new Date(record.created_at).getTime() ||
      !(["pending", "leased", "retry_wait", "acknowledged", "dead_letter"] as const).includes(record.state) ||
      (record.last_reason_code !== null && !reasonCode.test(record.last_reason_code))) return false;
  let identity: ReturnType<typeof enqueueIdentity>;
  try {
    identity = enqueueIdentity({ package_receipt: record.package_receipt,
      local_zip_ref: record.local_zip_ref });
  } catch {
    return false;
  }
  if (record.entry_id !== identity.entry_id || record.request_id !== identity.request_id ||
      record.idempotency_key !== identity.idempotency_key ||
      record.immutable_identity !== identity.immutable_identity ||
      !validPackageVerificationEvidence(record.package_verification_evidence,
        { package_receipt: record.package_receipt, local_zip_ref: record.local_zip_ref }, identity.immutable_identity) ||
      record.package_operation_id !== record.package_receipt.package_operation_id ||
      record.operation_id !== record.package_receipt.operation_id ||
      record.change_identity !== record.package_receipt.change_identity ||
      record.archive_schema_version !== record.package_receipt.archive_schema_version ||
      record.project_id !== record.package_receipt.project_id ||
      record.project_version !== record.package_receipt.project_version ||
      record.archive_id !== record.package_receipt.archive_id ||
      record.package_sha256 !== record.package_receipt.package_sha256 ||
      record.manifest_sha256 !== record.package_receipt.manifest_sha256 ||
      record.receipt_hash !== record.package_receipt.receipt_hash) return false;
  const stateValid = record.state === "pending"
    ? record.attempt_count === 0 && record.generation === 1 && record.lease === null &&
      record.next_attempt_at === null && record.last_reason_code === null && record.durable_receipt === null
    : record.state === "leased"
      ? record.attempt_count >= 1 && record.generation >= record.attempt_count + 1 &&
        lease(record.lease, record) && record.next_attempt_at === null && record.durable_receipt === null
      : record.state === "retry_wait"
        ? record.attempt_count >= 1 && record.generation >= record.attempt_count + 2 && record.lease === null &&
          validTime(record.next_attempt_at) && record.last_reason_code !== null && record.durable_receipt === null
        : record.state === "acknowledged"
          ? record.attempt_count >= 1 && record.generation >= record.attempt_count + 2 && record.lease === null &&
            record.next_attempt_at === null && record.last_reason_code === null &&
              durableReceipt(record.durable_receipt, record)
          : record.attempt_count >= 1 && record.generation >= record.attempt_count + 2 && record.lease === null &&
            record.next_attempt_at === null && record.last_reason_code !== null && record.durable_receipt === null;
  if (!stateValid) return false;
  const { record_hash: recordHash, ...payload } = record;
  return sha.test(recordHash) && stableHash(payload) === recordHash;
}

export function snapshotClaim(value: unknown): ArchiveOutboxClaim | undefined {
  if (!plainRecord(value) || !exactKeys(value, ["entry_id", "lease", "record"]) ||
      !validRecord(value.record)) return undefined;
  const record = value.record;
  if (record.state !== "leased" || record.lease === null ||
      value.entry_id !== record.entry_id || !lease(value.lease, record) ||
      stableHash(value.lease) !== stableHash(record.lease)) return undefined;
  return deepFreeze(clone(value as unknown as ArchiveOutboxClaim));
}
