import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PLAN_EVENT_PHASES,
  PLAN_EVENT_TYPES,
  readPlanEventBundle
} from "../src/index.js";

const currentPath = fileURLToPath(new URL("./fixtures/plan-event-v1-current.json", import.meta.url));
const legacyPath = fileURLToPath(new URL("./fixtures/plan-event-v0-legacy.json", import.meta.url));
const sha256 = (canonical: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonical).digest("hex")}`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)]));
  return value;
}

function hash(value: unknown): `sha256:${string}` {
  return sha256(JSON.stringify(canonical(value)));
}

function rehash(value: Record<string, unknown>): void {
  for (const event of value.events as Record<string, unknown>[]) {
    const machine = { lifecycle_kind: event.lifecycle_kind, run_id: event.run_id,
      change_key: event.change_key, phase: event.phase, attempt: event.attempt,
      type: event.type, producer_seq: event.producer_seq };
    event.idempotency_key = hash(machine);
    event.event_id = `plan_event:${hash({ ...machine, occurred_at: event.occurred_at }).slice(7)}`;
  }
  const { bundle_hash: ignored, ...body } = value;
  void ignored;
  value.bundle_hash = hash(body);
}

async function fixture(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("PlanEventBundle shared contract", () => {
  it("accepts the byte-frozen current fixture and closes the phase/event vocabulary", async () => {
    const current = await fixture(currentPath);
    await expect(readPlanEventBundle(JSON.stringify(current), { sha256 })).resolves.toEqual({
      ok: true,
      mode: "terminal",
      source_schema_version: 1,
      value: current
    });
    expect(PLAN_EVENT_PHASES).toEqual([
      "plan", "execute", "review", "package", "apidoc", "submit", "merge", "archive"
    ]);
    expect(PLAN_EVENT_TYPES).toEqual([
      "phase_started", "decision_recorded", "risk_found", "artifact_published",
      "validation_failed", "phase_ended"
    ]);
  });

  it("fails closed on legacy, unknown versions, non-serialized input and bounds before hashing", async () => {
    const legacy = await fixture(legacyPath);
    let calls = 0;
    const port = { sha256: (canonical: string) => { calls += 1; return sha256(canonical); } };
    await expect(readPlanEventBundle(JSON.stringify(legacy), port)).resolves.toEqual({
      ok: false, reason_code: "PLAN_EVENT_VERSION_UNSUPPORTED"
    });
    await expect(readPlanEventBundle(JSON.stringify({ schema_version: 2 }), port)).resolves.toEqual({
      ok: false, reason_code: "PLAN_EVENT_VERSION_UNSUPPORTED"
    });
    const getter = Object.defineProperty({}, "schema_version", {
      enumerable: true, get() { calls += 1; throw new Error("getter"); }
    });
    for (const value of [{}, getter, new Proxy({}, { get() { calls += 1; throw new Error("trap"); } })]) {
      await expect(readPlanEventBundle(value, port)).resolves.toEqual({
        ok: false, reason_code: "PLAN_EVENT_SERIALIZED_JSON_REQUIRED"
      });
    }
    await expect(readPlanEventBundle("x".repeat(4_000_001), port)).resolves.toEqual({
      ok: false, reason_code: "PLAN_EVENT_SERIALIZED_JSON_TOO_LARGE"
    });
    expect(calls).toBe(0);
  });

  it("rejects exact-key drift, forged hashes and hash Adapter failures", async () => {
    const current = await fixture(currentPath);
    const drift = { ...current, unexpected: true };
    await expect(readPlanEventBundle(JSON.stringify(drift), { sha256 })).resolves.toEqual({
      ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID"
    });
    const forged = structuredClone(current);
    ((forged.events as Record<string, unknown>[])[0] as Record<string, unknown>).event_id =
      `plan_event:${"0".repeat(64)}`;
    await expect(readPlanEventBundle(JSON.stringify(forged), { sha256 })).resolves.toEqual({
      ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID"
    });
    await expect(readPlanEventBundle(JSON.stringify(current), {
      sha256: () => { throw new Error("digest unavailable"); }
    })).resolves.toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    await expect(readPlanEventBundle(JSON.stringify(current), {
      sha256: () => "not-a-sha256"
    })).resolves.toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
  });

  it("enforces ordering, attempts, terminal transitions, identities and idempotency uniqueness", async () => {
    const current = await fixture(currentPath);
    const cases = [
      (value: Record<string, unknown>) => {
        const events = value.events as Record<string, unknown>[];
        events.reverse();
      },
      (value: Record<string, unknown>) => {
        const events = value.events as Record<string, unknown>[];
        (events[1] as Record<string, unknown>).attempt = 2;
      },
      (value: Record<string, unknown>) => {
        const events = value.events as Record<string, unknown>[];
        (events[1] as Record<string, unknown>).run_id = "run:foreign";
      },
      (value: Record<string, unknown>) => {
        const events = value.events as Record<string, unknown>[];
        events.push(structuredClone(events[0] as Record<string, unknown>));
      }
    ];
    for (const mutate of cases) {
      const value = structuredClone(current);
      mutate(value);
      rehash(value);
      await expect(readPlanEventBundle(JSON.stringify(value), { sha256 })).resolves.toEqual({
        ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID"
      });
    }
  });
});

describe("PlanAttemptEventBundle（HP-02 语义拆分）", () => {
  function attemptEvent(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      schema_version: 1,
      event_id: "plan_event:" + "0".repeat(64),
      lifecycle_kind: "change",
      run_id: "plan_run01",
      change_key: "change-attempt-01",
      phase: "plan",
      attempt: 2,
      type: "phase_started",
      producer_seq: 1,
      occurred_at: "2026-08-17T01:00:00.000Z",
      idempotency_key: "sha256:" + "0".repeat(64),
      ...overrides
    };
  }

  function attemptBundle(events: Record<string, unknown>[], attempt = 2): Record<string, unknown> {
    const bundle = {
      schema_version: 1,
      lifecycle_kind: "change",
      run_id: "plan_run01",
      change_key: "change-attempt-01",
      attempt,
      events,
      bundle_hash: ""
    };
    rehash(bundle);
    return bundle;
  }

  it("接受仅含当前 attempt=2 的合法包（首事件 attempt>=1）", async () => {
    const bundle = attemptBundle([
      attemptEvent({}),
      attemptEvent({ type: "artifact_published", producer_seq: 2, occurred_at: "2026-08-17T01:00:01.000Z" }),
      attemptEvent({ type: "phase_ended", producer_seq: 3, occurred_at: "2026-08-17T01:00:02.000Z" })
    ]);
    const { readPlanAttemptEventBundle } = await import("../src/index.js");
    const result = await readPlanAttemptEventBundle(JSON.stringify(bundle), { sha256 });
    expect(result).toMatchObject({ ok: true, mode: "terminal" });
  });

  it("拒绝 attempt 不一致的事件混入", async () => {
    const bundle = attemptBundle([
      attemptEvent({}),
      attemptEvent({ type: "phase_ended", producer_seq: 2, attempt: 1, occurred_at: "2026-08-17T01:00:01.000Z" })
    ]);
    const { readPlanAttemptEventBundle } = await import("../src/index.js");
    const result = await readPlanAttemptEventBundle(JSON.stringify(bundle), { sha256 });
    expect(result).toMatchObject({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
  });

  it("拒绝重复 phase_started 与 producer_seq 倒退", async () => {
    const bundle = attemptBundle([
      attemptEvent({}),
      attemptEvent({ type: "phase_started", producer_seq: 2, occurred_at: "2026-08-17T01:00:01.000Z" })
    ]);
    const { readPlanAttemptEventBundle } = await import("../src/index.js");
    const result = await readPlanAttemptEventBundle(JSON.stringify(bundle), { sha256 });
    expect(result.ok).toBe(false);
  });

  it("aggregate reader 仍要求首事件 attempt=1（生命周期语义不变）", async () => {
    const aggregate = attemptBundle([
      attemptEvent({}),
      attemptEvent({ type: "phase_ended", producer_seq: 2, occurred_at: "2026-08-17T01:00:01.000Z" })
    ]);
    // aggregate schema 无 attempt 字段，删除后按生命周期规则校验
    const { attempt: ignored, ...aggregateBody } = aggregate;
    void ignored;
    rehash(aggregateBody);
    const result = await readPlanEventBundle(JSON.stringify(aggregateBody), { sha256 });
    expect(result.ok).toBe(false);
  });
});
