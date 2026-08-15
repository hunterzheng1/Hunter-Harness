import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ArchivePackageReceipt, CoreV2Projection, PublishedArchiveInventory } from "../src/archive-package-builder/index.js";
import type { LocalArchiveReceipt } from "../src/archive-engine/index.js";
import {
  InMemoryLocalArchiveAuthorityPort,
  createLocalArchiveAuthority,
  normalizeLocalArchiveAuthorityRecord,
  serializeLocalArchiveAuthorityRecord,
  stableLocalArchiveAuthorityHash,
  type LocalArchiveAuthorityRecord,
  type LocalArchiveAuthorityVerificationInput
} from "../src/archive-outbox/index.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const PACKAGE_BYTES = new Uint8Array([1, 2, 3, 4]);
const PACKAGE_SHA = `sha256:${createHash("sha256").update(PACKAGE_BYTES).digest("hex")}` as const;

async function packageReceipt(): Promise<ArchivePackageReceipt> {
  const receipt = JSON.parse(await readFile(new URL("./fixtures/archive-package-builder-v2-current.json", import.meta.url), "utf8")) as ArchivePackageReceipt;
  return { ...receipt, package_sha256: PACKAGE_SHA, package_size_bytes: PACKAGE_BYTES.length };
}

function evidence(receipt: ArchivePackageReceipt) {
  const local_receipt: LocalArchiveReceipt = {
    schema_version: 1,
    operation_id: receipt.operation_id,
    change_identity: receipt.change_identity,
    closure_disposition: receipt.closure_disposition,
    archive_intent: receipt.archive_intent,
    source_snapshot_hash: receipt.source_snapshot_hash,
    archive_schema_version: 1,
    archive_path: receipt.archive_path,
    archive_manifest_hash: receipt.source_manifest_hash,
    completed_at: receipt.local_archive_completed_at
  };
  const inventory = {
    ...local_receipt,
    files: []
  } as PublishedArchiveInventory;
  const projection: CoreV2Projection = {
    schema_version: 2,
    project_id: receipt.project_id,
    project_version: receipt.project_version,
    archive_id: receipt.archive_id,
    files: []
  };
  return { local_receipt, inventory, projection };
}

function verifier() {
  return {
    calls: [] as LocalArchiveAuthorityVerificationInput[],
    async verify(input: LocalArchiveAuthorityVerificationInput) {
      this.calls.push(input);
      return {
        schema_version: 1 as const,
        verdict: "verified" as const,
        verification_hash: stableLocalArchiveAuthorityHash({
          project_id: input.trusted_package_receipt.project_id, archive_id: input.trusted_package_receipt.archive_id,
          trusted_package_receipt_hash: input.trusted_package_receipt.receipt_hash,
          local_archive_receipt_hash: input.trusted_package_receipt.source_receipt_hash,
          manifest_hash: input.trusted_package_receipt.manifest_sha256,
          inventory_hash: input.trusted_package_receipt.local_inventory_hash,
          core_v2_projection_hash: input.trusted_package_receipt.projection_hash,
          ref_id: input.local_zip_ref.ref_id, package_sha256: input.local_zip_ref.package_sha256,
          size_bytes: input.local_zip_ref.size_bytes
        })
      };
    }
  };
}

async function setup() {
  const receipt = await packageReceipt();
  const port = new InMemoryLocalArchiveAuthorityPort({ clock: () => new Date("2026-08-15T10:00:00.000Z") });
  const bridge = verifier();
  const authority = createLocalArchiveAuthority({ port, verifier_bridge: bridge });
  const supporting = evidence(receipt);
  const local_zip_ref = {
    ref_id: "local_archive_zip:fixture",
    package_sha256: receipt.package_sha256,
    size_bytes: receipt.package_size_bytes
  };
  const record = await authority.register({
    operation_id: "local_archive_authority_operation:register",
    authority_id: "local_archive_authority:project-state",
    project_id: receipt.project_id,
    trusted_package_receipt: receipt,
    local_archive_receipt: supporting.local_receipt,
    inventory: supporting.inventory,
    core_v2_projection: supporting.projection,
    local_zip_ref,
    package_bytes: PACKAGE_BYTES
  });
  return { authority, bridge, port, receipt, record };
}

