import {
  cleanupOldTransactions,
  clearLocalCredentials,
  listTransactions,
  readInstalledAgentConfiguration,
  readLocalCredentials,
  rollbackLatestCommittedUpdate
} from "@hunter-harness/core";
import type { HarnessAgent } from "@hunter-harness/contracts";

import { agentLabel, formatAgentLine } from "../ui/labels.js";
import { runConnect } from "./connect.js";
import type { CommandDependencies, ConfigureOptions } from "./configure.js";
import { runRefresh } from "./refresh.js";

function banner(lines: string[]): string {
  const width = Math.max(...lines.map((line) => [...line].length), 24);
  const bar = "─".repeat(width + 2);
  return [
    `┌${bar}┐`,
    ...lines.map((line) => {
      const pad = width - [...line].length;
      return `│ ${line}${" ".repeat(Math.max(0, pad))} │`;
    }),
    `└${bar}┘`
  ].join("\n");
}

async function platformStatusLine(cwd: string): Promise<string> {
  const creds = await readLocalCredentials(cwd);
  if (creds?.server_url && creds.token) {
    const project = creds.project_id === undefined ? "" : ` · 项目 ${creds.project_id}`;
    return `平台：已连接 ${creds.server_url}${project}`;
  }
  return "平台：未绑定（可选，用于推送 / 知识库 / 运行监控）";
}

async function toolsStatusLines(cwd: string): Promise<string[]> {
  const installed = await readInstalledAgentConfiguration(cwd);
  const agents = installed.agents.length > 0 ? installed.agents : [];
  if (agents.length === 0) return ["工具：尚未安装"];
  return [
    "工具：",
    ...agents.map((agent) => `  · ${formatAgentLine(agent, installed.profiles[agent])}`)
  ];
}

export async function runPlatformConnectionMenu(
  options: ConfigureOptions,
  dependencies: CommandDependencies,
  defaultAction: "bind" | "skip" = "bind"
): Promise<number> {
  const creds = await readLocalCredentials(dependencies.cwd);
  if (creds?.server_url && creds.token) {
    dependencies.stdout(
      `当前平台连接：\n` +
      `  地址：${creds.server_url}\n` +
      `  项目：${creds.project_id ?? "（未写入 project_id）"}\n` +
      `  密钥：已保存（本地凭据文件，不会再次显示明文）\n\n`
    );
    const answer = (await dependencies.prompt([
      "平台连接",
      "  1. 重新绑定（输入新地址与密钥）",
      "  2. 清除本地凭据",
      "  0. 返回",
      "请选择："
    ].join("\n"))).trim();
    if (answer === "0" || answer === "") return 0;
    if (answer === "2") {
      const confirm = (await dependencies.prompt("确认清除本地平台凭据？[y/N]：")).trim();
      if (!/^(?:y|yes)$/i.test(confirm)) {
        dependencies.stdout("已取消。\n");
        return 0;
      }
      const removed = await clearLocalCredentials(dependencies.cwd);
      dependencies.stdout(removed ? "已清除本地凭据。\n" : "本地没有凭据文件。\n");
      return 0;
    }
    if (answer !== "1") return 2;
  } else {
    const choice = (await dependencies.prompt(
      (defaultAction === "skip"
        ? "是否关联 Hunter Platform 项目？（可跳过，稍后再次运行 npx hunter-harness 配置）\n"
        : "尚未绑定平台。现在配置？（可稍后再次运行 npx hunter-harness 配置）\n") +
      "  1. 立即绑定\n" +
      "  0. 跳过\n" +
      `请选择 [${defaultAction === "skip" ? "0" : "1"}]：`
    )).trim();
    if (choice === "0" || /^n/i.test(choice) ||
        (choice === "" && defaultAction === "skip")) {
      dependencies.stdout("已跳过平台绑定。\n");
      return 0;
    }
    if (choice !== "" && choice !== "1") return 2;
  }

  const url = (await dependencies.prompt(
    "平台地址（远端使用 https://...；本机可用 http://127.0.0.1:端口）："
  )).trim();
  if (url === "") {
    dependencies.stdout("已取消（未输入地址）。\n");
    return 0;
  }
  return runConnect(url, {
    ...(options.json === undefined ? {} : { json: options.json }),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.yes === undefined ? {} : { yes: options.yes })
  }, dependencies);
}

async function runRemoveAgentsFlow(
  dependencies: CommandDependencies,
  options: ConfigureOptions
): Promise<number> {
  const installed = await readInstalledAgentConfiguration(dependencies.cwd);
  const current = installed.agents.length > 0 ? installed.agents : ["claude-code" as const];
  if (current.length <= 1) {
    dependencies.stderr("当前只安装了一个工具，无法再移除（至少保留一个）。\n");
    return 2;
  }
  const lines = current.map((agent, index) =>
    `  ${index + 1}. ${formatAgentLine(agent, installed.profiles[agent])}`
  ).join("\n");
  const answer = (await dependencies.prompt(
    `请选择要移除的工具（可多选，逗号分隔）：\n${lines}\n请输入编号，或 0 取消：`
  )).trim();
  if (answer === "" || answer === "0") return 0;
  const indexes = answer.split(/[,\s]+/).map((part) => Number(part.trim()));
  if (indexes.some((value) => !Number.isInteger(value) || value < 1 || value > current.length)) {
    dependencies.stderr("编号无效。\n");
    return 2;
  }
  const toRemove = indexes.map((index) => current[index - 1]).filter(
    (agent): agent is HarnessAgent => agent !== undefined
  );
  const remaining = current.filter((agent) => !toRemove.includes(agent));
  if (remaining.length === 0) {
    dependencies.stderr("不能移除全部工具。\n");
    return 2;
  }
  const confirm = (await dependencies.prompt(
    `将移除：${toRemove.map((agent) => agentLabel(agent)).join("、")}\n` +
    `保留：${remaining.map((agent) => agentLabel(agent)).join("、")}\n` +
    "未改动的受管文件若有本地修改会保留并提示冲突。确认？[y/N]："
  )).trim();
  if (!/^(?:y|yes)$/i.test(confirm)) {
    dependencies.stdout("已取消。\n");
    return 0;
  }
  return runRefresh({
    agents: remaining.join(","),
    removeAgents: toRemove.join(","),
    confirmed: true,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.json === undefined ? {} : { json: options.json }),
    ...(options.forceManaged === undefined ? {} : { forceManaged: options.forceManaged }),
    ...(options.recoveryRoot === undefined ? {} : { recoveryRoot: options.recoveryRoot })
  }, dependencies);
}

