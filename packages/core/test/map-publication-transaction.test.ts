import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createMapPublicationTransaction,
  InMemoryMapPublicationTransactionPort,
  planMapPublication,
  type MapManifestDraftV2,
  type MapPublicationCommitRequest
} from "../src/codebase/map-v2/index.js";
import { contentHash, stableHash, stableJson } from "../src/codebase/map-v2/stable.js";

const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const names = ["STACK.md", "INTEGRATIONS.md", "ARCHITECTURE.md", "STRUCTURE.md",
  "CONVENTIONS.md", "TESTING.md", "CONCERNS.md"] as const;

function plan(previous = sha("a")) {
  const documents = Object.fromEntries(names.map((name) => [name,
    name === "ARCHITECTURE.md" ? "# Architecture\n\nSee `src/index.ts`." : `# ${name}\n\nCurrent.`]));
  const manifest: MapManifestDraftV2 = {
    schema_version: 2, generator: { name: "fixture", version: "1" }, project_identity: "project-one",
    repository_identity: "repo-one", mode: "incremental", scope: "repository", path_filters: [],
    input_fingerprint: sha("b"), documents: names.map((name) => ({
      path: `.harness/codebase/map/${name}`, topics: [name], evidence_sources: [], input_fingerprint: sha("b"),
      content_hash: sha("c"), estimated_tokens: 1, status: "current"
    })), summary_hash: sha("d"), warnings: [], degradation_reasons: [], status: "ready"
  };
  const result = planMapPublication({ schema_version: 2, published_at: "2026-08-14T00:00:00.000Z",
    mode: "incremental", affected_documents: ["STACK.md"], previous_manifest_hash: previous,
    previous_documents: documents, proposed_documents: { "STACK.md": "# STACK.md\n\nUpdated." },
    manifest_draft: manifest, summary_content: "# Summary\n" });
  if (!result.ok) throw new Error(result.reason_codes.join(","));
  return result;
}

function request(operation_id = "map_operation:one", action_id = "codebase_map:refresh",
  idempotency_key = "map_publication:key-one"): MapPublicationCommitRequest {
  return { schema_version: 1, operation_id, action_id, idempotency_key, expected_previous_manifest: {
    state: "sha256", manifest_hash: sha("a") }, ownership_paths: [
      ...names.map((name) => `.harness/codebase/map/${name}` as const),
      ".harness/codebase/map-summary.md", ".harness/codebase/map-manifest.json"
    ], plan: plan() };
}

