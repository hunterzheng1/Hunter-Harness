import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  InMemoryRemoteArchiveV2Store,
  REMOTE_ARCHIVE_V2_MAX_LEASE_TTL_MS,
  RemoteArchiveV2Error,
  createInMemoryRemoteArchiveV2,
  normalizeRemoteArchiveV2Record,
  remoteArchiveV2PayloadHash,
  remoteArchiveV2StableHash,
  type RemoteArchiveV2PrepareInput,
  type RemoteArchiveV2PrepareResult
} from "../src/remote-sync/index.js";

const H = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;

function input(overrides: Partial<RemoteArchiveV2PrepareInput> = {}): RemoteArchiveV2PrepareInput {
  const metadata = {
    schema_version: 2 as const,
    source: { project_id: "prj_archive", branch_name: "main", actor_id: "agent-06b3",
      commit_sha: "0123456789abcdef", client_id: "cli_archive", change_key: "change-archive" },
    archive_id: "arc_archive",
    identities: { package_sha256: H("1"), package_size_bytes: 42, archive_schema_version: 1 as const,
      trusted_package_receipt_hash: H("2"), local_archive_receipt_hash: H("3"), manifest_hash: H("4"),
      inventory_hash: H("5"), core_v2_projection_hash: H("6") },
    upload_ref: { ref_id: "bounded_upload:archive-zip", sha256: H("1"), size_bytes: 42 }
  };
  return { schema_version: 2, operation_id: "remote_archive_operation:fixture", idempotency_key: H("7"),
    payload_hash: remoteArchiveV2PayloadHash(metadata), lease_ttl_ms: 60_000, metadata, ...overrides };
}

function claimOf(result: RemoteArchiveV2PrepareResult) {
  if (result.outcome !== "new" || result.claim === null) throw new Error("fixture claim missing");
  return result.claim;
}

