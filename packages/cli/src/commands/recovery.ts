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
  return options.agents !== undefined || options.adapter !== undefined ||
    options.profile !== undefined ||
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
      dependencies.stderr("存在未完成事务，需要以交互模式恢复。\n");
      return 5;
    }
    const answer = await dependencies.prompt([
      "检测到未完成的 Hunter Harness 事务。",
      "1. 恢复最近一次失败的更新",
      "2. 回滚最近一次已提交的更新",
      "3. 查看事务状态",
      "4. 清理旧事务",
      "请选择 [1-4]："
    ].join("\n"));
    try {
      if (answer.trim() === "1") {
        const result = await recoverTransaction(
          dependencies.cwd,
          pending[0]?.transactionId ?? ""
        );
        dependencies.stdout("恢复完成：" + result.status + "。\n");
        return 0;
      }
      if (answer.trim() === "2") {
        const result = await rollbackLatestCommittedUpdate(dependencies.cwd);
        dependencies.stdout("回滚完成：" + result.status + "。\n");
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
        dependencies.stdout("已清理 " + removed.length + " 个旧事务。\n");
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
    "Hunter Harness 项目菜单。",
    "1. 配置项目",
    "2. 回滚最近一次更新",
    "3. 清理旧事务",
    "4. 查看事务状态",
    "5. 退出",
    "请选择 [1-5]："
  ].join("\n"));
  try {
    if (answer.trim() === "1") {
      return null;
    }
    if (answer.trim() === "2") {
      const result = await rollbackLatestCommittedUpdate(dependencies.cwd);
      dependencies.stdout("回滚完成：" + result.status + "。\n");
      return 0;
    }
    if (answer.trim() === "3") {
      const removed = await cleanupOldTransactions(dependencies.cwd);
      dependencies.stdout("已清理 " + removed.length + " 个旧事务。\n");
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
