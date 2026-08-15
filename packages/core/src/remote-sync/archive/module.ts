import { randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";

import { InMemoryRemoteArchiveV2Store, RemoteArchiveV2CommitAmbiguity } from "./memory.js";
import { remoteArchiveV2StableHash } from "./stable.js";
import type {
  RemoteArchiveV2,
  RemoteArchiveV2Capability,
  RemoteArchiveV2Claim,
  RemoteArchiveV2CommitResult,
  RemoteArchiveV2ErrorCode,
  RemoteArchiveV2PrepareResult,
  RemoteArchiveV2Receipt,
  RemoteArchiveV2Record,
  RemoteArchiveV2Sha256,
  RemoteArchiveV2Source,
  RemoteArchiveV2Status
} from "./types.js";
import {
  remoteArchiveV2PayloadHash,
  remoteArchiveV2Snapshot,
  sameRemoteArchiveV2Source,
  snapshotRemoteArchiveV2Claim,
  snapshotRemoteArchiveV2Prepare,
  validRemoteArchiveV2Source
} from "./validation.js";

export class RemoteArchiveV2Error extends Error {
  constructor(readonly code: RemoteArchiveV2ErrorCode) { super(code); this.name = "RemoteArchiveV2Error"; }
}
function fail(code: RemoteArchiveV2ErrorCode): never { throw new RemoteArchiveV2Error(code); }
function capability(): RemoteArchiveV2Capability { return `remote_archive_capability:${randomBytes(32).toString("base64url")}`; }
function capHash(value: RemoteArchiveV2Capability): RemoteArchiveV2Sha256 { return remoteArchiveV2StableHash(value); }
function printable(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value &&
    [...value].every((character) => { const point = character.codePointAt(0) ?? 0; return point > 0x1f && point !== 0x7f; });
}
function now(store: InMemoryRemoteArchiveV2Store): string {
  const value = store.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("REMOTE_ARCHIVE_RECORD_INVALID");
  return value.toISOString();
}
function withRecordHash(value: Omit<RemoteArchiveV2Record, "record_hash"> | RemoteArchiveV2Record): RemoteArchiveV2Record {
  const snapshot = remoteArchiveV2Snapshot(value) as Omit<RemoteArchiveV2Record, "record_hash"> & { record_hash?: RemoteArchiveV2Sha256 };
  const body = { ...snapshot } as Omit<RemoteArchiveV2Record, "record_hash"> & { record_hash?: RemoteArchiveV2Sha256 };
  Reflect.deleteProperty(body, "record_hash");
  const result = { ...body, record_hash: remoteArchiveV2StableHash(body) } as RemoteArchiveV2Record;
  const freeze = (input: unknown): void => { if (input !== null && typeof input === "object") {
    for (const child of Object.values(input)) freeze(child); Object.freeze(input);
  } };
  freeze(result); return result;
}
function sourceInput(value: unknown): { operation_id: RemoteArchiveV2Record["operation_id"]; source: RemoteArchiveV2Source } {
  let safe: unknown; try { safe = remoteArchiveV2Snapshot(value); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
  if (safe === null || typeof safe !== "object" || Array.isArray(safe) || Object.keys(safe).sort().join("|") !== "operation_id|source")
    fail("REMOTE_ARCHIVE_INPUT_INVALID");
  const typed = safe as Record<string, unknown>;
  if (!printable(typed.operation_id, 240) || !typed.operation_id.startsWith("remote_archive_operation:") ||
      !validRemoteArchiveV2Source(typed.source)) fail("REMOTE_ARCHIVE_INPUT_INVALID");
  return typed as unknown as { operation_id: RemoteArchiveV2Record["operation_id"]; source: RemoteArchiveV2Source };
}

export function createInMemoryRemoteArchiveV2(options: {
  readonly store?: InMemoryRemoteArchiveV2Store;
  readonly clock?: () => Date;
} = {}): RemoteArchiveV2 {
  if (isProxy(options) || options === null || typeof options !== "object" || Array.isArray(options))
    fail("REMOTE_ARCHIVE_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const optionKeys = Reflect.ownKeys(descriptors);
  if (optionKeys.some((key) => typeof key !== "string" || (key !== "store" && key !== "clock")) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor) || descriptor.get !== undefined ||
        descriptor.set !== undefined || descriptor.enumerable !== true)) fail("REMOTE_ARCHIVE_INPUT_INVALID");
  const storeOption = descriptors.store?.value as unknown;
  const clockOption = descriptors.clock?.value as unknown;
  if (storeOption !== undefined && (!(storeOption instanceof InMemoryRemoteArchiveV2Store) || isProxy(storeOption)) ||
      clockOption !== undefined && typeof clockOption !== "function") fail("REMOTE_ARCHIVE_INPUT_INVALID");
  const store = storeOption as InMemoryRemoteArchiveV2Store | undefined ?? new InMemoryRemoteArchiveV2Store(
    clockOption === undefined ? {} : { clock: clockOption as () => Date }
  );
  async function prepare(value: unknown): Promise<RemoteArchiveV2PrepareResult> {
    let input; try { input = snapshotRemoteArchiveV2Prepare(value); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
    if (remoteArchiveV2PayloadHash(input.metadata) !== input.payload_hash) fail("REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH");
    const owner = store.keyOwner(input.idempotency_key);
    if (owner !== undefined) {
      const existing = store.read(owner);
      if (existing === undefined || existing.payload_hash !== input.payload_hash || existing.operation_id !== input.operation_id)
        fail("REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT");
      return { outcome: "replay", claim: null, record: existing };
    }
    const byOperation = store.read(input.operation_id);
    if (byOperation !== undefined) fail("REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT");
    const raw = capability(); const timestamp = now(store); const fence = 1;
    const prepareHash = remoteArchiveV2StableHash({ operation_id: input.operation_id, idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash });
    const record = withRecordHash({ schema_version: 2, operation_id: input.operation_id,
      prepare_id: `remote_archive_prepare:${prepareHash}` as const, idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash, source: input.metadata.source, archive_id: input.metadata.archive_id,
      identities: input.metadata.identities, upload_ref: input.metadata.upload_ref, state: "prepared", generation: 1,
      lease: { project_id: input.metadata.source.project_id, branch_name: input.metadata.source.branch_name,
        actor_id: input.metadata.source.actor_id, capability_hash: capHash(raw), fencing_token: fence,
        acquired_at: timestamp, expires_at: new Date(Date.parse(timestamp) + input.lease_ttl_ms).toISOString() },
      receipt: null, failure_code: null, created_at: timestamp, updated_at: timestamp });
    store.create(record);
    return { outcome: "new", claim: { operation_id: record.operation_id, prepare_id: record.prepare_id,
      source: record.source, generation: record.generation, fencing_token: fence, capability: raw }, record };
  }

  function authoritativeClaim(value: unknown): { claim: RemoteArchiveV2Claim; record: RemoteArchiveV2Record } {
    let claim; try { claim = snapshotRemoteArchiveV2Claim(value); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
    const record = store.read(claim.operation_id); if (record === undefined) fail("REMOTE_ARCHIVE_PREPARE_NOT_FOUND");
    if (record.prepare_id !== claim.prepare_id || !sameRemoteArchiveV2Source(record.source, claim.source) || record.lease === null ||
        record.lease.project_id !== claim.source.project_id || record.lease.branch_name !== claim.source.branch_name ||
        record.lease.actor_id !== claim.source.actor_id) fail("REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH");
    if ((record.state !== "committed" && record.state !== "committing" && record.generation !== claim.generation) ||
        record.lease.fencing_token !== claim.fencing_token ||
        record.lease.capability_hash !== capHash(claim.capability)) fail("REMOTE_ARCHIVE_LEASE_FENCED");
    return { claim, record };
  }

  function committedResult(record: RemoteArchiveV2Record, outcome: "new" | "replay"): RemoteArchiveV2CommitResult {
    if (record.state !== "committed" || record.receipt === null) fail("REMOTE_ARCHIVE_COMMIT_AMBIGUOUS");
    return { outcome, record, receipt: record.receipt };
  }

  function finalizeCommitting(record: RemoteArchiveV2Record): RemoteArchiveV2Record {
    if (record.state !== "committing") fail("REMOTE_ARCHIVE_COMMIT_AMBIGUOUS");
    const storedAt = now(store);
    const receiptBody = { schema_version: 2 as const, operation_id: record.operation_id, prepare_id: record.prepare_id,
      idempotency_key: record.idempotency_key, payload_hash: record.payload_hash, source: { ...record.source }, archive_id: record.archive_id,
      package_sha256: record.identities.package_sha256, package_size_bytes: record.identities.package_size_bytes,
      manifest_hash: record.identities.manifest_hash, trusted_package_receipt_hash: record.identities.trusted_package_receipt_hash,
      local_archive_receipt_hash: record.identities.local_archive_receipt_hash, inventory_hash: record.identities.inventory_hash,
      core_v2_projection_hash: record.identities.core_v2_projection_hash, stored_at: storedAt };
    const receiptHash = remoteArchiveV2StableHash(receiptBody);
    const receipt: RemoteArchiveV2Receipt = { ...receiptBody,
      receipt_id: `remote_archive_receipt:${receiptHash}` as const, receipt_hash: receiptHash };
    const committed = withRecordHash({ ...record, state: "committed", generation: record.generation + 1,
      receipt, updated_at: storedAt });
    store.replace(committed); return store.read(committed.operation_id) ?? fail("REMOTE_ARCHIVE_RECORD_INVALID");
  }

  async function commit(value: unknown): Promise<RemoteArchiveV2CommitResult> {
    let safe: unknown; try { safe = remoteArchiveV2Snapshot(value); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
    if (safe === null || typeof safe !== "object" || Array.isArray(safe) || Object.keys(safe).join("|") !== "claim")
      fail("REMOTE_ARCHIVE_INPUT_INVALID");
    const { record } = authoritativeClaim((safe as { claim: unknown }).claim);
    if (record.state === "committed") return committedResult(record, "replay");
    if (record.state === "committing") return committedResult(finalizeCommitting(record), "new");
    if (record.state !== "prepared") fail("REMOTE_ARCHIVE_LEASE_FENCED");
    if (record.lease === null || Date.parse(record.lease.expires_at) <= store.now().getTime()) {
      store.replace(withRecordHash({ ...record, state: "failed", generation: record.generation + 1, lease: null,
        failure_code: "REMOTE_ARCHIVE_PREPARE_EXPIRED", updated_at: now(store) }));
      fail("REMOTE_ARCHIVE_PREPARE_EXPIRED");
    }
    const committing = withRecordHash({ ...record, state: "committing", generation: record.generation + 1, updated_at: now(store) });
    store.replace(committing);
    try { store.maybeCrashAfterCommitting(); } catch (error) {
      if (error instanceof RemoteArchiveV2CommitAmbiguity) fail("REMOTE_ARCHIVE_COMMIT_AMBIGUOUS");
      throw error;
    }
    const committed = finalizeCommitting(store.read(record.operation_id) ?? fail("REMOTE_ARCHIVE_RECORD_INVALID"));
    try { store.maybeAmbiguous(); } catch (error) {
      if (!(error instanceof RemoteArchiveV2CommitAmbiguity)) throw error;
      const inspected = store.read(record.operation_id);
      if (inspected === undefined || inspected.state !== "committed") fail("REMOTE_ARCHIVE_COMMIT_AMBIGUOUS");
      return committedResult(inspected, "new");
    }
    return committedResult(committed, "new");
  }

  async function status(value: unknown): Promise<RemoteArchiveV2Status> {
    const input = sourceInput(value); let record = store.read(input.operation_id);
    if (record === undefined) return { operation_id: input.operation_id, state: "unknown", record: null };
    if (!sameRemoteArchiveV2Source(record.source, input.source)) fail("REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH");
    if (record.state === "committing") record = finalizeCommitting(record);
    return { operation_id: record.operation_id, state: record.state, record };
  }
  async function receipt(value: unknown): Promise<RemoteArchiveV2Receipt | null> {
    const result = await status(value); return result.record?.receipt ?? null;
  }
  return { prepare, commit, status, receipt };
}
