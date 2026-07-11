import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cleanupProject } from "../src/state/cleanup.js";
import { ensureStateLayout, runTransaction, stateLayout } from "../src/index.js";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function readJournal(root: string, txId: string): Promise<{ state: string; kind?: string }> {
  return JSON.parse(await readFile(join(stateLayout(root).transactions, txId, "journal.json"), "utf8")) as {
    state: string; kind?: string;
  };
}

describe("transaction retention", () => {
  it("removes staged/ after a successful transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ret-staged-"));
    await runTransaction(root, [{ operation: "add", path: "a.md", content: "a" }], {
      id: "tx_staged_1", kind: "refresh"
    });
    expect(await exists(join(stateLayout(root).transactions, "tx_staged_1", "staged"))).toBe(false);
  });

  it("retains before/after/journal/status for the latest rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ret-latest-"));
    await writeFile(join(root, "modify.md"), "before");
    await runTransaction(root, [{ operation: "modify", path: "modify.md", content: "after" }], {
      id: "tx_latest_1", kind: "refresh"
    });
    const txRoot = join(stateLayout(root).transactions, "tx_latest_1");
    expect(await exists(join(txRoot, "before"))).toBe(true);
    expect(await exists(join(txRoot, "after", "manifest.json"))).toBe(true);
    expect(await exists(join(txRoot, "journal.json"))).toBe(true);
    expect(await exists(join(txRoot, "status.json"))).toBe(true);
  });

  it("prunes the older same-kind successful transaction on a new commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ret-prune-"));
    await runTransaction(root, [{ operation: "add", path: "a.md", content: "1" }], {
      id: "tx_prune_1", kind: "refresh"
    });
    expect(await exists(join(stateLayout(root).transactions, "tx_prune_1"))).toBe(true);
    await runTransaction(root, [{ operation: "modify", path: "a.md", content: "2" }], {
      id: "tx_prune_2", kind: "refresh"
    });
    expect(await exists(join(stateLayout(root).transactions, "tx_prune_1"))).toBe(false);
    expect(await exists(join(stateLayout(root).transactions, "tx_prune_2"))).toBe(true);
  });

  it("keeps different-kind successful transactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ret-kinds-"));
    await runTransaction(root, [{ operation: "add", path: "a.md", content: "a" }], {
      id: "tx_kind_init", kind: "init"
    });
    await runTransaction(root, [{ operation: "modify", path: "a.md", content: "b" }], {
      id: "tx_kind_refresh", kind: "refresh"
    });
    expect(await exists(join(stateLayout(root).transactions, "tx_kind_init"))).toBe(true);
    expect(await exists(join(stateLayout(root).transactions, "tx_kind_refresh"))).toBe(true);
  });

  it("retains interrupted and recovery-required transactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ret-interrupt-"));
    await writeFile(join(root, "a.md"), "a");
    await expect(runTransaction(root, [
      { operation: "modify", path: "a.md", content: "x" }
    ], { id: "tx_interrupt_1", kind: "refresh", interruptAfterApply: 1 })).rejects.toThrow(/interrupt/i);
    // 新的成功提交不得剪除 interrupted 事务。
    await runTransaction(root, [{ operation: "add", path: "b.md", content: "b" }], {
      id: "tx_interrupt_2", kind: "refresh"
    });
    expect(await exists(join(stateLayout(root).transactions, "tx_interrupt_1"))).toBe(true);
    expect((await readJournal(root, "tx_interrupt_1")).state).toBe("interrupted");
  });
});

describe("cleanup", () => {
  it("dry-run reports without mutating", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-clean-dry-"));
    await ensureStateLayout(root);
    await runTransaction(root, [{ operation: "add", path: "a.md", content: "a" }], {
      id: "tx_clean_dry_1", kind: "refresh"
    });
    await mkdir(join(root, ".harness", "cache", "server-artifacts", "art_old"), { recursive: true });
    await writeFile(join(root, ".harness", "cache", "server-artifacts", "art_old", "blob"), "old");

    const result = await cleanupProject({ projectRoot: root, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.removed_cache).toContain("art_old");
    // dry-run 不应改动文件系统。
    expect(await exists(join(root, ".harness", "cache", "server-artifacts", "art_old", "blob"))).toBe(true);
    expect(await exists(join(stateLayout(root).transactions, "tx_clean_dry_1"))).toBe(true);
  });

  it("prunes older same-kind committed transactions and clears cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-clean-run-"));
    await ensureStateLayout(root);
    // 手工构造两个同 kind committed 事务（绕过运行时 retention 以验证 cleanup 自身）。
    const txRoot1 = join(stateLayout(root).transactions, "tx_manual_1");
    const txRoot2 = join(stateLayout(root).transactions, "tx_manual_2");
    for (const txr of [txRoot1, txRoot2]) {
      await mkdir(join(txr, "before"), { recursive: true });
      await mkdir(join(txr, "after"), { recursive: true });
      const journal = {
        schema_version: 1,
        transaction_id: txr,
        kind: "refresh",
        state: "committed",
        created_at: txr.endsWith("1") ? "2026-01-01T00:00:00.000Z" : "2026-07-11T00:00:00.000Z",
        operations: [], snapshots: [], applied_count: 0, failure: null
      };
      await writeFile(join(txr, "journal.json"), JSON.stringify(journal));
      await writeFile(join(txr, "status.json"), JSON.stringify({ schema_version: 1, state: "committed" }));
    }
    await mkdir(join(root, ".harness", "cache", "server-artifacts", "art_x"), { recursive: true });
    await writeFile(join(root, ".harness", "cache", "server-artifacts", "art_x", "blob"), "x");

    const result = await cleanupProject({ projectRoot: root, dryRun: false });
    expect(result.pruned_transactions).toContain("tx_manual_1");
    expect(await exists(txRoot1)).toBe(false);
    expect(await exists(txRoot2)).toBe(true);
    expect(await exists(join(root, ".harness", "cache", "server-artifacts", "art_x"))).toBe(false);
  });

  it("never leaves its allowed roots (knowledge/baseline/reports/project untouched)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-clean-roots-"));
    await ensureStateLayout(root);
    await mkdir(join(root, ".harness", "knowledge"), { recursive: true });
    await mkdir(join(root, ".harness", "reports"), { recursive: true });
    await mkdir(join(root, ".harness", "state", "baseline"), { recursive: true });
    await writeFile(join(root, ".harness", "knowledge", "index.json"), "{}\n");
    await writeFile(join(root, ".harness", "reports", "r.json"), "{}\n");
    await writeFile(join(root, ".harness", "state", "baseline", "manifest.json"), "{}\n");
    await writeFile(join(root, ".harness", "project.yaml"), "keep\n");

    await cleanupProject({ projectRoot: root, dryRun: false });

    expect(await readFile(join(root, ".harness", "knowledge", "index.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(root, ".harness", "reports", "r.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(root, ".harness", "state", "baseline", "manifest.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(root, ".harness", "project.yaml"), "utf8")).toBe("keep\n");
  });
});
