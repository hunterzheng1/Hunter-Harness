import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { canonicalJson } from "@hunter-harness/contracts";

import {
  PLAN_FINALIZATION_TRANSACTION_SCHEMA_VERSION,
  InMemoryPlanFinalizationEventOutboxPort,
  InMemoryPlanFinalizationFilesystemPort,
  createPlanFinalizationTransaction,
  type PlanFinalizationExecutionContext,
  type PlanFinalizationRendererPort,
  type PlanFinalizationTransactionInput
} from "../src/plan-quality/finalization-transaction/index.js";
import {
  planDurablePublicationTargetPaths,
  planDurablePublicationTargetSetHash
} from "../src/plan-quality/durable-publication-filesystem-contract/index.js";
import type { PlanDurablePublicationModule } from "../src/plan-quality/durable-publication/index.js";

const now = "2026-08-15T10:00:00.000Z";
const changeKey = "change-m3-transaction";
const projectId = "project-m3";
const hash = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const rawHash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function authority() {
  const paths = planDurablePublicationTargetPaths(changeKey);
  return {
    schema_version: 1 as const,
    record_kind: "plan_durable_publication_filesystem_authority" as const,
    root_identity: { schema_version: 1 as const, project_identity: projectId, project_root_hash: hash("root") },
    target_identity: {
      schema_version: 1 as const, change_key: changeKey, target_root: `plans/${changeKey}`,
      target_set_hash: planDurablePublicationTargetSetHash(changeKey), ownership_paths: paths
    },
    journal_identity: { schema_version: 1 as const, journal_root: `.harness/plan/${changeKey}`,
      journal_root_hash: hash("journal") }
  };
}

function plan() {
  const paths = [
    `plans/${changeKey}-design.md`, `plans/${changeKey}-plan.md`,
    `plans/${changeKey}-test-scenarios.md`, `plans/${changeKey}-implementation-detail.md`,
    "meta/gate-policy.json", "meta/worktree.json", "meta/implementation-checkpoints.json", "meta/scenario-manifest.json"
  ];
  const payloads = paths.map((path, index) => {
    const serialized_content = `${path}\n`;
    const bytes = [...Buffer.from(serialized_content, "utf8")];
    return { path, artifact_type: index < 4 ? ["design", "plan", "test_scenarios", "implementation_detail"][index] : "machine",
      format: path.endsWith(".md") ? "markdown" as const : "json" as const,
      classification: index < 4 ? index === 3 ? "compatibility_derived" as const : "human_truth" as const : "machine_derived" as const,
      serialized_content, bytes, byte_length: bytes.length, serialized_sha256: rawHash(serialized_content), semantic_content_hash: hash(`semantic-${index}`) };
  });
  const entries = payloads.map((item) => Object.fromEntries(Object.entries(item)
    .filter(([key]) => key !== "serialized_content" && key !== "bytes")));
  const manifest = { schema_version: 1 as const, change_key: changeKey, approval_receipt_ref: "approval:m3",
    artifact_derivation_receipt_refs: [hash("a"), hash("b"), hash("c")] as [string, string, string],
    ownership_paths: [...paths].sort(), entries };
  const manifest_hash = hash(manifest);
  return { schema_version: 1 as const, change_key: changeKey, publication_intent_id: `plan_publication:${manifest_hash.slice(7)}`,
    manifest_hash, manifest, approval_receipt_ref: manifest.approval_receipt_ref,
    artifact_derivation_receipt_refs: manifest.artifact_derivation_receipt_refs,
    ownership_paths: manifest.ownership_paths, payloads };
}

function context(overrides: Partial<PlanFinalizationExecutionContext> = {}): PlanFinalizationExecutionContext {
  return { schema_version: 1, project_id: projectId, change_key: changeKey, run_id: "run:m3", branch_name: "branch:m3",
    attempt: 1, phase: "plan", root_authority: authority(), ...overrides };
}

