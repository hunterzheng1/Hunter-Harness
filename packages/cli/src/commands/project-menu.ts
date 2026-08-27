import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupOldTransactions,
  clearLocalCredentials,
  listTransactions,
  readInstalledAgentConfiguration,
  readLocalCredentials,
  rollbackLatestCommittedUpdate
} from "@hunter-harness/core";
import type { HarnessAgent } from "@hunter-harness/contracts";

import { readLastServerUrl } from "../config/last-server.js";
import { agentLabel, formatAgentLine } from "../ui/labels.js";
import { sanitizeTerminalText } from "../ui/terminal.js";
import { runConnect } from "./connect.js";
import { runArchiveUpload } from "./archive-upload.js";
import type { CommandDependencies, ConfigureOptions } from "./configure.js";
import { runRefresh } from "./refresh.js";
import { readCliVersion } from "../version.js";
import {
  formatWorkflowVersionLine,
  readWorkflowFamilyManifest
} from "../workflow-data/resolve.js";

const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

interface PendingArchive {
  changeKey: string;
  packagePath: string;
  receiptPath: string;
}

async function listPendingArchives(projectRoot: string): Promise<PendingArchive[]> {
  const directory = join(projectRoot, ".harness", "state", "local", "archive-packages");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const pending: PendingArchive[] = [];
  for (const name of names.filter((item) => item.endsWith(".upload.json")).sort()) {
    const changeKey = name.slice(0, -".upload.json".length);
    try {
      const receipt = JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>;
      if (receipt.uploadStatus === "ready") continue;
      await readFile(join(directory, `${changeKey}.zip`));
      pending.push({
        changeKey,
        packagePath: join(directory, `${changeKey}.zip`),
        receiptPath: join(directory, name)
      });
    } catch {
      // Ignore incomplete or concurrently cleaned receipts.
    }
  }
  return pending;
}

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((entry) => entry.segment);
}

function characterCellWidth(character: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(character)) return 2;
  const base = [...character].find((part) => !/\p{Mark}/u.test(part));
  if (base === undefined) return 0;
  const codePoint = base.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) ? 2 : 1;
}

function cellWidth(value: string): number {
  return graphemes(value).reduce(
    (width, character) => width + characterCellWidth(character),
    0
  );
}

function wrapToCells(value: string, maximumWidth: number): string[] {
  const wrapped: string[] = [];
  let line = "";
  let width = 0;
  for (const character of graphemes(value)) {
    const characterWidth = characterCellWidth(character);
    if (width > 0 && width + characterWidth > maximumWidth) {
      wrapped.push(line);
      line = "";
      width = 0;
    }
    line += character;
    width += characterWidth;
  }
  wrapped.push(line);
  return wrapped;
}

function banner(lines: string[], columns: number): string {
  const maximumWidth = Math.max(8, columns - 4);
  const wrapped = lines.flatMap((line) =>
    wrapToCells(sanitizeTerminalText(line), maximumWidth)
  );
  const width = Math.min(
    maximumWidth,
    Math.max(Math.min(24, maximumWidth), ...wrapped.map(cellWidth))
  );
  const bar = "─".repeat(width + 2);
  return [
    `┌${bar}┐`,
    ...wrapped.map((line) => {
      const pad = width - cellWidth(line);
      return `│ ${line}${" ".repeat(Math.max(0, pad))} │`;
    }),
    `└${bar}┘`
  ].join("\n");
}

