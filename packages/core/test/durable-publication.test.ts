import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalJson } from "@hunter-harness/contracts";

import {
  createDurablePlanPublicationModule,
  verifyDurablePublicationReceipt,
  type PlanDurablePublicationPort
} from "../src/plan-quality/durable-publication/index.js";

const changeKey = "change-12-quality";
const projectId = "project-demo";
const paths = [
  "plans/change-12-quality-design.md", "plans/change-12-quality-plan.md",
  "plans/change-12-quality-test-scenarios.md", "plans/change-12-quality-implementation-detail.md",
  "meta/gate-policy.json", "meta/worktree.json", "meta/implementation-checkpoints.json", "meta/scenario-manifest.json"
];
function hash(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function rawHash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
function plan() {
  const payloads = paths.map((path, index) => {
    const serialized_content = "payload-" + index + "\n";
    const bytes = [...Buffer.from(serialized_content)];
    const descriptor = { path, artifact_type: index < 4 ? ["design", "plan", "test_scenarios", "implementation_detail"][index] : "machine",
      format: path.endsWith(".md") ? "markdown" as const : "json" as const,
      classification: index < 3 ? "human_truth" as const : index === 3 ? "compatibility_derived" as const : "machine_derived" as const,
      byte_length: bytes.length, serialized_sha256: rawHash(serialized_content), semantic_content_hash: hash("semantic-" + index) };
    return { ...descriptor, serialized_content, bytes };
  });
  const manifest = { schema_version: 1 as const, change_key: changeKey, approval_receipt_ref: "approval:12",
    artifact_derivation_receipt_refs: [hash("a"), hash("b"), hash("c")] as [string, string, string],
    ownership_paths: [...paths].sort(), entries: payloads.map((item) => {
      const descriptor = { ...item };
      delete descriptor.serialized_content;
      delete descriptor.bytes;
      return descriptor;
    }) };
  const manifest_hash = hash(manifest);
  return { schema_version: 1 as const, change_key: changeKey, publication_intent_id: "plan_publication:" + manifest_hash.slice(7),
    manifest_hash, manifest, approval_receipt_ref: manifest.approval_receipt_ref,
    artifact_derivation_receipt_refs: manifest.artifact_derivation_receipt_refs, ownership_paths: [...paths].sort(), payloads };
}
function input(overrides: Record<string, unknown> = {}) {
  return { schema_version: 1 as const, operation_id: "publication:12:one", idempotency_key: "idem:12:one",
    project_id: projectId, change_key: changeKey, expected_baseline: { state: "absent" as const, manifest_hash: null, generation: 0 as const },
    plan: plan(), ...overrides };
}
function receipt(value: ReturnType<typeof plan>, overrides: Record<string, unknown> = {}) {
  const body = { schema_version: 1 as const, operation_id: "publication:12:one", idempotency_key: "idem:12:one",
    project_id: projectId, change_key: changeKey, publication_intent_id: value.publication_intent_id,
    plan_hash: hash(value), previous_manifest_hash: null, manifest_hash: value.manifest_hash,
    previous_generation: 0, generation: 1, modified_paths: paths, preserved_paths: [],
    event_id: "plan_event:" + "1".repeat(64), committed_at: "2026-08-14T00:00:00.000Z", ...overrides };
  return { ...body, receipt_id: "plan_durable_publication_receipt:" + hash(body).slice(7) };
}
function portFor(value = plan(), behavior: (request: unknown) => unknown = () =>
  ({ state: "committed", receipt: receipt(value) })) {
  const calls: unknown[] = [];
  const port: PlanDurablePublicationPort & { calls: unknown[] } = {
    calls,
    async publish(request) { calls.push(request); return behavior(request); },
    async lookup(request) { calls.push({ lookup: request }); return { state: "unknown", receipt: null }; }
  };
  return port;
}

describe("Stage12-M4T durable publication contract", () => {
  it("accepts realistic-size payloads (bytes arrays beyond the old 4096 snapshot cap)", async () => {
    // 回归：集成时暴露的阻塞——snapshot 曾把数组限死在 4096 元素，
    // 任意 >4KB 的规划文档的 bytes 展开即被拒。现已对齐载荷边界（2MB/payload）。
    const value = plan();
    const big = "规".repeat(9_000); // ~27KB UTF-8
    (value.payloads[0] as { serialized_content: string }).serialized_content = big;
    const bytes = [...Buffer.from(big, "utf8")];
    (value.payloads[0] as { bytes: number[] }).bytes = bytes;
    (value.payloads[0] as { byte_length: number }).byte_length = bytes.length;
    (value.payloads[0] as { serialized_sha256: string }).serialized_sha256 = rawHash(big);
    const entries = value.payloads.map((item) => Object.fromEntries(Object.entries(item)
      .filter(([key]) => key !== "serialized_content" && key !== "bytes")));
    const manifest = { ...value.manifest, entries };
    const manifest_hash = hash(manifest);
    const normalized = { ...value, manifest, manifest_hash,
      publication_intent_id: "plan_publication:" + manifest_hash.slice(7) };
    const port = portFor(normalized, () => ({ state: "committed", receipt: receipt(normalized) }));
    const result = await createDurablePlanPublicationModule(port).publish(input({ plan: normalized }));
    expect(result.ok).toBe(true);
  });

  it("still rejects payloads beyond the 2MB publication bound (fail closed)", async () => {
    const value = plan();
    const tooBig = "x".repeat(2_000_001);
    (value.payloads[0] as { serialized_content: string }).serialized_content = tooBig;
    const bytes = [...Buffer.from(tooBig, "utf8")];
    (value.payloads[0] as { bytes: number[] }).bytes = bytes;
    (value.payloads[0] as { byte_length: number }).byte_length = bytes.length;
    (value.payloads[0] as { serialized_sha256: string }).serialized_sha256 = rawHash(tooBig);
    await expect(createDurablePlanPublicationModule(portFor(value)).publish(input({ plan: value })))
      .rejects.toThrow("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
  });

  it("publishes exact eight M4A payloads and allows the event only after verified durable receipt", async () => {
    const value = plan(); const port = portFor(value); const module = createDurablePlanPublicationModule(port);
    const result = await module.publish(input({ plan: value }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event_allowed).toBe(true);
    expect(result.event).toMatchObject({ event_kind: "publication_durable", receipt_id: result.receipt.receipt_id,
      publication_intent_id: value.publication_intent_id, generation: 1 });
    expect((port.calls[0] as Record<string, unknown>)).not.toHaveProperty("event");
    expect((port.calls[0] as Record<string, unknown>)).not.toHaveProperty("events");
    expect((port.calls[0] as { plan: { payloads: readonly unknown[] } }).plan.payloads).toHaveLength(8);
  });

  it("resolves an unknown commit with lookup using the exact same identity", async () => {
    const value = plan(); let lookupInput: unknown;
    const committed = receipt(value);
    const port: PlanDurablePublicationPort = {
      async publish() { return { state: "unknown", receipt: null }; },
      async lookup(request) { lookupInput = structuredClone(request); return { state: "committed", receipt: committed }; }
    };
    const result = await createDurablePlanPublicationModule(port).publish(input({ plan: value }));
    expect(result.ok).toBe(true);
    expect(lookupInput).toMatchObject({ operation_id: "publication:12:one", idempotency_key: "idem:12:one",
      project_id: projectId, change_key: changeKey, manifest_hash: value.manifest_hash, publication_intent_id: value.publication_intent_id,
      plan_hash: hash(value) });
  });

  it("accepts an exact replay and preserves an idempotency conflict as a terminal result", async () => {
    const value = plan(); const committed = receipt(value); let calls = 0;
    const port: PlanDurablePublicationPort = {
      async publish() { calls += 1; return calls === 1 ? { state: "committed", receipt: committed } : { state: "replayed", receipt: committed }; },
      async lookup() { return { state: "unknown", receipt: null }; }
    };
    const module = createDurablePlanPublicationModule(port);
    expect(await module.publish(input({ plan: value }))).toMatchObject({ ok: true, outcome: "committed" });
    expect(await module.publish(input({ plan: value }))).toMatchObject({ ok: true, outcome: "replayed" });
    const conflictPort: PlanDurablePublicationPort = {
      async publish() { return { state: "idempotency_conflict", receipt: null }; },
      async lookup() { return { state: "unknown", receipt: null }; }
    };
    expect(await createDurablePlanPublicationModule(conflictPort).publish(input({ plan: value })))
      .toMatchObject({ ok: false, outcome: "idempotency_conflict" });
  });

  it("honors baseline CAS and rejects tampered or foreign plans before invoking the Port", async () => {
    let calls = 0; const port = portFor(plan(), () => { calls += 1; return { state: "baseline_conflict", receipt: null }; });
    const module = createDurablePlanPublicationModule(port);
    const conflict = await module.publish(input({ expected_baseline: { state: "present", manifest_hash: hash("old"), generation: 2 } }));
    expect(conflict).toMatchObject({ ok: false, outcome: "baseline_conflict" }); expect(calls).toBe(1);
    const tampered = plan(); const firstPayload = tampered.payloads[0];
    if (firstPayload === undefined) throw new Error("fixture payload missing");
    firstPayload.serialized_content = "tampered\n";
    await expect(module.publish(input({ plan: tampered }))).rejects.toThrow("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
    await expect(module.publish(input({ change_key: "change-foreign" }))).rejects.toThrow("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
  });

  it("binds receipt predecessor and manifest truth to the request", async () => {
    const value = plan();
    const forged = receipt(value, { previous_manifest_hash: hash("foreign"), previous_generation: 7, generation: 8 });
    const port: PlanDurablePublicationPort = {
      async publish() { return { state: "committed", receipt: forged }; },
      async lookup() { return { state: "unknown", receipt: null }; }
    };
    await expect(createDurablePlanPublicationModule(port).publish(input({ plan: value })))
      .rejects.toThrow("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
    const diverged = structuredClone(value);
    diverged.artifact_derivation_receipt_refs = [hash("foreign"), hash("b"), hash("c")];
    await expect(createDurablePlanPublicationModule(port).publish(input({ plan: diverged })))
      .rejects.toThrow("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
    const foreignOwnership = structuredClone(value);
    foreignOwnership.ownership_paths = ["../foreign/path"];
    foreignOwnership.manifest.ownership_paths = ["../foreign/path"];
    const foreignManifestHash = hash(foreignOwnership.manifest);
    foreignOwnership.manifest_hash = foreignManifestHash;
    foreignOwnership.publication_intent_id = "plan_publication:" + foreignManifestHash.slice(7);
    await expect(createDurablePlanPublicationModule(port).publish(input({ plan: foreignOwnership })))
      .rejects.toThrow("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");

    // M4A ownership is the affected-path set, not the eight publication outputs.
    const affectedOwnership = structuredClone(value);
    const affectedPaths = ["docs/change-note.md", "src/domain/plan-source.ts"];
    affectedOwnership.ownership_paths = affectedPaths;
    affectedOwnership.manifest.ownership_paths = affectedPaths;
    affectedOwnership.manifest_hash = hash(affectedOwnership.manifest);
    affectedOwnership.publication_intent_id = "plan_publication:" + affectedOwnership.manifest_hash.slice(7);
    const result = await createDurablePlanPublicationModule(portFor(affectedOwnership))
      .publish(input({ plan: affectedOwnership }));
    expect(result).toMatchObject({ ok: true, outcome: "committed" });
  });

  it("fails closed for hostile Port results and receipt tampering", async () => {
    const value = plan(); let traps = 0;
    const hostile = Object.defineProperty({}, "state", { enumerable: true, get() { traps += 1; return "committed"; } });
    const port: PlanDurablePublicationPort = { async publish() { return hostile; }, async lookup() { return { state: "unknown", receipt: null }; } };
    await expect(createDurablePlanPublicationModule(port).publish(input({ plan: value }))).rejects.toThrow("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
    expect(traps).toBe(0);
    const valid = receipt(value); expect(verifyDurablePublicationReceipt(valid)).toBe(true);
    expect(verifyDurablePublicationReceipt({ ...valid, generation: 9 })).toBe(false);
    const malformed: PlanDurablePublicationPort = {
      async publish() { return { state: "committed", receipt: { ...valid, generation: 9 } }; },
      async lookup() { return { state: "unknown", receipt: null }; }
    };
    await expect(createDurablePlanPublicationModule(malformed).publish(input({ plan: value })))
      .rejects.toThrow("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
    const proxyPort = new Proxy({} as PlanDurablePublicationPort, {
      get() { traps += 1; throw new Error("trap"); },
      ownKeys() { traps += 1; throw new Error("trap"); }
    });
    expect(() => createDurablePlanPublicationModule(proxyPort)).toThrow("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
    expect(traps).toBe(0);
  });

  it("rolls back to the prior manifest generation rather than inventing a new target", async () => {
    const value = plan(); const prior = hash("prior-manifest");
    const port: PlanDurablePublicationPort = {
      async publish(request) {
        const rollback = request as { target_manifest_hash?: string; target_generation?: number };
        const body = receipt(value, { operation_id: "rollback:12", idempotency_key: "rollback:idem", previous_manifest_hash: value.manifest_hash,
          manifest_hash: rollback.target_manifest_hash, generation: rollback.target_generation, previous_generation: 2,
          publication_intent_id: "rollback:" + prior, rollback_of_operation_id: "publication:12:one" });
        return { state: "committed", receipt: body };
      },
      async lookup() { return { state: "unknown", receipt: null }; }
    };
    const result = await createDurablePlanPublicationModule(port).rollback({
      schema_version: 1, operation_id: "rollback:12", idempotency_key: "rollback:idem", project_id: projectId, change_key: changeKey,
      expected_baseline: { state: "present", manifest_hash: value.manifest_hash, generation: 2 },
      target_manifest_hash: prior, target_generation: 1, plan_hash: hash(value)
    });
    expect(result).toMatchObject({ ok: true, receipt: { manifest_hash: prior, generation: 1, previous_generation: 2 } });
    await expect(createDurablePlanPublicationModule(port).rollback({
      schema_version: 1, operation_id: "rollback:12", idempotency_key: "rollback:idem", project_id: projectId, change_key: changeKey,
      expected_baseline: { state: "present", manifest_hash: value.manifest_hash, generation: 2 },
      target_manifest_hash: prior, target_generation: 0, plan_hash: hash(value)
    })).rejects.toThrow("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
  });

  it("keeps v1 finalization receipts read-only", async () => {
    const module = createDurablePlanPublicationModule(portFor());
    const currentFixture = JSON.parse(await readFile(new URL("./fixtures/durable-publication-v1-current.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const legacyFixture = JSON.parse(await readFile(new URL("./fixtures/durable-publication-v1-finalization-legacy.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(currentFixture.payload_count).toBe(8);
    expect(legacyFixture.legacy_readiness).toBe("read_only");
    expect(module.readReceipt({ schema_version: 1, status: "succeeded", finalizer_action: "publish" }))
      .toEqual({ ok: true, mode: "legacy_read_only", source_schema_version: 1 });
    await expect(module.publish(input({ finalization: { schema_version: 1, status: "succeeded", finalizer_action: "publish" } })))
      .resolves.toMatchObject({ ok: false, outcome: "legacy_read_only" });
  });
});
