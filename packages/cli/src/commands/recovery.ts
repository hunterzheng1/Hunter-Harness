import {
  cleanupOldTransactions,
  inspectTransaction,
  listTransactions,
  pendingTransactions,
  recoverTransaction,
  resumeTransaction,
  rollbackCommittedUpdate,
  rollbackLatestCommittedUpdate
} from "@hunter-harness/core";

import type { CommandDependencies, ConfigureOptions } from "./configure.js";
import { detectProject } from "./refresh.js";

export interface RecoveryStatusOptions {
  json?: boolean;
}

export interface RecoveryCommandOptions {
  action?: "inspect" | "resume" | "rollback";
  nonInteractive?: boolean;
  yes?: boolean;
  json?: boolean;
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
      await runRecoveryStatus({ json: options.json === true }, dependencies);
      return 5;
    }
    const answer = await dependencies.prompt([
      "检测到未完成的 Hunter Harness 事务。",
      "1. 从已校验的暂存内容继续最近一次失败的更新",
      "2. 回滚最近一次已提交的更新",
      "3. 查看事务状态",
      "4. 清理旧事务",
      "请选择 [1-4]："
    ].join("\n"));
    try {
      if (answer.trim() === "1") {
        const result = await resumeTransaction(
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

  const detection = await detectProject(dependencies.cwd);
  if (detection.status !== "valid" || options.nonInteractive === true ||
      explicitConfigure(options)) {
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
    if (answer.trim() === "1") return null;
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
    dependencies.stderr(
      (error instanceof Error ? error.message : String(error)) + "\n"
    );
    return 5;
  }
}

export async function runRecoveryStatus(
  options: RecoveryStatusOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const [pending, projectState] = await Promise.all([
    pendingTransactions(dependencies.cwd),
    detectProject(dependencies.cwd)
  ]);
  const projectRequiresRecovery = projectState.status === "partial" ||
    projectState.status === "recovery-required";
  const mutationState = pending.some(
    (item) => item.mutationState === "APPLIED_PARTIAL"
  )
    ? "APPLIED_PARTIAL"
    : "NOT_STARTED";
  const output = {
    status: pending.length > 0 || projectRequiresRecovery ? "RECOVERY_REQUIRED" : "OK",
    reasonCode: pending.length > 0
      ? "LOCAL_HARNESS_RECOVERY_REQUIRED"
      : projectRequiresRecovery
        ? projectState.reasonCode
        : "NO_PENDING_RECOVERY",
    mutationState,
    pending,
    projectState: {
      status: projectState.status,
      reasonCode: "reasonCode" in projectState
        ? projectState.reasonCode
        : null,
      sentinels: "sentinels" in projectState
        ? projectState.sentinels
        : []
    },
    recommendedAction: pending.length > 0
      ? "resume"
      : projectRequiresRecovery
        ? "inspect"
      : null
  };
  dependencies.stdout(options.json === true
    ? JSON.stringify(output) + "\n"
    : pending.length > 0
      ? `存在 ${pending.length} 个待恢复事务；运行 hunter-harness recover <recoveryId>。\n`
      : "没有待恢复事务。\n");
  return 0;
}

export async function runRecoveryCommand(
  recoveryId: string | undefined,
  options: RecoveryCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const pending = await pendingTransactions(dependencies.cwd);
  const selectedId = recoveryId ?? pending[0]?.recoveryId;
  if (selectedId === undefined || selectedId.length === 0) {
    dependencies.stderr("RECOVERY_NOT_FOUND：没有可恢复事务\n");
    return 5;
  }
  try {
    const inspection = await inspectTransaction(dependencies.cwd, selectedId);
    const action = options.action ?? "inspect";
    if (!["inspect", "resume", "rollback"].includes(action)) {
      dependencies.stderr("RECOVERY_ACTION_INVALID：仅支持 inspect、resume、rollback\n");
      return 2;
    }
    if (action === "inspect") {
      dependencies.stdout(options.json === true
        ? JSON.stringify(inspection) + "\n"
        : `${inspection.status}：${inspection.recoveryId}，建议 ${inspection.recommendedAction ?? "inspect"}。\n`);
      return 0;
    }
    if (options.nonInteractive === true && options.yes !== true) {
      dependencies.stderr("RECOVERY_CONFIRMATION_REQUIRED：非交互恢复操作需要 --yes\n");
      return 2;
    }
    if (options.nonInteractive !== true && options.yes !== true) {
      const answer = await dependencies.prompt(
        `${action === "resume" ? "继续" : "回滚"}恢复事务 ${inspection.recoveryId}？[y/N]：`
      );
      if (!/^(?:y|yes)$/i.test(answer.trim())) return 2;
    }
    if (action === "resume") {
      const result = await resumeTransaction(
        dependencies.cwd,
        inspection.transactionId
      );
      const output = {
        status: "COMMITTED",
        reasonCode: "TRANSACTION_RESUMED",
        recoveryId: result.recoveryId,
        transactionId: result.transactionId,
        mutationState: "COMMITTED",
        planHash: result.planHash
      };
      dependencies.stdout(options.json === true
        ? JSON.stringify(output) + "\n"
        : "恢复完成：COMMITTED。\n");
      return 0;
    }
    const rollingBackCommitted = inspection.status === "COMMITTED";
    const result = rollingBackCommitted
      ? await rollbackCommittedUpdate(
          dependencies.cwd,
          inspection.transactionId
        )
      : await recoverTransaction(
          dependencies.cwd,
          inspection.transactionId
        );
    const rolledBack = rollingBackCommitted || result.status === "rolled_back";
    const output = {
      status: rolledBack ? "ROLLED_BACK" : "COMMITTED",
      reasonCode: rolledBack
        ? "TRANSACTION_ROLLED_BACK"
        : "TRANSACTION_ALREADY_COMMITTED",
      recoveryId: result.recoveryId,
      transactionId: result.transactionId,
      mutationState: rolledBack ? "ROLLED_BACK" : "COMMITTED",
      planHash: result.planHash
    };
    dependencies.stdout(options.json === true
      ? JSON.stringify(output) + "\n"
      : `恢复完成：${output.status}。\n`);
    return 0;
  } catch (error) {
    dependencies.stderr(
      (error instanceof Error ? error.message : String(error)) + "\n"
    );
    return 5;
  }
}
