import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTransaction } from "@hunter-harness/core";
import { beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../../resources", import.meta.url)
);

describe("configuration recovery menu", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-recovery-"));
    expect(await runCli([
      "--adapter", "claude-code", "--profile", "java",
      "--non-interactive", "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
  });

  it("detects and recovers an interrupted update", async () => {
    const path = join(root, "recover.md");
    await writeFile(path, "before\n");
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "recover.md",
      content: "after\n"
    }], {
      id: "tx_interrupted_update",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);
    expect(await readFile(path, "utf8")).toBe("after\n");

    const answers = ["1"];
    expect(await runCli([], {
      cwd: root,
      resourcesRoot,
      prompt: async () => answers.shift() ?? "",
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await readFile(path, "utf8")).toBe("before\n");
  });

  it("blocks non-interactive work until interrupted state is recovered", async () => {
    await writeFile(join(root, "blocked.md"), "before\n");
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "blocked.md",
      content: "after\n"
    }], {
      id: "tx_blocked_update",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow();
    expect(await runCli(["--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(5);
  });

  it("rolls back the latest committed update only while after hashes are clean", async () => {
    const path = join(root, "rollback.md");
    await writeFile(path, "before\n");
    await runTransaction(root, [{
      operation: "modify",
      path: "rollback.md",
      content: "after\n"
    }], { id: "tx_committed_update", kind: "update" });

    const answers = ["2"];
    expect(await runCli([], {
      cwd: root,
      resourcesRoot,
      prompt: async () => answers.shift() ?? "",
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await readFile(path, "utf8")).toBe("before\n");
  });

  it("refuses rollback after a user changes an updated file", async () => {
    const path = join(root, "dirty.md");
    await writeFile(path, "before\n");
    await runTransaction(root, [{
      operation: "modify",
      path: "dirty.md",
      content: "after\n"
    }], { id: "tx_dirty_update", kind: "update" });
    await writeFile(path, "user changed\n");

    const answers = ["2"];
    expect(await runCli([], {
      cwd: root,
      resourcesRoot,
      prompt: async () => answers.shift() ?? "",
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(5);
    expect(await readFile(path, "utf8")).toBe("user changed\n");
  });
});
