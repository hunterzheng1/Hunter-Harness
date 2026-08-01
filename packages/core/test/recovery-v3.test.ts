import {
  link,
  mkdir,
  mkdtemp as osMkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireRecoveryMutationLock,
  diagnoseRecovery,
  inspectRecovery,
  readDurableRecoveryIds,
  recoverTransaction,
  resumeTransaction,
  runTransaction,
  stateLayout
} from "../src/index.js";

// GitHub's Windows runner may expose TEMP through a junction. Canonicalize
// fixture roots so tests are independent of that parent alias; production
// still rejects a linked root itself and any linked internal component.
const tmpdir = (): string => realpathSync(osTmpdir());

async function mkdtemp(prefix: string): Promise<string> {
  return realpathSync(await osMkdtemp(prefix));
}

const identity = {
  projectIdentity: "sha256:recovery-project",
  cliVersion: "0.2.44",
  targetBundleVersion: "0.2.45",
  ownershipManifestHash: "sha256:ownership"
} as const;

async function textTree(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) {
        await visit(path);
      } else {
        files.push(await readFile(path, "utf8"));
      }
    }
  }
  await visit(root);
  return files.join("\n");
}

describe("schema v3 durable recovery", () => {
  it("resumes only pending operations after an interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_resume",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      ...identity
    })).rejects.toThrow(/interrupted/i);

    const result = await resumeTransaction(root, "tx_resume", {
      recoveryRoot,
      ...identity
    });

    expect(result.status).toBe("committed");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
    expect(await readFile(join(root, "two.md"), "utf8")).toBe("new");
    const journal = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_resume", "journal.json"),
      "utf8"
    ));
    expect(journal.completed_operations).toEqual([0, 1]);
    expect(journal.pending_operations).toEqual([]);
  });

  it("fails closed before writing when a completed target drifted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-drift-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_resume_drift",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      ...identity
    })).rejects.toThrow(/interrupted/i);
    await writeFile(join(root, "one.md"), "operator edit");

    await expect(resumeTransaction(root, "tx_resume_drift", {
      recoveryRoot,
      ...identity
    })).rejects.toMatchObject({ code: "RECOVERY_PRECONDITION_FAILED" });
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("operator edit");
    await expect(readFile(join(root, "two.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("inspects the durable copy after project-local state is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-durable-inspect-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));

    await expect(runTransaction(root, [
      { operation: "add", path: "managed.md", content: "generated content" },
      { operation: "add", path: "unrelated-business.md", content: "business body" }
    ], {
      id: "tx_durable",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["managed.md"]
      },
      ...identity
    })).rejects.toThrow(/interrupted/i);
    await rm(join(root, ".harness"), { recursive: true, force: true });

    const inspection = await inspectRecovery(root, "tx_durable", {
      recoveryRoot,
      projectIdentity: identity.projectIdentity
    });

    expect(inspection.source).toBe("durable");
    expect(inspection.recoveryId).toBe("tx_durable");
    expect(inspection.safeActions).toContain("rollback");
    expect(await textTree(recoveryRoot)).not.toContain("business body");
  });

  it("never persists sensitive staged content in the durable store", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-durable-secret-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    const sensitive = "Authorization: Bearer unsafe-secret-token-1234567890";

    await expect(runTransaction(root, [{
      operation: "add",
      path: "managed.md",
      content: sensitive
    }], {
      id: "tx_sensitive",
      kind: "update",
      recoveryStore: { root: recoveryRoot, managedPaths: ["managed.md"] },
      ...identity
    })).rejects.toMatchObject({ code: "RECOVERY_MIRROR_SENSITIVE_CONTENT" });

    await expect(readFile(join(root, "managed.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await textTree(recoveryRoot)).not.toContain(sensitive);
  });

  it("never persists a sensitive before-snapshot in the durable store", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-durable-before-secret-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    const sensitive = "Authorization: Bearer before-secret-token-1234567890";
    await writeFile(join(root, "managed.md"), sensitive);

    await expect(runTransaction(root, [{
      operation: "modify",
      path: "managed.md",
      content: "safe replacement"
    }], {
      id: "tx_sensitive_before",
      kind: "update",
      recoveryStore: { root: recoveryRoot, managedPaths: ["managed.md"] },
      ...identity
    })).rejects.toMatchObject({ code: "RECOVERY_MIRROR_SENSITIVE_CONTENT" });

    expect(await readFile(join(root, "managed.md"), "utf8")).toBe(sensitive);
    expect(await textTree(recoveryRoot)).not.toContain(sensitive);
  });

  it("rejects a durable recovery root that overlaps the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-overlap-recovery-"));

    await expect(runTransaction(root, [{
      operation: "add",
      path: "managed.md",
      content: "managed"
    }], {
      id: "tx_overlap_root",
      kind: "update",
      recoveryStore: {
        root: join(root, ".private-recovery"),
        managedPaths: ["managed.md"]
      },
      ...identity
    })).rejects.toMatchObject({ code: "RECOVERY_STORE_BOUNDARY_INVALID" });
    await expect(readFile(join(root, "managed.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("accepts a real recovery root below a parent junction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-parent-junction-project-"));
    const junctionTarget = await mkdtemp(join(
      tmpdir(),
      "hunter-parent-junction-target-"
    ));
    const junctionContainer = await mkdtemp(join(
      tmpdir(),
      "hunter-parent-junction-container-"
    ));
    const linkedParent = join(junctionContainer, "linked-parent");
    await symlink(
      junctionTarget,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir"
    );
    const recoveryRoot = join(linkedParent, "recovery");

    const result = await runTransaction(root, [{
      operation: "add",
      path: "managed.md",
      content: "managed"
    }], {
      id: "tx_parent_junction",
      kind: "update",
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["managed.md"]
      },
      ...identity
    });

    expect(result.status).toBe("committed");
    expect(await readFile(join(root, "managed.md"), "utf8")).toBe("managed");
  });

  it("keeps legacy journals inspect-and-rollback only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-legacy-resume-"));
    const transactionRoot = join(stateLayout(root).transactions, "tx_legacy");
    await mkdir(join(transactionRoot, "before"), { recursive: true });
    await writeFile(join(transactionRoot, "journal.json"), JSON.stringify({
      schema_version: 2,
      transaction_id: "tx_legacy",
      state: "interrupted",
      created_at: new Date().toISOString(),
      operations: [],
      snapshots: [],
      applied_count: 0,
      failure: "legacy"
    }));

    await expect(resumeTransaction(root, "tx_legacy", identity))
      .rejects.toMatchObject({ code: "LEGACY_RECOVERY_RESUME_UNSUPPORTED" });
  });

  it("rolls back from the durable copy when project-local state is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-durable-rollback-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_durable_rollback",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      ...identity
    })).rejects.toThrow(/interrupted/i);
    await rm(join(root, ".harness"), { recursive: true, force: true });

    const result = await recoverTransaction(root, "tx_durable_rollback", {
      recoveryRoot,
      projectIdentity: identity.projectIdentity
    });

    expect(result.status).toBe("rolled_back");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("before");
    await expect(readFile(join(root, "two.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("allows only one concurrent terminal recovery mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-recovery-race-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_race",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      ...identity
    })).rejects.toThrow(/interrupted/i);

    const outcomes = await Promise.allSettled([
      resumeTransaction(root, "tx_race", { recoveryRoot, ...identity }),
      recoverTransaction(root, "tx_race", {
        recoveryRoot,
        projectIdentity: identity.projectIdentity
      })
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "RECOVERY_CONFLICT" })
      })
    ]);
    const inspection = await inspectRecovery(root, "tx_race", {
      recoveryRoot,
      projectIdentity: identity.projectIdentity
    });
    expect(["committed", "rolled_back"]).toContain(inspection.state);
  });

  it("diagnoses with metadata fingerprints and no raw secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-recovery-diagnose-"));
    await expect(runTransaction(root, [
      { operation: "add", path: "managed.md", content: "generated" },
      { operation: "add", path: "second.md", content: "pending" }
    ], {
      id: "tx_diagnose",
      kind: "update",
      interruptAfterApply: 1,
      ...identity
    })).rejects.toThrow(/interrupted/i);
    const journalPath = join(
      stateLayout(root).transactions,
      "tx_diagnose",
      "journal.json"
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const sensitive = "Authorization: Bearer diagnose-secret-token-1234567890";
    journal.failure = sensitive;
    await writeFile(journalPath, JSON.stringify(journal));

    const diagnosis = await diagnoseRecovery(root, "tx_diagnose", {
      projectIdentity: identity.projectIdentity
    });
    const serialized = JSON.stringify(diagnosis);

    expect(diagnosis.scanPassed).toBe(true);
    expect(diagnosis.affectedPathHashes).toHaveLength(2);
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain(root);
  });

  it("rejects recovery ids and journal paths that escape the project", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hunter-recovery-traversal-"));
    const root = join(parent, "project");
    const outside = join(parent, "outside-canary.md");
    const transactionRoot = join(
      root,
      ".harness",
      "state",
      "escape"
    );
    await mkdir(join(transactionRoot, "before"), { recursive: true });
    await writeFile(outside, "operator canary");
    const outsidePath = "../outside-canary.md";
    const snapshotName = Buffer.from(outsidePath).toString("base64url");
    await writeFile(join(transactionRoot, "before", snapshotName), "attacker data");
    await writeFile(join(transactionRoot, "journal.json"), JSON.stringify({
      schema_version: 3,
      transaction_id: "../escape",
      recovery_id: "../escape",
      kind: "update",
      state: "interrupted",
      created_at: new Date().toISOString(),
      operations: [{
        operation: "modify",
        path: outsidePath,
        content_sha256: "sha256:" + "0".repeat(64)
      }],
      snapshots: [{
        path: outsidePath,
        existed: true,
        snapshot_name: snapshotName
      }],
      applied_count: 1,
      failure: "interrupted",
      project_identity: identity.projectIdentity,
      cli_version: identity.cliVersion,
      target_bundle_version: identity.targetBundleVersion,
      ownership_manifest_hash: identity.ownershipManifestHash,
      plan_hash: "sha256:" + "1".repeat(64),
      snapshot_digest: "sha256:" + "2".repeat(64),
      completed_operations: [0],
      pending_operations: [],
      completed_target_states: []
    }));

    await expect(recoverTransaction(root, "../escape"))
      .rejects.toMatchObject({ code: "RECOVERY_ID_INVALID" });
    expect(await readFile(outside, "utf8")).toBe("operator canary");
  });

  it("fails closed before rollback when a project snapshot is corrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-project-corrupt-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "pending" }
    ], {
      id: "tx_project_corrupt",
      kind: "update",
      interruptAfterApply: 1,
      ...identity
    })).rejects.toThrow(/interrupted/i);
    const transactionRoot = join(
      stateLayout(root).transactions,
      "tx_project_corrupt"
    );
    const journal = JSON.parse(await readFile(
      join(transactionRoot, "journal.json"),
      "utf8"
    ));
    const snapshotName = journal.snapshots.find(
      (item: { path: string }) => item.path === "one.md"
    ).snapshot_name;
    await writeFile(join(transactionRoot, "before", snapshotName), "corrupt");

    await expect(recoverTransaction(root, "tx_project_corrupt"))
      .rejects.toMatchObject({ code: "RECOVERY_PRECONDITION_FAILED" });
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
  });

  it("fails closed before rollback when a durable snapshot is corrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-durable-corrupt-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "pending" }
    ], {
      id: "tx_durable_corrupt",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      ...identity
    })).rejects.toThrow(/interrupted/i);
    const index = JSON.parse(await readFile(
      join(recoveryRoot, "index.json"),
      "utf8"
    ));
    const durableRoot = join(
      recoveryRoot,
      "recoveries",
      index.entries[0].projectKey,
      "tx_durable_corrupt"
    );
    const journal = JSON.parse(await readFile(
      join(durableRoot, "journal.json"),
      "utf8"
    ));
    const snapshotName = journal.snapshots.find(
      (item: { path: string }) => item.path === "one.md"
    ).snapshot_name;
    await writeFile(join(durableRoot, "before", snapshotName), "corrupt");
    await rm(join(root, ".harness"), { recursive: true, force: true });

    await expect(recoverTransaction(root, "tx_durable_corrupt", {
      recoveryRoot,
      projectIdentity: identity.projectIdentity
    })).rejects.toMatchObject({ code: "RECOVERY_PRECONDITION_FAILED" });
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
  });

  it("refuses rollback after a completed target drifted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-rollback-drift-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "pending" }
    ], {
      id: "tx_rollback_drift",
      kind: "update",
      interruptAfterApply: 1,
      ...identity
    })).rejects.toThrow(/interrupted/i);
    await writeFile(join(root, "one.md"), "operator edit");

    await expect(recoverTransaction(root, "tx_rollback_drift"))
      .rejects.toMatchObject({ code: "RECOVERY_PRECONDITION_FAILED" });
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("operator edit");
  });

  it("retires a dead-owner recovery lock but preserves a live owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-stale-recovery-lock-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "pending" }
    ], {
      id: "tx_stale_lock",
      kind: "update",
      interruptAfterApply: 1,
      ...identity
    })).rejects.toThrow(/interrupted/i);
    const transactionRoot = join(
      stateLayout(root).transactions,
      "tx_stale_lock"
    );
    await writeFile(join(transactionRoot, "recovery.lock"), JSON.stringify({
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString()
    }));

    expect((await recoverTransaction(root, "tx_stale_lock")).status)
      .toBe("rolled_back");
    const release = await acquireRecoveryMutationLock(transactionRoot);
    await expect(acquireRecoveryMutationLock(transactionRoot))
      .rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    await release();
  });

  it("allows only one contender to claim the same stale recovery lock", async () => {
    const transactionRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-stale-lock-race-"
    ));
    await writeFile(join(transactionRoot, "recovery.lock"), JSON.stringify({
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString()
    }));
    let arrivals = 0;
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const beforeStaleClaim = async () => {
      arrivals += 1;
      if (arrivals === 2) openBarrier?.();
      await barrier;
    };

    const results = await Promise.allSettled([
      acquireRecoveryMutationLock(transactionRoot, { beforeStaleClaim }),
      acquireRecoveryMutationLock(transactionRoot, { beforeStaleClaim })
    ]);
    const acquired = results.filter((result) => result.status === "fulfilled");
    const blocked = results.filter((result) => result.status === "rejected");

    expect(acquired).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      reason: { code: "RECOVERY_CONFLICT" }
    });
    if (acquired[0]?.status === "fulfilled") {
      await acquired[0].value();
    }
  });

  it("keeps a transaction lock usable across 300 sequential lifecycles", async () => {
    const transactionRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-lock-lifecycle-"
    ));

    for (let index = 0; index < 300; index += 1) {
      const release = await acquireRecoveryMutationLock(transactionRoot);
      await release();
    }

    const finalRelease = await acquireRecoveryMutationLock(transactionRoot);
    await expect(acquireRecoveryMutationLock(transactionRoot))
      .rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    await finalRelease();
  }, 90_000);

  it("registers 300 durable recoveries without exhausting a global lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-index-lifecycle-"));
    const recoveryRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-index-lifecycle-store-"
    ));

    for (let index = 0; index < 300; index += 1) {
      const result = await runTransaction(root, [], {
        id: `tx_index_lifecycle_${String(index).padStart(3, "0")}`,
        kind: "update",
        recoveryStore: {
          root: recoveryRoot,
          managedPaths: []
        },
        ...identity
      });
      expect(result.status).toBe("committed");
    }

    const recoveryIds = await readDurableRecoveryIds(
      root,
      recoveryRoot,
      identity.projectIdentity
    );
    expect(recoveryIds).toHaveLength(300);
    expect(recoveryIds).toContain("tx_index_lifecycle_000");
    expect(recoveryIds).toContain("tx_index_lifecycle_299");
  }, 90_000);

  it("fails before project mutation when the legacy index projection is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-index-malformed-"));
    const recoveryRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-index-malformed-store-"
    ));
    await writeFile(join(recoveryRoot, "index.json"), "{ malformed");

    await expect(runTransaction(root, [{
      operation: "add",
      path: "guarded.md",
      content: "must-not-apply"
    }], {
      id: "tx_index_malformed",
      kind: "update",
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["guarded.md"]
      },
      ...identity
    })).rejects.toMatchObject({
      code: "RECOVERY_STORE_BOUNDARY_INVALID"
    });
    await expect(readFile(join(root, "guarded.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "recoveries", nested: false },
    { name: ".index", nested: true }
  ])("rejects an internal $name directory link before project mutation", async ({
    name,
    nested
  }) => {
    const root = await mkdtemp(join(tmpdir(), "hunter-linked-store-project-"));
    const recoveryRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-linked-store-root-"
    ));
    const external = await mkdtemp(join(
      tmpdir(),
      "hunter-linked-store-external-"
    ));
    const linkParent = nested
      ? join(recoveryRoot, "recoveries")
      : recoveryRoot;
    await mkdir(linkParent, { recursive: true });
    await symlink(
      external,
      join(linkParent, name),
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(runTransaction(root, [{
      operation: "add",
      path: "guarded.md",
      content: "must-not-apply"
    }], {
      id: `tx_linked_${name.replace(".", "index")}`,
      kind: "update",
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["guarded.md"]
      },
      ...identity
    })).rejects.toMatchObject({
      code: "RECOVERY_STORE_BOUNDARY_INVALID"
    });
    await expect(readFile(join(root, "guarded.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(external)).toEqual([]);
  });

  it("rejects a hard-linked durable copy destination before project mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-hard-link-project-"));
    const recoveryRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-hard-link-store-"
    ));
    const external = join(
      await mkdtemp(join(tmpdir(), "hunter-hard-link-external-")),
      "canary.txt"
    );
    await writeFile(external, "external-canary");

    const seed = await runTransaction(root, [], {
      id: "tx_hard_link_seed",
      kind: "update",
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: []
      },
      ...identity
    });
    expect(seed.status).toBe("committed");
    const projectKeys = (await readdir(
      join(recoveryRoot, "recoveries"),
      { withFileTypes: true }
    ))
      .filter((entry) => entry.isDirectory() && entry.name !== ".index")
      .map((entry) => entry.name);
    expect(projectKeys).toHaveLength(1);
    const projectKey = projectKeys[0];
    if (projectKey === undefined) {
      throw new Error("seed recovery did not create a project key");
    }
    const stagedRoot = join(
      recoveryRoot,
      "recoveries",
      projectKey,
      "tx_hard_link_destination",
      "staged"
    );
    await mkdir(stagedRoot, { recursive: true });
    await link(external, join(stagedRoot, "0"));

    await expect(runTransaction(root, [{
      operation: "add",
      path: "guarded.md",
      content: "must-not-apply"
    }], {
      id: "tx_hard_link_destination",
      kind: "update",
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["guarded.md"]
      },
      ...identity
    })).rejects.toMatchObject({
      code: "RECOVERY_STORE_BOUNDARY_INVALID"
    });
    expect(await readFile(external, "utf8")).toBe("external-canary");
    await expect(readFile(join(root, "guarded.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges the compatibility projection after concurrent registrations", async () => {
    const recoveryRoot = await mkdtemp(join(
      tmpdir(),
      "hunter-index-concurrent-store-"
    ));
    const count = 24;

    const results = await Promise.all(
      Array.from({ length: count }, async (_value, index) => {
        const root = await mkdtemp(join(
          tmpdir(),
          `hunter-index-concurrent-${String(index).padStart(2, "0")}-`
        ));
        return runTransaction(root, [], {
          id: `tx_index_concurrent_${String(index).padStart(2, "0")}`,
          kind: "update",
          recoveryStore: {
            root: recoveryRoot,
            managedPaths: []
          },
          ...identity
        });
      })
    );
    expect(results.every((result) => result.status === "committed")).toBe(true);
    const projection = JSON.parse(await readFile(
      join(recoveryRoot, "index.json"),
      "utf8"
    )) as { entries: Array<{ recoveryId: string }> };
    expect(projection.entries).toHaveLength(count);
    expect(new Set(projection.entries.map((entry) => entry.recoveryId)).size)
      .toBe(count);
  });

  it("blocks terminal recovery while the live transaction owner holds the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-live-owner-lock-"));
    let announcePrepared: (() => void) | undefined;
    let continueApply: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      announcePrepared = resolve;
    });
    const continuation = new Promise<void>((resolve) => {
      continueApply = resolve;
    });
    const running = runTransaction(root, [{
      operation: "add",
      path: "one.md",
      content: "one"
    }], {
      id: "tx_live_owner",
      kind: "update",
      ...identity,
      pauseBeforeApply: async () => {
        announcePrepared?.();
        await continuation;
      }
    });
    await prepared;

    await expect(recoverTransaction(root, "tx_live_owner"))
      .rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    continueApply?.();
    expect((await running).status).toBe("committed");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("one");
  });

  it("requires all current identity fields before a v3 resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-identity-"));
    await expect(runTransaction(root, [
      { operation: "add", path: "one.md", content: "one" },
      { operation: "add", path: "two.md", content: "two" }
    ], {
      id: "tx_identity_required",
      kind: "update",
      interruptAfterApply: 1,
      ...identity
    })).rejects.toThrow(/interrupted/i);

    await expect(resumeTransaction(root, "tx_identity_required", {
      projectIdentity: identity.projectIdentity
    })).rejects.toMatchObject({ code: "RECOVERY_PRECONDITION_FAILED" });
    await expect(readFile(join(root, "two.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects every current identity drift before applying pending work", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-identity-drift-"));
    await expect(runTransaction(root, [
      { operation: "add", path: "one.md", content: "one" },
      { operation: "add", path: "two.md", content: "two" }
    ], {
      id: "tx_identity_drift",
      kind: "update",
      interruptAfterApply: 1,
      ...identity
    })).rejects.toThrow(/interrupted/i);
    const mismatches = [
      { ...identity, projectIdentity: "sha256:other-project" },
      { ...identity, cliVersion: "9.9.9" },
      { ...identity, targetBundleVersion: "9.9.9" },
      { ...identity, ownershipManifestHash: "sha256:other-ownership" },
      {
        ...identity,
        expectedPlanHash: "sha256:" + "0".repeat(64)
      }
    ];

    for (const mismatch of mismatches) {
      await expect(resumeTransaction(
        root,
        "tx_identity_drift",
        mismatch
      )).rejects.toMatchObject({ code: "RECOVERY_PRECONDITION_FAILED" });
      await expect(readFile(join(root, "two.md"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  });
});
