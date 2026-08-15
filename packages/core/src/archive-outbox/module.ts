import { ArchiveOutboxError } from "./errors.js";
import { clone, deepFreeze } from "./stable.js";
import type {
  ArchiveOutbox,
  ArchiveOutboxClaim,
  ArchiveOutboxAck,
  ArchiveOutboxCasResult,
  ArchiveOutboxEnqueueInput,
  ArchiveOutboxInspection,
  ArchiveOutboxNack,
  ArchiveOutboxPort,
  ArchiveOutboxPackageVerifierPort,
  ArchiveOutboxRecord,
  ArchiveOutboxReapResult,
  ArchiveRetentionDecision,
  ArchiveRetentionPolicy
} from "./types.js";
import {
  durableReceipt,
  denseArray,
  enqueueIdentity,
  exactKeys,
  identifier,
  plainRecord,
  reasonCode,
  sealRecord,
  snapshotClaim,
  strictTime,
  validPackageVerificationEvidence,
  validRecord
} from "./validation.js";
import { stableHash } from "./stable.js";
import type { ArchiveSyncReceipt } from "../remote-sync/types.js";

export function createArchiveOutbox(input: {
  readonly port: ArchiveOutboxPort;
  readonly package_verifier?: ArchiveOutboxPackageVerifierPort | undefined;
  readonly max_attempts?: number | undefined;
  readonly base_backoff_ms?: number | undefined;
  readonly max_backoff_ms?: number | undefined;
}): ArchiveOutbox {
  const port = input.port;
  const packageVerifier = input.package_verifier;
  const maxAttempts = input.max_attempts ?? 5;
  const baseBackoffMs = input.base_backoff_ms ?? 1_000;
  const maxBackoffMs = input.max_backoff_ms ?? 60_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100 ||
      !Number.isSafeInteger(baseBackoffMs) || baseBackoffMs < 1 ||
      !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < baseBackoffMs) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
  }

  function leaseExpiry(now: Date, ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const expires = new Date(now.getTime() + ttlMs);
    return strictTime(expires);
  }

  async function readRequired(entryId: ArchiveOutboxRecord["entry_id"]): Promise<ArchiveOutboxRecord> {
    const record = await port.read(entryId);
    if (record === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_NOT_FOUND");
    if (!validRecord(record)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return record;
  }

  async function cas(record: ArchiveOutboxRecord,
    next: ArchiveOutboxRecord): Promise<ArchiveOutboxCasResult> {
    const result: unknown = await port.compareAndSwap(record.entry_id, record.generation, next);
    if (!plainRecord(result) || !exactKeys(result, ["swapped", "record"])) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    const raw = result;
    const descriptor = Object.getOwnPropertyDescriptor(raw, "swapped");
    const recordDescriptor = Object.getOwnPropertyDescriptor(raw, "record");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "boolean" ||
        recordDescriptor === undefined || !("value" in recordDescriptor) || !validRecord(recordDescriptor.value)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    if (descriptor.value && (recordDescriptor.value.record_hash !== next.record_hash ||
        stableHash(recordDescriptor.value) !== stableHash(next))) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    return deepFreeze({ swapped: descriptor.value, record: clone(recordDescriptor.value) });
  }

  function currentLease(record: ArchiveOutboxRecord, claim: ArchiveOutboxClaim): boolean {
    return record.state === "leased" && record.lease !== null &&
      record.entry_id === claim.entry_id && record.generation === claim.record.generation &&
      record.lease.token === claim.lease.token && record.lease.owner_id === claim.lease.owner_id &&
      record.lease.generation === claim.lease.generation;
  }

  function retryDelay(attemptCount: number): number {
    const multiplier = 2 ** Math.min(30, Math.max(0, attemptCount - 1));
    return Math.min(maxBackoffMs, baseBackoffMs * multiplier);
  }

  function failedTransition(record: ArchiveOutboxRecord, nowDate: Date,
    reason: string, retryable: boolean): ArchiveOutboxRecord {
    const canRetry = retryable && record.attempt_count < maxAttempts;
    const { record_hash: ignored, ...payload } = record;
    void ignored;
    return sealRecord({
      ...payload,
      state: canRetry ? "retry_wait" : "dead_letter",
      generation: record.generation + 1,
      lease: null,
      next_attempt_at: canRetry
        ? strictTime(new Date(nowDate.getTime() + retryDelay(record.attempt_count)))
        : null,
      last_reason_code: reason,
      updated_at: strictTime(nowDate)
    });
  }

  function retention(record: ArchiveOutboxRecord, policy: ArchiveRetentionPolicy,
    now: string): ArchiveRetentionDecision {
    if (policy !== "retain" && policy !== "cleanup_after_durable_ack") {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const acknowledged = record.state === "acknowledged" && record.durable_receipt?.archive_status === "stored";
    const cleanup = acknowledged && policy === "cleanup_after_durable_ack";
    return deepFreeze({
      schema_version: 1,
      entry_id: record.entry_id,
      record_generation: record.generation,
      disposition: cleanup ? "cleanup_allowed" : "retain",
      reason_code: cleanup
        ? "OUTBOX_DURABLE_ACKNOWLEDGED"
        : acknowledged ? "OUTBOX_POLICY_RETAINS_ZIP" : "OUTBOX_NOT_ACKNOWLEDGED",
      local_zip_ref: clone(record.local_zip_ref),
      evaluated_at: now
    });
  }

  async function enqueue(value: ArchiveOutboxEnqueueInput): Promise<ArchiveOutboxRecord> {
    const identity = enqueueIdentity(value);
    const prior = await port.read(identity.entry_id);
    if (prior !== undefined) {
      if (!validRecord(prior)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
      if (prior.immutable_identity !== identity.immutable_identity) {
        throw new ArchiveOutboxError("ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT");
      }
      return deepFreeze(clone(prior));
    }
    if (packageVerifier === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
    let verification: unknown;
    try {
      verification = await packageVerifier.verify({
        package_receipt: clone(value.package_receipt), local_zip_ref: clone(value.local_zip_ref)
      });
    } catch {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
    }
    if (!validPackageVerificationEvidence(verification, value, identity.immutable_identity)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED");
    }
    const now = strictTime(port.clock());
    const record = sealRecord({
      schema_version: 1,
      ...identity,
      package_receipt: clone(value.package_receipt),
      package_verification_evidence: clone(verification),
      package_operation_id: value.package_receipt.package_operation_id,
      operation_id: value.package_receipt.operation_id,
      change_identity: value.package_receipt.change_identity,
      archive_schema_version: value.package_receipt.archive_schema_version,
      project_id: value.package_receipt.project_id,
      project_version: value.package_receipt.project_version,
      archive_id: value.package_receipt.archive_id,
      package_sha256: value.package_receipt.package_sha256,
      manifest_sha256: value.package_receipt.manifest_sha256,
      receipt_hash: value.package_receipt.receipt_hash,
      local_zip_ref: clone(value.local_zip_ref),
      state: "pending",
      attempt_count: 0,
      generation: 1,
      lease: null,
      next_attempt_at: null,
      last_reason_code: null,
      durable_receipt: null,
      created_at: now,
      updated_at: now
    });
    const stored = await port.put(record);
    if (!validRecord(stored)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    if (stored.entry_id !== record.entry_id || stored.immutable_identity !== record.immutable_identity) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT");
    }
    return deepFreeze(clone(stored));
  }

  async function claim(entryId: ArchiveOutboxRecord["entry_id"], ownerId: string,
    leaseTtlMs: number): Promise<ArchiveOutboxClaim> {
    if (!identifier.test(ownerId)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const nowDate = port.clock();
    const now = strictTime(nowDate);
    const record = await readRequired(entryId);
    const due = record.state === "pending" || (record.state === "retry_wait" &&
      record.next_attempt_at !== null && new Date(record.next_attempt_at).getTime() <= nowDate.getTime());
    if (!due || record.attempt_count >= maxAttempts) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_NOT_CLAIMABLE");
    }
    const generation = record.generation + 1;
    const lease = deepFreeze({
      token: `archive_outbox_lease:${stableHash({
        entry_id: entryId,
        owner_id: ownerId,
        generation,
        acquired_at: now
      }).slice("sha256:".length)}` as const,
      owner_id: ownerId,
      generation,
      acquired_at: now,
      expires_at: leaseExpiry(nowDate, leaseTtlMs)
    });
    const { record_hash: ignored, ...payload } = record;
    void ignored;
    const next = sealRecord({
      ...payload,
      state: "leased",
      attempt_count: record.attempt_count + 1,
      generation,
      lease,
      next_attempt_at: null,
      updated_at: now
    });
    const swapped = await cas(record, next);
    if (!swapped.swapped) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_NOT_CLAIMABLE", true);
    return deepFreeze({ entry_id: entryId, lease, record: clone(swapped.record) });
  }

  async function renew(claimValue: ArchiveOutboxClaim, leaseTtlMs: number): Promise<ArchiveOutboxClaim> {
    const claim = snapshotClaim(claimValue);
    if (claim === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    const nowDate = port.clock();
    const now = strictTime(nowDate);
    const record = await readRequired(claim.entry_id);
    if (!currentLease(record, claim) || record.lease === null ||
        new Date(record.lease.expires_at).getTime() <= nowDate.getTime()) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    }
    const generation = record.generation + 1;
    const lease = deepFreeze({
      token: `archive_outbox_lease:${stableHash({
        entry_id: record.entry_id,
        owner_id: record.lease.owner_id,
        generation,
        acquired_at: record.lease.acquired_at
      }).slice("sha256:".length)}` as const,
      owner_id: record.lease.owner_id,
      generation,
      acquired_at: record.lease.acquired_at,
      expires_at: leaseExpiry(nowDate, leaseTtlMs)
    });
    const { record_hash: ignored, ...payload } = record;
    void ignored;
    const next = sealRecord({ ...payload, generation, lease, updated_at: now });
    const swapped = await cas(record, next);
    if (!swapped.swapped) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE", true);
    return deepFreeze({ entry_id: record.entry_id, lease, record: clone(swapped.record) });
  }

  async function nack(claimValue: ArchiveOutboxClaim, reason: string,
    retryable: boolean): Promise<ArchiveOutboxNack> {
    if (!reasonCode.test(reason) || typeof retryable !== "boolean") {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const claim = snapshotClaim(claimValue);
    if (claim === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    const nowDate = port.clock();
    strictTime(nowDate);
    const record = await readRequired(claim.entry_id);
    if (!currentLease(record, claim) || record.lease === null ||
        new Date(record.lease.expires_at).getTime() <= nowDate.getTime()) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    }
    const next = failedTransition(record, nowDate, reason, retryable);
    const swapped = await cas(record, next);
    if (!swapped.swapped) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE", true);
    return deepFreeze({ record: clone(swapped.record), retry_at: swapped.record.next_attempt_at });
  }

  async function reap(limit = 100, cursor?: string): Promise<ArchiveOutboxReapResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (cursor !== undefined && !cursor.startsWith("archive_outbox:"))) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const nowDate = port.clock();
    strictTime(nowDate);
    const page = await port.list(cursor, limit);
    if (!plainRecord(page) || !exactKeys(page, ["records"], ["next_cursor"]) ||
        !denseArray(page.records) ||
        page.records.some((record) => !validRecord(record)) ||
        (page.next_cursor !== undefined && (typeof page.next_cursor !== "string" ||
          !page.next_cursor.startsWith("archive_outbox:")))) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    const reaped: ArchiveOutboxRecord["entry_id"][] = [];
    for (const record of page.records) {
      if (record.state !== "leased" || record.lease === null ||
          new Date(record.lease.expires_at).getTime() > nowDate.getTime()) continue;
      const next = failedTransition(record, nowDate, "OUTBOX_LEASE_EXPIRED", true);
      const swapped = await cas(record, next);
      if (swapped.swapped) reaped.push(record.entry_id);
    }
    return deepFreeze({
      inspected_count: page.records.length,
      reaped_entry_ids: reaped,
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor })
    });
  }

  async function inspect(entryId: ArchiveOutboxRecord["entry_id"],
    policy: ArchiveRetentionPolicy): Promise<ArchiveOutboxInspection> {
    const now = strictTime(port.clock());
    const record = await readRequired(entryId);
    return deepFreeze({ record: clone(record), retention: retention(record, policy, now) });
  }

  async function ack(claimValue: ArchiveOutboxClaim, receipt: ArchiveSyncReceipt,
    policy: ArchiveRetentionPolicy): Promise<ArchiveOutboxAck> {
    const claim = snapshotClaim(claimValue);
    if (claim === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    if (policy !== "retain" && policy !== "cleanup_after_durable_ack") {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    }
    const nowDate = port.clock();
    const now = strictTime(nowDate);
    const record = await readRequired(claim.entry_id);
    if (!currentLease(record, claim) || record.lease === null ||
        new Date(record.lease.expires_at).getTime() <= nowDate.getTime()) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE");
    }
    if (!durableReceipt(receipt, record)) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_ACK_INVALID");
    }
    const { record_hash: ignored, ...payload } = record;
    void ignored;
    const next = sealRecord({
      ...payload,
      state: "acknowledged",
      generation: record.generation + 1,
      lease: null,
      next_attempt_at: null,
      last_reason_code: null,
      durable_receipt: clone(receipt),
      updated_at: now
    });
    const swapped = await cas(record, next);
    if (!swapped.swapped) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_LEASE_STALE", true);
    return deepFreeze({
      record: clone(swapped.record),
      retention: retention(swapped.record, policy, now)
    });
  }

  return {
    enqueue,
    claim,
    renew,
    ack,
    nack,
    reap,
    inspect
  };
}
