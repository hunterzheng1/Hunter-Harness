import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupOldTransactions,
  listTransactions,
  pendingTransactions,
  recoverTransaction,
  rollbackLatestCommittedUpdate
} from "@hunter-harness/core";

import type { CommandDependencies, ConfigureOptions } from "./configure.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function explicitConfigure(options: ConfigureOptions): boolean {
  return options.adapter !== undefined || options.profile !== undefined ||
    options.config !== undefined || options.serverUrl !== undefined ||
    options.tokenEnv !== undefined;
}

export async function runRecoveryMenuIfApplicable(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number | null> {
  const pending = await pendingTransactions(dependencies.cwd);
  if (pending.length > 0) {
    if (options.nonInteractive === true) {
      dependencies.stderr("unfinished transaction requires interactive recovery\n");
      return 5;
    }
    const answer = await dependencies.prompt([
      "Unfinished Hunter Harness transaction detected.",
      "1. Recover last failed update",
      "2. Roll back last committed update",
      "3. View transaction status",
      "4. Clean old transactions",
      "Choose [1-4]: "
    ].join("\n"));
    try {
      if (answer.trim() === "1") {
        const result = await recoverTransaction(
          dependencies.cwd,
          pending[0]?.transactionId ?? ""
        );
        dependencies.stdout("Recovery completed: " + result.status + ".\n");
        return 0;
      }
      if (answer.trim() === "2") {
        const result = await rollbackLatestCommittedUpdate(dependencies.cwd);
        dependencies.stdout("Rollback completed: " + result.status + ".\n");
        return 0;
      }
      if (answer.trim() === "3") {
        dependencies.stdout(JSON.stringify(
          await listTransactions(dependencies.cwd), null, 2
        ) + "\n");
        return 0;
      }
      if (answer.trim() === "4") {
        const removed = await cleanupOldTransactions(dependencies.cwd);
        dependencies.stdout("Cleaned " + removed.length + " old transactions.\n");
        return 0;
      }
      return 2;
    } catch (error) {
      dependencies.stderr((error instanceof Error ? error.message : String(error)) + "\n");
      return 5;
    }
  }

  const initialized = await exists(join(dependencies.cwd, ".harness", "project.yaml"));
  if (!initialized || options.nonInteractive === true || explicitConfigure(options)) {
    return null;
  }
  const answer = await dependencies.prompt([
    "Hunter Harness project menu.",
    "1. Configure project",
    "2. Roll back last update",
    "3. Clean old transactions",
    "4. View transaction status",
    "5. Exit",
    "Choose [1-5]: "
  ].join("\n"));
  try {
    if (answer.trim() === "1") {
      return null;
    }
    if (answer.trim() === "2") {
      const result = await rollbackLatestCommittedUpdate(dependencies.cwd);
      dependencies.stdout("Rollback completed: " + result.status + ".\n");
      return 0;
    }
    if (answer.trim() === "3") {
      const removed = await cleanupOldTransactions(dependencies.cwd);
      dependencies.stdout("Cleaned " + removed.length + " old transactions.\n");
      return 0;
    }
    if (answer.trim() === "4") {
      dependencies.stdout(JSON.stringify(
        await listTransactions(dependencies.cwd), null, 2
      ) + "\n");
      return 0;
    }
    return answer.trim() === "5" ? 0 : 2;
  } catch (error) {
    dependencies.stderr((error instanceof Error ? error.message : String(error)) + "\n");
    return 5;
  }
}
