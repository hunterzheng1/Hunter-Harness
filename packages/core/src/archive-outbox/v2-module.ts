import { ArchiveOutboxError } from "./errors.js";
import { clone, deepFreeze, stableHash } from "./stable.js";
import { trustedArchiveOutboxV2Port, trustedArchiveOutboxV2Verifier,
  type TrustedArchiveOutboxV2Port, type TrustedArchiveOutboxV2Verifier } from "./v2-trusted.js";
import type {
  ArchiveOutboxEnqueueInput,
  ArchiveOutboxPackageVerifierPort,
  ArchiveOutboxRecord,
  ArchiveRetentionPolicy
} from "./types.js";
import type { ArchiveSyncReceipt } from "../remote-sync/types.js";
import type {
  ArchiveOutboxV2,
  ArchiveOutboxV2Capability,
  ArchiveOutboxV2Claim,
  ArchiveOutboxV2CleanupClaim,
  ArchiveOutboxV2CleanupClaimInput,
  ArchiveOutboxV2CleanupCompleteInput,
  ArchiveOutboxV2CleanupResult,
  ArchiveOutboxV2ClaimDueInput,
  ArchiveOutboxV2ClaimDueResult,
  ArchiveOutboxV2EnqueueInput,
  ArchiveOutboxV2Lease,
  ArchiveOutboxV2OperationId,
  ArchiveOutboxV2Port,
  ArchiveOutboxV2Record,
  ArchiveOutboxV2ReapInput,
  ArchiveOutboxV2ReapResult,
  ArchiveOutboxV2TransitionInspection,
  ArchiveOutboxV2TransitionKind,
  ArchiveOutboxV2TransitionOperation,
  ArchiveOutboxV2TransitionResult
} from "./v2-types.js";
import {
  cloneV2Record,
  isV2Capability,
  isV2EntryId,
  isV2OperationId,
  isV2Sha,
  isTransitionKind,
  newV2Capability,
  safeSnapshot,
  sealV2Record,
  snapshotV2,
  snapshotV2Claim,
  transitionOperation,
  v2CapabilityHash,
  validV2Record
} from "./v2-validation.js";
import {
  durableReceipt,
  enqueueIdentity,
  reasonCode,
  strictTime,
  validPackageVerificationEvidence
} from "./validation.js";

const OWNER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,127}$/u;

type V2InputVerifier = ArchiveOutboxPackageVerifierPort | {
  verify(input: { readonly package_receipt: unknown; readonly local_zip_ref: unknown }): Promise<unknown>;
};

function owner(value: unknown): value is string {
  return typeof value === "string" && OWNER.test(value);
}

function operation(value: unknown): value is ArchiveOutboxV2OperationId {
  return isV2OperationId(value);
}

function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100;
}

function validTtl(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 86_400_000;
}

function validRetention(value: unknown): value is ArchiveRetentionPolicy {
  return value === "retain" || value === "cleanup_after_durable_ack";
}

function retryDelay(attempt: number, base: number, maximum: number): number {
  return Math.min(maximum, base * (2 ** Math.min(30, Math.max(0, attempt - 1))));
}

function operationId(base: ArchiveOutboxV2OperationId, entryId: string, kind: ArchiveOutboxV2TransitionKind): ArchiveOutboxV2OperationId {
  return `archive_outbox_transition:${stableHash({ base, entry_id: entryId, kind }).slice("sha256:".length)}` as ArchiveOutboxV2OperationId;
}

function withoutHash(record: ArchiveOutboxV2Record): Omit<ArchiveOutboxV2Record, "record_hash"> {
  const { record_hash, ...payload } = record;
  void record_hash;
  return payload;
}

function transitionSnapshot(operationValue: ArchiveOutboxV2TransitionOperation, committedAt: string) {
  return {
    operation_id: operationValue.operation_id,
    kind: operationValue.kind,
    state: "committed" as const,
    idempotency_key: operationValue.idempotency_key,
    payload_hash: operationValue.payload_hash,
    committed_at: committedAt
  };
}

