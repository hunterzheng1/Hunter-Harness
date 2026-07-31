import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { stateLayout } from "../state/layout.js";
import { sha256Bytes, sha256File } from "../fs/hash.js";
import { collectProtectedLocalRootsInventory } from "../project/local-state.js";
import { uuidV7 } from "../project/uuid-v7.js";
import type { TransactionJournal } from "./journal.js";
import {
  externalRecoveryTransactionNames,
  recoveryJournalRoot,
  restoreRecoveryTransaction
} from "./recovery-store.js";
import {
  assertTransactionJournalIntegrity,
  rollbackTransaction,
  runTransaction,
  type TransactionResult
} from "./transaction.js";

export async function recoverTransaction(
  projectRoot: string,
  transactionId: string
): Promise<TransactionResult> {
  const transactionRoot = await restoreRecoveryTransaction(
    projectRoot,
    transactionId
  );
  const journal = JSON.parse(await readFile(
    join(transactionRoot, "journal.json"),
    "utf8"
  )) as TransactionJournal;
  if (journal.state === "committed") {
    const current = await collectProtectedLocalRootsInventory(projectRoot);
    return {
      transactionId,
      recoveryId: journal.recovery_id ?? transactionId,
      planHash: journal.plan_hash ?? sha256Bytes(JSON.stringify(journal.operations)),
      status: "committed",
      protectedLocalRoots: journal.protected_local_roots ?? {
        before: current,
        after: current,
        unchanged: true
      }
    };
  }
  return rollbackTransaction(projectRoot, transactionId);
}

export interface TransactionSummary {
  transactionId: string;
  recoveryId: string;
  kind: TransactionJournal["kind"];
  state: TransactionJournal["state"];
  createdAt: string;
  mutationState: RecoveryMutationState;
  appliedCount: number;
  planHash: string | null;
  failureReasonCode: string | null;
}

export type RecoveryMutationState =
  | "NOT_STARTED"
  | "APPLIED_PARTIAL"
  | "COMMITTED"
  | "ROLLED_BACK";

function mutationState(
  state: TransactionJournal["state"],
  appliedCount: number
): RecoveryMutationState {
  if (state === "committed") return "COMMITTED";
  if (state === "rolled_back") return "ROLLED_BACK";
  return appliedCount > 0 ? "APPLIED_PARTIAL" : "NOT_STARTED";
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
  let localNames: string[];
  try {
    localNames = await readdir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      localNames = [];
    } else {
      throw error;
    }
  }
  const names = [...new Set([
    ...localNames,
    ...await externalRecoveryTransactionNames(projectRoot)
  ])];
  const transactions: TransactionSummary[] = [];
  for (const transactionId of names) {
    try {
      const transactionRoot = await recoveryJournalRoot(
        projectRoot,
        transactionId
      );
      const journal = JSON.parse(await readFile(
        join(transactionRoot, "journal.json"), "utf8"
      )) as TransactionJournal;
      let statusAppliedCount = journal.applied_count;
      try {
        const status = JSON.parse(await readFile(
          join(transactionRoot, "status.json"),
          "utf8"
        )) as { applied_count?: number };
        statusAppliedCount = Math.max(
          statusAppliedCount,
          Number(status.applied_count ?? 0)
        );
      } catch {
        // Legacy transactions may not have a status projection.
      }
      transactions.push({
        transactionId,
        recoveryId: journal.recovery_id ?? transactionId,
        kind: journal.kind,
        state: journal.state,
        createdAt: journal.created_at,
        mutationState: mutationState(journal.state, statusAppliedCount),
        appliedCount: statusAppliedCount,
        planHash: journal.plan_hash ?? null,
        failureReasonCode: journal.failure_reason_code ?? null
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

export interface RecoveryInspection {
  status: "RECOVERY_REQUIRED" | "COMMITTED" | "ROLLED_BACK";
  reasonCode: string;
  recoveryId: string;
  transactionId: string;
  mutationState: RecoveryMutationState;
  planHash: string | null;
  kind: TransactionJournal["kind"];
  failureReasonCode: string | null;
  safeActions: string[];
  recommendedAction: "resume" | "rollback" | "inspect" | null;
  resumeCommand: string | null;
}

export async function inspectTransaction(
  projectRoot: string,
  transactionId: string
): Promise<RecoveryInspection> {
  const summary = (await listTransactions(projectRoot)).find(
    (item) => item.transactionId === transactionId ||
      item.recoveryId === transactionId
  );
  if (summary === undefined) {
    throw new Error("recovery transaction not found: " + transactionId);
  }
  const pending = RECOVERY_STATES.has(summary.state);
  const status = pending
    ? "RECOVERY_REQUIRED"
    : summary.state === "rolled_back"
      ? "ROLLED_BACK"
      : "COMMITTED";
  const recommendedAction = pending ? "resume" : null;
  return {
    status,
    reasonCode: pending
      ? summary.failureReasonCode ?? "TRANSACTION_RECOVERY_REQUIRED"
      : summary.state === "rolled_back"
        ? "TRANSACTION_ROLLED_BACK"
        : "TRANSACTION_COMMITTED",
    recoveryId: summary.recoveryId,
    transactionId: summary.transactionId,
    mutationState: summary.mutationState,
    planHash: summary.planHash,
    kind: summary.kind,
    failureReasonCode: summary.failureReasonCode,
    safeActions: pending
      ? ["inspect", "resume", "rollback"]
      : summary.state === "committed" && summary.kind === "update"
        ? ["inspect", "rollback"]
        : ["inspect"],
    recommendedAction,
    resumeCommand: pending
      ? `hunter-harness resume ${summary.recoveryId} --action ${recommendedAction ?? "inspect"} --json`
      : null
  };
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

export async function rollbackCommittedUpdate(
  projectRoot: string,
  transactionId: string
): Promise<TransactionResult> {
  const selected = (await listTransactions(projectRoot)).find((item) =>
    (item.transactionId === transactionId || item.recoveryId === transactionId) &&
    item.kind === "update" &&
    item.state === "committed"
  );
  if (selected === undefined) {
    throw new Error(
      "committed update transaction is not available for rollback: " + transactionId
    );
  }
  const transactionRoot = await recoveryJournalRoot(
    projectRoot,
    selected.transactionId
  );
  const journal = JSON.parse(await readFile(
    join(transactionRoot, "journal.json"), "utf8"
  )) as TransactionJournal;
  await assertTransactionJournalIntegrity(transactionRoot, journal);
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

export async function rollbackLatestCommittedUpdate(
  projectRoot: string
): Promise<TransactionResult> {
  const latest = (await listTransactions(projectRoot)).find((item) =>
    item.kind === "update" && item.state === "committed"
  );
  if (latest === undefined) {
    throw new Error("no committed update transaction is available for rollback");
  }
  return rollbackCommittedUpdate(projectRoot, latest.transactionId);
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
