import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { PlanProfile } from "../src/plan-classification/index.js";
import {
  derivePlanProfilePolicy,
  planProfileClassificationHash,
  planProfileId
} from "../src/plan-classification/stable.js";
import type { PlanningContext, PlanningPartitionUpdates } from "../src/planning-context/index.js";
import {
  InMemoryPlanningContextStatePort,
  InMemoryPlanningContextStateStore,
  PLANNING_CONTEXT_STATE_RECORD_KIND,
  normalizePlanningContextStateLegacy,
  planningContextStateDescriptor,
  type PlanningContextStateCommitInput
} from "../src/planning-context/state-port/index.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)])
  );
  return value;
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function reidentifyContext(context: Omit<PlanningContext, "context_id">): PlanningContext {
  return { ...context, context_id: `planning_context:${hash(context).slice(7)}` };
}

async function fixtures(): Promise<{ context: PlanningContext; profile: PlanProfile }> {
  const rawContext = JSON.parse(await readFile(new URL("./fixtures/planning-context-v1-current.json", import.meta.url), "utf8")) as PlanningContext;
  const classification = JSON.parse(await readFile(new URL("./fixtures/plan-classification-v1-current.json", import.meta.url), "utf8")) as { profile: PlanProfile };
  const withoutId = {
    ...rawContext,
    plan_profile_ref: classification.profile.profile_id,
    partition_hashes: { ...rawContext.partition_hashes, profile: hash(classification.profile.classification_hash) }
  };
  const { context_id: ignored, ...identity } = withoutId;
  void ignored;
  return { profile: classification.profile, context: {
    ...withoutId, context_id: `planning_context:${hash(identity).slice(7)}`
  } };
}

const actor = { schema_version: 1 as const, actor_id: "agent-09", authority_kind: "agent" as const,
  authority_ref: "run:09" };

const unchangedPartitionUpdates = () => ({
  intent_hash: { operation: "unchanged" as const },
  knowledge_context_ref: { operation: "unchanged" as const },
  evidence_map_ref: { operation: "unchanged" as const },
  rules_manifest_hash: { operation: "unchanged" as const },
  map_manifest_hash: { operation: "unchanged" as const },
  profile_classification_hash: { operation: "unchanged" as const },
  phase_set_ref: { operation: "unchanged" as const }
});

function input(context: PlanningContext, profile: PlanProfile,
  overrides: Partial<PlanningContextStateCommitInput> = {}): PlanningContextStateCommitInput {
  const aggregate = { schema_version: 1 as const, project_id: "project-09", change_key: profile.change_id };
  const descriptor = planningContextStateDescriptor(context);
  return {
    expected_revision: 0, aggregate, actor,
    command: { schema_version: 1, idempotency_key: "context-create", command_hash: hash("context-create") },
    profile, context, descriptor, stream_kind: "planning_context", event_kind: "context_created",
    previous_descriptor: null, occurred_at: "2026-08-15T00:00:00.000Z", run_id: "run:09", ...overrides
  };
}