async function runManageToolsMenu(
  options: ConfigureOptions,
  dependencies: CommandDependencies,
  currentProfile: "general" | "java",
  currentSurface: "both" | "ide" | "cli"
): Promise<number> {
  const answer = (await dependencies.prompt([
    "管理工具",
    "  1. 新增或刷新指定工具（可改「通用」或「Java」配置）",
    "  2. 移除一个或多个工具",
    "  0. 返回",
    "请选择："
  ].join("\n"))).trim();
  if (answer === "0" || answer === "") return 0;
  if (answer === "2") return runRemoveAgentsFlow(dependencies, options);
  if (answer !== "1") return 2;
  // Lazy import avoids a circular load with configure.ts.
  const { runConfigureAgentsFlow } = await import("./configure.js");
  return runConfigureAgentsFlow(options, dependencies, currentProfile, currentSurface);
}

async function runTransactionMenu(
  dependencies: CommandDependencies
): Promise<number> {
  const answer = (await dependencies.prompt([
    "事务与恢复",
    "  1. 回滚最近一次更新",
    "  2. 清理旧事务",
    "  3. 查看事务状态",
    "  0. 返回",
    "请选择："
  ].join("\n"))).trim();
  try {
    if (answer === "0" || answer === "") return 0;
    if (answer === "1") {
      const result = await rollbackLatestCommittedUpdate(dependencies.cwd);
      dependencies.stdout(`回滚完成：${result.status}。\n`);
      return 0;
    }
    if (answer === "2") {
      const removed = await cleanupOldTransactions(dependencies.cwd);
      dependencies.stdout(`已清理 ${removed.length} 个旧事务。\n`);
      return 0;
    }
    if (answer === "3") {
      dependencies.stdout(JSON.stringify(await listTransactions(dependencies.cwd), null, 2) + "\n");
      return 0;
    }
    return 2;
  } catch (error) {
    dependencies.stderr((error instanceof Error ? error.message : String(error)) + "\n");
    return 5;
  }
}

/**
 * Interactive home for an already-initialized project.
 * Returns an exit code (including after configure/refresh), never null.
 */
export async function runInitializedProjectMenu(
  options: ConfigureOptions,
  dependencies: CommandDependencies,
  currentProfile: "general" | "java",
  currentSurface: "both" | "ide" | "cli"
): Promise<number> {
  if (options.nonInteractive === true) {
    const { runConfigureAgentsFlow } = await import("./configure.js");
    return runConfigureAgentsFlow(options, dependencies, currentProfile, currentSurface);
  }

  const installed = await readInstalledAgentConfiguration(dependencies.cwd);
  const currentAgents = installed.agents.length > 0
    ? installed.agents
    : (["claude-code"] as HarnessAgent[]);
  const projectName = dependencies.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? dependencies.cwd;
  const statusLines = [
    `Hunter Harness · ${projectName}`,
    await platformStatusLine(dependencies.cwd),
    ...await toolsStatusLines(dependencies.cwd)
  ];
  dependencies.stdout(banner(statusLines) + "\n\n");

  const answer = (await dependencies.prompt([
    "请选择操作：",
    "  1. 一键刷新已安装工具（不重选工具与配置）",
    "  2. 管理工具（新增 / 换配置 / 移除）",
    "  3. 平台连接（绑定或修改地址与密钥）",
    "  4. 事务与恢复",
    "  0. 退出",
    "请选择 [1]："
  ].join("\n"))).trim();

  const choice = answer === "" ? "1" : answer;
  if (choice === "0") return 0;
  if (choice === "1") {
    dependencies.stdout(
      `正在按现有配置刷新：${currentAgents.map((agent) =>
        formatAgentLine(agent, installed.profiles[agent] ?? currentProfile)
      ).join("、")}…\n`
    );
    return runRefresh({
      agents: currentAgents.join(","),
      confirmed: true,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      ...(options.json === undefined ? {} : { json: options.json }),
      ...(options.forceManaged === undefined ? {} : { forceManaged: options.forceManaged }),
      ...(options.recoveryRoot === undefined ? {} : { recoveryRoot: options.recoveryRoot })
    }, dependencies);
  }
  if (choice === "2") {
    return runManageToolsMenu(options, dependencies, currentProfile, currentSurface);
  }
  if (choice === "3") {
    return runPlatformConnectionMenu(options, dependencies);
  }
  if (choice === "4") {
    return runTransactionMenu(dependencies);
  }
  dependencies.stderr("无效选项。\n");
  return 2;
}