describe("Stage05-M3U map publication filesystem transaction contract", () => {
  it("commits the exact M3T plan and replays the same key without a second apply", async () => {
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const module = createMapPublicationTransaction(port);
    const first = await module.commitPublication(request());
    const replay = await module.commitPublication(request());
    expect(first.outcome).toBe("committed");
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt?.receipt_id).toBe(first.receipt?.receipt_id);
    expect(replay.no_changes).toBe(true);
    expect(port.calls.apply).toBe(1);
    expect(first.receipt).toMatchObject({ previous_manifest_hash: sha("a"), modified_paths: expect.any(Array),
      preserved_paths: [], verification: { manifest_hash_verified: true, payloads_verified: true,
        journal_committed: true } });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("fails stale baselines and conflicts the same key with a different plan or action", async () => {
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("f") });
    const module = createMapPublicationTransaction(port);
    expect((await module.commitPublication(request())).outcome).toBe("stale");
    const fresh = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const tx = createMapPublicationTransaction(fresh);
    await tx.commitPublication(request());
    expect((await tx.commitPublication(request("map_operation:two"))).outcome).toBe("idempotency_conflict");
    expect((await tx.commitPublication(request("map_operation:one", "other:action"))).outcome)
      .toBe("idempotency_conflict");
  });

  it("reports an ambiguous commit, resolves it through inspect, and recovers a pre-commit crash", async () => {
    const committed = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a"),
      crash_once_at: "after_commit" });
    const tx = createMapPublicationTransaction(committed);
    const ambiguous = await tx.commitPublication(request());
    expect(ambiguous.outcome).toBe("recovery_required");
    expect((await tx.inspect(request().operation_id)).state).toBe("committed");
    expect((await tx.recover(request().operation_id)).outcome).toBe("replayed");

    const applying = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a"),
      crash_once_at: "before_commit" });
    const recoverable = createMapPublicationTransaction(applying);
    expect((await recoverable.commitPublication(request())).outcome).toBe("recovery_required");
    expect((await recoverable.recover(request().operation_id)).outcome).toBe("committed");
  });

  it("binds a prepared operation to the complete request and conflicts a different replay", async () => {
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a"),
      crash_once_at: "before_commit" });
    const tx = createMapPublicationTransaction(port);
    expect((await tx.commitPublication(request())).outcome).toBe("recovery_required");
    const prepared = await tx.inspect("map_operation:one");
    expect(prepared).toMatchObject({ state: "applying", binding: { operation_id: "map_operation:one",
      action_id: "codebase_map:refresh", idempotency_key: "map_publication:key-one",
      plan_hash: request().plan.plan_hash, expected_previous_manifest: request().expected_previous_manifest,
      ownership_paths: request().ownership_paths } });
    expect(Object.isFrozen(prepared.binding)).toBe(true);
    expect((await tx.commitPublication(request("map_operation:one", "other:action"))).outcome)
      .toBe("idempotency_conflict");
    expect((await tx.recover("map_operation:one")).outcome).toBe("committed");
  });

  it("fails closed on malformed committed apply output instead of reporting transport ambiguity", async () => {
    const source = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const port = { inspect: source.inspect, prepare: source.prepare,
      apply: () => Promise.resolve({ operation_id: "map_operation:one", state: "committed", receipt: {},
        recovery_token: `map_recovery:${"0".repeat(64)}` }), recover: source.recover, rollback: source.rollback,
      readback: source.readback };
    await expect(createMapPublicationTransaction(port as never).commitPublication(request()))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
  });

  it("rejects a self-hashed committed receipt that is foreign to the prepared binding", async () => {
    const source = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const port = { inspect: source.inspect, prepare: source.prepare, recover: source.recover,
      rollback: source.rollback, readback: source.readback,
      apply: async (...args: Parameters<typeof source.apply>) => {
        const output = structuredClone(await source.apply(...args));
        if (output.receipt === null) return output;
        const { receipt_id: ignored, ...body } = output.receipt;
        void ignored;
        const foreignBody = { ...body, action_id: "foreign:action" };
        const receiptId = createHash("sha256").update(stableJson(foreignBody)).digest("hex");
        return { ...output, receipt: { ...foreignBody, receipt_id: `map_publication_receipt:${receiptId}` } };
      } };
    await expect(createMapPublicationTransaction(port as never).commitPublication(request()))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
  });

  it("does not accept committed verification when post-commit readback is incomplete", async () => {
    const source = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    let calls = 0;
    const port = { inspect: source.inspect, prepare: source.prepare, apply: source.apply, recover: source.recover,
      rollback: source.rollback, readback: async (...args: Parameters<typeof source.readback>) => {
        calls += 1;
        const output = await source.readback(...args);
        return calls === 1 ? output : { ...output, payload_hashes: {} };
      } };
    await expect(createMapPublicationTransaction(port as never).commitPublication(request()))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
  });

  it("rejects a restart inspection whose self-consistent receipt/readback rewrites one target payload", async () => {
    const source = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a"),
      crash_once_at: "after_commit" });
    const first = createMapPublicationTransaction(source);
    expect((await first.commitPublication(request())).outcome).toBe("recovery_required");
    const persisted = await source.inspect(request().operation_id);
    if (persisted.receipt === null || persisted.binding === null) throw new Error("fixture did not commit");
    const originalReadback = await source.readback(request().operation_id);
    expect(Object.keys(persisted.binding.expected_payload_hashes)).toEqual(request().ownership_paths);
    expect(persisted.binding.expected_readback_hash).toBe(persisted.receipt.verification.readback_hash);
    const rewrittenPayloads = { ...originalReadback.payload_hashes, [request().ownership_paths[0]]: sha("f") };
    const rewrittenHash = stableHash({ plan_hash: persisted.binding.plan_hash,
      manifest_hash: persisted.binding.new_manifest_hash,
      payloads: request().ownership_paths.map((path) => ({ path, content_hash: rewrittenPayloads[path] })) });
    const { receipt_id: ignored, ...receiptBody } = persisted.receipt;
    void ignored;
    const rewrittenReceiptBody = { ...receiptBody,
      verification: { ...persisted.receipt.verification, readback_hash: rewrittenHash } };
    const rewrittenReceipt = { ...rewrittenReceiptBody,
      receipt_id: `map_publication_receipt:${stableHash(rewrittenReceiptBody).slice(7)}` };
    const restartedPort = {
      inspect: () => Promise.resolve({ ...persisted, receipt: rewrittenReceipt }),
      prepare: source.prepare,
      apply: source.apply,
      recover: source.recover,
      rollback: source.rollback,
      readback: () => Promise.resolve({ ...originalReadback, payload_hashes: rewrittenPayloads })
    };
    await expect(createMapPublicationTransaction(restartedPort as never).recover(request().operation_id))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
  });

  it("rejects a prepared inspection whose recovery token drifts from its request binding", async () => {
    const source = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const port = { inspect: source.inspect, apply: source.apply, recover: source.recover, rollback: source.rollback,
      readback: source.readback, prepare: async (...args: Parameters<typeof source.prepare>) => ({
        ...(await source.prepare(...args)), recovery_token: `map_recovery:${"f".repeat(64)}`
      }) };
    await expect(createMapPublicationTransaction(port as never).commitPublication(request()))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
    expect(source.calls.apply).toBe(0);
  });

  it("derives modified paths and canonical readback hash from all nine live payload hashes", async () => {
    const initial = plan();
    const manifestHash = contentHash(initial.manifest_payload);
    const next = plan(manifestHash);
    const payloadHashes = Object.fromEntries(Object.entries(next.payloads).map(([path, payload]) =>
      [path, contentHash(payload)]));
    payloadHashes[".harness/codebase/map/STACK.md"] = sha("f");
    const input = { ...request(), expected_previous_manifest: { state: "sha256" as const,
      manifest_hash: manifestHash }, plan: next };
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: manifestHash,
      initial_payload_hashes: payloadHashes } as never);
    const result = await createMapPublicationTransaction(port).commitPublication(input);
    expect(result.outcome).toBe("committed");
    expect(result.receipt?.modified_paths).toEqual([".harness/codebase/map/STACK.md"]);
    expect(result.receipt?.preserved_paths).toEqual(input.ownership_paths.slice(1));
    expect(result.no_changes).toBe(false);
    const exactHashes = Object.fromEntries(Object.entries(next.payloads).map(([path, payload]) =>
      [path, contentHash(payload)]));
    const canonical = { plan_hash: next.plan_hash, manifest_hash: manifestHash,
      payloads: input.ownership_paths.map((path) => ({ path, content_hash: exactHashes[path] })) };
    const expectedReadback = `sha256:${createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
    expect(result.receipt?.verification.readback_hash).toBe(expectedReadback);

    const unchanged = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: manifestHash,
      initial_payload_hashes: exactHashes } as never);
    const nochange = await createMapPublicationTransaction(unchanged).commitPublication(input);
    expect(nochange).toMatchObject({ outcome: "committed", no_changes: true,
      receipt: { modified_paths: [], preserved_paths: input.ownership_paths } });
  });

  it("rolls back only while the live manifest is still the published hash", async () => {
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const tx = createMapPublicationTransaction(port);
    const committed = await tx.commitPublication(request());
    expect((await tx.rollback({ schema_version: 1, operation_id: request().operation_id,
      recovery_token: committed.receipt?.recovery_token ?? "", expected_published_manifest_hash:
      committed.receipt?.new_manifest_hash ?? "" })).outcome).toBe("rolled_back");
    expect((await tx.rollback({ schema_version: 1, operation_id: request().operation_id,
      recovery_token: committed.receipt?.recovery_token ?? "", expected_published_manifest_hash:
      committed.receipt?.new_manifest_hash ?? "" })).outcome).toBe("conflict");
  });

  it("rejects hostile inputs and Port results without executing accessors or Proxy traps", async () => {
    let traps = 0; let getters = 0;
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const tx = createMapPublicationTransaction(port);
    const hostile = new Proxy(request() as object, { ownKeys() { traps += 1; return []; } });
    await expect(tx.commitPublication(hostile as never)).rejects.toThrow("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
    const accessor = { ...request() } as Record<string, unknown>;
    Object.defineProperty(accessor, "plan", { enumerable: true, get() { getters += 1; return plan(); } });
    await expect(tx.commitPublication(accessor as never)).rejects.toThrow("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
    expect({ traps, getters, apply: port.calls.apply }).toEqual({ traps: 0, getters: 0, apply: 0 });

    const proxyPort = new Proxy(port, { getOwnPropertyDescriptor() { traps += 1; throw new Error("unsafe"); } });
    expect(() => createMapPublicationTransaction(proxyPort)).toThrow("MAP_PUBLICATION_PORT_INVALID");
    expect(traps).toBe(0);

    const thenablePort = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const thenable = {} as Record<string, unknown>;
    Object.defineProperty(thenable, "then", { enumerable: true, get() { getters += 1; throw new Error("unsafe"); } });
    Object.defineProperty(thenablePort, "inspect", { value: () => thenable });
    await expect(createMapPublicationTransaction(thenablePort).commitPublication(request()))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
    expect(getters).toBe(0);

    const outputPort = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const hostileOutput = new Proxy({}, { ownKeys() { traps += 1; throw new Error("unsafe"); } });
    Object.defineProperty(outputPort, "inspect", { value: () => Promise.resolve(hostileOutput) });
    await expect(createMapPublicationTransaction(outputPort).commitPublication(request()))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
    expect(traps).toBe(0);

    const rollbackProxy = new Proxy({}, { ownKeys() { traps += 1; throw new Error("unsafe"); } });
    await expect(tx.rollback(rollbackProxy as never)).rejects.toThrow("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
    expect(traps).toBe(0);
  });

  it("rejects a self-consistent-looking plan when any M3T payload projection is changed", async () => {
    const port = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const input = structuredClone(request()) as unknown as MapPublicationCommitRequest & {
      plan: { documents: Record<string, string> }
    };
    input.plan.documents["STACK.md"] = "# foreign projection";
    await expect(createMapPublicationTransaction(port).commitPublication(input))
      .rejects.toThrow("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
    expect(port.calls).toMatchObject({ inspect: 0, prepare: 0, apply: 0 });
  });

  it("accepts synchronous plain Port data but rejects malformed rollback and readback payloads", async () => {
    const source = new InMemoryMapPublicationTransactionPort({ initial_manifest_hash: sha("a") });
    const syncFirstPort = { inspect: (operationId: string) => ({ operation_id: operationId, state: "unknown" as const,
      receipt: null, recovery_token: null, binding: null }), prepare: source.prepare, apply: source.apply, recover: source.recover,
      rollback: source.rollback, readback: source.readback };
    const tx = createMapPublicationTransaction(syncFirstPort as never);
    expect((await tx.commitPublication(request())).outcome).toBe("committed");
    const malformedRollback = { ...syncFirstPort,
      rollback: () => Promise.resolve({ outcome: "rolled_back", extra: true }) };
    await expect(createMapPublicationTransaction(malformedRollback as never).rollback({ schema_version: 1,
      operation_id: request().operation_id,
      recovery_token: `map_recovery:${"0".repeat(64)}`, expected_published_manifest_hash: sha("a") }))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
    const malformedReadback = { ...syncFirstPort, readback: () => Promise.resolve({ operation_id: request().operation_id,
      live_manifest_hash: null, payload_hashes: {}, journal_committed: true }) };
    await expect(createMapPublicationTransaction(malformedReadback as never).readback(request().operation_id))
      .rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
  });

  it("reads the exact current receipt and keeps legacy receipts read-only", async () => {
    const module = createMapPublicationTransaction(new InMemoryMapPublicationTransactionPort());
    const current = JSON.parse(await readFile(new URL("./fixtures/map-publication-transaction-v1-current.json",
      import.meta.url), "utf8")) as unknown;
    const legacy = JSON.parse(await readFile(new URL("./fixtures/map-publication-transaction-v0-legacy.json",
      import.meta.url), "utf8")) as unknown;
    const readCurrent = module.readReceipt(current);
    expect(readCurrent).toMatchObject({ ok: true, mode: "current" });
    expect(Object.isFrozen(readCurrent) && Object.isFrozen(readCurrent.ok && readCurrent.mode === "current" ?
      readCurrent.value.verification : null)).toBe(true);
    expect(JSON.parse(JSON.stringify(readCurrent.ok && readCurrent.mode === "current" ? readCurrent.value : null)))
      .toEqual(current);
    const generated = await createMapPublicationTransaction(new InMemoryMapPublicationTransactionPort({
      initial_manifest_hash: sha("a") })).commitPublication(request());
    expect(generated.receipt).toEqual(current);
    expect(module.readReceipt(legacy)).toEqual({ ok: true, mode: "legacy_read_only", source_schema_version: 0 });
    expect(module.readReceipt({ ...(current as object), extra: true })).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_RECEIPT_INVALID" });
    const duplicate = structuredClone(current) as Record<string, unknown>;
    duplicate.modified_paths = [request().ownership_paths[0], request().ownership_paths[0]];
    duplicate.preserved_paths = request().ownership_paths.slice(1);
    const { receipt_id: ignored, ...duplicateBody } = duplicate;
    void ignored;
    duplicate.receipt_id = `map_publication_receipt:${createHash("sha256").update(stableJson(duplicateBody)).digest("hex")}`;
    expect(module.readReceipt(duplicate)).toEqual({ ok: false, reason_code: "MAP_PUBLICATION_RECEIPT_INVALID" });
  });
});
