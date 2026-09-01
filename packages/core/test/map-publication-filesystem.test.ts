import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMapPublicationFilesystemTransactionPort,
  createMapPublicationTransaction,
  planMapPublication,
  MAP_PUBLICATION_GENERATION_POINTER_PATH,
  type MapManifestDraftV2,
  type MapPublicationCommitRequest
} from "../src/codebase/map-v2/index.js";
import { stableHash } from "../src/codebase/map-v2/stable.js";

const names = ["STACK.md", "INTEGRATIONS.md", "ARCHITECTURE.md", "STRUCTURE.md",
  "CONVENTIONS.md", "TESTING.md", "CONCERNS.md"] as const;
const roots: string[] = [];

function makeRequest(): MapPublicationCommitRequest {
  const documents = Object.fromEntries(names.map((name) => [name, `# ${name}\n\nCurrent.`]));
  const manifest: MapManifestDraftV2 = {
    schema_version: 2,
    generator: { name: "fixture", version: "1" },
    project_identity: "filesystem-test",
    repository_identity: "repo-one",
    mode: "incremental",
    scope: "repository",
    path_filters: [],
    input_fingerprint: "sha256:" + "b".repeat(64),
    documents: names.map((name) => ({
      path: `.harness/codebase/map/${name}`,
      topics: [name],
      evidence_sources: [],
      input_fingerprint: "sha256:" + "b".repeat(64),
      content_hash: "sha256:" + "c".repeat(64),
      estimated_tokens: 1,
      status: "current"
    })),
    summary_hash: "sha256:" + "d".repeat(64),
    warnings: [],
    degradation_reasons: [],
    status: "ready"
  };
  const publication = planMapPublication({
    schema_version: 2,
    published_at: "2026-08-14T00:00:00.000Z",
    mode: "full",
    affected_documents: [...names],
    previous_documents: {},
    proposed_documents: { ...documents, "ARCHITECTURE.md": "# ARCHITECTURE.md\n\nSee src/index.ts for the entrypoint." },
    manifest_draft: manifest,
    summary_content: "# Summary\n"
  });
  if (!publication.ok) throw new Error(publication.reason_codes.join(","));
  return {
    schema_version: 1,
    operation_id: "map_operation:filesystem",
    action_id: "codebase_map:refresh",
    idempotency_key: "map_publication:filesystem",
    expected_previous_manifest: { state: "absent" },
    ownership_paths: [
      ...names.map((name) => `.harness/codebase/map/${name}` as const),
      ".harness/codebase/map-summary.md",
      ".harness/codebase/map-manifest.json"
    ],
    plan: publication
  };
}