describe("planning context durable state port", () => {
  it("atomically persists the bounded canonical payload, descriptor, and append-only event", async () => {
    const { context, profile } = await fixtures();
    const port = new InMemoryPlanningContextStatePort();
    expect((await port.commit(input(context, profile))).outcome).toBe("committed");
    const current = await port.getCurrent({ schema_version: 1, project_id: "project-09",
      change_key: profile.change_id });
    expect(current).toMatchObject({ revision: 1, context, descriptor: planningContextStateDescriptor(context) });
    expect(current.context).not.toBe(context);
    expect(Object.isFrozen(current.context)).toBe(true);
    const audit = await port.listAudit(current.aggregate, 10);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ event_kind: "context_created", context });
    expect(audit.events[0]?.context).not.toBe(context);
  });

  it("enforces one current context per Change with CAS and exact idempotency", async () => {
    const { context, profile } = await fixtures();
    const port = new InMemoryPlanningContextStatePort();
    const firstInput = input(context, profile);
    const first = await port.commit(firstInput);
    const replay = await port.commit(firstInput);
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt?.receipt_id).toBe(first.receipt?.receipt_id);
    expect((await port.commit(input(context, profile, { command: { schema_version: 1,
      idempotency_key: "stale", command_hash: hash("stale") } }))).outcome).toBe("revision_conflict");
    expect((await port.listAudit(firstInput.aggregate, 10)).events).toHaveLength(1);
    const { context_id: ignored, ...body } = context;
    void ignored;
    const changedContext = reidentifyContext({ ...body, created_at: "2026-08-15T01:00:00.000Z" });
    expect((await port.commit({ ...firstInput, context: changedContext,
      descriptor: planningContextStateDescriptor(changedContext) }))
      .outcome).toBe("idempotency_conflict");
  });

  it("requires change_key to equal PlanProfile.change_id and the Context to reference that Profile", async () => {
    const { context, profile } = await fixtures();
    const port = new InMemoryPlanningContextStatePort();
    await expect(port.commit(input(context, profile, { aggregate: { schema_version: 1,
      project_id: "project-09", change_key: "other-change" } }))).rejects.toThrow("change_key/profile change_id");
    const { context_id: ignored, ...body } = context;
    void ignored;
    const wrongRef = reidentifyContext({ ...body, plan_profile_ref: `plan_profile:${"f".repeat(64)}` });
    await expect(port.commit(input(wrongRef, profile)))
      .rejects.toThrow("profile reference");
    const wrongProfilePartition = reidentifyContext({ ...body,
      partition_hashes: { ...body.partition_hashes, profile: hash("wrong-classification") } });
    await expect(port.commit(input(wrongProfilePartition, profile)))
      .rejects.toThrow("profile partition");
  });

  it("requires replacement payload lineage and exposes only state events", async () => {
    const { context, profile } = await fixtures();
    const port = new InMemoryPlanningContextStatePort();
    const firstInput = input(context, profile);
    await port.commit(firstInput);
    const replacementBody = { ...context, created_at: "2026-08-15T01:00:00.000Z", supersedes: context.context_id };
    const { context_id: ignored, ...identity } = replacementBody;
    void ignored;
    const replacement = { ...replacementBody,
      context_id: `planning_context:${hash(identity).slice(7)}` } as PlanningContext;
    const descriptor = planningContextStateDescriptor(replacement);
    const replaced = await port.commit(input(replacement, profile, { expected_revision: 1,
      command: { schema_version: 1, idempotency_key: "context-replace", command_hash: hash("context-replace") },
      descriptor, previous_descriptor: firstInput.descriptor, event_kind: "context_replaced" }));
    expect(replaced.outcome).toBe("committed");
    const { context_id: replacedId, ...replacementIdentity } = replacement;
    const nextRules = `sha256:${"9".repeat(64)}` as const;
    const invalidated = reidentifyContext({ ...replacementIdentity,
      created_at: "2026-08-15T02:00:00.000Z", supersedes: replacedId,
      rules_manifest_hash: nextRules,
      partition_hashes: { ...replacementIdentity.partition_hashes, rules: hash(nextRules) } });
    const invalidatedDescriptor = planningContextStateDescriptor(invalidated);
    expect(await port.commit({ ...input(invalidated, profile, { expected_revision: 2,
      command: { schema_version: 1, idempotency_key: "partitions-invalidated",
        command_hash: hash("partitions-invalidated") }, descriptor: invalidatedDescriptor,
      previous_descriptor: descriptor, event_kind: "partitions_invalidated" }),
      partition_updates: { ...unchangedPartitionUpdates(), rules_manifest_hash: { operation: "set", value: nextRules } }
    } as PlanningContextStateCommitInput)).toMatchObject({
      outcome: "committed", current_revision: 3
    });
    const { supersedes: omittedSupersedes, context_id: replacementId, ...badBody } = replacement;
    void omittedSupersedes;
    void replacementId;
    const badReplacement = reidentifyContext(badBody);
    await expect(port.commit(input(badReplacement, profile, {
      expected_revision: 3, command: { schema_version: 1, idempotency_key: "bad-replace", command_hash: hash("bad") },
      previous_descriptor: invalidatedDescriptor, event_kind: "context_replaced"
    }))).rejects.toThrow("replacement lineage");
    expect((await port.listAudit(firstInput.aggregate, 10)).events.map((event) => event.event_kind)).toEqual([
      "context_created", "context_replaced", "partitions_invalidated"
    ]);
  });

  it("closes replacement event semantics over partition deltas", async () => {
    const { context, profile } = await fixtures();
    const port = new InMemoryPlanningContextStatePort();
    const firstInput = input(context, profile);
    await port.commit(firstInput);
    const nextRules = `sha256:${"8".repeat(64)}` as const;
    const { context_id: previousId, ...body } = context;
    const changed = reidentifyContext({ ...body, supersedes: previousId,
      rules_manifest_hash: nextRules, partition_hashes: { ...body.partition_hashes, rules: hash(nextRules) } });
    await expect(port.commit(input(changed, profile, { expected_revision: 1,
      command: { schema_version: 1, idempotency_key: "wrong-event", command_hash: hash("wrong-event") },
      descriptor: planningContextStateDescriptor(changed), previous_descriptor: firstInput.descriptor,
      event_kind: "context_replaced" }))).rejects.toThrow("event semantics");
    const unchangedPartitions = reidentifyContext({ ...body, supersedes: previousId,
      created_at: "2026-08-15T03:00:00.000Z" });
    await expect(port.commit({ ...input(unchangedPartitions, profile, { expected_revision: 1,
      command: { schema_version: 1, idempotency_key: "empty-invalidation", command_hash: hash("empty") },
      descriptor: planningContextStateDescriptor(unchangedPartitions), previous_descriptor: firstInput.descriptor,
      event_kind: "partitions_invalidated" }), partition_updates: unchangedPartitionUpdates()
    } as PlanningContextStateCommitInput)).rejects.toThrow("partition dependency closure");
  });

  it("requires invalidated deltas to equal the pure PlanningContext dependency closure", async () => {
    const { context, profile } = await fixtures();
    const attempt = async (next: PlanningContext, partition_updates: PlanningPartitionUpdates,
      witnessProfile: PlanProfile = profile) => {
      const port = new InMemoryPlanningContextStatePort();
      const first = input(context, profile);
      await port.commit(first);
      return port.commit({ ...input(next, witnessProfile, {
        expected_revision: 1, command: { schema_version: 1, idempotency_key: `closure-${next.context_id}`,
          command_hash: hash(next.context_id) }, descriptor: planningContextStateDescriptor(next),
        previous_descriptor: first.descriptor, event_kind: "partitions_invalidated" }), partition_updates
      } as PlanningContextStateCommitInput);
    };
    const { context_id: previousId, ...body } = context;

    const nextMap = `sha256:${"c".repeat(64)}` as const;
    const mapOnly = reidentifyContext({ ...body, supersedes: previousId, map_manifest_hash: nextMap,
      partition_hashes: { ...body.partition_hashes, map: hash(nextMap) } });
    await expect(attempt(mapOnly, { ...unchangedPartitionUpdates(),
      map_manifest_hash: { operation: "set", value: nextMap } })).rejects.toThrow("partition dependency closure");

    const nextIntent = `sha256:${"d".repeat(64)}` as const;
    const intentOnly = reidentifyContext({ ...body, supersedes: previousId,
      intent_contract_ref: `intent:${nextIntent.slice(7)}`,
      partition_hashes: { ...body.partition_hashes, intent: hash(nextIntent) } });
    await expect(attempt(intentOnly, { ...unchangedPartitionUpdates(),
      intent_hash: { operation: "set", value: nextIntent } })).rejects.toThrow("partition dependency closure");

    const risk_signals = [...profile.risk_signals, "security" as const].sort();
    const policy = derivePlanProfilePolicy(risk_signals);
    const profileBody = { ...profile, profile_version: profile.profile_version + 1, supersedes: profile.profile_id,
      risk_signals, mode: policy.mode, required_phases: policy.required_phases, optional_phases: policy.optional_phases,
      required_validations: policy.required_validations,
      interaction_budget: { max_clarification_rounds: policy.max_clarification_rounds,
        allowed_blocking_interactions: profile.interaction_budget.allowed_blocking_interactions },
      reason_codes: [policy.reason_code] };
    const classification_hash = planProfileClassificationHash(profileBody);
    const changedProfile = { ...profileBody, classification_hash,
      profile_id: planProfileId({ change_id: profile.change_id, classification_hash,
        profile_version: profileBody.profile_version, supersedes: profile.profile_id }) } as PlanProfile;
    const profileOnly = reidentifyContext({ ...body, supersedes: previousId,
      plan_profile_ref: changedProfile.profile_id,
      partition_hashes: { ...body.partition_hashes, profile: hash(changedProfile.classification_hash) } });
    await expect(attempt(profileOnly, { ...unchangedPartitionUpdates(),
      profile_classification_hash: { operation: "set", value: changedProfile.classification_hash } }, changedProfile))
      .rejects.toThrow("partition dependency closure");

    const nextPhaseSet = `planned_phase_set:${"e".repeat(64)}` as const;
    const profileAndPhases = reidentifyContext({ ...body, supersedes: previousId,
      plan_profile_ref: changedProfile.profile_id, planned_phase_set_ref: nextPhaseSet,
      partition_hashes: { ...body.partition_hashes, profile: hash(changedProfile.classification_hash),
        phases: hash(nextPhaseSet) } });
    const port = new InMemoryPlanningContextStatePort();
    const first = input(context, profile);
    await port.commit(first);
    await expect(port.commit({ ...input(profileAndPhases, changedProfile, { expected_revision: 1,
      command: { schema_version: 1, idempotency_key: "profile-phases-closure", command_hash: hash("profile-phases-closure") },
      descriptor: planningContextStateDescriptor(profileAndPhases), previous_descriptor: first.descriptor,
      event_kind: "partitions_invalidated" }), partition_updates: { ...unchangedPartitionUpdates(),
      profile_classification_hash: { operation: "set", value: changedProfile.classification_hash } }
    } as PlanningContextStateCommitInput)).resolves.toMatchObject({ outcome: "committed", current_revision: 2 });
  });

  it("atomically creates a recoverable pending delivery and durably acknowledges it", async () => {
    const { context, profile } = await fixtures();
    const store = new InMemoryPlanningContextStateStore();
    const first = new InMemoryPlanningContextStatePort(store);
    const commit = await first.commit(input(context, profile));
    const aggregate = { schema_version: 1 as const, project_id: "project-09", change_key: profile.change_id };
    const pending = await first.listPendingDeliveries(aggregate, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: "pending", aggregate,
      audit_event_id: commit.receipt?.audit_event_id, delivery: null });
    const restarted = new InMemoryPlanningContextStatePort(store);
    expect(await restarted.listPendingDeliveries(aggregate, 10)).toEqual(pending);
    const entry = pending[0];
    if (entry === undefined) throw new Error("pending delivery missing");
    const ack = { aggregate, outbox_id: entry.outbox_id, audit_event_id: entry.audit_event_id,
      delivery_receipt_id: "platform-event-receipt-09", acknowledged_at: "2026-08-15T04:00:00.000Z" };
    const acknowledged = await restarted.acknowledgeDelivery(ack);
    expect(acknowledged).toMatchObject({ state: "acknowledged", delivery: {
      receipt_id: ack.delivery_receipt_id, acknowledged_at: ack.acknowledged_at
    } });
    expect(await restarted.listPendingDeliveries(aggregate, 10)).toEqual([]);
    expect(await restarted.getDelivery(aggregate, entry.outbox_id)).toEqual(acknowledged);
    expect(await restarted.acknowledgeDelivery(ack)).toEqual(acknowledged);
    await expect(restarted.acknowledgeDelivery({ ...ack, delivery_receipt_id: "other-receipt" }))
      .rejects.toThrow("delivery acknowledgement conflict");
  });

  it("reconstructs the complete current payload after a port restart without a shadow payload map", async () => {
    const { context, profile } = await fixtures();
    const store = new InMemoryPlanningContextStateStore();
    await new InMemoryPlanningContextStatePort(store).commit(input(context, profile));
    const restarted = new InMemoryPlanningContextStatePort(store);
    expect((await restarted.getCurrent({ schema_version: 1, project_id: "project-09",
      change_key: profile.change_id })).context).toEqual(context);
  });

  it("keeps v0 read-only and fails closed on Proxy, accessor, and thenable inputs with zero execution", async () => {
    const legacy = JSON.parse(await readFile(new URL("./fixtures/planning-context-v0-legacy.json", import.meta.url), "utf8"));
    expect(normalizePlanningContextStateLegacy(legacy)).toMatchObject({ ok: true,
      source_schema_version: 0, readiness: "legacy_read_only" });
    const { context, profile } = await fixtures();
    const port = new InMemoryPlanningContextStatePort();
    let executions = 0;
    const hostile = new Proxy(input(context, profile), { get() { executions += 1; throw new Error("executed"); } });
    await expect(port.commit(hostile)).rejects.toThrow("DURABLE_STATE_BOUNDARY_INVALID");
    const accessor = input(context, profile) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "context", { enumerable: true, get() { executions += 1; return context; } });
    await expect(port.commit(accessor as unknown as PlanningContextStateCommitInput)).rejects.toThrow("DURABLE_STATE_BOUNDARY_INVALID");
    const thenable = { ...input(context, profile), then() { executions += 1; } };
    await expect(port.commit(thenable as unknown as PlanningContextStateCommitInput)).rejects.toThrow("DURABLE_STATE_BOUNDARY_INVALID");
    expect(executions).toBe(0);
    expect(() => normalizePlanningContextStateLegacy(new Proxy(legacy, { get() { executions += 1; } })))
      .toThrow("PLANNING_CONTEXT_LEGACY_INVALID");
    expect(executions).toBe(0);
  });

  it("derives a content-addressed PlanningContext descriptor", async () => {
    const { context } = await fixtures();
    const descriptor = planningContextStateDescriptor(context);
    expect(descriptor.record_kind).toBe(PLANNING_CONTEXT_STATE_RECORD_KIND);
    expect(descriptor.record_id).toBe(`planning_context_state:${descriptor.content_hash.slice(7)}`);
  });
});