function durableReceipt(record: LocalArchiveAuthorityRecord) {
  const operation_id = "remote_archive_operation:ack" as const;
  const prepare_id = `remote_archive_prepare:${stableLocalArchiveAuthorityHash({ operation_id,
    idempotency_key: SHA_A, payload_hash: SHA_B })}` as const;
  const body = { schema_version: 2 as const, operation_id,
    prepare_id, idempotency_key: SHA_A, payload_hash: SHA_B,
    source: { project_id: record.project_id, branch_name: "main", actor_id: "remote-worker" }, archive_id: record.archive_id,
    package_sha256: record.package_sha256, package_size_bytes: record.size_bytes, manifest_hash: record.manifest_hash,
    trusted_package_receipt_hash: record.trusted_package_receipt_hash,
    local_archive_receipt_hash: record.local_archive_receipt_hash, inventory_hash: record.inventory_hash,
    core_v2_projection_hash: record.core_v2_projection_hash, stored_at: "2026-08-15T10:00:00.000Z" };
  const receipt_hash = stableLocalArchiveAuthorityHash(body);
  return { ...body, receipt_id: `remote_archive_receipt:${receipt_hash}` as const, receipt_hash };
}

describe("archive outbox local authority contract", () => {
  it("serializes the exact durable record without a raw local path", async () => {
    const fixture = await readFile(new URL("./fixtures/archive-outbox-local-authority-v2-current.json", import.meta.url), "utf8");
    const parsed = normalizeLocalArchiveAuthorityRecord(JSON.parse(fixture));
    expect(parsed).toMatchObject({ ok: true, readiness: "ready", source_schema_version: 2 });
    if (!parsed.ok || parsed.readiness !== "ready") throw new Error("fixture invalid");
    expect(serializeLocalArchiveAuthorityRecord(parsed.record)).toBe(fixture);
    expect(fixture).not.toMatch(/[A-Za-z]:\\|archive_path|local_path|file:\/\//u);
  });

  it("keeps schema v1 read-only", async () => {
    expect(normalizeLocalArchiveAuthorityRecord({ schema_version: 1, project_id: "p", ref_id: "r", package_sha256: SHA_A }))
      .toMatchObject({ ok: true, readiness: "legacy_read_only", source_schema_version: 1 });
    expect(normalizeLocalArchiveAuthorityRecord({ schema_version: 1, project_id: "p", ref_id: "r",
      package_sha256: SHA_A, unexpected: true })).toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
  });

  it("rejects a durable record whose exact wire bytes no longer match its record hash", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/archive-outbox-local-authority-v2-current.json", import.meta.url), "utf8"));
    fixture.size_bytes += 1;
    expect(normalizeLocalArchiveAuthorityRecord(fixture)).toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
  });

  it("binds project identity, opaque ref, hash, size, and all verifier evidence", async () => {
    const { bridge, receipt, record } = await setup();
    expect(record).toMatchObject({ project_id: receipt.project_id, ref_id: "local_archive_zip:fixture", package_sha256: receipt.package_sha256,
      size_bytes: receipt.package_size_bytes, storage_kind: "project_state_cas" });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toMatchObject({ trusted_package_receipt: { receipt_hash: receipt.receipt_hash },
      local_archive_receipt: { operation_id: receipt.operation_id }, inventory: { operation_id: receipt.operation_id },
      core_v2_projection: { project_id: receipt.project_id } });
    expect(JSON.stringify(record)).not.toContain(receipt.archive_path);
  });

  it("replays the same durable operation and conflicts on changed intent", async () => {
    const { authority, bridge, receipt, record } = await setup();
    const supporting = evidence(receipt);
    const request = { operation_id: "local_archive_authority_operation:register", authority_id: record.authority_id,
      project_id: receipt.project_id, trusted_package_receipt: receipt, local_archive_receipt: supporting.local_receipt,
      inventory: supporting.inventory, core_v2_projection: supporting.projection, local_zip_ref: record,
      package_bytes: PACKAGE_BYTES } as const;
    expect(await authority.register(request)).toEqual(record);
    await expect(authority.register({ ...request, local_zip_ref: { ...record, ref_id: "local_archive_zip:changed" } }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_OPERATION_CONFLICT" });
    expect(bridge.calls).toHaveLength(1);
  });

  it("rejects bytes whose content or resolved content does not match the bound SHA-256", async () => {
    const { authority, port, receipt, record } = await setup();
    const supporting = evidence(receipt);
    await expect(authority.register({ operation_id: "local_archive_authority_operation:bad-bytes",
      authority_id: "local_archive_authority:other", project_id: "other-project", trusted_package_receipt: { ...receipt, project_id: "other-project" },
      local_archive_receipt: supporting.local_receipt, inventory: supporting.inventory,
      core_v2_projection: { ...supporting.projection, project_id: "other-project" },
      local_zip_ref: { ref_id: "local_archive_zip:bad", package_sha256: PACKAGE_SHA, size_bytes: PACKAGE_BYTES.length },
      package_bytes: new Uint8Array([4, 3, 2, 1]) })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
    Object.defineProperty(port, "readBlob", { value: async () => new Uint8Array([4, 3, 2, 1]) });
    await expect(authority.resolve(record.project_id, record.ref_id)).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID" });
  });

  it("validates intrinsic byte size and SHA-256 before invoking verifier or blob storage", async () => {
    class DishonestPort extends InMemoryLocalArchiveAuthorityPort {
      putCalls = 0;
      override async putBlob(): Promise<void> {
        this.putCalls += 1;
      }
    }
    const receipt = await packageReceipt(); const supporting = evidence(receipt);
    const port = new DishonestPort(); const bridge = verifier();
    const authority = createLocalArchiveAuthority({ port, verifier_bridge: bridge });
    await expect(authority.register({ operation_id: "local_archive_authority_operation:dishonest-bytes",
      authority_id: "local_archive_authority:dishonest", project_id: receipt.project_id, trusted_package_receipt: receipt,
      local_archive_receipt: supporting.local_receipt, inventory: supporting.inventory, core_v2_projection: supporting.projection,
      local_zip_ref: { ref_id: "local_archive_zip:dishonest", package_sha256: PACKAGE_SHA, size_bytes: PACKAGE_BYTES.length },
      package_bytes: new Uint8Array([4, 3, 2, 1]) })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
    expect(bridge.calls).toHaveLength(0);
    expect(port.putCalls).toBe(0);
  });

  it("rejects verifier evidence and durable acknowledgement receipts that are not exact bindings", async () => {
    const receipt = await packageReceipt();
    const supporting = evidence(receipt);
    const badBridge = verifier();
    badBridge.verify = async () => ({ schema_version: 1, verdict: "verified", verification_hash: SHA_A });
    const authority = createLocalArchiveAuthority({ port: new InMemoryLocalArchiveAuthorityPort(), verifier_bridge: badBridge });
    await expect(authority.register({ operation_id: "local_archive_authority_operation:bad-verification",
      authority_id: "local_archive_authority:project-state", project_id: receipt.project_id, trusted_package_receipt: receipt,
      local_archive_receipt: supporting.local_receipt, inventory: supporting.inventory, core_v2_projection: supporting.projection,
      local_zip_ref: { ref_id: "local_archive_zip:bad-verification", package_sha256: PACKAGE_SHA, size_bytes: PACKAGE_BYTES.length },
      package_bytes: PACKAGE_BYTES })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_VERIFICATION_FAILED" });

    const ready = await setup();
    const claim = await ready.authority.claim({ operation_id: "local_archive_authority_operation:bind-claim", entry_id: ready.record.entry_id,
      expected_generation: ready.record.generation, owner_id: "worker", lease_ttl_ms: 1000 });
    const durable = durableReceipt(ready.record);
    const wrongBody = { ...durable, inventory_hash: SHA_A };
    const { receipt_hash: ignoredHash, receipt_id: ignoredId, ...body } = wrongBody;
    void ignoredHash; void ignoredId;
    const receipt_hash = stableLocalArchiveAuthorityHash(body);
    await expect(ready.authority.acknowledge({ operation_id: "local_archive_authority_operation:bad-ack", claim,
      durable_receipt: { ...body, receipt_hash, receipt_id: `remote_archive_receipt:${receipt_hash}` } }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
    const malformedBody = { ...durable, schema_version: 99, operation_id: "bad", prepare_id: "bad",
      idempotency_key: "bad", payload_hash: "bad", stored_at: "not-time", unexpected: true };
    const { receipt_hash: malformedOldHash, receipt_id: malformedOldId, ...malformedHashBody } = malformedBody;
    void malformedOldHash; void malformedOldId;
    const malformedHash = stableLocalArchiveAuthorityHash(malformedHashBody);
    await expect(ready.authority.acknowledge({ operation_id: "local_archive_authority_operation:malformed-ack", claim,
      durable_receipt: { ...malformedHashBody, receipt_hash: malformedHash,
        receipt_id: `remote_archive_receipt:${malformedHash}` } as never }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
  });

  it("uses cross-process generation and fencing for lease transitions", async () => {
    const { authority, port, record } = await setup();
    const claim = await authority.claim({ operation_id: "local_archive_authority_operation:claim", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "worker-a", lease_ttl_ms: 1000 });
    const replay = await authority.claim({ operation_id: "local_archive_authority_operation:claim", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "worker-a", lease_ttl_ms: 1000 });
    expect(replay).toMatchObject({ outcome: "replay", capability: null, record: claim.record });
    const restarted = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    expect(await restarted.claim({ operation_id: "local_archive_authority_operation:claim", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "worker-a", lease_ttl_ms: 1000 }))
      .toMatchObject({ outcome: "replay", capability: null, record: claim.record });
    await expect(restarted.acknowledge({ operation_id: "local_archive_authority_operation:stale", claim: { ...claim, fencing_token: claim.fencing_token - 1 },
      durable_receipt: durableReceipt(record) })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE" });
    const ack = await restarted.acknowledge({ operation_id: "local_archive_authority_operation:ack", claim, durable_receipt: durableReceipt(record) });
    expect(ack.state).toBe("acknowledged");
    expect(await restarted.acknowledge({ operation_id: "local_archive_authority_operation:ack", claim,
      durable_receipt: durableReceipt(record) })).toEqual(ack);
  });

  it("resolves an opaque ref from durable authority state after restart", async () => {
    const { port, record } = await setup();
    const restarted = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    const bytes = await restarted.resolve(record.project_id, record.ref_id);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(record.size_bytes);
  });

  it("recovers an expired lease after restart and fences the old capability", async () => {
    let current = new Date("2026-08-15T10:00:00.000Z");
    const receipt = await packageReceipt();
    const port = new InMemoryLocalArchiveAuthorityPort({ clock: () => current });
    const authority = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    const supporting = evidence(receipt);
    const record = await authority.register({ operation_id: "local_archive_authority_operation:register-recovery",
      authority_id: "local_archive_authority:project-state", project_id: receipt.project_id, trusted_package_receipt: receipt,
      local_archive_receipt: supporting.local_receipt, inventory: supporting.inventory, core_v2_projection: supporting.projection,
      local_zip_ref: { ref_id: "local_archive_zip:recovery", package_sha256: receipt.package_sha256, size_bytes: receipt.package_size_bytes },
      package_bytes: PACKAGE_BYTES });
    const stale = await authority.claim({ operation_id: "local_archive_authority_operation:claim-recovery", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "dead-worker", lease_ttl_ms: 10 });
    current = new Date(current.getTime() + 11);
    const restarted = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    const recovered = await restarted.recoverExpired({ operation_id: "local_archive_authority_operation:recover",
      entry_id: record.entry_id, expected_generation: stale.generation });
    expect(recovered.state).toBe("available");
    expect(await restarted.recoverExpired({ operation_id: "local_archive_authority_operation:recover",
      entry_id: record.entry_id, expected_generation: stale.generation })).toEqual(recovered);
    await expect(restarted.acknowledge({ operation_id: "local_archive_authority_operation:late-ack", claim: stale,
      durable_receipt: durableReceipt(record) })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE" });
  });

  it("keeps cleanup independent, capability-fenced, and unavailable before durable ack", async () => {
    const { authority, port, record } = await setup();
    await expect(authority.claimCleanup({ operation_id: "local_archive_authority_operation:cleanup-early", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "reaper" })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_CLEANUP_NOT_ALLOWED" });
    const claim = await authority.claim({ operation_id: "local_archive_authority_operation:claim", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "worker", lease_ttl_ms: 1000 });
    const ack = await authority.acknowledge({ operation_id: "local_archive_authority_operation:ack", claim, durable_receipt: durableReceipt(record) });
    const cleanup = await authority.claimCleanup({ operation_id: "local_archive_authority_operation:cleanup", entry_id: ack.entry_id,
      expected_generation: ack.generation, owner_id: "reaper" });
    expect(await authority.claimCleanup({ operation_id: "local_archive_authority_operation:cleanup", entry_id: ack.entry_id,
      expected_generation: ack.generation, owner_id: "reaper" }))
      .toMatchObject({ outcome: "replay", capability: null, record: cleanup.record });
    const restarted = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    expect(await restarted.claimCleanup({ operation_id: "local_archive_authority_operation:cleanup", entry_id: ack.entry_id,
      expected_generation: ack.generation, owner_id: "reaper" }))
      .toMatchObject({ outcome: "replay", capability: null, record: cleanup.record });
    const completed = await authority.completeCleanup({ operation_id: "local_archive_authority_operation:cleanup-complete", claim: cleanup });
    expect(completed.cleanup.state).toBe("completed");
    expect(await authority.completeCleanup({ operation_id: "local_archive_authority_operation:cleanup-complete", claim: cleanup })).toEqual(completed);
    expect(await authority.resolve(record.project_id, record.ref_id)).toBeUndefined();
  });

  it("persists cleanup retry state and never records completion before deletion succeeds", async () => {
    const { authority, port, record } = await setup();
    const claim = await authority.claim({ operation_id: "local_archive_authority_operation:retry-claim", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "worker", lease_ttl_ms: 1000 });
    const ack = await authority.acknowledge({ operation_id: "local_archive_authority_operation:retry-ack", claim,
      durable_receipt: durableReceipt(record) });
    const cleanup = await authority.claimCleanup({ operation_id: "local_archive_authority_operation:retry-cleanup", entry_id: ack.entry_id,
      expected_generation: ack.generation, owner_id: "reaper" });
    const originalDelete = port.deleteBlob.bind(port);
    let failOnce = true;
    Object.defineProperty(port, "deleteBlob", { value: async (...args: Parameters<typeof port.deleteBlob>) => {
      if (failOnce) { failOnce = false; throw new Error("disk busy"); }
      return originalDelete(...args);
    } });
    const request = { operation_id: "local_archive_authority_operation:retry-complete", claim: cleanup } as const;
    await expect(authority.completeCleanup(request)).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID" });
    expect((await port.read(record.entry_id))?.cleanup.state).toBe("pending_retry");
    expect((await authority.completeCleanup(request)).cleanup.state).toBe("completed");
  });

  it("reclaims an expired cleanup retry after restart with a fresh capability", async () => {
    let current = new Date("2026-08-15T10:00:00.000Z");
    const receipt = await packageReceipt();
    const port = new InMemoryLocalArchiveAuthorityPort({ clock: () => current });
    const supporting = evidence(receipt);
    const authority = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    const record = await authority.register({ operation_id: "local_archive_authority_operation:restart-register",
      authority_id: "local_archive_authority:restart", project_id: receipt.project_id, trusted_package_receipt: receipt,
      local_archive_receipt: supporting.local_receipt, inventory: supporting.inventory, core_v2_projection: supporting.projection,
      local_zip_ref: { ref_id: "local_archive_zip:restart", package_sha256: PACKAGE_SHA, size_bytes: PACKAGE_BYTES.length },
      package_bytes: PACKAGE_BYTES });
    const upload = await authority.claim({ operation_id: "local_archive_authority_operation:restart-upload", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "worker", lease_ttl_ms: 1_000 });
    const acknowledged = await authority.acknowledge({ operation_id: "local_archive_authority_operation:restart-ack",
      claim: upload, durable_receipt: durableReceipt(record) });
    const staleCleanup = await authority.claimCleanup({ operation_id: "local_archive_authority_operation:restart-cleanup",
      entry_id: record.entry_id, expected_generation: acknowledged.generation, owner_id: "dead-reaper" });
    Object.defineProperty(port, "deleteBlob", { configurable: true, value: async () => { throw new Error("disk busy"); } });
    await expect(authority.completeCleanup({ operation_id: "local_archive_authority_operation:restart-complete", claim: staleCleanup }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID" });
    const pending = await port.read(record.entry_id);
    if (pending === undefined) throw new Error("missing pending cleanup record");
    current = new Date(current.getTime() + 600_001);
    await expect(authority.completeCleanup({ operation_id: "local_archive_authority_operation:restart-complete-expired",
      claim: staleCleanup })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE" });
    expect(await authority.claimCleanup({ operation_id: "local_archive_authority_operation:restart-cleanup",
      entry_id: record.entry_id, expected_generation: acknowledged.generation, owner_id: "dead-reaper" }))
      .toMatchObject({ outcome: "replay", capability: null });
    Object.defineProperty(port, "deleteBlob", { configurable: true,
      value: InMemoryLocalArchiveAuthorityPort.prototype.deleteBlob });
    const restarted = createLocalArchiveAuthority({ port, verifier_bridge: verifier() });
    const recovered = await restarted.claimCleanup({ operation_id: "local_archive_authority_operation:restart-cleanup-recover",
      entry_id: record.entry_id, expected_generation: pending.generation, owner_id: "live-reaper" });
    expect(recovered).toMatchObject({ outcome: "new", capability: expect.stringMatching(/^local_archive_authority_capability:/u) });
    expect(recovered.fencing_token).toBeGreaterThan(staleCleanup.fencing_token);
    expect((await restarted.completeCleanup({ operation_id: "local_archive_authority_operation:restart-complete-recovered",
      claim: recovered })).cleanup.state).toBe("completed");
  });

  it("rejects semantic state tampering even when the attacker recomputes the record hash", async () => {
    const { record } = await setup();
    const body = { ...record, cleanup: { state: "claimed", generation: 1, lease: null } };
    const { record_hash: ignored, ...withoutHash } = body;
    void ignored;
    expect(normalizeLocalArchiveAuthorityRecord({ ...withoutHash, record_hash: stableLocalArchiveAuthorityHash(withoutHash) }))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
    const zeroLeaseBody = { ...record, state: "leased", generation: 1,
      lease: { owner_id: "worker", capability_hash: SHA_A, fencing_token: 1,
        acquired_at: record.created_at, expires_at: record.created_at },
      last_operation: { operation_id: "local_archive_authority_operation:zero", kind: "claim", intent_hash: SHA_A } };
    const { record_hash: zeroIgnored, ...zeroWithoutHash } = zeroLeaseBody;
    void zeroIgnored;
    expect(normalizeLocalArchiveAuthorityRecord({ ...zeroWithoutHash,
      record_hash: stableLocalArchiveAuthorityHash(zeroWithoutHash) }))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
    const archiveBody = { ...record, archive_id: "" };
    const { record_hash: archiveIgnored, ...archiveWithoutHash } = archiveBody;
    void archiveIgnored;
    expect(normalizeLocalArchiveAuthorityRecord({ ...archiveWithoutHash,
      record_hash: stableLocalArchiveAuthorityHash(archiveWithoutHash) }))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
  });

  it("normalizes v2 records from a descriptor-only snapshot with deep-frozen alias isolation", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/archive-outbox-local-authority-v2-current.json", import.meta.url), "utf8"));
    let coercions = 0;
    const hostileHash = { [Symbol.toPrimitive]() { coercions += 1; return SHA_A; } };
    expect(normalizeLocalArchiveAuthorityRecord({ ...fixture, package_sha256: hostileHash }))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
    expect(coercions).toBe(0);

    const normalized = normalizeLocalArchiveAuthorityRecord(fixture);
    if (!normalized.ok || normalized.readiness !== "ready") throw new Error("fixture invalid");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.record)).toBe(true);
    expect(Object.isFrozen(normalized.record.cleanup)).toBe(true);
    fixture.cleanup.state = "completed";
    expect(normalized.record.cleanup.state).not.toBe("completed");
  });

  it("rejects an oversized property key at the snapshot boundary", () => {
    const hugeKey = "x".repeat(2_000_000);
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.schema_version = 99;
    hostile[hugeKey] = "bounded-value";
    expect(normalizeLocalArchiveAuthorityRecord(hostile))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });

    let coercions = 0;
    const guarded = Object.create(null) as Record<string, unknown>;
    guarded[hugeKey] = "bounded-value";
    guarded.schema_version = { [Symbol.toPrimitive]() { coercions += 1; return 2; } };
    expect(normalizeLocalArchiveAuthorityRecord(guarded))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
    expect(coercions).toBe(0);
  });

  it("keeps in-memory durable records recursively frozen and isolated from caller aliases", async () => {
    const { port, record } = await setup();
    const stored = await port.read(record.entry_id);
    if (stored === undefined) throw new Error("missing stored record");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.cleanup)).toBe(true);
    expect(stored).not.toBe(record);
  });

  it("rejects rehashed records whose generations drift from their lease fencing tokens", async () => {
    const { authority, record } = await setup();
    const upload = await authority.claim({ operation_id: "local_archive_authority_operation:generation-upload",
      entry_id: record.entry_id, expected_generation: record.generation, owner_id: "worker", lease_ttl_ms: 1_000 });
    if (upload.record.lease === null) throw new Error("missing upload lease");
    const uploadBody = { ...upload.record, lease: { ...upload.record.lease, fencing_token: upload.record.generation + 1 } };
    const { record_hash: ignoredUploadHash, ...uploadWithoutHash } = uploadBody; void ignoredUploadHash;
    expect(normalizeLocalArchiveAuthorityRecord({ ...uploadWithoutHash,
      record_hash: stableLocalArchiveAuthorityHash(uploadWithoutHash) }))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });

    const acknowledged = await authority.acknowledge({ operation_id: "local_archive_authority_operation:generation-ack",
      claim: upload, durable_receipt: durableReceipt(record) });
    const cleanup = await authority.claimCleanup({ operation_id: "local_archive_authority_operation:generation-cleanup",
      entry_id: record.entry_id, expected_generation: acknowledged.generation, owner_id: "reaper" });
    if (cleanup.record.cleanup.lease === null) throw new Error("missing cleanup lease");
    const cleanupBody = { ...cleanup.record, cleanup: { ...cleanup.record.cleanup,
      generation: cleanup.record.cleanup.lease.fencing_token + 1 } };
    const { record_hash: ignoredCleanupHash, ...cleanupWithoutHash } = cleanupBody; void ignoredCleanupHash;
    expect(normalizeLocalArchiveAuthorityRecord({ ...cleanupWithoutHash,
      record_hash: stableLocalArchiveAuthorityHash(cleanupWithoutHash) }))
      .toEqual({ ok: false, reason_code: "LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID" });
  });

  it("rejects Proxy/accessor/thenable inputs without executing traps", async () => {
    const { authority, record } = await setup();
    let proxyCalls = 0;
    const hostile = new Proxy({ operation_id: "local_archive_authority_operation:x", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "x", lease_ttl_ms: 1 }, { get() { proxyCalls += 1; throw new Error("trap"); } });
    await expect(authority.claim(hostile as never)).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
    expect(proxyCalls).toBe(0);

    let getterCalls = 0;
    const bridge = Object.defineProperty({}, "verify", { enumerable: true, get() { getterCalls += 1; throw new Error("getter"); } });
    expect(() => createLocalArchiveAuthority({ port: new InMemoryLocalArchiveAuthorityPort(), verifier_bridge: bridge as never }))
      .toThrow("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    expect(getterCalls).toBe(0);

    let thenCalls = 0;
    const thenable = new Proxy({ then() { thenCalls += 1; } }, { get() { thenCalls += 1; throw new Error("then"); } });
    class HostilePort extends InMemoryLocalArchiveAuthorityPort {
      override read(): Promise<LocalArchiveAuthorityRecord | undefined> { return thenable as never; }
    }
    const hostileAuthority = createLocalArchiveAuthority({ port: new HostilePort(), verifier_bridge: verifier() });
    await expect(hostileAuthority.claim({ operation_id: "local_archive_authority_operation:x", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "x", lease_ttl_ms: 1 })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID" });
    expect(thenCalls).toBe(0);

    let rejectionTrapCalls = 0;
    const hostileReason = new Proxy({}, { get() { rejectionTrapCalls += 1; throw new Error("reason trap"); } });
    class RejectingPort extends InMemoryLocalArchiveAuthorityPort {
      override inspectOperation(): Promise<undefined> { return Promise.reject(hostileReason); }
    }
    const rejectingAuthority = createLocalArchiveAuthority({ port: new RejectingPort(), verifier_bridge: verifier() });
    await expect(rejectingAuthority.claim({ operation_id: "local_archive_authority_operation:reject", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "x", lease_ttl_ms: 1 })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID" });
    expect(rejectionTrapCalls).toBe(0);
    await expect(authority.claim({ operation_id: "local_archive_authority_operation:bounds", entry_id: record.entry_id,
      expected_generation: record.generation, owner_id: "x".repeat(161), lease_ttl_ms: 1 }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
  });

  it("snapshots bounded verifier inputs without executing nested traps", async () => {
    const receipt = await packageReceipt();
    const supporting = evidence(receipt);
    let traps = 0;
    const nested = Object.defineProperty({}, "path", { enumerable: true,
      get() { traps += 1; throw new Error("nested trap"); } });
    const bridge = verifier();
    const authority = createLocalArchiveAuthority({ port: new InMemoryLocalArchiveAuthorityPort(), verifier_bridge: bridge });
    const base = { operation_id: "local_archive_authority_operation:nested", authority_id: "local_archive_authority:nested",
      project_id: receipt.project_id, trusted_package_receipt: receipt, local_archive_receipt: supporting.local_receipt,
      core_v2_projection: supporting.projection,
      local_zip_ref: { ref_id: "local_archive_zip:nested", package_sha256: PACKAGE_SHA, size_bytes: PACKAGE_BYTES.length },
      package_bytes: PACKAGE_BYTES } as const;
    await expect(authority.register({ ...base, inventory: { ...supporting.inventory, files: [nested] } as never }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
    expect(traps).toBe(0);
    await expect(authority.register({ ...base, operation_id: "local_archive_authority_operation:oversized",
      inventory: { ...supporting.inventory, files: Array.from({ length: 4_097 }, () => ({})) } as never }))
      .rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID" });
    expect(bridge.calls).toHaveLength(0);
  });

  it("does not let the verifier mutate its authoritative evidence snapshot", async () => {
    const receipt = await packageReceipt();
    const supporting = evidence(receipt);
    const local_zip_ref = { ref_id: "local_archive_zip:mutation", package_sha256: PACKAGE_SHA, size_bytes: PACKAGE_BYTES.length };
    const expected = stableLocalArchiveAuthorityHash({ project_id: receipt.project_id, archive_id: receipt.archive_id,
      trusted_package_receipt_hash: receipt.receipt_hash, local_archive_receipt_hash: receipt.source_receipt_hash,
      manifest_hash: receipt.manifest_sha256, inventory_hash: receipt.local_inventory_hash,
      core_v2_projection_hash: receipt.projection_hash, ref_id: local_zip_ref.ref_id,
      package_sha256: local_zip_ref.package_sha256, size_bytes: local_zip_ref.size_bytes });
    const bridge = { async verify(input: LocalArchiveAuthorityVerificationInput) {
      (input.trusted_package_receipt as { archive_id: string }).archive_id = "mutated";
      return { schema_version: 1 as const, verdict: "verified" as const, verification_hash: expected };
    } };
    const authority = createLocalArchiveAuthority({ port: new InMemoryLocalArchiveAuthorityPort(), verifier_bridge: bridge });
    await expect(authority.register({ operation_id: "local_archive_authority_operation:mutation",
      authority_id: "local_archive_authority:mutation", project_id: receipt.project_id, trusted_package_receipt: receipt,
      local_archive_receipt: supporting.local_receipt, inventory: supporting.inventory, core_v2_projection: supporting.projection,
      local_zip_ref, package_bytes: PACKAGE_BYTES })).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID" });
    expect(receipt.archive_id).not.toBe("mutated");
  });
});
