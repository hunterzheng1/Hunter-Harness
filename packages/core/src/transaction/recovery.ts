import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { stateLayout } from "../state/layout.js";
import { sha256File } from "../fs/hash.js";
import { uuidV7 } from "../project/uuid-v7.js";
import type { TransactionJournal } from "./journal.js";
import {
  rollbackTransaction,
  runTransaction,
  type TransactionResult
} from "./transaction.js";

export async function recoverTransaction(
  projectRoot: string,
  transactionId: string
): Promise<TransactionResult> {
  const journal = JSON.parse(await readFile(
    join(stateLayout(projectRoot).transactions, transactionId, "journal.json"),
    "utf8"
  )) as TransactionJournal;
  if (journal.state === "committed") {
    return { transactionId, status: "committed" };
  }
  return rollbackTransaction(projectRoot, transactionId);
}

export interface TransactionSummary {
  transactionId: string;
  kind: TransactionJournal["kind"];
  state: TransactionJournal["state"];
  createdAt: string;
}

const RECOVERY_STATES = new Set<TransactionJournal["state"]>([
  "prepared",
  "applying",
  "interrupted",
  "rolling_back",
  "recovery_required"
]);

export async function listTransactions(projectRoot: string): Promise<TransactionSummary[]> {
  const root = stateLayout(projectRoot).transactions;
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const transactions: TransactionSummary[] = [];
  for (const transactionId of names) {
    try {
      const journal = JSON.parse(await readFile(
        join(root, transactionId, "journal.json"), "utf8"
      )) as TransactionJournal;
      transactions.push({
        transactionId,
        kind: journal.kind,
        state: journal.state,
        createdAt: journal.created_at
      });
    } catch {
      // Ignore non-transaction entries; state validation reports malformed journals separately.
    }
  }
  return transactions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function pendingTransactions(
  projectRoot: string
): Promise<TransactionSummary[]> {
  return (await listTransactions(projectRoot)).filter((item) =>
    RECOVERY_STATES.has(item.state)
  );
}

async function pathExists(path: string): Promise<boolean> {
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

export async function rollbackLatestCommittedUpdate(
  projectRoot: string
): Promise<TransactionResult> {
  const latest = (await listTransactions(projectRoot)).find((item) =>
    item.kind === "update" && item.state === "committed"
  );
  if (latest === undefined) {
    throw new Error("no committed update transaction is available for rollback");
  }
  const transactionRoot = join(
    stateLayout(projectRoot).transactions,
    latest.transactionId
  );
  const journal = JSON.parse(await readFile(
    join(transactionRoot, "journal.json"), "utf8"
  )) as TransactionJournal;
  const after = JSON.parse(await readFile(
    join(transactionRoot, "after", "manifest.json"), "utf8"
  )) as Array<{ path: string; exists: boolean; hash: string | null }>;
  for (const entry of after) {
    const target = join(projectRoot, entry.path);
    const exists = await pathExists(target);
    if (exists !== entry.exists || (exists && await sha256File(target) !== entry.hash)) {
      throw new Error("cannot rollback dirty path: " + entry.path);
    }
  }

  const operations = [];
  const seen = new Set<string>();
  for (const snapshot of journal.snapshots) {
    if (seen.has(snapshot.path)) {
      continue;
    }
    seen.add(snapshot.path);
    const target = join(projectRoot, snapshot.path);
    const exists = await pathExists(target);
    if (snapshot.existed && snapshot.snapshot_name !== null) {
      const content = await readFile(join(
        transactionRoot, "before", snapshot.snapshot_name
      ));
      operations.push({
        operation: exists ? "modify" as const : "add" as const,
        path: snapshot.path,
        content
      });
    } else if (exists) {
      operations.push({ operation: "delete" as const, path: snapshot.path });
    }
  }
  return runTransaction(projectRoot, operations, {
    id: "tx_rollback_" + Date.now() + "_" + uuidV7(),
    kind: "rollback"
  });
}

export async function cleanupOldTransactions(
  projectRoot: string,
  now = new Date()
): Promise<string[]> {
  const transactions = await listTransactions(projectRoot);
  const committedUpdates = transactions.filter((item) =>
    item.kind === "update" && item.state === "committed"
  );
  const keepCommitted = new Set(committedUpdates.slice(0, 10).map(
    (item) => item.transactionId
  ));
  const removed: string[] = [];
  for (const item of transactions) {
    if (RECOVERY_STATES.has(item.state) || keepCommitted.has(item.transactionId)) {
      continue;
    }
    const ageDays = (now.getTime() - Date.parse(item.createdAt)) / 86_400_000;
    const removable = item.state === "rolled_back"
      ? ageDays > 7
      : item.state === "committed" && ageDays > 30;
    if (!removable) {
      continue;
    }
    await rm(join(stateLayout(projectRoot).transactions, item.transactionId), {
      recursive: true,
      force: true
    });
    removed.push(item.transactionId);
  }
  return removed;
}
