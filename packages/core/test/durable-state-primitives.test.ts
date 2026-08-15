import { describe, expect, it } from "vitest";

import {
  InMemoryDurableStateStore,
  auditCursor,
  auditEventId,
  canonicalCommandHash,
  parseAuditCursor,
  snapshotAggregateIdentity,
  snapshotActorAuthority,
  snapshotArtifactBlobRef,
  snapshotRecordDescriptor,
  type DurableCommitInput
} from "../src/durable-state-primitives/index.js";

const aggregate = { schema_version: 1 as const, project_id: "prj_demo", change_key: "change-one" };
const actor = { schema_version: 1 as const, actor_id: "actor_demo", authority_kind: "user" as const, authority_ref: "session-1" };
const descriptor = { schema_version: 1 as const, record_kind: "plan_profile", record_id: "profile:one",
  record_schema_version: 1, content_hash: `sha256:${"a".repeat(64)}` as const };

function input(idempotencyKey: string, expectedRevision: number | null = 0): DurableCommitInput {
  return { expected_revision: expectedRevision, aggregate, actor,
    command: { schema_version: 1, idempotency_key: idempotencyKey, command_hash: canonicalCommandHash({
      aggregate, actor, idempotency_key: idempotencyKey, descriptor, stream_kind: "plan_classification",
      event_kind: "published", previous_descriptor: null, expected_revision: expectedRevision }) },
    descriptor, stream_kind: "plan_classification", event_kind: "published",
    previous_descriptor: null, occurred_at: "2026-08-14T00:00:00.000Z" };
}

describe("durable state primitives", () => {
  it("rejects hostile and malformed descriptor inputs without invoking traps", () => {
    let gets = 0;
    const hostile = new Proxy({ schema_version: 1, project_id: "prj_demo", change_key: "change-one" }, {
      get() { gets += 1; throw new Error("getter"); },
      getOwnPropertyDescriptor() { gets += 1; throw new Error("descriptor"); }
    });
    expect(() => snapshotAggregateIdentity(hostile)).toThrow("DURABLE_STATE_BOUNDARY_INVALID");
    expect(gets).toBe(0);
    expect(() => snapshotArtifactBlobRef({ schema_version: 1, content_sha256: `sha256:${"a".repeat(64)}`,
      byte_length: 1, media_type: "text/plain", encoding: "identity", storage_ref: "x", extra: true })).toThrow();
  });

  it("commits, replays same command and fences revision/different payload", () => {
    const store = new InMemoryDurableStateStore();
    const first = store.commit(input("command-one"));
    expect(first.outcome).toBe("committed");
    const replay = store.commit(input("command-one"));
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt?.receipt_id).toBe(first.receipt?.receipt_id);
    const conflict = store.commit(input("command-two", 0));
    expect(conflict.outcome).toBe("revision_conflict");
    const different = store.commit({ ...input("command-one"), actor: { ...actor, actor_id: "actor_other" } });
    expect(different.outcome).toBe("idempotency_conflict");
    const timeChanged = store.commit({ ...input("command-one"), occurred_at: "2026-08-14T00:01:00.000Z",
      command: input("command-one").command });
    expect(timeChanged.outcome).toBe("idempotency_conflict");
  });

  it("uses a bounded full-tuple audit cursor", () => {
    const store = new InMemoryDurableStateStore();
    store.commit(input("one"));
    const page = store.listAudit(aggregate, "plan_classification", 1);
    expect(page.events).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
    const event = page.events[0];
    if (event === undefined) throw new Error("missing audit event");
    const cursor = auditCursor({ schema_version: 1, stream_revision: 1, event_id: event.event_id });
    expect(parseAuditCursor(cursor)?.event_id).toBe(event.event_id);
    expect(() => parseAuditCursor("not-base64")).toThrow();
    expect(() => store.listAudit(aggregate, "plan_classification", 101)).toThrow();
  });

  it("derives event identity from the complete command and descriptor", () => {
    const command = input("identity").command;
    const id = auditEventId({ aggregate, stream_kind: "plan_classification", stream_revision: 1,
      event_kind: "published", occurred_at: "2026-08-14T00:00:00.000Z", actor, command, descriptor,
      previous_descriptor: null });
    expect(id).toMatch(/^audit_event:sha256:[a-f0-9]{64}$/u);
    expect(snapshotActorAuthority(actor).actor_id).toBe("actor_demo");
    expect(snapshotRecordDescriptor(descriptor).record_id).toBe("profile:one");
  });

  it("rejects an untrusted stream kind at the runtime list boundary", () => {
    const store = new InMemoryDurableStateStore();
    expect(() => store.listAudit(aggregate, "evil" as never, 1)).toThrow("DURABLE_STATE_BOUNDARY_INVALID");
  });

  it("keeps optional run correlation in audit identity and idempotency fencing", () => {
    const store = new InMemoryDurableStateStore();
    const first = store.commit({ ...input("run-one"), run_id: "run:one" });
    expect(first.outcome).toBe("committed");
    const event = store.listAudit(aggregate, "plan_classification", 1).events[0];
    expect(event?.run_id).toBe("run:one");
    const changedRun = store.commit({ ...input("run-one"), run_id: "run:two" });
    expect(changedRun.outcome).toBe("idempotency_conflict");
    const noRun = store.commit({ ...input("run-two") });
    expect(noRun.outcome).toBe("revision_conflict");
    const withRunId = auditEventId({ aggregate, stream_kind: "plan_classification", stream_revision: 1,
      event_kind: "published", occurred_at: "2026-08-14T00:00:00.000Z", actor, command: input("run-one").command,
      descriptor, previous_descriptor: null, run_id: "run:one" });
    expect(withRunId).toBe(event?.event_id);
  });
});
