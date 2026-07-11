import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { stateLayout } from "./layout.js";

// design §10：cleanup 默认清理已完成事务（保留每 kind 最新一个供回滚）+ 可重建的 server-artifacts 缓存。
// 永不触碰 Knowledge、reports、baseline、project 配置、active locks、未完成事务。
// 仅在 .harness/state/transactions 与 .harness/cache/server-artifacts 两个根下操作。

export interface CleanupOptions {
  projectRoot: string;
  dryRun: boolean;
}

export interface CleanupResult {
  dry_run: boolean;
  pruned_transactions: string[];
  removed_cache: string[];
}

function isSafeEntryName(name: string): boolean {
  return name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".." &&
    !name.includes("\0");
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function cleanupProject(options: CleanupOptions): Promise<CleanupResult> {
  const layout = stateLayout(options.projectRoot);
  const pruned: string[] = [];
  const removedCache: string[] = [];

  // 1. 事务：每 kind 仅保留最新 committed（供回滚），剪除更早的 committed；保留所有非 committed 事务。
  const committedByKind = new Map<string, Array<{ id: string; createdAt: string }>>();
  for (const name of await listDir(layout.transactions)) {
    if (!isSafeEntryName(name)) continue;
    let journal: { state?: unknown; kind?: unknown; created_at?: unknown };
    try {
      journal = JSON.parse(await readFile(join(layout.transactions, name, "journal.json"), "utf8")) as {
        state?: unknown; kind?: unknown; created_at?: unknown;
      };
    } catch {
      continue;
    }
    if (journal.state === "committed" && typeof journal.kind === "string") {
      const arr = committedByKind.get(journal.kind) ?? [];
      arr.push({ id: name, createdAt: typeof journal.created_at === "string" ? journal.created_at : "" });
      committedByKind.set(journal.kind, arr);
    }
  }
  for (const arr of committedByKind.values()) {
    arr.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (let index = 1; index < arr.length; index += 1) {
      const entry = arr[index];
      if (entry === undefined) continue;
      pruned.push(entry.id);
      if (!options.dryRun) {
        await rm(join(layout.transactions, entry.id), { recursive: true, force: true });
      }
    }
  }

  // 2. server-artifacts 缓存：可重建，清理 obsolete 条目。
  for (const name of await listDir(layout.serverArtifacts)) {
    if (!isSafeEntryName(name)) continue;
    removedCache.push(name);
    if (!options.dryRun) {
      await rm(join(layout.serverArtifacts, name), { recursive: true, force: true });
    }
  }

  return {
    dry_run: options.dryRun,
    pruned_transactions: pruned.sort(),
    removed_cache: removedCache.sort()
  };
}
