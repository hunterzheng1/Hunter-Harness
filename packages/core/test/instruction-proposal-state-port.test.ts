import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  INSTRUCTION_PROPOSAL_STATE_RECORD_KIND,
  InMemoryInstructionProposalStatePort,
  normalizeInstructionProposalStateLegacy,
  type InstructionProposalStateCommitInput
} from "../src/instruction-proposal/state-port/index.js";

const aggregate = { schema_version: 1 as const, project_id: "project-demo", change_key: "change-07" };
const actor = { schema_version: 1 as const, actor_id: "actor-demo", authority_kind: "user" as const,
  authority_ref: "session-07" };
const descriptor = { schema_version: 1 as const, record_kind: INSTRUCTION_PROPOSAL_STATE_RECORD_KIND,
  record_id: "proposal:demo", record_schema_version: 1,
  content_hash: `sha256:${"a".repeat(64)}` as const };
const decisionDescriptor = { ...descriptor, content_hash: `sha256:${"b".repeat(64)}` as const };

function commitInput(overrides: Partial<InstructionProposalStateCommitInput> = {}): InstructionProposalStateCommitInput {
  const base = {
    expected_revision: 0,
    aggregate,
    actor,
    command: { schema_version: 1 as const, idempotency_key: "proposal-create",
      command_hash: `sha256:${"1".repeat(64)}` as const },
    descriptor,
    stream_kind: "instruction_proposal" as const,
    event_kind: "proposal_created" as const,
    previous_descriptor: null,
    occurred_at: "2026-08-14T00:00:00.000Z"
  } satisfies InstructionProposalStateCommitInput;
  return { ...base, ...overrides };
}

describe("instruction proposal state port", () => {
  it("commits one current descriptor and audit event atomically", async () => {
    const port = new InMemoryInstructionProposalStatePort();
    const first = await port.commit(commitInput());
    expect(first.outcome).toBe("committed");
    expect(first.current_revision).toBe(1);
    const current = await port.getCurrent(aggregate);
    expect(current).toEqual({ revision: 1, descriptor });
    const page = await port.listAudit(aggregate, 10);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.event_kind).toBe("proposal_created");
    expect(page.events[0]?.aggregate).toEqual(aggregate);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(page.events[0])).toBe(true);
  });

  it("replays an exact command and fences same-key actor or payload changes", async () => {
    const port = new InMemoryInstructionProposalStatePort();
    const input = commitInput();
    const first = await port.commit(input);
    const replay = await port.commit(input);
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt?.receipt_id).toBe(first.receipt?.receipt_id);
    const actorChanged = await port.commit({ ...input, actor: { ...actor, actor_id: "actor-other" } });
    expect(actorChanged.outcome).toBe("idempotency_conflict");
    const payloadChanged = await port.commit({ ...input, descriptor: decisionDescriptor });
    expect(payloadChanged.outcome).toBe("idempotency_conflict");
  });

  it("fences stale revisions and commits a decision with the prior state", async () => {
    const port = new InMemoryInstructionProposalStatePort();
    await port.commit(commitInput());
    const stale = await port.commit(commitInput({ command: { schema_version: 1,
      idempotency_key: "stale", command_hash: `sha256:${"2".repeat(64)}` }, descriptor: decisionDescriptor,
      event_kind: "candidate_decided", expected_revision: 0, previous_descriptor: null }));
    expect(stale.outcome).toBe("revision_conflict");
    const decision = await port.commit(commitInput({ command: { schema_version: 1,
      idempotency_key: "decision", command_hash: `sha256:${"3".repeat(64)}` }, descriptor: decisionDescriptor,
      event_kind: "candidate_decided", expected_revision: 1, previous_descriptor: descriptor }));
    expect(decision.outcome).toBe("committed");
    expect((await port.getCurrent(aggregate)).descriptor).toEqual(decisionDescriptor);
    expect((await port.listAudit(aggregate, 10)).events.map((event) => event.event_kind)).toEqual([
      "proposal_created", "candidate_decided"
    ]);
  });

  it("uses the full aggregate identity and a bounded cursor", async () => {
    const port = new InMemoryInstructionProposalStatePort();
    await port.commit(commitInput());
    const other = { ...aggregate, change_key: "change-other" };
    const otherInput = commitInput({ aggregate: other, command: { schema_version: 1,
      idempotency_key: "other", command_hash: `sha256:${"4".repeat(64)}` } });
    expect((await port.commit(otherInput)).outcome).toBe("committed");
    const page = await port.listAudit(aggregate, 1);
    expect(page.next_cursor).toBeNull();
    await expect(port.listAudit(aggregate, 101)).rejects.toThrow("DURABLE_STATE_LIMIT_INVALID");
  });

  it("rejects hostile or wrong-kind writes without invoking traps", async () => {
    const port = new InMemoryInstructionProposalStatePort();
    let traps = 0;
    const hostile = new Proxy(commitInput(), {
      get() { traps += 1; throw new Error("getter"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor"); }
    });
    await expect(port.commit(hostile)).rejects.toThrow("DURABLE_STATE_BOUNDARY_INVALID");
    expect(traps).toBe(0);
    await expect(port.commit(commitInput({ stream_kind: "plan_decision" as never }))).rejects.toThrow();
    await expect(port.commit(commitInput({ descriptor: { ...descriptor, record_kind: "other" } }))).rejects.toThrow();
  });

  it("normalizes legacy proposal metadata as read-only", async () => {
    const legacy = JSON.parse(await readFile(new URL("./fixtures/instruction-proposal-state-v0-legacy.json", import.meta.url), "utf8"));
    const view = normalizeInstructionProposalStateLegacy(legacy);
    expect(view.ready).toBe(false);
    expect(view.source_schema_version).toBe(0);
    expect(Object.isFrozen(view)).toBe(true);
    const current = JSON.parse(await readFile(new URL("./fixtures/instruction-proposal-state-v1-current.json", import.meta.url), "utf8"));
    expect(current.schema_version).toBe(1);
  });

  it("rejects legacy Proxy/accessor and unknown fields before reading them", () => {
    let traps = 0;
    const proxy = new Proxy({ schema_version: 0, proposal_id: "legacy", created_at: "2025-01-01T00:00:00.000Z", changes: [] }, {
      get() { traps += 1; throw new Error("getter"); },
      ownKeys() { traps += 1; throw new Error("keys"); }
    });
    expect(() => normalizeInstructionProposalStateLegacy(proxy)).toThrow("INSTRUCTION_LEGACY_PROPOSAL_INVALID");
    expect(traps).toBe(0);
    expect(() => normalizeInstructionProposalStateLegacy({ schema_version: 0, proposal_id: "legacy",
      created_at: "2025-01-01T00:00:00.000Z", changes: [], extra: true })).toThrow("INSTRUCTION_LEGACY_PROPOSAL_INVALID");
    const accessor = { schema_version: 0, proposal_id: "legacy", created_at: "2025-01-01T00:00:00.000Z", changes: [] } as Record<string, unknown>;
    Object.defineProperty(accessor, "proposal_id", { enumerable: true, get() { traps += 1; return "legacy"; } });
    expect(() => normalizeInstructionProposalStateLegacy(accessor)).toThrow("INSTRUCTION_LEGACY_PROPOSAL_INVALID");
    expect(traps).toBe(0);
  });
});
