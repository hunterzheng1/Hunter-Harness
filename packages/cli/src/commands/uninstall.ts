import { homedir } from "node:os";

import { uninstallHarness, type UninstallReport } from "@hunter-harness/core";

import { resolveUserStateRoot } from "../config/user-state.js";
import type { CommandDependencies } from "./configure.js";

export interface UninstallCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  keepData?: boolean;
  global?: boolean;
}

function renderPlan(report: UninstallReport, stdout: (value: string) => void): void {
  if (report.actions.length === 0) {
    stdout("未发现 hunter-harness 安装内容，无需卸载。\n");
    return;
  }
  const kindLabel: Record<string, string> = {
    "delete-file": "删除文件",
    "delete-dir": "删除目录",
    "strip-file": "摘除内容",
    skip: "跳过保留"
  };
  stdout(`将${report.dry_run ? "（预览）" : ""}处理 ${report.actions.length} 项：\n`);
  for (const action of report.actions) {
    stdout(`  [${kindLabel[action.kind] ?? action.kind}] ${action.path} — ${action.detail}\n`);
  }
  for (const warning of report.warnings) {
    stdout(`  警告：${warning}\n`);
  }
}

/**
 * 卸载入口：默认 dry-run 预览，`--yes` 实际执行；
 * `--keep-data` 保留 .harness/state 运行数据；`--global` 追加用户级目录清理。
 */
export async function runUninstall(
  options: UninstallCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const keepData = options.keepData === true;
  const globalScope = options.global === true;
  const base = {
    projectRoot: dependencies.cwd,
    keepData,
    global: globalScope,
    ...(globalScope
      ? {
          userStateRoot: resolveUserStateRoot(dependencies.env),
          userHome: dependencies.env.USERPROFILE ?? dependencies.env.HOME ?? homedir()
        }
      : {})
  };

  try {
    const execute = options.yes === true && options.dryRun !== true;
    const report = await uninstallHarness({ ...base, dryRun: !execute });
    if (options.json === true) {
      dependencies.stdout(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    renderPlan(report, dependencies.stdout);
    if (report.actions.length === 0) return 0;
    if (execute) {
      dependencies.stdout(
        `\n卸载完成：删除 ${report.counts.deleted} 项，摘除 ${report.counts.stripped} 处，` +
        `保留 ${report.counts.skipped} 项。\n`
      );
      return 0;
    }
    dependencies.stdout(
      "\n以上为预览（dry-run）。确认无误后加 --yes 执行；" +
      "--keep-data 保留运行数据，--global 追加用户级清理。\n"
    );
    return 0;
  } catch (error) {
    dependencies.stderr(
      `uninstall 失败：${error instanceof Error ? error.message : String(error)}\n`
    );
    return 5;
  }
}
