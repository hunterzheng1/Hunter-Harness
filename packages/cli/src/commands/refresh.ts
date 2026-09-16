import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  projectConfigSchema,
  stripLegacyConfigFields,
  type ProjectConfig
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import {
  AGENTS_LEARNED_RULES_BLOCK_ID,
  collectFreshness,
  ensureHarnessGitignore,
  inspectHarnessStateEvidence,
  readLocalCredentials,
  refreshLearnedRules,
  refreshProject,
  resolveRecoveryRoot,
  uuidV7,
  type RefreshResult
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { harnessErrorInfo } from "../config/init-config.js";
import { serializeCliResult, type CliResult } from "../output/json.js";
import { readCliVersion } from "../version.js";
import {
  formatWorkflowVersionLine,
  readWorkflowFamilyManifest
} from "../workflow-data/resolve.js";

// v1.0：投影面固定（.agents/skills + AGENTS.md 与 .codebuddy/skills 派生），
// refresh 不再有 agents/profile/codebuddy-surface/remove-agents 参数。
export interface RefreshCommandOptions {
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
      const protectedSentinels = evidence.protectedLocalRoots
        .filter((inventory) => inventory.files > 0 || inventory.directories > 0)
        .map((inventory) => inventory.path);
      if (protectedSentinels.length > 0) {
        return {
          status: "partial",
          reasonCode: "PARTIAL_HARNESS_STATE_DETECTED",
          sentinels: protectedSentinels,
          protectedLocalRoots: evidence.protectedLocalRoots
        };
      }
      return { status: "absent" };
    }
    throw error;
  }
  // 软着陆：剥离 v0 配置中的已废弃字段（adapters/profiles/adapter_options 等）。
  const stripped = stripLegacyConfigFields(parseYaml(content));
  const parsed = projectConfigSchema.safeParse(stripped.value);
  if (!parsed.success) {
    return { status: "invalid" };
  }
  return { status: "valid", config: parsed.data };
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
  if (options.confirmed !== true) {
    if (options.nonInteractive === true) {
      if (!options.yes && !dryRun) {
        dependencies.stderr("非交互模式刷新需要 --yes\n");
        return 2;
      }
    } else if (!options.yes && !dryRun) {
      const answer = await dependencies.prompt("刷新到最新版本？[y/N]：");
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
    for (const warning of result.legacy_warnings) {
      output.warnings.push({
        code: "LEGACY_RESIDUE_DETECTED",
        message: warning
      });
    }
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
    // per-surface identity + freshness 五态。
    const freshness = await collectFreshness({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot
    });
    output.freshness = freshness.agents;
    // 归档后自动规则学习：高置信候选幂等刷新 AGENTS.md 受管段（无候选时保持空占位块）。
    const learned = await refreshLearnedRules(dependencies.cwd, { dryRun });
    if (learned.changed) {
      output.items.push({
        path: "AGENTS.md",
        status: dryRun ? "planned" : "applied",
        block: AGENTS_LEARNED_RULES_BLOCK_ID,
        rules: learned.learned_rules.length
      });
      if (dryRun) {
        output.summary.planned = Number(output.summary.planned ?? 0) + 1;
      } else {
        output.summary.applied = Number(output.summary.applied ?? 0) + 1;
      }
    }
    for (const removed of learned.removed_legacy_state) {
      output.items.push({ path: removed, status: dryRun ? "planned" : "removed" });
    }
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
        `Harness 刷新：${parts.join("，") || "没有变更"}。\n` +
        formatWorkflowVersionLine(cliVersion, workflowManifest) + "\n" +
        (result.legacy_warnings.length > 0
          ? result.legacy_warnings.map((warning) => `提示：${warning}\n`).join("")
          : "") +
        (gitignore.trackedMigrationNotice?.shouldDisplay === true
          ? `迁移提示：${gitignore.trackedMigrationNotice.message}\n涉及：${gitignore.trackedMigrationNotice.patterns.join("、")}\n`
          : "") +
        (learned.changed
          ? `经验规则：已${dryRun ? "计划 " : ""}更新 AGENTS.md 受管段（${learned.learned_rules.length} 条，来自 ${learned.scanned_archives} 个归档）。\n`
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
        exit_code: exitCode as CliResult["exit_code"],
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
