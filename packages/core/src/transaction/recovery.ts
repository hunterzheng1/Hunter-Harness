import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { stateLayout } from "../state/layout.js";
import type { TransactionJournal } from "./journal.js";
import {
  rollbackTransaction,
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