function finalization(publicationIntentId = plan().publication_intent_id) {
  const receiptBody = { schema_version: 1 as const, status: "succeeded" as const, run_id: "run:m3",
    change_key: changeKey, profile_ref: "profile:m3", artifact_set_hash: hash("artifacts"),
    layer_receipt_hashes: [hash("layer1"), hash("layer2"), hash("layer3")],
    publication_intent_id: publicationIntentId, finalizer_action: "publish" as const, completed_at: now };
  const receipt_hash = hash(receiptBody);
  const receipt = { ...receiptBody, receipt_hash, receipt_id: `plan_quality:finalization:${receipt_hash.slice(7)}` };
  const common = { lifecycle_kind: "change" as const, run_id: "run:m3", change_key: changeKey, phase: "plan" as const,
    attempt: 1, occurred_at: now };
  const makeEvent = (type: "phase_started" | "artifact_published" | "phase_ended", producer_seq: number) => {
    const machine = { lifecycle_kind: common.lifecycle_kind, run_id: common.run_id, change_key: common.change_key,
      phase: common.phase, attempt: common.attempt, type, producer_seq };
    const eventId = hash({ ...machine, occurred_at: now });
    return { schema_version: 1 as const, ...common, type, producer_seq,
      event_id: `plan_event:${eventId.slice(7)}`, idempotency_key: hash(machine),
      ...(type === "artifact_published" ? { receipt_ref: receipt.receipt_id } : {}) };
  };
  return { schema_version: 1 as const, branch_name: "branch:m3", receipt,
    events: [makeEvent("phase_started", 1), makeEvent("artifact_published", 2), makeEvent("phase_ended", 3)],
    quality_verification_input: { schema_version: 1 as const, witness: "quality-m3" } };
}

function planWithFirstPayload(serialized_content: string) {
  const base = plan();
  const payloads = base.payloads.map((item, index) => index === 0 ? {
    ...item, serialized_content, bytes: [...Buffer.from(serialized_content, "utf8")],
    byte_length: Buffer.byteLength(serialized_content, "utf8"), serialized_sha256: rawHash(serialized_content)
  } : item);
  const entries = payloads.map((item) => Object.fromEntries(Object.entries(item)
    .filter(([key]) => key !== "serialized_content" && key !== "bytes")));
  const manifest = { ...base.manifest, entries };
  const manifest_hash = hash(manifest);
  return { ...base, payloads, manifest, manifest_hash,
    publication_intent_id: `plan_publication:${manifest_hash.slice(7)}` };
}

function input(overrides: Partial<PlanFinalizationTransactionInput> = {}): PlanFinalizationTransactionInput {
  const value = plan();
  return { schema_version: PLAN_FINALIZATION_TRANSACTION_SCHEMA_VERSION, operation_id: "plan_finalize:m3:1",
    idempotency_key: hash("finalize-idempotency"), context: context(), finalization: finalization(),
    expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }, plan: value,
    recovery_token: `plan_recovery:${"a".repeat(64)}`, ...overrides };
}

function publicationModule(): PlanDurablePublicationModule {
  return {
    async publish(value) {
      const request = value as { readonly operation_id: string; readonly idempotency_key: string; readonly project_id: string;
        readonly change_key: string; readonly plan: ReturnType<typeof plan>; readonly expected_baseline: { readonly generation: number; readonly manifest_hash: string | null } };
      const receiptBody = { schema_version: 1 as const,
        operation_id: request.operation_id, idempotency_key: request.idempotency_key, project_id: request.project_id,
        change_key: request.change_key, publication_intent_id: request.plan.publication_intent_id, plan_hash: hash(request.plan),
        previous_manifest_hash: request.expected_baseline.manifest_hash, manifest_hash: request.plan.manifest_hash,
        previous_generation: request.expected_baseline.generation, generation: request.expected_baseline.generation + 1,
        modified_paths: request.plan.payloads.map((item) => item.path), preserved_paths: [],
        event_id: "audit_event:sha256:" + "2".repeat(64), committed_at: now };
      const receipt = { ...receiptBody, receipt_id: `plan_durable_publication_receipt:${hash(receiptBody).slice(7)}` };
      return { ok: true as const, outcome: "committed" as const, event_allowed: true as const,
        receipt, event: { schema_version: 1 as const, event_kind: "publication_durable" as const,
          operation_id: request.operation_id, change_key: request.change_key, publication_intent_id: request.plan.publication_intent_id,
          receipt_id: receipt.receipt_id, generation: receipt.generation, occurred_at: now } };
    },
    async rollback() { return { ok: false as const, outcome: "unknown" as const, receipt: null, operation_id: "x" }; },
    async lookup() { return { ok: false as const, outcome: "unknown" as const, receipt: null, operation_id: "x" }; },
    readReceipt() { return { ok: false as const, reason_code: "PLAN_DURABLE_PUBLICATION_RECEIPT_INVALID" as const }; }
  };
}

