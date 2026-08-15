import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlanProfile } from "../src/plan-classification/index.js";
import type { PlanningContext } from "../src/planning-context/index.js";
import {
  createPlanningContextFilesystemStatePort,
  planningContextStateDescriptor,
  type PlanningContextStateCommitInput
} from "../src/planning-context/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)]));
  return value;
}
const hash = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;

async function fixture(): Promise<{ context: PlanningContext; profile: PlanProfile }> {
  const context = JSON.parse(await readFile(new URL("./fixtures/planning-context-v1-current.json", import.meta.url), "utf8")) as PlanningContext;
  const classification = JSON.parse(await readFile(new URL("./fixtures/plan-classification-v1-current.json", import.meta.url), "utf8")) as { profile: PlanProfile };
  const changed = { ...context, plan_profile_ref: classification.profile.profile_id,
    partition_hashes: { ...context.partition_hashes, profile: hash(classification.profile.classification_hash) } };
  const { context_id: ignored, ...body } = changed; void ignored;
  return { profile: classification.profile, context: { ...changed, context_id: `planning_context:${hash(body).slice(7)}` } };
}

function command(context: PlanningContext, profile: PlanProfile, overrides: Partial<PlanningContextStateCommitInput> = {}): PlanningContextStateCommitInput {
  return { expected_revision: 0, aggregate: { schema_version: 1, project_id: "project-09", change_key: profile.change_id },
    actor: { schema_version: 1, actor_id: "agent-09", authority_kind: "agent", authority_ref: "run:09" },
    command: { schema_version: 1, idempotency_key: "context-create", command_hash: hash("context-create") },
    profile, context, descriptor: planningContextStateDescriptor(context), stream_kind: "planning_context",
    event_kind: "context_created", previous_descriptor: null, occurred_at: "2026-08-15T00:00:00.000Z", run_id: "run:09",
    ...overrides };
}

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "planning-context-authority-")); roots.push(value); return value; }
function meta(projectRoot: string, changeKey: string): string {
  return join(projectRoot, ".harness", "changes", encodeURIComponent(changeKey), "meta");
}