function requestWith(patch: Partial<MapPublicationCommitRequest>): MapPublicationCommitRequest {
  return { ...makeRequest(), ...patch };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

describe("Map publication filesystem adapter", () => {
  it("publishes, replays, reads back and rolls back exact owned targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const request = makeRequest();
    const port = createMapPublicationFilesystemTransactionPort({
      project_root: root,
      project_identity: "filesystem-test"
    });
    const module = createMapPublicationTransaction(port);
    const first = await module.commitPublication(request);
    expect(first.outcome).toBe("committed");
    const restarted = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root,
      project_identity: "filesystem-test"
    }));
    expect((await restarted.inspect(request.operation_id)).state).toBe("committed");
    const replay = await restarted.commitPublication(request);
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt?.receipt_id).toBe(first.receipt?.receipt_id);
    const readback = await module.readback(request.operation_id);
    expect(readback.journal_committed).toBe(true);
    expect(readback.live_manifest_hash).toBe(first.receipt?.new_manifest_hash);
    const rollback = await module.rollback({
      schema_version: 1,
      operation_id: request.operation_id,
      recovery_token: first.receipt?.recovery_token ?? "",
      expected_published_manifest_hash: first.receipt?.new_manifest_hash ?? ""
    });
    expect(rollback.outcome).toBe("rolled_back");
    expect((await module.readback(request.operation_id)).live_manifest_hash).toBe(null);
  });

  it("publishes an immutable generation pointer and fences readers from mixed projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-generation-"));
    roots.push(root);
    const request = makeRequest();
    const port = createMapPublicationFilesystemTransactionPort({
      project_root: root,
      project_identity: "filesystem-test"
    });
    const module = createMapPublicationTransaction(port);
    const committed = await module.commitPublication(request);
    if (committed.outcome !== "committed") throw new Error("fixture did not commit");
    const pointerPath = join(root, MAP_PUBLICATION_GENERATION_POINTER_PATH);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
      state: string; generation_id: string; payload_hashes: Record<string, string>;
    };
    expect(pointer.state).toBe("published");
    expect(pointer.generation_id).toMatch(/^map_generation:sha256:[a-f0-9]{64}$/u);
    expect(Object.keys(pointer.payload_hashes)).toHaveLength(9);
    const generationRoot = join(root, ".harness", "codebase", "map", ".generations", encodeURIComponent(pointer.generation_id));
    expect((await readdir(generationRoot)).sort()).toHaveLength(9);
    // A compatibility projection may be in-flight or tampered; authoritative
    // readers resolve one immutable generation through the pointer instead.
    await writeFile(join(root, ".harness", "codebase", "map", "STACK.md"), "mixed projection\n", "utf8");
    const readback = await module.readback(request.operation_id);
    expect(readback.live_manifest_hash).toBe(committed.receipt.new_manifest_hash);
    expect(readback.payload_hashes[".harness/codebase/map/STACK.md"]).toBe(pointer.payload_hashes[".harness/codebase/map/STACK.md"]);
  });

  it("reclaims a stale immutable lock record without a successor chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-lock-reclaim-"));
    roots.push(root);
    const journalRoot = join(root, ".harness", "state", "map-publication");
    const lockRoot = join(journalRoot, ".root.lock");
    await mkdir(journalRoot, { recursive: true });
    await writeFile(lockRoot, JSON.stringify({ schema_version: 1,
      project_root_hash: stableHash(await realpath(root)), pid: 2_147_483_647,
      acquired_at: new Date(0).toISOString() }), "utf8");
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test"
    }));
    await expect(module.commitPublication(makeRequest())).resolves.toMatchObject({ outcome: "committed" });
    const lockArtifacts = (await readdir(journalRoot)).filter((entry) => entry.startsWith(".root.lock"));
    expect(lockArtifacts.some((entry) => entry.startsWith(".root.lock.claim-"))).toBe(false);
    expect(lockArtifacts.filter((entry) => entry === ".root.lock.reclaim").length).toBe(1);
  });

  it("recovers a dead reclaimer marker after a crash without weakening the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-lock-marker-"));
    roots.push(root);
    const journalRoot = join(root, ".harness", "state", "map-publication");
    await mkdir(journalRoot, { recursive: true });
    const rootHash = stableHash(await realpath(root));
    await writeFile(join(journalRoot, ".root.lock"), JSON.stringify({ schema_version: 1,
      project_root_hash: rootHash, pid: 2_147_483_647, acquired_at: new Date(0).toISOString(),
      nonce: "dead-owner", state: "active" }), "utf8");
    await writeFile(join(journalRoot, ".root.lock.reclaim"), JSON.stringify({ schema_version: 1,
      project_root_hash: rootHash, owner_nonce: "dead-owner", pid: 2_147_483_646, acquired_at: new Date(0).toISOString(),
      nonce: "dead-reclaimer" }), "utf8");
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test"
    }));
    await expect(module.commitPublication(makeRequest())).resolves.toMatchObject({ outcome: "committed" });
    expect(await exists(join(journalRoot, ".root.lock.reclaim"))).toBe(true);
  });

  it("recovers a dead successor whose predecessor reclaim marker survived acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-lock-predecessor-marker-"));
    roots.push(root);
    const journalRoot = join(root, ".harness", "state", "map-publication");
    await mkdir(journalRoot, { recursive: true });
    const rootHash = stableHash(await realpath(root));
    await writeFile(join(journalRoot, ".root.lock"), JSON.stringify({ schema_version: 1,
      project_root_hash: rootHash, pid: 2_147_483_647, acquired_at: new Date(1).toISOString(),
      nonce: "dead-successor-b", state: "active" }), "utf8");
    await writeFile(join(journalRoot, ".root.lock.reclaim"), JSON.stringify({ schema_version: 1,
      project_root_hash: rootHash, owner_nonce: "released-predecessor-a", pid: 2_147_483_646,
      acquired_at: new Date(0).toISOString(), nonce: "dead-reclaimer-a" }), "utf8");
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test"
    }));
    await expect(module.commitPublication(makeRequest())).resolves.toMatchObject({ outcome: "committed" });
    expect((await readdir(journalRoot)).some((entry) => entry.includes("dead-predecessor"))).toBe(false);
  });

  it("fails closed and restores a successor when the stable lock path swaps during reclaim", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-lock-swap-"));
    roots.push(root);
    const journalRoot = join(root, ".harness", "state", "map-publication");
    await mkdir(journalRoot, { recursive: true });
    const lockPath = join(journalRoot, ".root.lock");
    const rootHash = stableHash(await realpath(root));
    await writeFile(lockPath, JSON.stringify({ schema_version: 1, project_root_hash: rootHash,
      pid: 2_147_483_647, acquired_at: new Date(0).toISOString(), nonce: "stale-owner", state: "active" }), "utf8");
    let swapped = false;
    const request = makeRequest();
    const port = createMapPublicationFilesystemTransactionPort({ project_root: root, project_identity: "filesystem-test",
      before_root_lock_reclaim: async () => {
        if (swapped) return;
        swapped = true;
        await writeFile(lockPath, JSON.stringify({ schema_version: 1, project_root_hash: rootHash,
          pid: process.pid, acquired_at: new Date().toISOString(), nonce: "successor-owner", state: "active" }), "utf8");
      }
    });
    await expect(port.prepare(request, stableHash(request), stableHash(request.plan.manifest_payload),
      `map_recovery:${"a".repeat(64)}`)).rejects.toThrow("MAP_PUBLICATION_FILESYSTEM_LOCKED");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ nonce: "successor-owner", state: "active" });
    expect((await readdir(journalRoot)).some((entry) => entry.endsWith(".stale"))).toBe(false);
  });

  it("fails closed when the generation pointer or immutable payload is tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-generation-tamper-"));
    roots.push(root);
    const request = makeRequest();
    const port = createMapPublicationFilesystemTransactionPort({ project_root: root, project_identity: "filesystem-test" });
    const module = createMapPublicationTransaction(port);
    const committed = await module.commitPublication(request);
    if (committed.outcome !== "committed") throw new Error("fixture did not commit");
    const pointerPath = join(root, MAP_PUBLICATION_GENERATION_POINTER_PATH);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { generation_id: string };
    const generationPath = join(root, ".harness", "codebase", "map", ".generations", encodeURIComponent(pointer.generation_id), encodeURIComponent(".harness/codebase/map/STACK.md"));
    await writeFile(generationPath, "tampered generation\n", "utf8");
    await expect(module.readback(request.operation_id)).rejects.toThrow("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    const restored = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    restored.generation_id = "map_generation:sha256:" + "0".repeat(64);
    await writeFile(pointerPath, JSON.stringify(restored), "utf8");
    await expect(module.readback(request.operation_id)).rejects.toThrow();
  });

  it("rejects a foreign operation identifier without touching the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const port = createMapPublicationFilesystemTransactionPort({
      project_root: root,
      project_identity: "filesystem-test"
    });
    const inspection = await port.inspect("map_operation:missing");
    expect(inspection).toEqual({ operation_id: "map_operation:missing", state: "unknown",
      receipt: null, recovery_token: null, binding: null });
  });

  it("reads a pre-pointer v1 projection as legacy read-only state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-legacy-projection-"));
    roots.push(root);
    const request = makeRequest();
    const targetRoot = join(root, ".harness", "codebase", "map");
    await mkdir(targetRoot, { recursive: true });
    for (const path of request.ownership_paths) {
      const relative = path.slice(".harness/codebase/".length);
      const file = join(root, ".harness", "codebase", relative);
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, request.plan.payloads[path], "utf8");
    }
    const port = createMapPublicationFilesystemTransactionPort({ project_root: root, project_identity: "filesystem-test" });
    const readback = await port.readback("map_operation:legacy");
    expect(readback.journal_committed).toBe(false);
    expect(Object.keys(readback.payload_hashes)).toHaveLength(9);
    expect(await exists(join(targetRoot, ".generation-pointer.json"))).toBe(false);
  });

  it("rejects a journal root outside the project subtree before creating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    const outside = await mkdtemp(join(tmpdir(), "hunter-map-outside-"));
    roots.push(root, outside);
    const journal = join(outside, "journals");
    const port = createMapPublicationFilesystemTransactionPort({ project_root: root,
      project_identity: "filesystem-test", journal_root: journal });
    await expect(port.inspect("map_operation:outside")).rejects.toThrow("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
    expect(await exists(journal)).toBe(false);
  });

  it("rejects a symlinked project component without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    const outside = await mkdtemp(join(tmpdir(), "hunter-map-outside-"));
    roots.push(root, outside);
    try { await symlink(outside, join(root, ".harness"), "junction"); }
    catch { return; }
    const port = createMapPublicationFilesystemTransactionPort({ project_root: root, project_identity: "filesystem-test" });
    await expect(port.inspect("map_operation:symlink")).rejects.toThrow("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
    expect(await exists(join(outside, "codebase"))).toBe(false);
  });

  it("tolerates ancestor path aliasing (CI 8.3 短名/TMPDIR 软链) while still publishing to the real root", async () => {
    // realpath 等价检查只盯最终组件：祖先被 junction/软链别名化是环境常态
    //（Windows CI 的 RUNNER~1 短名、macOS /tmp→/private/tmp），不是攻击面
    const realBase = await mkdtemp(join(tmpdir(), "hunter-map-alias-real-"));
    const projectDir = join(realBase, "proj");
    await mkdir(projectDir, { recursive: true });
    const aliasBase = join(tmpdir(), `hunter-map-alias-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    try { await symlink(realBase, aliasBase, "junction"); }
    catch { await rm(realBase, { recursive: true, force: true }); return; }
    roots.push(realBase, aliasBase);
    const port = createMapPublicationFilesystemTransactionPort({
      project_root: join(aliasBase, "proj"),
      project_identity: "filesystem-test"
    });
    const module = createMapPublicationTransaction(port);
    const result = await module.commitPublication(requestWith({ operation_id: "map_operation:alias" }));
    expect(result.outcome).toBe("committed");
    expect(await exists(join(projectDir, ".harness", "codebase", "map-manifest.json"))).toBe(true);
  });

  it("rejects a restart with a different project identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const request = makeRequest();
    const first = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    await expect(first.commitPublication(request)).resolves.toMatchObject({ outcome: "committed" });
    const restarted = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "different-project" }));
    await expect(restarted.inspect(request.operation_id)).rejects.toThrow("MAP_PUBLICATION_PORT_INVALID");
  });

  it("rejects the same idempotency key on a different operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    await expect(module.commitPublication(makeRequest())).resolves.toMatchObject({ outcome: "committed" });
    const second = await module.commitPublication(requestWith({ operation_id: "map_operation:second" }));
    expect(second).toEqual({ outcome: "idempotency_conflict" });
  });

  it("recovers a complete live target set before applying the stale baseline check", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const request = makeRequest();
    const port = createMapPublicationFilesystemTransactionPort({ project_root: root, project_identity: "filesystem-test" });
    const module = createMapPublicationTransaction(port);
    const committed = await module.commitPublication(request);
    if (committed.outcome !== "committed") throw new Error("fixture did not commit");
    const journalPath = join(root, ".harness", "state", "map-publication", "map_operation%3Afilesystem.journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.state = "recovery_required";
    journal.commit_ambiguity = "unknown";
    journal.readback = "failed";
    journal.cleanup = "not_required";
    await writeFile(journalPath, JSON.stringify(journal), "utf8");
    const recovered = await createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" })).recover(request.operation_id);
    expect(recovered.outcome).toBe("committed");
  });

  it("refuses rollback when any owned live payload changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const request = makeRequest();
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    const committed = await module.commitPublication(request);
    if (committed.outcome !== "committed") throw new Error("fixture did not commit");
    await writeFile(join(root, ".harness", "codebase", "map", "STACK.md"), "tampered\n", "utf8");
    const rollback = await module.rollback({ schema_version: 1, operation_id: request.operation_id,
      recovery_token: committed.receipt.recovery_token, expected_published_manifest_hash: committed.receipt.new_manifest_hash });
    expect(rollback.outcome).toBe("conflict");
  });

  it("resumes a rollback after projection completed but pointer switch was interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-rollback-recovery-"));
    roots.push(root);
    const request = makeRequest();
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    const committed = await module.commitPublication(request);
    if (committed.outcome !== "committed") throw new Error("fixture did not commit");
    const pointerPath = join(root, MAP_PUBLICATION_GENERATION_POINTER_PATH);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    const operationRoot = join(root, ".harness", "state", "map-publication", "map_operation%3Afilesystem");
    await writeFile(join(operationRoot, "rollback-intent.json"), JSON.stringify({ schema_version: 1,
      operation_id: request.operation_id, expected_published_manifest_hash: committed.receipt.new_manifest_hash,
      current_pointer_hash: stableHash(pointer) }), "utf8");
    await writeFile(join(root, ".harness", "codebase", "map", "STACK.md"), "partial rollback projection\n", "utf8");
    const rollback = await module.rollback({ schema_version: 1, operation_id: request.operation_id,
      recovery_token: committed.receipt.recovery_token, expected_published_manifest_hash: committed.receipt.new_manifest_hash });
    expect(rollback.outcome).toBe("rolled_back");
    expect((await module.readback(request.operation_id)).live_manifest_hash).toBe(null);
  });

  it("refuses rollback when backup metadata is not exactly nine validated entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const request = makeRequest();
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    const committed = await module.commitPublication(request);
    if (committed.outcome !== "committed") throw new Error("fixture did not commit");
    const metaPath = join(root, ".harness", "state", "map-publication", "map_operation%3Afilesystem", "backup.json");
    const backups = JSON.parse(await readFile(metaPath, "utf8")) as unknown[];
    await writeFile(metaPath, JSON.stringify(backups.slice(0, 8)), "utf8");
    const rollback = await module.rollback({ schema_version: 1, operation_id: request.operation_id,
      recovery_token: committed.receipt.recovery_token, expected_published_manifest_hash: committed.receipt.new_manifest_hash });
    expect(rollback.outcome).toBe("conflict");
  });

  it("serializes concurrent publication calls at the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const request = makeRequest();
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    const outcomes = await Promise.all([module.commitPublication(request), module.commitPublication(request)]);
    expect(outcomes.every((value) => value.outcome === "committed" || value.outcome === "replayed")).toBe(true);
    expect(outcomes[0].receipt?.receipt_id).toBe(outcomes[1].receipt?.receipt_id);
  });

  it("fails closed when a foreign process holds the durable root lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-"));
    roots.push(root);
    const journalRoot = join(root, ".harness", "state", "map-publication");
    await mkdir(journalRoot, { recursive: true });
    const lockPath = join(journalRoot, ".root.lock");
    await writeFile(lockPath, "foreign-lock", "utf8");
    const module = createMapPublicationTransaction(createMapPublicationFilesystemTransactionPort({
      project_root: root, project_identity: "filesystem-test" }));
    await expect(module.commitPublication(makeRequest())).rejects.toThrow("MAP_PUBLICATION_FILESYSTEM_LOCKED");
    await rm(lockPath, { force: true });
  });

  it("fences two processes while reclaiming one stale lock generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-fs-lock-race-"));
    roots.push(root);
    const journalRoot = join(root, ".harness", "state", "map-publication");
    await mkdir(journalRoot, { recursive: true });
    const lockPath = join(journalRoot, ".root.lock");
    const staleOwner = {
      schema_version: 1,
      project_root_hash: stableHash(await realpath(root)),
      pid: 2_147_483_647,
      acquired_at: new Date(0).toISOString()
    };
    // The adapter verifies the trusted root hash before stale takeover.  The
    // fixture uses the same canonical realpath hash as the trusted factory.
    await writeFile(lockPath, JSON.stringify({ ...staleOwner, nonce: "stale", state: "active" }), "utf8");

    const request = makeRequest();
    const sourceRoot = resolve("packages/core/src/codebase/map-v2/publication-transaction/filesystem.ts");
    const sourceModule = resolve("packages/core/src/codebase/map-v2/publication-transaction/module.ts");
    const barrier = join(root, "barrier.start");
    const readyPaths = [join(root, "child-a.ready"), join(root, "child-b.ready")];
    const resultPaths = [join(root, "child-a.result"), join(root, "child-b.result")];
    const childScript = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createMapPublicationFilesystemTransactionPort } from ${JSON.stringify(pathToFileURL(sourceRoot).href)};
      import { createMapPublicationTransaction } from ${JSON.stringify(pathToFileURL(sourceModule).href)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      writeFileSync(process.env.HH_READY, "ready");
      while (!existsSync(process.env.HH_BARRIER)) await sleep(5);
      try {
        const port = createMapPublicationFilesystemTransactionPort({
          project_root: process.env.HH_ROOT,
          project_identity: "filesystem-test"
        });
        const result = await createMapPublicationTransaction(port).commitPublication(JSON.parse(process.env.HH_REQUEST));
        writeFileSync(process.env.HH_RESULT, JSON.stringify({ ok: true, outcome: result.outcome }));
      } catch (error) {
        writeFileSync(process.env.HH_RESULT, JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      }
    `;
    const children = resultPaths.map((resultPath, index) => {
      const readyPath = readyPaths[index];
      return spawn(process.execPath, ["--import", "tsx/esm", "-e", childScript], {
        cwd: resolve("."),
        env: {
          ...process.env,
          HH_ROOT: root,
          HH_REQUEST: JSON.stringify(request),
          HH_BARRIER: barrier,
          HH_READY: readyPath,
          HH_RESULT: resultPath
        },
        stdio: "ignore"
      });
    });
    while (!readyPaths.every((path) => existsSync(path))) await new Promise((resolveReady) => setTimeout(resolveReady, 5));
    writeFileSync(barrier, "go");
    await Promise.all(children.map((child) => new Promise<void>((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code) => code === 0 ? resolveChild() : rejectChild(new Error(`child exited ${code}`)));
    })));
    const results = await Promise.all(resultPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as {
      ok: boolean; outcome?: string; error?: string;
    }));
    expect(results.some((result) => result.ok)).toBe(true);
    expect(results.every((result) => result.ok || result.error?.includes("MAP_PUBLICATION_FILESYSTEM_LOCKED"))).toBe(true);
    expect((await readdir(journalRoot)).filter((entry) => entry.startsWith(".root.lock.claim-")).length).toBe(0);
  });
});