async function platformStatusLine(cwd: string): Promise<string> {
  const creds = await readLocalCredentials(cwd);
  if (creds?.server_url && creds.token) {
    const project = creds.project_display_name === undefined
      ? " · 项目名称未缓存"
      : ` · ${creds.project_display_name}`;
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
    const displayName = sanitizeTerminalText(
      creds.project_display_name ?? "（名称未缓存，可重新绑定补全）"
    );
    dependencies.stdout(
      `当前平台连接：\n` +
      `  地址：${creds.server_url}\n` +
      `  项目：${displayName}\n` +
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

  // 默认地址：重新绑定时用当前凭据的地址，否则用最近一次成功连接的地址；
  // 直接回车采用默认值，有输入则以输入为准。
  const rememberedUrl = await readLastServerUrl(dependencies.env);
  const defaultUrl = creds?.server_url ?? rememberedUrl;
  const entered = (await dependencies.prompt(
    defaultUrl === undefined
      ? "平台地址（远端使用 https://...；本机可用 http://127.0.0.1:端口）："
      : `平台地址 [${defaultUrl}]（回车使用默认地址，或输入新地址）：`
  )).trim();
  const url = entered === "" ? (defaultUrl ?? "") : entered;
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
  const cliVersion = await readCliVersion();
  const workflowManifest = await readWorkflowFamilyManifest(dependencies.resourcesRoot);
  const pendingArchives = await listPendingArchives(dependencies.cwd);
  const parsedColumns = Number.parseInt(dependencies.env.COLUMNS ?? "", 10);
  const detectedColumns = dependencies.terminalColumns ?? parsedColumns;
  const terminalColumns = Number.isFinite(detectedColumns) && detectedColumns >= 12
    ? detectedColumns
    : 80;
  const statusLines = [
    `Hunter Harness v${cliVersion} · ${projectName}`,
    formatWorkflowVersionLine(cliVersion, workflowManifest),
    await platformStatusLine(dependencies.cwd),
    `待上传归档：${pendingArchives.length} 个`,
    ...await toolsStatusLines(dependencies.cwd)
  ];
  dependencies.stdout(banner(statusLines, terminalColumns) + "\n\n");

  const answer = (await dependencies.prompt([
    "请选择操作：",
    "  1. 一键刷新已安装工具（不重选工具与配置）",
    "  2. 管理工具（新增 / 换配置 / 移除）",
    "  3. 平台连接（绑定或修改地址与密钥）",
    `  4. 重试待上传归档（${pendingArchives.length} 个）`,
    "  5. 事务与恢复",
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
    if (pendingArchives.length === 0) {
      dependencies.stdout("当前没有待上传归档。\n");
      return 0;
    }
    let exitCode = 0;
    for (const archive of pendingArchives) {
      dependencies.stdout(`正在重试归档：${archive.changeKey}\n`);
      const result = await runArchiveUpload({
        file: archive.packagePath,
        changeKey: archive.changeKey,
        nonInteractive: true,
        yes: true,
        onReceipt: async (receipt) => {
          if (receipt.archive_status === "durable" && receipt.knowledge_status === "ready") {
            await Promise.all([
              unlink(archive.packagePath).catch(() => undefined),
              unlink(archive.receiptPath).catch(() => undefined)
            ]);
            return;
          }
          let existing: Record<string, unknown> = {};
          try {
            existing = JSON.parse(await readFile(archive.receiptPath, "utf8")) as Record<string, unknown>;
          } catch {
            // Recreate a bounded retry receipt when the previous one is damaged.
          }
          const failed = receipt.knowledge_status === "failed";
          await writeFile(archive.receiptPath, JSON.stringify({
            ...existing,
            schemaVersion: 1,
            changeKey: archive.changeKey,
            packagePath: archive.packagePath,
            packageSha256: receipt.package_sha256,
            uploadStatus: failed ? "failed" : "pending",
            archiveStatus: receipt.archive_status,
            knowledgeStatus: receipt.knowledge_status,
            archiveId: receipt.archive_id,
            reasonCode: failed
              ? "ARCHIVE_KNOWLEDGE_INDEX_FAILED"
              : "ARCHIVE_KNOWLEDGE_INDEXING",
            updatedAt: new Date().toISOString()
          }, null, 2) + "\n", "utf8");
        }
      }, dependencies);
      if (result !== 0) exitCode = result;
    }
    return exitCode;
  }
  if (choice === "5") {
    return runTransactionMenu(dependencies);
  }
  dependencies.stderr("无效选项。\n");
  return 2;
}
