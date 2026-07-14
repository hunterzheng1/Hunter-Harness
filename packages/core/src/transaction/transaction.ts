import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertNoCaseCollisions,
  assertNoSymlinks,
  assertSameVolume,
  normalizeManagedPath
} from "../fs/path-safety.js";
import { sha256Bytes, sha256File } from "../fs/hash.js";
import { atomicWriteJson } from "../state/atomic.js";
import { ensureStateLayout, stateLayout } from "../state/layout.js";
import type {
  SnapshotRecord,
  TransactionJournal,
  TransactionJournalOperation,
  TransactionOperation
} from "./journal.js";

export interface TransactionOptions {
  id?: string;
  kind?: TransactionJournal["kind"];
  failAfterApply?: number;
  interruptAfterApply?: number;
}

export interface TransactionResult {
  transactionId: string;
  status: "committed" | "rolled_back";
}

class InterruptedTransactionError extends Error {
  constructor() {
    super("transaction interrupted by failure injection");
    this.name = "InterruptedTransactionError";
  }
}

function encodePath(path: string): string {
  return Buffer.from(path).toString("base64url");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function affectedPaths(operation: TransactionOperation): string[] {
  if (operation.operation === "rename") {
    return [operation.from_path, operation.to_path];
  }
  return [operation.path];
}

async function writeJournal(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  await atomicWriteJson(join(transactionRoot, "journal.json"), journal);
  await writeStatus(transactionRoot, journal);
}

async function writeStatus(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  await atomicWriteJson(join(transactionRoot, "status.json"), {
    schema_version: 1,
    transaction_id: journal.transaction_id,
    state: journal.state,
    applied_count: journal.applied_count,
    failure: journal.failure,
    updated_at: new Date().toISOString()
  });
}

function journalOperation(
  operation: TransactionOperation
): TransactionJournalOperation {
  if (operation.operation === "rename") {
    return {
      operation: "rename",
      from_path: operation.from_path,
      to_path: operation.to_path
    };
  }
  return { operation: operation.operation, path: operation.path };
}

// design §10：提交后剪除同 kind 的更早成功事务，仅保留最新一个供回滚。
// 只读 journal.json 判定 state/kind，绝不动非 committed（interrupted/failed/recovery_required）事务。
async function pruneOlderSuccessful(
  layout: { transactions: string },
  currentId: string,
  kind: string | undefined
): Promise<void> {
  if (kind === undefined) return;
  let entries: string[];
  try {
    entries = await readdir(layout.transactions);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (name === currentId) continue;
    const txRoot = join(layout.transactions, name);
    try {
      const journal = JSON.parse(await readFile(join(txRoot, "journal.json"), "utf8")) as {
        state?: string; kind?: string;
      };
      if (journal.state === "committed" && journal.kind === kind) {
        await rm(txRoot, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
}

async function snapshotPaths(
  projectRoot: string,
  transactionRoot: string,
  paths: readonly string[]
): Promise<SnapshotRecord[]> {
  const snapshots: SnapshotRecord[] = [];
  for (const path of paths) {
    const target = join(projectRoot, path);
    const present = await exists(target);
    const snapshotName = present ? encodePath(path) : null;
    if (snapshotName !== null) {
      await copyFile(target, join(transactionRoot, "before", snapshotName));
    }
    snapshots.push({ path, existed: present, snapshot_name: snapshotName });
  }
  return snapshots;
}

async function stageOperations(
  transactionRoot: string,
  operations: readonly TransactionOperation[]
): Promise<void> {
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation?.operation === "add" || operation?.operation === "modify" ||
        operation?.operation === "rename") {
      await writeFile(join(transactionRoot, "staged", String(index)), operation.content);
    }
  }
}

async function installStaged(
  staged: string,
  target: string,
  transactionId: string
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  assertSameVolume(staged, target);
  const temporary = join(
    dirname(target),
    ".hunter-" + transactionId + "-" + randomUUID() + ".tmp"
  );
  await copyFile(staged, temporary);
  await rm(target, { force: true });
  await rename(temporary, target);
}

async function applyOperation(
  projectRoot: string,
  transactionRoot: string,
  operation: TransactionOperation,
  index: number,
  transactionId: string
): Promise<void> {
  if (operation.operation === "delete") {
    await rm(join(projectRoot, operation.path), { force: true });
    return;
  }
  if (operation.operation === "rename") {
    await rm(join(projectRoot, operation.from_path), { force: true });
    await installStaged(
      join(transactionRoot, "staged", String(index)),
      join(projectRoot, operation.to_path),
      transactionId
    );
    return;
  }
  await installStaged(
    join(transactionRoot, "staged", String(index)),
    join(projectRoot, operation.path),
    transactionId
  );
}

export async function rollbackTransaction(
  projectRoot: string,
  transactionId: string
): Promise<TransactionResult> {
  const transactionRoot = join(stateLayout(projectRoot).transactions, transactionId);
  const journal = JSON.parse(
    await readFile(join(transactionRoot, "journal.json"), "utf8")
  ) as TransactionJournal;
  if (journal.state === "committed") {
    return { transactionId, status: "committed" };
  }

  journal.state = "rolling_back";
  await writeJournal(transactionRoot, journal);
  try {
    for (const snapshot of [...journal.snapshots].reverse()) {
      const target = join(projectRoot, snapshot.path);
      await rm(target, { force: true, recursive: true });
      if (snapshot.existed && snapshot.snapshot_name !== null) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(
          join(transactionRoot, "before", snapshot.snapshot_name),
          target
        );
      }
    }
    journal.state = "rolled_back";
    await writeJournal(transactionRoot, journal);
    return { transactionId, status: "rolled_back" };
  } catch (error) {
    journal.state = "recovery_required";
    journal.failure = error instanceof Error ? error.message : String(error);
    await writeJournal(transactionRoot, journal);
    throw error;
  }
}

export async function runTransaction(
  projectRoot: string,
  rawOperations: readonly TransactionOperation[],
  options: TransactionOptions = {}
): Promise<TransactionResult> {
  const layout = await ensureStateLayout(projectRoot);
  const transactionId = options.id ?? "tx_" + Date.now() + "_" + randomUUID();
  const transactionRoot = join(layout.transactions, transactionId);
  await Promise.all([
    mkdir(join(transactionRoot, "before"), { recursive: true }),
    mkdir(join(transactionRoot, "after"), { recursive: true }),
    mkdir(join(transactionRoot, "staged"), { recursive: true })
  ]);

  const operations = rawOperations.map((operation): TransactionOperation => {
    if (operation.operation === "rename") {
      return {
        ...operation,
        from_path: normalizeManagedPath(operation.from_path),
        to_path: normalizeManagedPath(operation.to_path)
      };
    }
    return { ...operation, path: normalizeManagedPath(operation.path) };
  });
  const paths = operations.flatMap(affectedPaths);
  assertNoCaseCollisions(paths);
  for (const path of paths) {
    await assertNoSymlinks(projectRoot, path);
  }

  const snapshots = await snapshotPaths(projectRoot, transactionRoot, paths);
  await stageOperations(transactionRoot, operations);
  const journal: TransactionJournal = {
    schema_version: 2,
    transaction_id: transactionId,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    state: "prepared",
    created_at: new Date().toISOString(),
    operations: operations.map(journalOperation),
    snapshots,
    applied_count: 0,
    failure: null
  };
  await writeJournal(transactionRoot, journal);

  try {
    journal.state = "applying";
    await writeJournal(transactionRoot, journal);
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (operation === undefined) {
        continue;
      }
      await applyOperation(projectRoot, transactionRoot, operation, index, transactionId);
      journal.applied_count = index + 1;
      // Progress is a small fixed-size status write. journal.json is persisted
      // only at state transitions, so N files no longer cause N rewrites of an
      // O(N + payload) document.
      await writeStatus(transactionRoot, journal);
      if (options.interruptAfterApply === journal.applied_count) {
        journal.state = "interrupted";
        journal.failure = "injected interruption";
        await writeJournal(transactionRoot, journal);
        throw new InterruptedTransactionError();
      }
      if (options.failAfterApply === journal.applied_count) {
        throw new Error("injected transaction failure");
      }
    }

    const after = [];
    for (const path of paths) {
      const target = join(projectRoot, path);
      after.push({
        path,
        exists: await exists(target),
        hash: await exists(target) ? await sha256File(target) : null
      });
    }
    await atomicWriteJson(join(transactionRoot, "after", "manifest.json"), after);
    journal.state = "committed";
    await writeJournal(transactionRoot, journal);
  } catch (error) {
    if (error instanceof InterruptedTransactionError) {
      throw error;
    }
    journal.failure = error instanceof Error ? error.message : String(error);
    await writeJournal(transactionRoot, journal);
    await rollbackTransaction(projectRoot, transactionId);
    throw error;
  }
  // design §10：成功提交后立即删 staged/（保留 before/after/journal/status 供回滚），
  // 并按 kind 保留最新成功事务，剪除更早的同 kind committed 事务。
  await rm(join(transactionRoot, "staged"), { recursive: true, force: true });
  await pruneOlderSuccessful(layout, transactionId, options.kind);
  return { transactionId, status: "committed" };
}

export async function verifyStagedContent(
  content: string | Uint8Array,
  expectedSha256: string
): Promise<void> {
  if (sha256Bytes(content) !== expectedSha256) {
    throw new Error("staged content hash mismatch");
  }
}