function exactTransitionRecord(candidate: ArchiveOutboxV2Record, proposed: ArchiveOutboxV2Record,
  operationValue: ArchiveOutboxV2TransitionOperation): boolean {
  return candidate.entry_id === proposed.entry_id && candidate.generation === proposed.generation &&
    candidate.record_hash === proposed.record_hash && stableHash(candidate) === stableHash(proposed) &&
    candidate.last_transition !== null && proposed.last_transition !== null &&
    candidate.last_transition.operation_id === operationValue.operation_id &&
    candidate.last_transition.kind === operationValue.kind &&
    candidate.last_transition.idempotency_key === operationValue.idempotency_key &&
    candidate.last_transition.payload_hash === operationValue.payload_hash &&
    stableHash(candidate.last_transition) === stableHash(proposed.last_transition);
}

export function createArchiveOutboxV2(input: {
  readonly port: ArchiveOutboxV2Port;
  readonly package_verifier?: V2InputVerifier | undefined;
  readonly max_attempts?: number | undefined;
  readonly base_backoff_ms?: number | undefined;
  readonly max_backoff_ms?: number | undefined;
}): ArchiveOutboxV2 {
  const port: TrustedArchiveOutboxV2Port = trustedArchiveOutboxV2Port(input.port);
  const packageVerifier: TrustedArchiveOutboxV2Verifier | undefined = input.package_verifier === undefined
    ? undefined : trustedArchiveOutboxV2Verifier(input.package_verifier);
  const maxAttempts = input.max_attempts ?? 5;
  const baseBackoff = input.base_backoff_ms ?? 1_000;
  const maxBackoff = input.max_backoff_ms ?? 60_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100 ||
      !Number.isSafeInteger(baseBackoff) || baseBackoff < 1 ||
      !Number.isSafeInteger(maxBackoff) || maxBackoff < baseBackoff) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
  }

  const capabilities = new Map<string, ArchiveOutboxV2Capability>();

  function nowDate(): Date {
    const date = port.clock();
    if (!(date instanceof Date)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    let timestamp: number;
    try { timestamp = Date.prototype.getTime.call(date); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!Number.isFinite(timestamp)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return new Date(timestamp);
  }

  async function readRaw(entryId: ArchiveOutboxV2Record["entry_id"]): Promise<unknown> {
    return port.read(entryId);
  }

  async function readRequired(entryId: ArchiveOutboxV2Record["entry_id"]): Promise<ArchiveOutboxV2Record> {
    const raw = await readRaw(entryId);
    if (raw === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_NOT_FOUND");
    let snapshot: unknown;
    try { snapshot = snapshotV2(raw); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!validV2Record(snapshot)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return cloneV2Record(snapshot);
  }

  async function inspectTransition(operationId: ArchiveOutboxV2OperationId): Promise<ArchiveOutboxV2TransitionInspection> {
    if (!operation(operationId)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    let raw: unknown;
    try { raw = await port.inspectTransition(operationId); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    try {
      const result = snapshotV2(raw) as ArchiveOutboxV2TransitionInspection;
      if (!result || typeof result !== "object" ||
          Object.keys(result).sort().join("|") !== "entry_id|idempotency_key|kind|operation_id|payload_hash|record|state" ||
          result.operation_id !== operationId ||
          !["unknown", "prepared", "committed", "ambiguous", "conflict"].includes(result.state) ||
          (result.entry_id !== null && !isV2EntryId(result.entry_id)) ||
          (result.kind !== null && !isTransitionKind(result.kind)) ||
          (result.idempotency_key !== null && !isV2Sha(result.idempotency_key)) ||
          (result.payload_hash !== null && !isV2Sha(result.payload_hash)) ||
          (result.record !== null && !validV2Record(result.record))) throw new Error("invalid transition inspection");
      return deepFreeze(clone(result));
    } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
  }

  async function replayedRecord(operationId: ArchiveOutboxV2OperationId,
    entryId?: ArchiveOutboxV2Record["entry_id"], expectedPayload?: unknown): Promise<ArchiveOutboxV2Record | undefined> {
    const inspection = await inspectTransition(operationId);
    if (inspection.state === "ambiguous") throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", true);
    if (inspection.state !== "committed" || inspection.record === null) return undefined;
    if (entryId !== undefined && inspection.record.entry_id !== entryId) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
    }
    if (expectedPayload !== undefined && stableHash(expectedPayload) !== inspection.payload_hash) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
    }
    return cloneV2Record(inspection.record);
  }

  async function commit(operationValue: ArchiveOutboxV2TransitionOperation,
    next: ArchiveOutboxV2Record): Promise<ArchiveOutboxV2Record> {
    const raw: unknown = await port.commitTransition(operationValue, next);
    let result: ArchiveOutboxV2TransitionResult;
    try { result = snapshotV2(raw) as ArchiveOutboxV2TransitionResult; } catch {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    if (!result || typeof result !== "object" ||
        Object.keys(result).sort().join("|") !== "operation_id|outcome|record" ||
        !["new", "replayed", "conflict", "ambiguous"].includes(result.outcome) ||
        result.operation_id !== operationValue.operation_id) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    if ((result.outcome === "new" || result.outcome === "replayed") && result.record === null) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    if ((result.outcome === "conflict" || result.outcome === "ambiguous") && result.record !== null) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    if (result.outcome === "new" || result.outcome === "replayed") {
      if (result.record === null || !validV2Record(result.record) ||
          !exactTransitionRecord(result.record, next, operationValue)) {
        throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
      }
      return cloneV2Record(result.record);
    }
    if (result.outcome === "ambiguous") {
      const inspected = await inspectTransition(operationValue.operation_id);
      if (inspected.state === "committed" && inspected.record !== null && validV2Record(inspected.record) &&
          inspected.entry_id === next.entry_id && inspected.kind === operationValue.kind &&
          inspected.idempotency_key === operationValue.idempotency_key &&
          inspected.payload_hash === operationValue.payload_hash &&
          exactTransitionRecord(inspected.record, next, operationValue)) {
        return cloneV2Record(inspected.record);
      }
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", true);
    }
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", result.outcome === "conflict");
  }

  function leaseExpiry(date: Date, ttl: number): string {
    if (!validTtl(ttl)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    return strictTime(new Date(date.getTime() + ttl));
  }

  function cleanupAt(record: ArchiveOutboxV2Record, generation: number,
    status: ArchiveOutboxV2Record["cleanup"]["status"], claimOperationId: ArchiveOutboxV2Record["cleanup"]["claim_operation_id"] = null,
    completedOperationId: ArchiveOutboxV2Record["cleanup"]["completed_operation_id"] = null) {
    return {
      status,
      record_generation: generation,
      local_zip_ref: clone(record.local_zip_ref),
      claim_operation_id: claimOperationId,
      completed_operation_id: completedOperationId
    };
  }

  function nextRecord(record: ArchiveOutboxV2Record, operationValue: ArchiveOutboxV2TransitionOperation,
    committedAt: string, patch: Partial<Omit<ArchiveOutboxV2Record, "record_hash">>): ArchiveOutboxV2Record {
    return (requireValidRecord({
      ...withoutHash(record), ...patch,
      last_transition: transitionSnapshot(operationValue, committedAt),
      updated_at: committedAt
    }));
  }

  function requireValidRecord(value: Omit<ArchiveOutboxV2Record, "record_hash">): ArchiveOutboxV2Record {
    const record = sealV2(value);
    if (!validV2Record(record)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return record;
  }

  function sealV2(value: Omit<ArchiveOutboxV2Record, "record_hash">): ArchiveOutboxV2Record {
    return sealV2Record(value);
  }

  async function enqueue(value: ArchiveOutboxV2EnqueueInput): Promise<ArchiveOutboxV2Record> {
    let inputValue: ArchiveOutboxV2EnqueueInput;
    try { inputValue = safeSnapshot(value) as ArchiveOutboxV2EnqueueInput; } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID"); }
    if (inputValue.operation_id !== undefined && !operation(inputValue.operation_id)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const identity: ReturnType<typeof enqueueIdentity> = enqueueIdentity(inputValue as ArchiveOutboxEnqueueInput);
    const priorRaw = await readRaw(identity.entry_id);
    if (priorRaw !== undefined) {
      let prior: unknown;
      try { prior = snapshotV2(priorRaw); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
      if (!validV2Record(prior)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT");
      if (prior.immutable_identity !== identity.immutable_identity) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT");
      return cloneV2Record(prior);
    }
    if (packageVerifier === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
    let verification: unknown;
    try {
      verification = await packageVerifier.verify({ package_receipt: clone(inputValue.package_receipt), local_zip_ref: clone(inputValue.local_zip_ref) });
      verification = snapshotV2(verification);
    } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED"); }
    if (!validPackageVerificationEvidence(verification, inputValue as ArchiveOutboxEnqueueInput,
      identity.immutable_identity)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
    const now = strictTime(nowDate());
    const record = requireValidRecord({
      schema_version: 2,
      ...identity,
      package_receipt: clone(inputValue.package_receipt),
      package_verification_evidence: clone(verification),
      package_operation_id: inputValue.package_receipt.package_operation_id,
      operation_id: inputValue.package_receipt.operation_id,
      change_identity: inputValue.package_receipt.change_identity,
      archive_schema_version: inputValue.package_receipt.archive_schema_version,
      project_id: inputValue.package_receipt.project_id,
      project_version: inputValue.package_receipt.project_version,
      archive_id: inputValue.package_receipt.archive_id,
      package_sha256: inputValue.package_receipt.package_sha256,
      manifest_sha256: inputValue.package_receipt.manifest_sha256,
      receipt_hash: inputValue.package_receipt.receipt_hash,
      local_zip_ref: clone(inputValue.local_zip_ref),
      state: "pending",
      attempt_count: 0,
      generation: 1,
      lease: null,
      next_attempt_at: null,
      last_reason_code: null,
      durable_receipt: null,
      cleanup: cleanupAt({ local_zip_ref: inputValue.local_zip_ref } as ArchiveOutboxV2Record, 1, "not_allowed"),
      last_transition: null,
      created_at: now,
      updated_at: now
    });
    let stored: unknown = await port.put(record);
    try { stored = snapshotV2(stored); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!validV2Record(stored) || stored.immutable_identity !== record.immutable_identity) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT");
    }
    return cloneV2Record(stored);
  }

  function ensureClaim(value: unknown): ArchiveOutboxV2Claim {
    const claim = snapshotV2Claim(value);
    if (claim === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    return claim;
  }

  async function claimDue(inputValue: ArchiveOutboxV2ClaimDueInput): Promise<ArchiveOutboxV2ClaimDueResult> {
    let input: ArchiveOutboxV2ClaimDueInput;
    try { input = safeSnapshot(inputValue); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID"); }
    if (!operation(input.operation_id) || !owner(input.owner_id) || !validTtl(input.lease_ttl_ms) ||
        (input.limit !== undefined && !validLimit(input.limit)) ||
        (input.cursor !== undefined && !isV2EntryId(input.cursor))) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const now = nowDate();
    const pageRaw = await port.list(input.cursor, input.limit ?? 100);
    let page: unknown;
    try { page = snapshotV2(pageRaw); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!page || typeof page !== "object" ||
        (Object.keys(page).sort().join("|") !== "next_cursor|records" && Object.keys(page).sort().join("|") !== "records") ||
        !Array.isArray((page as Record<string, unknown>).records)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    const records = (page as { records: unknown[] }).records;
    if (records.length > (input.limit ?? 100) || records.some((record) => !validV2Record(record))) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    const claims: ArchiveOutboxV2Claim[] = [];
    for (const value of records) {
      const record = value as ArchiveOutboxV2Record;
      const due = record.state === "pending" || (record.state === "retry_wait" && record.next_attempt_at !== null &&
        new Date(record.next_attempt_at).getTime() <= now.getTime());
      if (!due || record.attempt_count >= maxAttempts) continue;
      const id = operationId(input.operation_id, record.entry_id, "claim");
      const prior = await inspectTransition(id);
      if (prior.state === "ambiguous") throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", true);
      if (prior.state === "committed" && prior.record !== null) {
        const priorCapability = capabilities.get(id);
        if (!isV2Capability(priorCapability) || prior.record.lease === null ||
            v2CapabilityHash(priorCapability) !== prior.record.lease.capability_hash) {
          throw new ArchiveOutboxError("ARCHIVE_OUTBOX_CAPABILITY_UNAVAILABLE", true);
        }
        if (prior.record.state === "leased") {
          claims.push(deepFreeze({ entry_id: prior.record.entry_id, capability: priorCapability,
            lease: clone(prior.record.lease), record: cloneV2Record(prior.record) }));
        }
        continue;
      }
      const capability = newV2Capability();
      const generation = record.generation + 1;
      const lease: ArchiveOutboxV2Lease = {
        capability_hash: v2CapabilityHash(capability), owner_id: input.owner_id, generation,
        acquired_at: strictTime(now), expires_at: leaseExpiry(now, input.lease_ttl_ms)
      };
      const transition = transitionOperation({ operation_id: id, entry_id: record.entry_id, kind: "claim",
        expected_generation: record.generation, payload: { owner_id: input.owner_id, lease },
        owner_id: input.owner_id, capability_hash: lease.capability_hash });
      const next = nextRecord(record, transition, strictTime(now), {
        state: "leased", attempt_count: record.attempt_count + 1, generation, lease,
        next_attempt_at: null, last_reason_code: null, cleanup: cleanupAt(record, generation, "not_allowed")
      });
      capabilities.set(id, capability);
      const committed = await commit(transition, next);
      if (committed.state === "leased" && committed.lease !== null && committed.lease.capability_hash === lease.capability_hash) {
        const rawCapability = capabilities.get(id);
        if (!isV2Capability(rawCapability)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", true);
        claims.push(deepFreeze({ entry_id: committed.entry_id, capability: rawCapability,
          lease: clone(committed.lease), record: cloneV2Record(committed) }));
      }
    }
    const nextCursor = (page as Record<string, unknown>).next_cursor;
    if (nextCursor !== undefined && !isV2EntryId(nextCursor)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return deepFreeze({ claims, inspected_count: records.length, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }) });
  }

  async function renew(claimValue: ArchiveOutboxV2Claim, inputValue: { operation_id: ArchiveOutboxV2OperationId; lease_ttl_ms: number }): Promise<ArchiveOutboxV2Claim> {
    const claim = ensureClaim(claimValue);
    let input: { operation_id: ArchiveOutboxV2OperationId; lease_ttl_ms: number };
    try { input = safeSnapshot(inputValue); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID"); }
    if (!operation(input.operation_id) || !validTtl(input.lease_ttl_ms)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const prior = await replayedRecord(input.operation_id, claim.entry_id);
    if (prior !== undefined) {
      const priorCapability = capabilities.get(input.operation_id);
      if (prior.lease === null || !isV2Capability(priorCapability) ||
          v2CapabilityHash(priorCapability) !== prior.lease.capability_hash) {
        throw new ArchiveOutboxError("ARCHIVE_OUTBOX_CAPABILITY_UNAVAILABLE", true);
      }
      return deepFreeze({ entry_id: prior.entry_id, capability: priorCapability,
        lease: clone(prior.lease), record: cloneV2Record(prior) });
    }
    const now = nowDate();
    const record = await readRequired(claim.entry_id);
    if (record.state !== "leased" || record.lease === null || record.lease.owner_id !== claim.lease.owner_id ||
        record.generation !== claim.record.generation || record.lease.capability_hash !== claim.lease.capability_hash ||
        new Date(record.lease.expires_at).getTime() <= now.getTime()) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    const capability = newV2Capability();
    const generation = record.generation + 1;
    const lease: ArchiveOutboxV2Lease = { capability_hash: v2CapabilityHash(capability), owner_id: record.lease.owner_id,
      generation, acquired_at: strictTime(now), expires_at: leaseExpiry(now, input.lease_ttl_ms) };
    const transition = transitionOperation({ operation_id: input.operation_id, entry_id: record.entry_id, kind: "renew",
      expected_generation: record.generation, payload: { lease }, owner_id: lease.owner_id,
      capability_hash: lease.capability_hash });
    const next = nextRecord(record, transition, strictTime(now), { generation, lease, cleanup: cleanupAt(record, generation, "not_allowed") });
    capabilities.set(input.operation_id, capability);
    const committed = await commit(transition, next);
    const raw = capabilities.get(input.operation_id);
    if (committed.lease === null || !isV2Capability(raw)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", true);
    return deepFreeze({ entry_id: committed.entry_id, capability: raw, lease: clone(committed.lease), record: cloneV2Record(committed) });
  }

  async function ack(claimValue: ArchiveOutboxV2Claim, receiptValue: ArchiveSyncReceipt,
    policy: ArchiveRetentionPolicy, operationId: ArchiveOutboxV2OperationId): Promise<ArchiveOutboxV2Record> {
    const claim = ensureClaim(claimValue);
    if (!validRetention(policy) || !operation(operationId)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    let receipt: ArchiveSyncReceipt;
    try { receipt = safeSnapshot(receiptValue); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_ACK_INVALID"); }
    if (!durableReceipt(receipt, claim.record as unknown as ArchiveOutboxRecord)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_ACK_INVALID");
    }
    const prior = await replayedRecord(operationId, claim.entry_id, { receipt, policy });
    if (prior !== undefined) return prior;
    const now = nowDate();
    const record = await readRequired(claim.entry_id);
    if (record.state !== "leased" || record.lease === null || record.lease.owner_id !== claim.lease.owner_id ||
        record.generation !== claim.record.generation || record.lease.capability_hash !== claim.lease.capability_hash ||
        new Date(record.lease.expires_at).getTime() <= now.getTime() ||
        !durableReceipt(receipt, record as unknown as ArchiveOutboxRecord)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_ACK_INVALID");
    const generation = record.generation + 1;
    const transition = transitionOperation({ operation_id: operationId, entry_id: record.entry_id, kind: "ack",
      expected_generation: record.generation, payload: { receipt, policy } });
    const next = nextRecord(record, transition, strictTime(now), { state: "acknowledged", generation, lease: null,
      next_attempt_at: null, last_reason_code: null, durable_receipt: clone(receipt),
      cleanup: cleanupAt(record, generation, policy === "cleanup_after_durable_ack" ? "allowed" : "not_allowed") });
    return commit(transition, next);
  }

  async function nack(claimValue: ArchiveOutboxV2Claim, reason: string, retryable: boolean,
    operationId: ArchiveOutboxV2OperationId): Promise<ArchiveOutboxV2Record> {
    const claim = ensureClaim(claimValue);
    if (typeof reason !== "string" || !REASON.test(reason) || !reasonCode.test(reason) || typeof retryable !== "boolean" || !operation(operationId)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const prior = await replayedRecord(operationId, claim.entry_id, { reason, retryable });
    if (prior !== undefined) return prior;
    const now = nowDate();
    const record = await readRequired(claim.entry_id);
    if (record.state !== "leased" || record.lease === null || record.lease.owner_id !== claim.lease.owner_id ||
        record.generation !== claim.record.generation || record.lease.capability_hash !== claim.lease.capability_hash ||
        new Date(record.lease.expires_at).getTime() <= now.getTime()) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    const canRetry = retryable && record.attempt_count < maxAttempts;
    const generation = record.generation + 1;
    const transition = transitionOperation({ operation_id: operationId, entry_id: record.entry_id, kind: "nack",
      expected_generation: record.generation, payload: { reason, retryable } });
    const next = nextRecord(record, transition, strictTime(now), { state: canRetry ? "retry_wait" : "dead_letter", generation,
      lease: null, next_attempt_at: canRetry ? strictTime(new Date(now.getTime() + retryDelay(record.attempt_count, baseBackoff, maxBackoff))) : null,
      last_reason_code: reason, cleanup: cleanupAt(record, generation, "not_allowed") });
    return commit(transition, next);
  }

  async function reap(inputValue: ArchiveOutboxV2ReapInput): Promise<ArchiveOutboxV2ReapResult> {
    let input: ArchiveOutboxV2ReapInput;
    try { input = safeSnapshot(inputValue); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID"); }
    if (!operation(input.operation_id) || (input.limit !== undefined && !validLimit(input.limit)) ||
        (input.cursor !== undefined && !isV2EntryId(input.cursor))) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const now = nowDate();
    const pageRaw = await port.list(input.cursor, input.limit ?? 100);
    let page: unknown;
    try { page = snapshotV2(pageRaw); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!page || typeof page !== "object" ||
        (Object.keys(page).sort().join("|") !== "next_cursor|records" && Object.keys(page).sort().join("|") !== "records") ||
        !Array.isArray((page as Record<string, unknown>).records)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    const records = (page as { records: unknown[] }).records;
    if (records.length > (input.limit ?? 100) || records.some((record) => !validV2Record(record))) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    const reaped: ArchiveOutboxV2Record["entry_id"][] = [];
    for (const value of records) {
      const record = value as ArchiveOutboxV2Record;
      const transitionId = operationId(input.operation_id, record.entry_id, "reap");
      const prior = await inspectTransition(transitionId);
      if (prior.state === "ambiguous") throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT", true);
      if (prior.state === "committed" && prior.record !== null) {
        if (prior.record.last_transition?.operation_id === transitionId && prior.record.last_transition.kind === "reap") {
          reaped.push(record.entry_id);
          continue;
        }
        throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
      }
      if (record.state !== "leased" || record.lease === null || new Date(record.lease.expires_at).getTime() > now.getTime()) continue;
      const canRetry = record.attempt_count < maxAttempts;
      const generation = record.generation + 1;
      const transition = transitionOperation({ operation_id: transitionId, entry_id: record.entry_id,
        kind: "reap", expected_generation: record.generation, payload: { expired_generation: record.generation } });
      const next = nextRecord(record, transition, strictTime(now), { state: canRetry ? "retry_wait" : "dead_letter", generation,
        lease: null, next_attempt_at: canRetry ? strictTime(new Date(now.getTime() + retryDelay(record.attempt_count, baseBackoff, maxBackoff))) : null,
        last_reason_code: "OUTBOX_LEASE_EXPIRED", cleanup: cleanupAt(record, generation, "not_allowed") });
      try { await commit(transition, next); reaped.push(record.entry_id); } catch (error) {
        if (!(error instanceof ArchiveOutboxError) || error.code !== "ARCHIVE_OUTBOX_PORT_CONFLICT") throw error;
      }
    }
    const nextCursor = (page as Record<string, unknown>).next_cursor;
    if (nextCursor !== undefined && !isV2EntryId(nextCursor)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return deepFreeze({ inspected_count: records.length, reaped_entry_ids: reaped,
      ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }) });
  }

  async function claimCleanup(inputValue: ArchiveOutboxV2CleanupClaimInput): Promise<ArchiveOutboxV2CleanupClaim> {
    let input: ArchiveOutboxV2CleanupClaimInput;
    try { input = safeSnapshot(inputValue); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID"); }
    if (!operation(input.operation_id) || typeof input.entry_id !== "string" ||
        !Number.isSafeInteger(input.expected_generation) || input.expected_generation < 1) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const prior = await replayedRecord(input.operation_id, input.entry_id);
    if (prior !== undefined) {
      if (prior.cleanup.status !== "claimed") throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
      return deepFreeze({ operation_id: input.operation_id, entry_id: prior.entry_id,
        record_generation: prior.generation, local_zip_ref: clone(prior.local_zip_ref), record: cloneV2Record(prior) });
    }
    const record = await readRequired(input.entry_id);
    if (record.state !== "acknowledged" || record.cleanup.status !== "allowed" || record.generation !== input.expected_generation) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
    }
    const generation = record.generation + 1;
    const transition = transitionOperation({ operation_id: input.operation_id, entry_id: record.entry_id, kind: "cleanup_claim",
      expected_generation: record.generation, payload: { local_zip_ref: record.local_zip_ref } });
    const next = nextRecord(record, transition, strictTime(nowDate()), { generation,
      cleanup: cleanupAt(record, generation, "claimed", input.operation_id) });
    const committed = await commit(transition, next);
    return deepFreeze({ operation_id: input.operation_id, entry_id: committed.entry_id,
      record_generation: committed.generation, local_zip_ref: clone(committed.local_zip_ref), record: cloneV2Record(committed) });
  }

  async function completeCleanup(inputValue: ArchiveOutboxV2CleanupCompleteInput): Promise<ArchiveOutboxV2CleanupResult> {
    let input: ArchiveOutboxV2CleanupCompleteInput;
    try { input = safeSnapshot(inputValue); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID"); }
    if (!operation(input.operation_id) || typeof input.entry_id !== "string" || typeof input.tombstone !== "boolean" ||
        !Number.isSafeInteger(input.expected_generation) || input.expected_generation < 1) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const prior = await replayedRecord(input.operation_id, input.entry_id);
    if (prior !== undefined) {
      if (prior.cleanup.status !== "completed" && prior.cleanup.status !== "tombstoned") {
        throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
      }
      return deepFreeze({ outcome: prior.cleanup.status === "tombstoned" ? "tombstoned" : "completed", record: cloneV2Record(prior) });
    }
    const record = await readRequired(input.entry_id);
    if (record.state !== "acknowledged" || record.cleanup.status !== "claimed" ||
        record.generation !== input.expected_generation || record.cleanup.claim_operation_id === null) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_CONFLICT");
    }
    const generation = record.generation + 1;
    const kind: ArchiveOutboxV2TransitionKind = input.tombstone ? "cleanup_tombstone" : "cleanup_complete";
    const transition = transitionOperation({ operation_id: input.operation_id, entry_id: record.entry_id, kind,
      expected_generation: record.generation, payload: { tombstone: input.tombstone, claim_operation_id: record.cleanup.claim_operation_id } });
    const next = nextRecord(record, transition, strictTime(nowDate()), { generation,
      cleanup: cleanupAt(record, generation, input.tombstone ? "tombstoned" : "completed",
        record.cleanup.claim_operation_id, input.operation_id) });
    const committed = await commit(transition, next);
    return deepFreeze({ outcome: input.tombstone ? "tombstoned" : "completed", record: cloneV2Record(committed) });
  }

  async function inspect(entryId: ArchiveOutboxV2Record["entry_id"]): Promise<ArchiveOutboxV2Record> {
    return readRequired(entryId);
  }

  return { enqueue, claimDue, renew, ack, nack, reap, claimCleanup, completeCleanup, inspect };
}
