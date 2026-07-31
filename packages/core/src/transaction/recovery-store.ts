import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { sha256Bytes } from "../fs/hash.js";
import { stateLayout } from "../state/layout.js";

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

async function validJournal(root: string, transactionId: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(join(root, "journal.json"), "utf8")
    ) as { transaction_id?: unknown; state?: unknown };
    return parsed !== null && typeof parsed === "object" &&
      parsed.transaction_id === transactionId &&
      typeof parsed.state === "string";
  } catch {
    return false;
  }
}

export function externalRecoveryTransactionsRoot(projectRoot: string): string {
  const configured = process.env.HUNTER_HARNESS_RECOVERY_ROOT?.trim();
  const base = configured === undefined || configured === ""
    ? join(homedir(), ".hunter-harness", "recovery")
    : resolve(configured);
  const projectKey = sha256Bytes(resolve(projectRoot)).replace("sha256:", "");
  return join(base, projectKey, "transactions");
}

export function externalRecoveryTransactionRoot(
  projectRoot: string,
  transactionId: string
): string {
  return join(externalRecoveryTransactionsRoot(projectRoot), transactionId);
}

export async function mirrorRecoveryTransaction(
  transactionRoot: string,
  recoveryRoot: string
): Promise<void> {
  await mkdir(dirname(recoveryRoot), { recursive: true });
  const token = randomUUID();
  const temporary = recoveryRoot + ".tmp-" + token;
  const previous = recoveryRoot + ".previous-" + token;
  await cp(transactionRoot, temporary, { recursive: true, force: true });
  const hadPrevious = await exists(recoveryRoot);
  if (hadPrevious) await rename(recoveryRoot, previous);
  try {
    await rename(temporary, recoveryRoot);
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (hadPrevious && !await exists(recoveryRoot)) {
      await rename(previous, recoveryRoot);
    }
    throw error;
  }
}

export async function removeRecoveryMirror(recoveryRoot: string): Promise<void> {
  await rm(recoveryRoot, { recursive: true, force: true });
}

export async function restoreRecoveryTransaction(
  projectRoot: string,
  transactionId: string
): Promise<string> {
  const local = join(stateLayout(projectRoot).transactions, transactionId);
  if (await validJournal(local, transactionId)) return local;
  const external = externalRecoveryTransactionRoot(projectRoot, transactionId);
  if (!await validJournal(external, transactionId)) {
    if (await exists(join(local, "journal.json")) ||
        await exists(join(external, "journal.json"))) {
      throw new Error("RECOVERY_JOURNAL_CORRUPT: " + transactionId);
    }
    throw new Error("RECOVERY_NOT_FOUND: " + transactionId);
  }
  await mkdir(dirname(local), { recursive: true });
  await mirrorRecoveryTransaction(external, local);
  return local;
}

export async function externalRecoveryTransactionNames(
  projectRoot: string
): Promise<string[]> {
  try {
    return await readdir(externalRecoveryTransactionsRoot(projectRoot));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function recoveryJournalRoot(
  projectRoot: string,
  transactionId: string
): Promise<string> {
  const local = join(stateLayout(projectRoot).transactions, transactionId);
  if (await validJournal(local, transactionId)) return local;
  const external = externalRecoveryTransactionRoot(projectRoot, transactionId);
  if (await validJournal(external, transactionId)) return external;
  throw new Error("RECOVERY_JOURNAL_CORRUPT: " + transactionId);
}
