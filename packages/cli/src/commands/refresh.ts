import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  harnessAgentSchema,
  projectConfigSchema,
  sortHarnessAgents,
  type ProjectConfig
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import {
  collectFreshness,
  ensureHarnessGitignore,
  inspectHarnessStateEvidence,
  readLocalCredentials,
  refreshProject,
  resolveRecoveryRoot,
  uuidV7,
  type HarnessProfile,
  type RefreshResult
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { harnessErrorInfo, InitConfigurationError, parseAgentsInput } from "../config/init-config.js";
import { serializeCliResult, type CliResult } from "../output/json.js";
import { profileLabel } from "../ui/labels.js";
import { readCliVersion } from "../version.js";
import {
  formatWorkflowVersionLine,
  readWorkflowFamilyManifest
} from "../workflow-data/resolve.js";

export interface RefreshCommandOptions {
  agents?: string;
  /** Comma-separated agents to uninstall (clean managed files + adapters.enabled). */
  removeAgents?: string;
  codebuddySurface?: string;
  profile?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  forceManaged?: boolean;
  confirmed?: boolean;
  recoveryRoot?: string;
}

export type ProjectDetection =
  | { status: "absent" }
  | {
    status: "partial";
    reasonCode: "PARTIAL_HARNESS_STATE_DETECTED";
    sentinels: string[];
    protectedLocalRoots: Awaited<ReturnType<typeof inspectHarnessStateEvidence>>["protectedLocalRoots"];
  }
  | {
    status: "recovery-required";
    reasonCode: "LOCAL_HARNESS_RECOVERY_REQUIRED";
    sentinels: string[];
    protectedLocalRoots: Awaited<ReturnType<typeof inspectHarnessStateEvidence>>["protectedLocalRoots"];
    recoveryTransactions: string[];
  }
  | { status: "invalid" }
  | { status: "valid"; config: ProjectConfig };

export async function detectProject(root: string): Promise<ProjectDetection> {
  let content: string;
  try {
    content = await readFile(join(root, ".harness", "project.yaml"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const evidence = await inspectHarnessStateEvidence(root);
      if (evidence.recoveryRequired) {
        return {
          status: "recovery-required",
          reasonCode: "LOCAL_HARNESS_RECOVERY_REQUIRED",
          sentinels: evidence.sentinels,
          protectedLocalRoots: evidence.protectedLocalRoots,
          recoveryTransactions: evidence.recoveryTransactions
        };
      }
      if (evidence.sentinels.length > 0) {
        return {
          status: "partial",
          reasonCode: "PARTIAL_HARNESS_STATE_DETECTED",
          sentinels: evidence.sentinels,
          protectedLocalRoots: evidence.protectedLocalRoots
        };
      }
      return { status: "absent" };
    }
    throw error;
  }
  const parsed = projectConfigSchema.safeParse(parseYaml(content));
  if (!parsed.success) {
    return { status: "invalid" };
  }
  return { status: "valid", config: parsed.data };
}

function parseProfile(value: string | undefined): HarnessProfile | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "1" || value === "general") return "general";
  if (value === "2" || value === "java") return "java";
  throw new Error("配置类型必须为 general 或 java");
}

function refreshAgents(config: ProjectConfig): ReturnType<typeof sortHarnessAgents> {
  const agents = sortHarnessAgents(config.adapters.enabled.flatMap((agent) => {
    const parsed = harnessAgentSchema.safeParse(agent);
    return parsed.success ? [parsed.data] : [];
  }));
  return agents.length > 0 ? agents : ["claude-code"];
}

function codebuddySurface(
  config: ProjectConfig,
  override?: string
): "both" | "ide" | "cli" {
  const value = override ?? config.adapter_options?.codebuddy?.surface ?? "both";
  if (value === "both" || value === "ide" || value === "cli") return value;
  throw new InitConfigurationError(
    "codebuddy surface 必须为 both、ide 或 cli",
    3,
    "CODEBUDDY_SURFACE_INVALID"
  );
}

function summarize(result: RefreshResult): CliResult {
  const items = [
    ...result.applied.map((item) => ({ ...item, status: result.dry_run ? "planned" : "applied" })),
    ...result.removed.map((item) => ({ ...item, status: result.dry_run ? "planned" : "removed" })),
    ...result.preserved.map((item) => ({ ...item, status: "preserved" })),
    ...result.unchanged.map((item) => ({ ...item, status: "unchanged" }))
  ];
  const exitCode = result.conflicts.length > 0 ? 5 : 0;
  return {
    schema_version: 1,
    command: "refresh",
    request_id: uuidV7(),
    dry_run: result.dry_run,
    ok: exitCode === 0,
    exit_code: exitCode,
    project_id: null,
    summary: {
      applied: result.dry_run ? 0 : result.applied.length,
      removed: result.dry_run ? 0 : result.removed.length,
      preserved: result.preserved.length,
      unchanged: result.unchanged.length,
      conflicts: result.conflicts.length
    },
    items,
    warnings: result.conflicts,
    errors: [],
    plan_hash: result.plan_hash,
    recovery_id: result.recovery_id
  };
}

