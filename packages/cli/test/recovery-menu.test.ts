import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRecoveryRoot, runTransaction } from "@hunter-harness/core";
import { beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

describe("configuration recovery menu", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-recovery-"));
    expect(await runCli([
      "--profile", "java",
      "--non-interactive", "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
  });

  it("detects and resumes an interrupted update", async () => {
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
    expect(await readFile(path, "utf8")).toBe("after\n");
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

  it("skips phantom durable index entries whose transaction directory is gone", async () => {
    const path = join(root, "phantom.md");
    await writeFile(path, "before\n");
    const recoveryRoot = resolveRecoveryRoot();
    const durableDir = join(recoveryRoot, "recoveries");
    const beforeTransaction = new Set(await readdir(durableDir).catch(() => [] as string[]));
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "phantom.md",
      content: "after\n"
    }], {
      id: "tx_phantom_durable",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);

    // 复现生产现场（本机 13942 条索引里 10 条幻影）：durable 索引保留条目，
    // 但事务目录已被外部清理。durable 目录是 projectKey 哈希命名，靠 diff 定位。
    const afterTransaction = await readdir(durableDir);
    for (const name of afterTransaction) {
      if (name !== ".index" && !beforeTransaction.has(name)) {
        await rm(join(durableDir, name), { recursive: true, force: true });
      }
    }
    // 项目本地 journal 一并移除，强制走 durable 候选循环。
    await rm(join(root, ".harness", "state", "transactions", "tx_phantom_durable"), {
      recursive: true, force: true
    });

    // 修复前：inspectRecovery(幻影) 抛 RECOVERY_NOT_FOUND，bare 启动直接崩溃；
    // 非交互路径也会选中幻影候选并以 BLOCKED exit 3 卡住 configure。
    let prompted = false;
    expect(await runCli(["--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      prompt: async () => {
        prompted = true;
        return "3";
      },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(prompted).toBe(false);
  });

  it("rolls back the latest committed update only while after hashes are clean", async () => {
    const path = join(root, "rollback.md");
    await writeFile(path, "before\n");
    await runTransaction(root, [{
      operation: "modify",
      path: "rollback.md",
      content: "after\n"
    }], { id: "tx_committed_update", kind: "update" });

    expect(await runCli([
      "recover",
      "tx_committed_update",
      "--action",
      "rollback",
      "--yes"
    ], {
      cwd: root,
      resourcesRoot,
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

    expect(await runCli([
      "recover",
      "tx_dirty_update",
      "--action",
      "rollback",
      "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(5);
    expect(await readFile(path, "utf8")).toBe("user changed\n");
  });
});