function setup(options: { readonly delivery?: "complete" | "ambiguous" | "failed"; readonly filesystem_outcome?: "complete" | "ambiguous" | "failed" } = {},
  overrides: { readonly filesystem?: InMemoryPlanFinalizationFilesystemPort; readonly event_outbox?: InMemoryPlanFinalizationEventOutboxPort;
    readonly publication?: PlanDurablePublicationModule } = {}) {
  const filesystem = overrides.filesystem ?? new InMemoryPlanFinalizationFilesystemPort({ apply_outcome: options.filesystem_outcome });
  const event_outbox = overrides.event_outbox ?? new InMemoryPlanFinalizationEventOutboxPort({ delivery: options.delivery });
  const calls: string[] = [];
  const renderer: PlanFinalizationRendererPort = { async render() { calls.push("render"); return plan(); } };
  const quality_verifier = { verify(value: unknown) {
    const input = value as { readonly plan_hash: `sha256:${string}`; readonly event_bundle_hash: `sha256:${string}`;
      readonly finalization: { readonly receipt: { readonly receipt_hash: `sha256:${string}`; readonly layer_receipt_hashes: readonly string[] } } };
    const body = { schema_version: 1 as const, valid: true as const, receipt_hash: input.finalization.receipt.receipt_hash,
      plan_hash: input.plan_hash, layer_receipt_hashes: input.finalization.receipt.layer_receipt_hashes,
      event_bundle_hash: input.event_bundle_hash };
    return { ...body, proof_hash: hash(body) };
  } };
  const module = createPlanFinalizationTransaction({ filesystem, publication: overrides.publication ?? publicationModule(), event_outbox, renderer, quality_verifier, clock: () => now });
  return { module, filesystem, event_outbox, calls, quality_verifier };
}

function forgeRecord(record: NonNullable<Awaited<ReturnType<ReturnType<typeof setup>["module"]["finalize"]>>["record"]>, changes: Record<string, unknown>) {
  const { record_hash: ignored, ...body } = { ...record, ...changes }; void ignored;
  return { ...body, record_hash: hash(body) };
}

class FailFirstEnqueueOutbox extends InMemoryPlanFinalizationEventOutboxPort {
  fail = true;
  override async enqueue(input: Parameters<InMemoryPlanFinalizationEventOutboxPort["enqueue"]>[0]) {
    if (this.fail) { this.fail = false; throw new Error("enqueue unavailable"); }
    return super.enqueue(input);
  }
}