function renderProfileTransitionPreview(result: RefreshResult): string {
  const items = [
    ...result.applied,
    ...result.removed,
    ...result.preserved,
    ...result.unchanged
  ];
  const actionLabel: Record<RefreshResult["applied"][number]["action"], string> = {
    add: "新增", replace: "替换", delete: "删除", preserve: "保留", unchanged: "无需变更"
  };
  const reasonLabel: Record<RefreshResult["applied"][number]["reason"], string> = {
    MISSING_TARGET: "目标缺失", BASELINE_CLEAN: "基线未修改", ALREADY_CURRENT: "已是最新",
    LOCAL_MODIFICATION: "检测到本地修改", MALFORMED_MANAGED_BLOCK: "受管区块格式异常",
    LEGACY_PROFILE_FILE_MODIFIED: "旧配置文件已修改", LEGACY_BASELINE_UNKNOWN: "旧版基线未知",
    FORCE_MANAGED: "强制更新"
  };
  return "配置切换预览：\n" + items
    .map((item) => `- ${actionLabel[item.action]}：${item.target_path}（${reasonLabel[item.reason]}）`)
    .join("\n") + "\n";
}

// 显式 `hunter-harness refresh` 与 bare 命令在既有项目上的派发共用此入口；
// 核心协调统一走 core.refreshProject（design §3.4：不复制算法）。
export async function runRefresh(
  options: RefreshCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  const detection = await detectProject(dependencies.cwd);
  if (detection.status === "absent") {
    dependencies.stderr("尚未初始化 Hunter Harness；请先运行 `hunter-harness`。\n");
    return 3;
  }
  if (detection.status === "invalid") {
    dependencies.stderr("PROJECT_CONFIG_INVALID：.harness/project.yaml 无效\n");
    return 3;
  }
  if (detection.status === "partial" || detection.status === "recovery-required") {
    dependencies.stderr(`${detection.reasonCode}：需要先恢复本地 Harness 主状态\n`);
    return 6;
  }

  const currentProfile = (detection.config.project.profiles[0] ?? "general") as HarnessProfile;
  let targetProfile: HarnessProfile | undefined;
  let targetAgents: ReturnType<typeof refreshAgents>;
  let removeAgents: ReturnType<typeof refreshAgents> = [];
  try {
    targetProfile = parseProfile(options.profile);
    targetAgents = options.agents === undefined
      ? refreshAgents(detection.config)
      : parseAgentsInput(options.agents);
    if (options.removeAgents !== undefined && options.removeAgents.trim() !== "") {
      removeAgents = parseAgentsInput(options.removeAgents);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof InitConfigurationError ? error.code : undefined;
    dependencies.stderr((code === undefined ? "" : code + ": ") + message + "\n");
    return error instanceof InitConfigurationError ? error.exitCode : 3;
  }

  const dryRun = options.dryRun === true;
  const planTimestamp = new Date().toISOString();
  const cliVersion = await readCliVersion();
  const recoveryStore = {
    root: options.recoveryRoot ?? resolveRecoveryRoot(dependencies.env)
  };
  let guardedPreview: RefreshResult;
  try {
    guardedPreview = await refreshProject({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot,
      ...(targetProfile === undefined ? {} : { profile: targetProfile }),
      agents: targetAgents,
      ...(removeAgents.length === 0 ? {} : { removeAgents }),
      codebuddySurface: codebuddySurface(
        detection.config,
        options.codebuddySurface
      ),
      dryRun: true,
      forceManaged: options.forceManaged === true,
      planTimestamp,
      cliVersion
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    return 1;
  }
  if (((targetProfile !== undefined && targetProfile !== currentProfile) ||
      targetAgents.some((agent, index) => agent !== refreshAgents(detection.config)[index]) ||
      targetAgents.length !== refreshAgents(detection.config).length) && !dryRun) {
    const rendered = renderProfileTransitionPreview(guardedPreview);
    if (options.json === true) {
      dependencies.stderr(rendered);
    } else {
      dependencies.stdout(rendered);
    }
  }
  if (options.confirmed !== true) {
    if (options.nonInteractive === true) {
      if (!options.yes && !dryRun) {
        dependencies.stderr("非交互模式刷新需要 --yes\n");
        return 2;
      }
    } else if (!options.yes && !dryRun) {
      const label = removeAgents.length > 0
        ? "移除工具并保留其余配置"
        : targetProfile === currentProfile
          ? `刷新当前配置（${profileLabel(currentProfile)}）`
          : targetProfile === undefined
            ? "刷新所选工具的当前配置"
            : `更新所选工具配置：${profileLabel(currentProfile)} → ${profileLabel(targetProfile)}`;
      const answer = await dependencies.prompt(`${label}？[y/N]：`);
      if (!/^(?:y|yes)$/i.test(answer.trim())) {
        return 2;
      }
    }
  }

  // Wave-2 H-17: --force-managed must never be silent — require explicit --yes/--confirmed.
  if (options.forceManaged === true && !dryRun && options.yes !== true && options.confirmed !== true) {
    dependencies.stderr("FORCE_MANAGED_REQUIRES_CONFIRM: --force-managed requires --yes or --confirmed\n");
    return 2;
  }

  try {
    const result = dryRun
      ? guardedPreview
      : await refreshProject({
        projectRoot: dependencies.cwd,
        resourcesRoot: dependencies.resourcesRoot,
        ...(targetProfile === undefined ? {} : { profile: targetProfile }),
        agents: targetAgents,
        ...(removeAgents.length === 0 ? {} : { removeAgents }),
        codebuddySurface: codebuddySurface(
          detection.config,
          options.codebuddySurface
        ),
        dryRun: false,
        forceManaged: options.forceManaged === true,
        expectedPlanHash: guardedPreview.plan_hash,
        planTimestamp,
        cliVersion,
        recoveryStore
      });
    const localCredentials = await readLocalCredentials(dependencies.cwd);
    const gitignore = await ensureHarnessGitignore(dependencies.cwd, {
      dryRun,
      platformBound: localCredentials?.server_url !== undefined &&
        localCredentials.token !== undefined && localCredentials.project_id !== undefined
    });
    const output = summarize(result);
    const noteworthyGitignore = gitignore.patternResults.filter((item) =>
      item.status === "tracked" || item.status === "preserved-by-negation"
    );
    if (gitignore.changed || noteworthyGitignore.length > 0) {
      output.items.push({
        path: gitignore.path,
        status: dryRun ? "planned" : gitignore.changed ? "applied" : "preserved",
        patterns: gitignore.patternResults
      });
    }
    if (gitignore.changed) {
      if (dryRun) {
        output.summary.planned = Number(output.summary.planned ?? 0) + 1;
      } else {
        output.summary.applied = Number(output.summary.applied ?? 0) + 1;
      }
    }
    if (gitignore.trackedMigrationNotice?.shouldDisplay === true) {
      output.warnings.push({
        code: "TRACKED_HARNESS_FILES_NEED_MIGRATION",
        message: gitignore.trackedMigrationNotice.message,
        paths: gitignore.trackedMigrationNotice.patterns
      });
    }
    // per-agent identity + freshness 六态（task 12）：legacy 字段不动，新增 freshness 数组。
    const freshness = await collectFreshness({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot,
      ...(targetProfile === undefined ? {} : { profile: targetProfile }),
      agents: targetAgents,
      codebuddySurface: codebuddySurface(detection.config, options.codebuddySurface)
    });
    output.freshness = freshness.agents;
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({ ...output, request_id: requestId }));
    } else {
      const parts: string[] = [];
      if (result.applied.length > 0) parts.push(`已更新 ${result.applied.length} 个`);
      if (result.removed.length > 0) parts.push(`已删除 ${result.removed.length} 个`);
      if (result.preserved.length > 0) parts.push(`已保留 ${result.preserved.length} 个`);
      if (result.unchanged.length > 0) parts.push(`无需变更 ${result.unchanged.length} 个`);
      const workflowManifest = await readWorkflowFamilyManifest(dependencies.resourcesRoot);
      dependencies.stdout(
        `Harness 刷新（${profileLabel(result.profile)}）：${parts.join("，") || "没有变更"}。\n` +
        formatWorkflowVersionLine(cliVersion, workflowManifest) + "\n" +
        (gitignore.trackedMigrationNotice?.shouldDisplay === true
          ? `迁移提示：${gitignore.trackedMigrationNotice.message}\n涉及：${gitignore.trackedMigrationNotice.patterns.join("、")}\n`
          : "")
      );
    }
    return output.exit_code;
  } catch (error) {
    const info = harnessErrorInfo(error);
    const exitCode = info.exitCode ?? 1;
    const code = info.code;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr((code !== undefined ? code + ": " : "") + message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "refresh",
        request_id: requestId,
        dry_run: dryRun,
        ok: false,
        exit_code: exitCode,
        project_id: null,
        summary: { applied: 0, removed: 0, preserved: 0, unchanged: 0, conflicts: 0 },
        items: [],
        warnings: [],
        errors: [{ ...(code === undefined ? {} : { code }), message }]
      }));
    }
    return exitCode;
  }
}
