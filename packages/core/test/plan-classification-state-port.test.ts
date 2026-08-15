import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  InMemoryPlanClassificationStatePort,
  PLAN_CLASSIFICATION_STATE_RECORD_KIND,
  PLAN_PROFILE_RECORD_KIND,
  PLANNED_PHASE_SET_RECORD_KIND,
  planClassificationStateDescriptor,
  type PlanClassificationStateCommitInput
} from "../src/plan-classification/state-port/index.js";
import { InMemoryDurableStateStore } from "../src/durable-state-primitives/index.js";

const identity = { schema_version: 1 as const, project_id: "project-08", change_id: "change-08", change_key: "change-08" };
const aggregate = { schema_version: 1 as const, project_id: identity.project_id, change_key: identity.change_key };
const actor = { schema_version: 1 as const, actor_id: "agent-08", authority_kind: "agent" as const, authority_ref: "run:08" };
const profileRef = { schema_version: 1 as const, record_kind: PLAN_PROFILE_RECORD_KIND, record_id: `plan_profile:${"a".repeat(64)}`,
  record_schema_version: 1, content_hash: `sha256:${"b".repeat(64)}` as const };
const phaseSetRef = { schema_version: 1 as const, record_kind: PLANNED_PHASE_SET_RECORD_KIND,
  record_id: `planned_phase_set:${"c".repeat(64)}`, record_schema_version: 1,
  content_hash: `sha256:${"d".repeat(64)}` as const };
const descriptor = planClassificationStateDescriptor(profileRef, phaseSetRef);

function commitInput(overrides: Partial<PlanClassificationStateCommitInput> = {}): PlanClassificationStateCommitInput {
  return {
    expected_revision: 0, aggregate, change_id: identity.change_id, actor,
    command: { schema_version: 1, idempotency_key: "classify-08", command_hash: `sha256:${"1".repeat(64)}` },
    profile_ref: profileRef, planned_phase_set_ref: phaseSetRef, descriptor,
    stream_kind: "plan_classification", event_kind: "classification_created",
    previous_descriptor: null, occurred_at: "2026-08-14T00:00:00.000Z", run_id: "run:08", ...overrides
  };
}

describe("plan classification durable state port", () => {
  it("commits Profile and PlannedPhaseSet refs as one current descriptor", async () => {
    const port = new InMemoryPlanClassificationStatePort();
    const result = await port.commit(commitInput());
    expect(result.outcome).toBe("committed");
    const current = await port.getCurrent(identity);
    expect(current.descriptor).toEqual(descriptor);
    expect(current.profile_ref).toEqual(profileRef);
    expect(current.planned_phase_set_ref).toEqual(phaseSetRef);
    const event = (await port.listAudit(identity, 10)).events[0];
    expect(event?.run_id).toBe("run:08");
    expect(event?.descriptor.record_kind).toBe(PLAN_CLASSIFICATION_STATE_RECORD_KIND);
    expect(Object.isFrozen(current)).toBe(true);
  });

  it("enforces per-Change CAS and exact idempotency across both refs", async () => {
    const port = new InMemoryPlanClassificationStatePort();
    await port.commit(commitInput());
    const stale = await port.commit(commitInput({ expected_revision: 0, command: {
      schema_version: 1, idempotency_key: "stale", command_hash: `sha256:${"2".repeat(64)}`
    }}));
    expect(stale.outcome).toBe("revision_conflict");
    const otherPhase = { ...phaseSetRef, record_id: `planned_phase_set:${"e".repeat(64)}` };
    const otherDescriptor = planClassificationStateDescriptor(profileRef, otherPhase);
    const changed = await port.commit(commitInput({ command: {
      schema_version: 1, idempotency_key: "classify-08", command_hash: `sha256:${"1".repeat(64)}`
    }, planned_phase_set_ref: otherPhase, descriptor: otherDescriptor }));
    expect(changed.outcome).toBe("idempotency_conflict");
  });

  it("requires canonical change_id/change_key and rejects payload refs", async () => {
    const port = new InMemoryPlanClassificationStatePort();
    await expect(port.commit(commitInput({ change_id: "other-change" }))).rejects.toThrow("mapping invalid");
    await expect(port.getCurrent({ ...identity, change_id: "other-change" })).rejects.toThrow("mapping invalid");
    await expect(port.commit(commitInput({ descriptor: { ...descriptor, content_hash: `sha256:${"f".repeat(64)}` } }))).rejects.toThrow("descriptor mismatch");
    let traps = 0;
    const hostile = new Proxy(commitInput(), { get() { traps += 1; throw new Error("getter"); } });
    await expect(port.commit(hostile)).rejects.toThrow("DURABLE_STATE_BOUNDARY_INVALID");
    expect(traps).toBe(0);
  });

  it("reconstructs refs from the durable descriptor across a new port instance", async () => {
    const backing = new InMemoryDurableStateStore();
    const first = new InMemoryPlanClassificationStatePort(backing);
    await first.commit(commitInput());
    const restarted = new InMemoryPlanClassificationStatePort(backing);
    const current = await restarted.getCurrent(identity);
    expect(current.profile_ref).toEqual(profileRef);
    expect(current.planned_phase_set_ref).toEqual(phaseSetRef);
  });

  it("fails closed when a generic backing store contains a non-compound descriptor", async () => {
    const backing = new InMemoryDurableStateStore();
    backing.commit({
      expected_revision: 0, aggregate, actor,
      command: { schema_version: 1, idempotency_key: "foreign", command_hash: `sha256:${"f".repeat(64)}` },
      descriptor: { schema_version: 1, record_kind: "plan_profile", record_id: `plan_profile:${"f".repeat(64)}`,
        record_schema_version: 1, content_hash: `sha256:${"f".repeat(64)}` },
      stream_kind: "plan_classification", event_kind: "classification_created", previous_descriptor: null,
      occurred_at: "2026-08-14T00:00:00.000Z"
    });
    const port = new InMemoryPlanClassificationStatePort(backing);
    await expect(port.getCurrent(identity)).rejects.toThrow("compound state descriptor");
    await expect(port.listAudit(identity, 10)).rejects.toThrow("compound state descriptor");
  });

  it("reads the checked-in current-state fixture as descriptor-only refs", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/plan-classification-state-v1-current.json", import.meta.url), "utf8")) as {
      readonly change_id: string; readonly change_key: string; readonly profile_ref: typeof profileRef;
      readonly planned_phase_set_ref: typeof phaseSetRef;
    };
    expect(fixture.change_id).toBe(fixture.change_key);
    expect(planClassificationStateDescriptor(fixture.profile_ref, fixture.planned_phase_set_ref).record_kind)
      .toBe(PLAN_CLASSIFICATION_STATE_RECORD_KIND);
  });
});