describe("Stage12-M3 plan finalization transaction", () => {
  it("renders, stages, durably publishes, verifies receipt, then delivers canonical events", async () => {
    const setupValue = setup();
    const result = await setupValue.module.finalize(input());
    expect(result).toMatchObject({ ok: true, status: "publication_committed_event_complete" });
    expect(setupValue.calls).toEqual(["render"]);
    expect(setupValue.filesystem.calls).toEqual({ prepare: 1, apply: 1, inspect: expect.any(Number), readback: 1 });
    expect(setupValue.event_outbox.delivered).toHaveLength(1);
    expect(result.publication_receipt?.receipt_id).toMatch(/^plan_durable_publication_receipt:/u);
  });

  it("replays the same identity without duplicating publication or event delivery", async () => {
    const setupValue = setup(); const request = input();
    const first = await setupValue.module.finalize(request); const second = await setupValue.module.finalize(request);
    expect(second).toEqual(first);
    expect(setupValue.event_outbox.delivered).toHaveLength(1);
    expect(setupValue.filesystem.calls.apply).toBe(1);
  });

  it("accepts a bounded payload larger than the generic snapshot array cap", async () => {
    const large = planWithFirstPayload("x".repeat(4_097));
    const filesystem = new InMemoryPlanFinalizationFilesystemPort();
    const event_outbox = new InMemoryPlanFinalizationEventOutboxPort();
    const quality_verifier = { verify(value: unknown) {
      const input = value as { readonly plan_hash: `sha256:${string}`; readonly event_bundle_hash: `sha256:${string}`;
        readonly finalization: { readonly receipt: { readonly receipt_hash: `sha256:${string}`; readonly layer_receipt_hashes: readonly string[] } } };
      const body = { schema_version: 1 as const, valid: true as const, receipt_hash: input.finalization.receipt.receipt_hash,
        plan_hash: input.plan_hash, layer_receipt_hashes: input.finalization.receipt.layer_receipt_hashes,
        event_bundle_hash: input.event_bundle_hash };
      return { ...body, proof_hash: hash(body) };
    } };
    const module = createPlanFinalizationTransaction({ filesystem, publication: publicationModule(), event_outbox,
      renderer: { async render() { return large; } }, quality_verifier, clock: () => now });
    const result = await module.finalize(input({ plan: large, finalization: finalization(large.publication_intent_id) }));
    expect(result).toMatchObject({ ok: true, status: "publication_committed_event_complete" });
  });

  it.each([
    ["pending", "publication_committed_event_pending"],
    ["ambiguous", "publication_committed_event_ambiguous"],
    ["failed", "publication_committed_event_failed"]
  ] as const)("exposes non-distributed event state %s after durable publication", async (delivery, status) => {
    const result = await setup({ delivery }).module.finalize(input());
    expect(result).toMatchObject({ ok: false, status, publication_receipt: expect.any(Object), record: expect.any(Object) });
  });

  it("does not publish blocked or legacy finalization and never writes an artifact event", async () => {
    const setupValue = setup();
    const blockedEvidence = finalization();
    const blockedBody = { ...blockedEvidence.receipt, status: "blocked" as const, finalizer_action: "none" as const };
    const blockedHash = hash(Object.fromEntries(Object.entries(blockedBody).filter(([key]) => key !== "receipt_hash" && key !== "receipt_id")));
    const blocked = input({ finalization: { ...blockedEvidence,
      receipt: { ...blockedBody, receipt_hash: blockedHash, receipt_id: `plan_quality:finalization:${blockedHash.slice(7)}` } } });
    await expect(setupValue.module.finalize(blocked)).resolves.toMatchObject({ ok: false, status: "blocked" });
    await expect(setupValue.module.finalize({ ...blocked, schema_version: 0 } as never)).resolves.toMatchObject({ ok: false, status: "legacy_read_only" });
    expect(setupValue.filesystem.calls.prepare).toBe(0);
    expect(setupValue.event_outbox.delivered).toHaveLength(0);
  });

  it("persists pending before enqueue failure and resumes it after a process restart", async () => {
    const filesystem = new InMemoryPlanFinalizationFilesystemPort();
    const event_outbox = new FailFirstEnqueueOutbox();
    const first = setup({});
    const quality_verifier = first.quality_verifier;
    const renderer: PlanFinalizationRendererPort = { async render() { return plan(); } };
    const dependencies = { filesystem, publication: publicationModule(), event_outbox, renderer, quality_verifier, clock: () => now };
    const module1 = createPlanFinalizationTransaction(dependencies);
    const pending = await module1.finalize(input());
    expect(pending).toMatchObject({ ok: false, status: "publication_committed_event_pending", event_outbox: null, record: { event_outbox_id: null } });
    const module2 = createPlanFinalizationTransaction(dependencies);
    const resumed = await module2.resume(input());
    expect(resumed).toMatchObject({ ok: true, status: "publication_committed_event_complete", event_outbox: expect.any(Object), record: { status: "publication_committed_event_complete" } });
    expect(event_outbox.calls.enqueue).toBe(1);
    expect(event_outbox.calls.deliver).toBe(1);
  });

  it("returns a non-success durable state for a pre-publication filesystem failure", async () => {
    const setupValue = setup({ filesystem_outcome: "failed" });
    const result = await setupValue.module.finalize(input());
    expect(result).toMatchObject({ ok: false, status: "publication_not_committed", record: { status: "publication_not_committed" } });
    expect(result.publication_receipt).toBeNull();
  });

  it("requires a verifier proof bound to the current receipt, plan, and event bundle", async () => {
    const filesystem = new InMemoryPlanFinalizationFilesystemPort();
    const event_outbox = new InMemoryPlanFinalizationEventOutboxPort();
    const invalidVerifier = { verify() {
      return { schema_version: 1 as const, valid: true as const, receipt_hash: hash("foreign-receipt"), plan_hash: hash("foreign-plan"),
        layer_receipt_hashes: [hash("a"), hash("b"), hash("c")] as [string, string, string], event_bundle_hash: hash("foreign-events"), proof_hash: hash("proof") };
    } };
    const module = createPlanFinalizationTransaction({ filesystem, publication: publicationModule(), event_outbox,
      renderer: { async render() { return plan(); } }, quality_verifier: invalidVerifier, clock: () => now });
    await expect(module.finalize(input())).rejects.toMatchObject({ code: "PLAN_FINALIZATION_QUALITY_INVALID" });
    expect(filesystem.calls.prepare).toBe(0);
  });

  it("rejects foreign execution identity, root authority drift, and malformed renderer output before any effect", async () => {
    const setupValue = setup();
    await expect(setupValue.module.finalize(input({ context: context({ branch_name: "branch:foreign" }),
      finalization: finalization() }))).rejects.toMatchObject({ code: "PLAN_FINALIZATION_IDENTITY_INVALID" });
    const hostileRenderer: PlanFinalizationRendererPort = { render() { return new Proxy({}, { get() { throw new Error("secret"); } }); } };
    const hostile = createPlanFinalizationTransaction({ filesystem: setupValue.filesystem, publication: publicationModule(),
      event_outbox: setupValue.event_outbox, renderer: hostileRenderer, quality_verifier: setupValue.quality_verifier, clock: () => now });
    await expect(hostile.finalize(input())).rejects.toMatchObject({ code: "PLAN_FINALIZATION_RENDER_INVALID" });
    expect(setupValue.filesystem.calls.prepare).toBe(0);
  });

  it("closes durable record context, baseline, ownership, and pending receipt identity", async () => {
    const complete = setup();
    const published = await complete.module.finalize(input());
    if (!published.record) throw new Error("missing transaction record");
    if (!published.record.filesystem_binding) throw new Error("missing filesystem binding");
    expect(complete.module.readRecord({ ...published, record: forgeRecord(published.record, { project_id: "project:foreign" }) }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    expect(complete.module.readRecord({ ...published, record: forgeRecord(published.record, {
      filesystem_binding: { ...published.record.filesystem_binding, expected_baseline: { state: "present", manifest_hash: hash("foreign"), generation: 1 } }
    }) })).toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    expect(complete.module.readRecord({ ...published, record: forgeRecord(published.record, {
      ownership_paths: ["plans/foreign-design.md", ...published.record.ownership_paths.slice(1)]
    }) })).toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    if (!published.record.publication_receipt) throw new Error("missing publication receipt");
    const { receipt_id: ignoredReceiptId, ...foreignReceiptBody } = {
      ...published.record.publication_receipt, plan_hash: hash("foreign-plan"), manifest_hash: hash("foreign-manifest")
    }; void ignoredReceiptId;
    const foreignReceipt = { ...foreignReceiptBody,
      receipt_id: `plan_durable_publication_receipt:${hash(foreignReceiptBody).slice(7)}` };
    expect(complete.module.readRecord({ ...published, publication_receipt: foreignReceipt,
      record: forgeRecord(published.record, { publication_receipt: foreignReceipt }) }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    expect(complete.module.readRecord({ ...published, ok: false }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    expect(complete.module.readRecord({ ...published, record: null }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    expect(complete.module.readRecord({ ...published, status: "publication_committed_event_pending", ok: false,
      reason_code: "PLAN_FINALIZATION_OUTBOX_PENDING", record: forgeRecord(published.record, {
        status: "publication_committed_event_pending", reason_code: "PLAN_FINALIZATION_OUTBOX_PENDING"
      }) })).toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    expect(complete.module.readRecord({ ...published, reason_code: "PLAN_FINALIZATION_OUTBOX_PENDING" }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });

    const pending = setup({ delivery: "pending" });
    const pendingResult = await pending.module.finalize(input());
    if (!pendingResult.record) throw new Error("missing pending transaction record");
    expect(pending.module.readRecord({ ...pendingResult, publication_receipt: null,
      record: forgeRecord(pendingResult.record, { publication_receipt: null }) }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
    const ambiguous = setup({ delivery: "ambiguous" });
    const ambiguousResult = await ambiguous.module.finalize(input());
    if (!ambiguousResult.record) throw new Error("missing ambiguous transaction record");
    expect(ambiguous.module.readRecord({ ...ambiguousResult, event_outbox: null,
      record: forgeRecord(ambiguousResult.record, { event_outbox_id: null }) }))
      .toEqual({ ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" });
  });

  it("binds inspected outbox records and validates a filesystem receipt without a transaction record", async () => {
    class ForeignInspectOutbox extends InMemoryPlanFinalizationEventOutboxPort {
      tamper = false;
      stateTamper = false;
      override async inspect(input: Parameters<InMemoryPlanFinalizationEventOutboxPort["inspect"]>[0]) {
        const value = await super.inspect(input);
        if (this.stateTamper && value !== undefined) return { ...value, state: "pending" as const };
        if (!this.tamper || value === undefined) return value;
        const operation_id = "plan_finalize:foreign";
        const idempotency_key = hash("foreign-outbox");
        const outbox_id = `plan_event_outbox:${hash({ operation_id, idempotency_key, receipt_id: value.publication_receipt_id,
          event_bundle_hash: value.event_bundle_hash, run_id: value.run_id, change_key: value.change_key,
          branch_name: value.branch_name, attempt: value.attempt }).slice(7)}`;
        return { ...value, operation_id, idempotency_key, outbox_id };
      }
    }
    const event_outbox = new ForeignInspectOutbox();
    const setupValue = setup({}, { event_outbox });
    const published = await setupValue.module.finalize(input());
    event_outbox.stateTamper = true;
    await expect(setupValue.module.inspect({ schema_version: 1, operation_id: input().operation_id,
      idempotency_key: input().idempotency_key, outbox_id: published.event_outbox?.outbox_id }))
      .rejects.toMatchObject({ code: "PLAN_FINALIZATION_OUTBOX_INVALID" });
    event_outbox.stateTamper = false;
    event_outbox.tamper = true;
    await expect(setupValue.module.inspect({ schema_version: 1, operation_id: input().operation_id,
      idempotency_key: input().idempotency_key, outbox_id: published.event_outbox?.outbox_id }))
      .rejects.toMatchObject({ code: "PLAN_FINALIZATION_OUTBOX_INVALID" });

    const invalidReceiptFilesystem = new InMemoryPlanFinalizationFilesystemPort();
    invalidReceiptFilesystem.inspect = async (value) => ({ operation_id: value.operation_id, state: "committed",
      receipt: { schema_version: 1 }, recovery_token: input().recovery_token, binding: null });
    const noRecord = setup({}, { filesystem: invalidReceiptFilesystem });
    await expect(noRecord.module.inspect({ schema_version: 1, operation_id: input().operation_id,
      idempotency_key: input().idempotency_key })).rejects.toMatchObject({ code: "PLAN_FINALIZATION_FILESYSTEM_INVALID" });

    const normal = setup();
    const completed = await normal.module.finalize(input());
    if (!completed.publication_receipt) throw new Error("missing completed receipt");
    const { receipt_id: omitted, ...foreignBody } = { ...completed.publication_receipt,
      operation_id: "plan_finalize:foreign", idempotency_key: hash("foreign") }; void omitted;
    const foreignReceipt = { ...foreignBody,
      receipt_id: `plan_durable_publication_receipt:${hash(foreignBody).slice(7)}` };
    const foreignReceiptFilesystem = new InMemoryPlanFinalizationFilesystemPort();
    foreignReceiptFilesystem.inspect = async (value) => ({ operation_id: value.operation_id, state: "committed",
      receipt: foreignReceipt, recovery_token: input().recovery_token, binding: null });
    const foreignNoRecord = setup({}, { filesystem: foreignReceiptFilesystem });
    await expect(foreignNoRecord.module.inspect({ schema_version: 1, operation_id: input().operation_id,
      idempotency_key: input().idempotency_key })).rejects.toMatchObject({ code: "PLAN_FINALIZATION_FILESYSTEM_INVALID" });

    class ForeignReadbackFilesystem extends InMemoryPlanFinalizationFilesystemPort {
      tamper = false;
      override async readback(operationId: string) {
        const value = await super.readback(operationId);
        return this.tamper ? { ...value, readback_hash: hash("foreign-readback") } : value;
      }
    }
    const foreignReadback = new ForeignReadbackFilesystem();
    const bound = setup({}, { filesystem: foreignReadback });
    await bound.module.finalize(input()); foreignReadback.tamper = true;
    await expect(bound.module.inspect({ schema_version: 1, operation_id: input().operation_id,
      idempotency_key: input().idempotency_key })).rejects.toMatchObject({ code: "PLAN_FINALIZATION_FILESYSTEM_INVALID" });
  });

  it("keeps pre-publication filesystem and publication failures not-committed", async () => {
    class ApplyAndInspectFailureFilesystem extends InMemoryPlanFinalizationFilesystemPort {
      override async apply(input: Parameters<InMemoryPlanFinalizationFilesystemPort["apply"]>[0]) {
        void input; throw new Error("apply unavailable");
      }
      override async inspect(input: Parameters<InMemoryPlanFinalizationFilesystemPort["inspect"]>[0]) {
        void input; throw new Error("inspect unavailable");
      }
    }
    const beforePublication = setup({}, { filesystem: new ApplyAndInspectFailureFilesystem() });
    const inspectFailure = await beforePublication.module.finalize(input());
    expect(inspectFailure).toMatchObject({ ok: false, status: "publication_not_committed", record: { status: "publication_not_committed" } });
    expect(inspectFailure.publication_receipt).toBeNull();

    class ReadbackFailureFilesystem extends InMemoryPlanFinalizationFilesystemPort {
      override async readback(operationId: string) { void operationId; throw new Error("readback unavailable"); }
    }
    const readbackFailure = await setup({}, { filesystem: new ReadbackFailureFilesystem() }).module.finalize(input());
    expect(readbackFailure).toMatchObject({ ok: false, status: "publication_not_committed", record: { status: "publication_not_committed" } });
    expect(readbackFailure.publication_receipt).toBeNull();

    const publication = { ...publicationModule(), publish: async () => { throw new Error("publication unknown"); } };
    const publishFailure = await setup({}, { publication }).module.finalize(input());
    expect(publishFailure).toMatchObject({ ok: false, status: "publication_not_committed", record: { status: "publication_not_committed" } });
    expect(publishFailure.publication_receipt).toBeNull();
  });

  it("rejects hostile ports and thenables without invoking arbitrary execution", async () => {
    const setupValue = setup();
    const hostileFilesystem = new Proxy(setupValue.filesystem, { get() { throw new Error("filesystem secret"); } });
    expect(() => createPlanFinalizationTransaction({ filesystem: hostileFilesystem as never, publication: publicationModule(),
      event_outbox: setupValue.event_outbox, renderer: setupValue.module as never, quality_verifier: setupValue.quality_verifier, clock: () => now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_FINALIZATION_PORT_INVALID" }));
    const hostile = createPlanFinalizationTransaction({ filesystem: setupValue.filesystem, publication: publicationModule(),
      event_outbox: setupValue.event_outbox, renderer: { render() { return { then() { throw new Error("thenable secret"); } }; } } as never,
      quality_verifier: setupValue.quality_verifier, clock: () => now });
    await expect(hostile.finalize(input())).rejects.toMatchObject({ code: "PLAN_FINALIZATION_RENDER_INVALID" });
  });
});
