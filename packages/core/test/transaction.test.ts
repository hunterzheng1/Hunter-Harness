import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