describe("Remote Archive v2 contract", () => {
  it("prepares an independent archive operation without embedding ZIP bytes or raw capability", async () => {
    const archive = createInMemoryRemoteArchiveV2({ clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const prepared = await archive.prepare(input());
    expect(prepared.outcome).toBe("new");
    expect(claimOf(prepared).capability).toMatch(/^remote_archive_capability:[A-Za-z0-9_-]{43}$/u);
    expect(prepared.record).toMatchObject({ state: "prepared", operation_id: "remote_archive_operation:fixture",
      prepare_id: expect.stringMatching(/^remote_archive_prepare:sha256:[a-f0-9]{64}$/u), payload_hash: input().payload_hash });
    const wire = JSON.stringify(prepared.record);
    expect(wire).not.toContain(claimOf(prepared).capability);
    expect(wire).not.toContain('"content"');
    expect(prepared.record.upload_ref).toEqual(input().metadata.upload_ref);
  });

  it("recomputes the full canonical metadata payload hash", async () => {
    const archive = createInMemoryRemoteArchiveV2();
    const request = input();
    await expect(archive.prepare({ ...request, payload_hash: H("f") }))
      .rejects.toMatchObject({ code: "REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH" });
    await expect(archive.prepare({ ...request, metadata: { ...request.metadata,
      identities: { ...request.metadata.identities, inventory_hash: H("a") } } }))
      .rejects.toMatchObject({ code: "REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH" });
  });

  it("replays the same key and payload but conflicts on different payload", async () => {
    const archive = createInMemoryRemoteArchiveV2();
    const first = await archive.prepare(input());
    const replay = await archive.prepare(input());
    expect(replay).toMatchObject({ outcome: "replay", record: first.record, claim: null });
    const changed = input({ operation_id: "remote_archive_operation:other" });
    const changedMetadata = { ...changed.metadata, archive_id: "arc_other" };
    await expect(archive.prepare({ ...changed, metadata: changedMetadata,
      payload_hash: remoteArchiveV2PayloadHash(changedMetadata) }))
      .rejects.toMatchObject({ code: "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT" });
  });

  it("commits with source-bound fencing and exposes status plus receipt lookup", async () => {
    const archive = createInMemoryRemoteArchiveV2({ clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const prepared = await archive.prepare(input());
    const claim = claimOf(prepared);
    await expect(archive.commit({ claim: { ...claim, fencing_token: claim.fencing_token + 1 } }))
      .rejects.toMatchObject({ code: "REMOTE_ARCHIVE_LEASE_FENCED" });
    const committed = await archive.commit({ claim });
    expect(committed).toMatchObject({ outcome: "new", record: { state: "committed" }, receipt: {
      operation_id: prepared.record.operation_id, prepare_id: prepared.record.prepare_id,
      payload_hash: prepared.record.payload_hash, package_sha256: prepared.record.identities.package_sha256 } });
    expect((await archive.status({ operation_id: prepared.record.operation_id, source: input().metadata.source })).state).toBe("committed");
    expect(await archive.receipt({ operation_id: prepared.record.operation_id, source: input().metadata.source })).toEqual(committed.receipt);
    expect((await archive.commit({ claim })).outcome).toBe("replay");
  });

  it("converges an unknown commit result through status lookup", async () => {
    const store = new InMemoryRemoteArchiveV2Store({ fail_after_commit_once: true });
    const archive = createInMemoryRemoteArchiveV2({ store });
    const prepared = await archive.prepare(input());
    const committed = await archive.commit({ claim: claimOf(prepared) });
    expect(committed).toMatchObject({ outcome: "new", record: { state: "committed" } });
  });

  it("reconciles a durable committing record after a crash and restart", async () => {
    const store = new InMemoryRemoteArchiveV2Store({ fail_after_committing_once: true,
      clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const first = createInMemoryRemoteArchiveV2({ store });
    const prepared = await first.prepare(input());
    await expect(first.commit({ claim: claimOf(prepared) })).rejects.toMatchObject({ code: "REMOTE_ARCHIVE_COMMIT_AMBIGUOUS" });
    const restarted = createInMemoryRemoteArchiveV2({ store });
    const status = await restarted.status({ operation_id: prepared.record.operation_id, source: input().metadata.source });
    expect(status).toMatchObject({ state: "committed", record: { receipt: { payload_hash: prepared.record.payload_hash } } });
    expect(await restarted.receipt({ operation_id: prepared.record.operation_id, source: input().metadata.source }))
      .toEqual(status.record?.receipt);
  });

  it("deep-freezes durable outputs and isolates them from caller aliases", async () => {
    const request = input();
    const archive = createInMemoryRemoteArchiveV2();
    const prepared = await archive.prepare(request);
    expect(Object.isFrozen(prepared.record.identities)).toBe(true);
    expect(() => { (prepared.record.identities as { manifest_hash: string }).manifest_hash = H("f"); }).toThrow(TypeError);
    (request.metadata.identities as { manifest_hash: `sha256:${string}` }).manifest_hash = H("e");
    const status = await archive.status({ operation_id: prepared.record.operation_id, source: input().metadata.source });
    expect(status.record?.identities.manifest_hash).toBe(H("4"));
    expect(normalizeRemoteArchiveV2Record(status.record)).toMatchObject({ ok: true, readiness: "ready" });
  });

  it("reconstructs status and durable prepare replay after restart without returning a raw capability", async () => {
    const store = new InMemoryRemoteArchiveV2Store();
    const first = createInMemoryRemoteArchiveV2({ store });
    const prepared = await first.prepare(input());
    const restarted = createInMemoryRemoteArchiveV2({ store });
    expect((await restarted.status({ operation_id: prepared.record.operation_id, source: input().metadata.source })).state).toBe("prepared");
    await expect(restarted.prepare(input())).resolves.toMatchObject({ outcome: "replay", claim: null, record: prepared.record });
    expect(await restarted.commit({ claim: claimOf(prepared) })).toMatchObject({ record: { state: "committed" } });
  });

  it("keeps legacy v1 read-only", async () => {
    const legacy = JSON.parse(await readFile(new URL("./fixtures/remote-archive-v1-legacy.json", import.meta.url), "utf8"));
    expect(normalizeRemoteArchiveV2Record(legacy)).toMatchObject({ ok: true, source_schema_version: 1,
      readiness: "legacy_read_only" });
    expect(normalizeRemoteArchiveV2Record({ ...legacy, foreign: true }))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
  });

  it("validates the exact durable v2 record hash", async () => {
    const prepared = await createInMemoryRemoteArchiveV2().prepare(input());
    expect(normalizeRemoteArchiveV2Record(prepared.record)).toMatchObject({ ok: true, source_schema_version: 2, readiness: "ready" });
    expect(normalizeRemoteArchiveV2Record({ ...prepared.record, archive_id: "arc_tampered" }))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
  });

  it("closes prepare derivation, RFC3339 time ordering, lease expiry, and lifecycle state", async () => {
    const prepared = await createInMemoryRemoteArchiveV2({ clock: () => new Date("2026-08-15T00:00:00.000Z") }).prepare(input());
    const forge = (changes: Record<string, unknown>) => {
      const { record_hash: ignored, ...body } = { ...prepared.record, ...changes }; void ignored;
      return { ...body, record_hash: remoteArchiveV2StableHash(body) };
    };
    expect(normalizeRemoteArchiveV2Record(forge({ prepare_id: `remote_archive_prepare:${H("f")}` })))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
    expect(normalizeRemoteArchiveV2Record(forge({ updated_at: "not-a-time" })))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
    const lease = { ...prepared.record.lease, expires_at: "2026-08-14T23:59:59.999Z" };
    expect(normalizeRemoteArchiveV2Record(forge({ lease })))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
    expect(normalizeRemoteArchiveV2Record(forge({ state: "failed", failure_code: null, lease: null })))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
  });

  it("rejects foreign identity, illegal transition, generation, and fencing replacements", async () => {
    const store = new InMemoryRemoteArchiveV2Store({ clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const archive = createInMemoryRemoteArchiveV2({ store });
    const prepared = await archive.prepare(input());
    const withHash = (changes: Record<string, unknown>) => {
      const { record_hash: ignored, ...body } = { ...prepared.record, ...changes }; void ignored;
      return { ...body, record_hash: remoteArchiveV2StableHash(body) } as typeof prepared.record;
    };
    const changedKey = withHash({
      idempotency_key: H("8"),
      prepare_id: `remote_archive_prepare:${remoteArchiveV2StableHash({
        operation_id: prepared.record.operation_id, idempotency_key: H("8"), payload_hash: prepared.record.payload_hash
      })}`
    });
    expect(() => store.replace(changedKey)).toThrow("REMOTE_ARCHIVE_RECORD_INVALID");
    expect(store.keyOwner(prepared.record.idempotency_key)).toBe(prepared.record.operation_id);
    expect(store.keyOwner(H("8"))).toBeUndefined();

    const illegalFence = withHash({
      state: "committing", generation: 2,
      lease: { ...prepared.record.lease, fencing_token: claimOf(prepared).fencing_token + 1 }
    });
    expect(() => store.replace(illegalFence)).toThrow("REMOTE_ARCHIVE_RECORD_INVALID");

    const lease = prepared.record.lease;
    if (lease === null) throw new Error("fixture lease missing");
    const illegalLeaseTime = withHash({
      state: "committing", generation: 2,
      lease: { ...lease, acquired_at: new Date(Date.parse(lease.acquired_at) + 1).toISOString(),
        expires_at: new Date(Date.parse(lease.expires_at) + 1).toISOString() }
    });
    expect(() => store.replace(illegalLeaseTime)).toThrow("REMOTE_ARCHIVE_RECORD_INVALID");

    const committed = await archive.commit({ claim: claimOf(prepared) });
    const illegalTransition = {
      ...committed.record,
      state: "prepared",
      generation: committed.record.generation + 1,
      receipt: null,
      updated_at: new Date(Date.parse(committed.record.updated_at) + 1).toISOString(),
      record_hash: "" as `sha256:${string}`
    };
    const { record_hash: ignored, ...transitionBody } = illegalTransition; void ignored;
    const transition = { ...transitionBody, record_hash: remoteArchiveV2StableHash(transitionBody) } as typeof committed.record;
    expect(() => store.replace(transition)).toThrow("REMOTE_ARCHIVE_RECORD_INVALID");
  });

  it("bounds durable lease TTL and failed generation", async () => {
    const prepared = await createInMemoryRemoteArchiveV2({
      clock: () => new Date("2026-08-15T00:00:00.000Z")
    }).prepare(input());
    const forge = (changes: Record<string, unknown>) => {
      const { record_hash: ignored, ...body } = { ...prepared.record, ...changes }; void ignored;
      return { ...body, record_hash: remoteArchiveV2StableHash(body) };
    };
    const lease = prepared.record.lease;
    if (lease === null) throw new Error("fixture lease missing");
    const tooLongLease = {
      ...lease,
      expires_at: new Date(Date.parse(lease.acquired_at) + REMOTE_ARCHIVE_V2_MAX_LEASE_TTL_MS + 1).toISOString()
    };
    expect(normalizeRemoteArchiveV2Record(forge({ lease: tooLongLease })))
      .toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
    expect(normalizeRemoteArchiveV2Record(forge({
      state: "failed", generation: 1, lease: null, receipt: null,
      failure_code: "REMOTE_ARCHIVE_PREPARE_EXPIRED",
      updated_at: new Date(Date.parse(prepared.record.updated_at) + 1).toISOString()
    }))).toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
    expect(normalizeRemoteArchiveV2Record(forge({
      state: "failed", generation: 2, lease, receipt: null,
      failure_code: "REMOTE_ARCHIVE_PREPARE_EXPIRED",
      updated_at: new Date(Date.parse(prepared.record.updated_at) + 1).toISOString()
    }))).toEqual({ ok: false, reason_code: "REMOTE_ARCHIVE_RECORD_INVALID" });
  });

  it("bounds printable operation identity on status and clears only an expired lease", async () => {
    let current = new Date("2026-08-15T00:00:00.000Z");
    const archive = createInMemoryRemoteArchiveV2({ clock: () => current });
    const prepared = await archive.prepare(input());
    await expect(archive.status({ operation_id: `remote_archive_operation:${"x".repeat(241)}`, source: input().metadata.source }))
      .rejects.toMatchObject({ code: "REMOTE_ARCHIVE_INPUT_INVALID" });
    await expect(archive.status({ operation_id: "remote_archive_operation:bad\nlookup", source: input().metadata.source }))
      .rejects.toMatchObject({ code: "REMOTE_ARCHIVE_INPUT_INVALID" });
    current = new Date("2026-08-15T00:02:00.000Z");
    await expect(archive.commit({ claim: claimOf(prepared) })).rejects.toMatchObject({ code: "REMOTE_ARCHIVE_PREPARE_EXPIRED" });
    await expect(archive.status({ operation_id: prepared.record.operation_id, source: input().metadata.source }))
      .resolves.toMatchObject({ state: "failed", record: { generation: 2, lease: null, failure_code: "REMOTE_ARCHIVE_PREPARE_EXPIRED" } });
  });

  it("rejects Proxy, accessor, and thenable inputs without executing traps", async () => {
    const archive = createInMemoryRemoteArchiveV2();
    let calls = 0;
    const proxy = new Proxy(input(), { get() { calls += 1; throw new Error("trap"); } });
    await expect(archive.prepare(proxy)).rejects.toBeInstanceOf(RemoteArchiveV2Error);
    const accessor = input() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "metadata", { enumerable: true, get() { calls += 1; return input().metadata; } });
    await expect(archive.prepare(accessor as unknown as RemoteArchiveV2PrepareInput)).rejects.toBeInstanceOf(RemoteArchiveV2Error);
    const thenable = { ...input(), then() { calls += 1; } };
    await expect(archive.prepare(thenable as unknown as RemoteArchiveV2PrepareInput)).rejects.toBeInstanceOf(RemoteArchiveV2Error);
    const options = Object.defineProperty({}, "store", { enumerable: true, get() { calls += 1; throw new Error("trap"); } });
    expect(() => createInMemoryRemoteArchiveV2(options as never)).toThrow("REMOTE_ARCHIVE_INPUT_INVALID");
    expect(calls).toBe(0);
  });
});
