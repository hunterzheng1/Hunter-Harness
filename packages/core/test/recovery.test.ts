import {
  mkdtemp as osMkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  recoverTransaction,
  pendingTransactions,
  resumeTransaction,
  rollbackCommittedUpdate,
  runTransaction,
  stateLayout
} from "../src/index.js";

// Keep durable recovery fixtures outside junction aliases used by some
// Windows CI temp directories; production still fails closed on linked roots
// and linked internal components.
const tmpdir = (): string => realpathSync(osTmpdir());

async function mkdtemp(prefix: string): Promise<string> {
  return realpathSync(await osMkdtemp(prefix));
}

describe("transaction recovery", () => {
  it("recovers an interrupted update from its journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-recover-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_interrupted",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);

    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
    const recovery = await recoverTransaction(root, "tx_interrupted");
    expect(recovery.status).toBe("rolled_back");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("before");
    await expect(readFile(join(root, "two.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const journal = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_interrupted", "journal.json"),
      "utf8"
    )) as { state: string };
    expect(journal.state).toBe("rolled_back");
  });

  it("does not roll back an already committed transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-committed-"));
    await runTransaction(root, [
      { operation: "add", path: "one.md", content: "committed" }
    ], { id: "tx_committed" });

    const recovery = await recoverTransaction(root, "tx_committed");
    expect(recovery.status).toBe("committed");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("committed");
  });

  it("resumes an interrupted transaction from verified staged content", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_resume",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);

    const resumed = await resumeTransaction(root, "tx_resume");

    expect(resumed.status).toBe("committed");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
    expect(await readFile(join(root, "two.md"), "utf8")).toBe("new");
  });

  it("refuses resume when a pending target changed after interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-dirty-pending-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "managed" }
    ], {
      id: "tx_resume_dirty_pending",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);
    await writeFile(join(root, "two.md"), "user edit");

    await expect(
      resumeTransaction(root, "tx_resume_dirty_pending")
    ).rejects.toThrow(/RESUME_PENDING_TARGET_CHANGED/);
    expect(await readFile(join(root, "two.md"), "utf8")).toBe("user edit");
  });

  it("requires caller expectations to match custom target and ownership identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-identity-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_resume_identity",
      interruptAfterApply: 1,
      cliVersion: "hunter-harness@0.2.45",
      targetBundleVersion: "bundle-2",
      ownershipManifestHash: "sha256:ownership-2"
    })).rejects.toThrow(/interrupted/i);

    await expect(
      resumeTransaction(root, "tx_resume_identity", {
        targetBundleVersion: "bundle-3",
        ownershipManifestHash: "sha256:ownership-2"
      })
    ).rejects.toThrow(/TARGET_BUNDLE_VERSION_CHANGED/);
    const resumed = await resumeTransaction(root, "tx_resume_identity", {
      targetBundleVersion: "bundle-2",
      ownershipManifestHash: "sha256:ownership-2"
    });
    expect(resumed.status).toBe("committed");
  });

  it("refuses rollback when a before snapshot has been tampered with", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-snapshot-tamper-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_snapshot_tamper",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);
    const journal = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_snapshot_tamper", "journal.json"),
      "utf8"
    )) as { snapshots: Array<{ snapshot_name: string | null }> };
    const snapshotName = journal.snapshots.find(
      (snapshot) => snapshot.snapshot_name !== null
    )?.snapshot_name;
    expect(snapshotName).toBeTruthy();
    await writeFile(
      join(
        stateLayout(root).transactions,
        "tx_snapshot_tamper",
        "before",
        snapshotName as string
      ),
      "tampered"
    );

    await expect(
      recoverTransaction(root, "tx_snapshot_tamper")
    ).rejects.toThrow(/SNAPSHOT_DIGEST_MISMATCH/);
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
  });

  it("discovers and resumes an interrupted transaction after local state loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-external-recovery-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    const previous = process.env.HUNTER_HARNESS_RECOVERY_ROOT;
    process.env.HUNTER_HARNESS_RECOVERY_ROOT = recoveryRoot;
    try {
      await writeFile(join(root, "one.md"), "before");
      await expect(runTransaction(root, [
        { operation: "modify", path: "one.md", content: "after" },
        { operation: "add", path: "two.md", content: "new" }
      ], {
        id: "tx_external_resume",
        interruptAfterApply: 1
      })).rejects.toThrow(/interrupted/i);
      await rm(join(root, ".harness"), { recursive: true, force: true });

      expect(await pendingTransactions(root)).toMatchObject([
        { transactionId: "tx_external_resume", mutationState: "APPLIED_PARTIAL" }
      ]);
      const resumed = await resumeTransaction(root, "tx_external_resume");

      expect(resumed.status).toBe("committed");
      expect(await readFile(join(root, "two.md"), "utf8")).toBe("new");
    } finally {
      if (previous === undefined) {
        delete process.env.HUNTER_HARNESS_RECOVERY_ROOT;
      } else {
        process.env.HUNTER_HARNESS_RECOVERY_ROOT = previous;
      }
    }
  });

  it("uses a valid external mirror when the local recovery journal is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-corrupt-local-recovery-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-recovery-store-"));
    const previous = process.env.HUNTER_HARNESS_RECOVERY_ROOT;
    process.env.HUNTER_HARNESS_RECOVERY_ROOT = recoveryRoot;
    try {
      await writeFile(join(root, "one.md"), "before");
      await expect(runTransaction(root, [
        { operation: "modify", path: "one.md", content: "after" },
        { operation: "add", path: "two.md", content: "new" }
      ], {
        id: "tx_corrupt_local",
        interruptAfterApply: 1
      })).rejects.toThrow(/interrupted/i);
      await writeFile(
        join(stateLayout(root).transactions, "tx_corrupt_local", "journal.json"),
        "{not-json"
      );

      expect(await pendingTransactions(root)).toMatchObject([
        { transactionId: "tx_corrupt_local" }
      ]);
      const resumed = await resumeTransaction(root, "tx_corrupt_local");

      expect(resumed.status).toBe("committed");
      expect(await readFile(join(root, "two.md"), "utf8")).toBe("new");
    } finally {
      if (previous === undefined) {
        delete process.env.HUNTER_HARNESS_RECOVERY_ROOT;
      } else {
        process.env.HUNTER_HARNESS_RECOVERY_ROOT = previous;
      }
    }
  });

  it("rolls back only the explicitly selected committed transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-exact-rollback-"));
    await writeFile(join(root, "one.md"), "before");
    await runTransaction(root, [
      { operation: "modify", path: "one.md", content: "first" }
    ], { id: "tx_first", kind: "update" });
    await runTransaction(root, [
      { operation: "modify", path: "one.md", content: "second" }
    ], { id: "tx_second", kind: "update" });

    await expect(
      rollbackCommittedUpdate(root, "tx_first")
    ).rejects.toThrow(/not available/i);
    const result = await rollbackCommittedUpdate(root, "tx_second");

    expect(result.status).toBe("committed");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("first");
  });

  it("refuses committed rollback when its before snapshot is tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-committed-tamper-"));
    await writeFile(join(root, "one.md"), "before");
    await runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" }
    ], { id: "tx_committed_tamper", kind: "update" });
    const transactionRoot = join(
      stateLayout(root).transactions,
      "tx_committed_tamper"
    );
    const journal = JSON.parse(await readFile(
      join(transactionRoot, "journal.json"),
      "utf8"
    )) as { snapshots: Array<{ snapshot_name: string | null }> };
    const snapshotName = journal.snapshots[0]?.snapshot_name;
    expect(snapshotName).toBeTruthy();
    await writeFile(join(transactionRoot, "before", snapshotName ?? ""), "tampered");

    await expect(
      rollbackCommittedUpdate(root, "tx_committed_tamper")
    ).rejects.toThrow(/SNAPSHOT_DIGEST_MISMATCH/);
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
  });
});