describe("PlanningContext filesystem authority", () => {
  it("publishes one immutable generation and reconstructs current, audit, and pending delivery after restart", async () => {
    const projectRoot = await root(); const { context, profile } = await fixture(); const input = command(context, profile);
    const first = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    expect(await first.commit(input)).toMatchObject({ outcome: "committed", current_revision: 1 });
    const restarted = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    expect(await restarted.getCurrent(input.aggregate)).toMatchObject({ revision: 1, context, descriptor: input.descriptor });
    expect((await restarted.listAudit(input.aggregate, 10)).events).toHaveLength(1);
    expect(await restarted.listPendingDeliveries(input.aggregate, 10)).toHaveLength(1);
    const pointerRaw = await readFile(join(meta(projectRoot, profile.change_id), "planning-context.json"), "utf8");
    const pointer = JSON.parse(pointerRaw) as { generation_id: string; generation_hash: string };
    const generationRaw = await readFile(join(meta(projectRoot, profile.change_id), ".planning-context-generations", `${encodeURIComponent(pointer.generation_id)}.json`), "utf8");
    expect(hash(JSON.parse(generationRaw))).toBe(pointer.generation_hash);
    expect(`${pointerRaw}${generationRaw}`).not.toContain(resolve(projectRoot));
  });

  it("serializes concurrent CAS, replays commands, and durably closes delivery acknowledgement", async () => {
    const projectRoot = await root(); const { context, profile } = await fixture(); const input = command(context, profile);
    const left = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    const right = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    const outcomes = await Promise.all([left.commit(input), right.commit(input)]);
    expect(outcomes.map((item) => item.outcome).sort()).toEqual(["committed", "replayed"]);
    expect((await right.commit({ ...input, command: { ...input.command,
      idempotency_key: "stale", command_hash: hash("stale") } })).outcome).toBe("revision_conflict");
    expect((await left.commit(input)).outcome).toBe("replayed");
    const pending = (await left.listPendingDeliveries(input.aggregate, 10))[0];
    if (pending === undefined) throw new Error("pending missing");
    const ack = { aggregate: input.aggregate, outbox_id: pending.outbox_id, audit_event_id: pending.audit_event_id,
      delivery_receipt_id: "platform-event:09", acknowledged_at: "2026-08-15T01:00:00.000Z" };
    expect((await left.acknowledgeDelivery(ack)).state).toBe("acknowledged");
    const restarted = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    expect(await restarted.listPendingDeliveries(input.aggregate, 10)).toEqual([]);
    expect(await restarted.acknowledgeDelivery(ack)).toMatchObject({ state: "acknowledged", delivery: { receipt_id: "platform-event:09" } });
  });

  it("fails closed on generation tampering and pointer swaps between double reads", async () => {
    const projectRoot = await root(); const { context, profile } = await fixture(); const input = command(context, profile);
    const first = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    await first.commit(input);
    const pointerPath = join(meta(projectRoot, profile.change_id), "planning-context.json");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { generation_id: string };
    const generationPath = join(meta(projectRoot, profile.change_id), ".planning-context-generations", `${encodeURIComponent(pointer.generation_id)}.json`);
    await writeFile(generationPath, `${JSON.stringify({ tampered: true })}\n`, "utf8");
    await expect(first.getCurrent(input.aggregate)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID" });

    await rm(projectRoot, { recursive: true, force: true }); roots.pop();
    const secondRoot = await root(); const second = createPlanningContextFilesystemStatePort({ project_root: secondRoot, project_identity: "project-09" });
    await second.commit(input); const secondPointer = join(meta(secondRoot, profile.change_id), "planning-context.json");
    let swapped = false;
    const racing = createPlanningContextFilesystemStatePort({ project_root: secondRoot, project_identity: "project-09",
      before_pointer_second_read: async () => { if (!swapped) { swapped = true; await writeFile(secondPointer, "{}\n", "utf8"); } } });
    await expect(racing.getCurrent(input.aggregate)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID" });
  });

  it("reclaims only a verifiably dead Map-semantics lock and never overwrites a legacy v0 authority", async () => {
    const projectRoot = await root(); const { context, profile } = await fixture(); const input = command(context, profile);
    const metaRoot = meta(projectRoot, profile.change_id); await mkdir(metaRoot, { recursive: true });
    const authorityHash = hash({ project_identity: "project-09", project_root: resolve(projectRoot), change_key: profile.change_id });
    await writeFile(join(metaRoot, ".planning-context.lock"), JSON.stringify({ schema_version: 1, project_root_hash: authorityHash,
      pid: 2_147_483_647, acquired_at: "2026-08-15T00:00:00.000Z", nonce: "dead-owner", state: "active" }), "utf8");
    const port = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    expect((await port.commit(input)).outcome).toBe("committed");

    const legacyRoot = await root(); const legacyMeta = meta(legacyRoot, profile.change_id); await mkdir(legacyMeta, { recursive: true });
    const legacy = await readFile(new URL("./fixtures/planning-context-v0-legacy.json", import.meta.url), "utf8");
    await writeFile(join(legacyMeta, "planning-context.json"), legacy, "utf8");
    const legacyLock = `${JSON.stringify({ schema_version: 1,
      project_root_hash: hash({ project_identity: "project-09", project_root: resolve(legacyRoot), change_key: profile.change_id }),
      pid: process.pid, acquired_at: "2026-08-15T00:00:00.000Z", nonce: "live-owner", state: "active" })}\n`;
    await writeFile(join(legacyMeta, ".planning-context.lock"), legacyLock, "utf8");
    const legacyPort = createPlanningContextFilesystemStatePort({ project_root: legacyRoot, project_identity: "project-09" });
    expect(await legacyPort.readLegacy(input.aggregate)).toMatchObject({ source_schema_version: 0, readiness: "legacy_read_only" });
    await expect(legacyPort.commit(input)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY" });
    expect(await readFile(join(legacyMeta, "planning-context.json"), "utf8")).toBe(legacy);
    expect(await readFile(join(legacyMeta, ".planning-context.lock"), "utf8")).toBe(legacyLock);
  });

  it("commits after a dead successor crashes before clearing its predecessor marker", async () => {
    const projectRoot = await root(); const { context, profile } = await fixture(); const input = command(context, profile);
    const metaRoot = meta(projectRoot, profile.change_id); await mkdir(metaRoot, { recursive: true });
    const authorityHash = hash({ project_identity: "project-09", project_root: resolve(projectRoot), change_key: profile.change_id });
    await writeFile(join(metaRoot, ".planning-context.lock"), JSON.stringify({ schema_version: 1,
      project_root_hash: authorityHash, pid: 2_147_483_647, acquired_at: "2026-08-15T00:00:01.000Z",
      nonce: "dead-successor-b", state: "active" }), "utf8");
    await writeFile(join(metaRoot, ".planning-context.lock.reclaim"), JSON.stringify({ schema_version: 1,
      project_root_hash: authorityHash, owner_nonce: "released-predecessor-a", pid: 2_147_483_646,
      acquired_at: "2026-08-15T00:00:00.000Z", nonce: "dead-reclaimer-a" }), "utf8");
    const port = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    await expect(port.commit(input)).resolves.toMatchObject({ outcome: "committed", current_revision: 1 });
  });

  it("rejects hostile authority options and oversized pointer bytes without executing traps", async () => {
    let traps = 0;
    const accessor = Object.defineProperty({ project_identity: "project-09" }, "project_root", {
      enumerable: true, get: () => { traps += 1; return "ignored"; }
    });
    expect(() => createPlanningContextFilesystemStatePort(accessor as never)).toThrowError(
      expect.objectContaining({ code: "PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID" })
    );
    const proxy = new Proxy({}, { get: () => { traps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; }, ownKeys: () => { traps += 1; return []; } });
    expect(() => createPlanningContextFilesystemStatePort(proxy as never)).toThrowError(
      expect.objectContaining({ code: "PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID" })
    );
    expect(traps).toBe(0);

    const projectRoot = await root(); const { profile } = await fixture();
    const aggregate = { schema_version: 1 as const, project_id: "project-09", change_key: profile.change_id };
    const metaRoot = meta(projectRoot, profile.change_id); await mkdir(metaRoot, { recursive: true });
    await writeFile(join(metaRoot, "planning-context.json"), "x".repeat(16 * 1024 + 1), "utf8");
    const port = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    await expect(port.getCurrent(aggregate)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID" });
  });

  it("bounds hostile durable data before canonical hashing", async () => {
    const projectRoot = await root(); const { profile } = await fixture();
    const aggregate = { schema_version: 1 as const, project_id: "project-09", change_key: profile.change_id };
    const metaRoot = meta(projectRoot, profile.change_id);
    const generations = join(metaRoot, ".planning-context-generations"); await mkdir(generations, { recursive: true });
    const generationHash = `sha256:${"a".repeat(64)}`;
    const generationId = `planning_context_generation:${generationHash.slice(7)}`;
    await writeFile(join(generations, `${encodeURIComponent(generationId)}.json`),
      `${"[".repeat(20_000)}null${"]".repeat(20_000)}\n`, "utf8");
    await writeFile(join(metaRoot, "planning-context.json"), `${JSON.stringify({
      schema_version: 1, record_kind: "planning_context_state_pointer", aggregate, revision: 1,
      generation_id: generationId, generation_hash: generationHash
    })}\n`, "utf8");
    const port = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    await expect(port.getCurrent(aggregate)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID" });
  });

  it("rejects a non-canonical PlanProfile change key before creating authority directories", async () => {
    const projectRoot = await root();
    const port = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09" });
    const aggregate = { schema_version: 1 as const, project_id: "project-09", change_key: "bad_key" };
    await expect(port.getCurrent(aggregate)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID" });
    await expect(access(join(projectRoot, ".harness"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("translates every shared Map filesystem helper failure into a Planning authority error", async () => {
    const parent = await root(); const projectFile = join(parent, "not-a-project-directory");
    await writeFile(projectFile, "file", "utf8");
    const aggregate = { schema_version: 1 as const, project_id: "project-09", change_key: "valid-change" };
    const invalidRootPort = createPlanningContextFilesystemStatePort({ project_root: projectFile, project_identity: "project-09" });
    await expect(invalidRootPort.getCurrent(aggregate)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID" });

    const projectRoot = await root(); const { context, profile } = await fixture(); const input = command(context, profile);
    const metaRoot = meta(projectRoot, profile.change_id); await mkdir(metaRoot, { recursive: true });
    const authorityHash = hash({ project_identity: "project-09", project_root: resolve(projectRoot), change_key: profile.change_id });
    await writeFile(join(metaRoot, ".planning-context.lock"), JSON.stringify({ schema_version: 1, project_root_hash: authorityHash,
      pid: 2_147_483_647, acquired_at: "2026-08-15T00:00:00.000Z", nonce: "dead-owner", state: "active" }), "utf8");
    const reclaimFailure = createPlanningContextFilesystemStatePort({ project_root: projectRoot, project_identity: "project-09",
      before_lock_reclaim: () => { throw new Error("shared helper failure"); } });
    await expect(reclaimFailure.commit(input)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID" });
  });
});
