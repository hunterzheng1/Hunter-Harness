import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BaselineManifest } from "@hunter-harness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireProtocolLock,
  ensureStateLayout,
  readBaseline,
  runTransaction,
  stateLayout,
  writeBaseline
} from "../src/index.js";

describe("protocol state", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-state-"));
  });

  it("creates the closed state and cache layout", async () => {
    const layout = await ensureStateLayout(root);
    expect(layout.baseline).toContain(join(".harness", "state", "baseline"));
    expect(layout.transactions).toContain(join(".harness", "state", "transactions"));
    expect(layout.locks).toContain(join(".harness", "state", "locks"));
    expect(layout.local).toContain(join(".harness", "state", "local"));
    expect(layout.serverArtifacts).toContain(join(".harness", "cache", "server-artifacts"));
  });

  it("writes and reads the baseline atomically", async () => {
    const baseline: BaselineManifest = {
      schema_version: 1,
      project_id: null,
      complete_project_version: null,
      artifact_manifest_hash: null,
      files: {}
    };
    await writeBaseline(root, baseline);
    expect(await readBaseline(root)).toEqual(baseline);
  });

  it("prevents active concurrent operations and replaces stale locks", async () => {
    const first = await acquireProtocolLock(root, "update", {
      now: 1000,
      staleAfterMs: 500
    });
    await expect(acquireProtocolLock(root, "push", {
      now: 1200,
      staleAfterMs: 500
    })).rejects.toThrow(/lock/i);
    await first.release();

    const stale = await acquireProtocolLock(root, "update", {
      now: 2000,
      staleAfterMs: 500
    });
    await writeFile(stale.path, JSON.stringify({
      operation: "update",
      request_id: "old",
      nonce: "old",
      pid: 1,
      started_at_ms: 1000,
      heartbeat_at_ms: 1000
    }));
    const replacement = await acquireProtocolLock(root, "push", {
      now: 3000,
      staleAfterMs: 500
    });
    expect(replacement.operation).toBe("push");
    await replacement.release();
  });

  it("commits add, modify, delete, and rename as one transaction", async () => {
    await ensureStateLayout(root);
    await writeFile(join(root, "modify.md"), "before");
    await writeFile(join(root, "delete.md"), "delete me");
    await writeFile(join(root, "from.md"), "rename me");

    const result = await runTransaction(root, [
      { operation: "add", path: "added.md", content: "added" },
      { operation: "modify", path: "modify.md", content: "after" },
      { operation: "delete", path: "delete.md" },
      { operation: "rename", from_path: "from.md", to_path: "to.md", content: "renamed" }
    ], { id: "tx_mixed" });

    expect(result.status).toBe("committed");
    expect(await readFile(join(root, "added.md"), "utf8")).toBe("added");
    expect(await readFile(join(root, "modify.md"), "utf8")).toBe("after");
    await expect(readFile(join(root, "delete.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "from.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "to.md"), "utf8")).toBe("renamed");
    expect(stateLayout(root).transactions).toContain(".harness");
  });

  it("keeps staged payloads out of the durable journal", async () => {
    const marker = "payload-must-not-be-serialized-";
    const payload = marker.repeat(40_000);

    await runTransaction(root, [
      { operation: "add", path: "large.txt", content: payload }
    ], { id: "tx_compact_journal" });

    const transactionRoot = join(
      stateLayout(root).transactions,
      "tx_compact_journal"
    );
    const rawJournal = await readFile(join(transactionRoot, "journal.json"), "utf8");
    const journal = JSON.parse(rawJournal) as {
      schema_version: number;
      operations: unknown[];
      applied_count: number;
    };
    const status = JSON.parse(await readFile(
      join(transactionRoot, "status.json"),
      "utf8"
    )) as { state: string; applied_count: number };

    expect(rawJournal).not.toContain(marker);
    expect(Buffer.byteLength(rawJournal)).toBeLessThan(4_096);
    expect(journal.schema_version).toBe(3);
    expect(journal.operations).toEqual([
      expect.objectContaining({
        operation: "add",
        path: "large.txt",
        content_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      })
    ]);
    expect(journal.applied_count).toBe(1);
    expect(status).toMatchObject({ state: "committed", applied_count: 1 });
  });

  it("rolls every file back when an eligible write fails", async () => {
    await writeFile(join(root, "one.md"), "one-before");
    await writeFile(join(root, "two.md"), "two-before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "one-after" },
      { operation: "modify", path: "two.md", content: "two-after" },
      { operation: "add", path: "three.md", content: "three" }
    ], { id: "tx_fail", failAfterApply: 2 })).rejects.toThrow(/injected/i);

    expect(await readFile(join(root, "one.md"), "utf8")).toBe("one-before");
    expect(await readFile(join(root, "two.md"), "utf8")).toBe("two-before");
    await expect(readFile(join(root, "three.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const status = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_fail", "status.json"),
      "utf8"
    )) as { state: string };
    expect(status.state).toBe("rolled_back");
  });

  it("refuses undeclared writes to protected local roots and records invariant inventories", async () => {
    const archiveFile = join(
      root,
      ".harness",
      "archive",
      "existing",
      "reports",
      "final",
      "summary-data.json"
    );
    await mkdir(join(archiveFile, ".."), { recursive: true });
    await writeFile(archiveFile, "{\"preserve\":true}\n", "utf8");

    await expect(runTransaction(root, [
      { operation: "delete", path: ".harness/archive/existing/reports/final/summary-data.json" }
    ], { id: "tx_forbidden_archive", kind: "refresh" })).rejects.toMatchObject({
      code: "PROTECTED_LOCAL_ROOT_WRITE_FORBIDDEN"
    });
    expect(await readFile(archiveFile, "utf8")).toBe("{\"preserve\":true}\n");

    const result = await runTransaction(root, [
      { operation: "add", path: "managed.txt", content: "ok" }
    ], { id: "tx_preserves_archive", kind: "refresh" });
    expect(result.protectedLocalRoots.before).toEqual(result.protectedLocalRoots.after);
    expect(result.protectedLocalRoots.before).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".harness/archive",
        files: 1
      })
    ]));
    const journal = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_preserves_archive", "journal.json"),
      "utf8"
    )) as {
      protected_local_roots: {
        before: unknown[];
        after: unknown[];
        unchanged: boolean;
      };
    };
    expect(journal.protected_local_roots.unchanged).toBe(true);
    expect(journal.protected_local_roots.before).toEqual(
      journal.protected_local_roots.after
    );
  });

  it("records a stable recovery contract and immutable plan hash", async () => {
    const result = await runTransaction(root, [{
      operation: "add",
      path: "contract.txt",
      content: "value\n"
    }], {
      id: "tx_contract",
      kind: "update",
      projectIdentity: "sha256:project",
      cliVersion: "0.2.44",
      targetBundleVersion: "0.2.45",
      ownershipManifestHash: "sha256:ownership"
    });

    expect(result.recoveryId).toBe("tx_contract");
    expect(result.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const journal = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_contract", "journal.json"),
      "utf8"
    ));
    expect(journal).toMatchObject({
      schema_version: 3,
      transaction_id: "tx_contract",
      recovery_id: "tx_contract",
      project_identity: "sha256:project",
      cli_version: "0.2.44",
      target_bundle_version: "0.2.45",
      ownership_manifest_hash: "sha256:ownership",
      plan_hash: result.planHash,
      state: "committed"
    });
    expect(journal.snapshot_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(journal.completed_operations).toEqual([0]);
    expect(journal.pending_operations).toEqual([]);
  });

  it("rejects transaction ids that can escape the transaction store", async () => {
    const outside = join(root, ".harness", "state", "escaped");

    await expect(runTransaction(root, [{
      operation: "add",
      path: "managed.txt",
      content: "must not be written"
    }], {
      id: "../escaped"
    })).rejects.toMatchObject({ code: "RECOVERY_ID_INVALID" });

    await expect(readFile(join(outside, "journal.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(root, "managed.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
