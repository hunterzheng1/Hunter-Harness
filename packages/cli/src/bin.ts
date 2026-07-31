#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import { Command, CommanderError } from "commander";

import {
  runConfigure,
  runInit,
  type CommandDependencies,
  type ConfigureOptions
} from "./commands/configure.js";
import { runCleanup, type CleanupCommandOptions } from "./commands/cleanup.js";
import { runPush, type PushOptions } from "./commands/push.js";
import {
  detectProject,
  runRefresh,
  type RefreshCommandOptions
} from "./commands/refresh.js";
import { runUpdate, type UpdateOptions } from "./commands/update.js";
import { runRulesSync, type RulesSyncCommandOptions } from "./commands/rules-sync.js";
import {
  runRulesReview,
  type RulesReviewCommandOptions
} from "./commands/rules-review.js";
import { runCapabilities } from "./commands/capabilities.js";
import { runConfigShow, type ConfigShowOptions } from "./commands/config-origins.js";
import { runDoctor, type DoctorCommandOptions } from "./commands/doctor.js";
import { runSync, type SyncCommandOptions } from "./commands/sync.js";
import {
  runRecoveryCommand,
  runRecoveryMenuIfApplicable,
  runRecoveryStatus,
  type RecoveryCommandOptions
} from "./commands/recovery.js";
import {
  readWorkflowFamilyManifest,
  resolveWorkflowResourcesRoot,
  WorkflowDataResolutionError
} from "./workflow-data/resolve.js";
import type { ResolveWorkflowDataOptions } from "./workflow-data/resolve.js";
import {
  assertWorkflowCompatibility,
  CLI_CAPABILITIES,
  WorkflowCompatibilityError
} from "./workflow-data/compatibility.js";
import { readCliVersion } from "./version.js";

export interface CliDependencies extends Partial<CommandDependencies> {
  cwd?: string;
  resourcesRoot?: string;
  pacoteExtract?: ResolveWorkflowDataOptions["pacoteExtract"];
}

interface SecretInputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

interface SecretOutputStream extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export async function promptSecret(
  question: string,
  input: SecretInputStream = process.stdin,
  output: SecretOutputStream = process.stdout
): Promise<string> {
  if (input.isTTY !== true || output.isTTY !== true) {
    const terminal = createInterface({ input, output });
    try {
      return await terminal.question(question);
    } finally {
      terminal.close();
    }
  }

  output.write(question);
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const terminal = createInterface({
    input,
    output: mutedOutput,
    terminal: true
  });
  try {
    return await terminal.question("");
  } finally {
    terminal.close();
    output.write("\n");
  }
}

function defaultDependencies(overrides: CliDependencies): CommandDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    resourcesRoot: overrides.resourcesRoot ?? "",
    stdout: overrides.stdout ?? ((value) => process.stdout.write(value)),
    stderr: overrides.stderr ?? ((value) => process.stderr.write(value)),
    prompt: overrides.prompt ?? (async (question) => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await terminal.question(question);
      } finally {
        terminal.close();
      }
    }),
    promptSecret: overrides.promptSecret ?? overrides.prompt ?? promptSecret,
    fetch: overrides.fetch ?? globalThis.fetch,
    env: overrides.env ?? process.env
  };
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--dry-run")
    .option("--yes")
    .option("--json")
    .option("--server-url <url>")
    .option("--token-env <ENV_NAME>")
    .option("--non-interactive")
    .option("--agents <csv>")
    .option("--codebuddy-surface <surface>")
    .option("--workflow-family <slug>")
    .option("--workflow-version <version>")
    .option("--recovery-root <path>");
}

export async function runCli(
  argv: readonly string[],
  overrides: CliDependencies = {}
): Promise<number> {
  const dependencies = defaultDependencies(overrides);
  try {
    const resolveOptions: ResolveWorkflowDataOptions = {
      cwd: dependencies.cwd,
      env: dependencies.env,
      override: overrides.resourcesRoot
    };
    if (overrides.pacoteExtract !== undefined) {
      resolveOptions.pacoteExtract = overrides.pacoteExtract;
    }
    dependencies.resourcesRoot = await resolveWorkflowResourcesRoot(resolveOptions, argv);
    const command = argv.find((value) => !value.startsWith("-"));
    if (command !== "capabilities" && command !== "doctor") {
      assertWorkflowCompatibility(
        await readWorkflowFamilyManifest(dependencies.resourcesRoot),
        {
          cliVersion: await readCliVersion(),
          capabilities: CLI_CAPABILITIES
        }
      );
    }
  } catch (error) {
    if (error instanceof WorkflowDataResolutionError) {
      dependencies.stderr(error.message + "\n");
      return error.exitCode;
    }
    if (error instanceof WorkflowCompatibilityError) {
      dependencies.stderr(JSON.stringify({
        status: "BLOCKED",
        reasonCode: error.code,
        message: error.message,
        compatibility: error.compatibility
      }) + "\n");
      return error.exitCode;
    }
    throw error;
  }

  const program = addCommonOptions(new Command())
    .name("hunter-harness")
    .description("Local-first, server-governed agent harness")
    .option("--profile <name>")
    .option("--config <file>")
    .option("--force-managed")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: dependencies.stdout,
      writeErr: dependencies.stderr
    });

  let exitCode = 0;
  program.action(async (options: ConfigureOptions) => {
    const recoveryResult = await runRecoveryMenuIfApplicable(options, dependencies);
    if (recoveryResult !== null) {
      exitCode = recoveryResult;
      return;
    }
    const detection = await detectProject(dependencies.cwd);
    const guardedOptions = detection.status === "absent" &&
      options.nonInteractive === true
      ? { ...options, profile: options.profile ?? "general" }
      : options;
    exitCode = await runConfigure(guardedOptions, dependencies);
  });
  addCommonOptions(program.command("init"))
    .description("仅在空白项目中初始化 Hunter Harness")
    .option("--profile <name>")
    .option("--config <file>")
    .option("--force-managed")
    .action(async (options: ConfigureOptions) => {
      exitCode = await runInit(
        { ...program.opts<ConfigureOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("refresh"))
    .description("本地保守刷新已安装的 Harness 项目")
    .option("--profile <name>")
    .option("--force-managed")
    .action(async (options: RefreshCommandOptions) => {
      exitCode = await runRefresh(
        { ...program.opts<RefreshCommandOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("update"))
    .description("应用已批准的服务端产物")
    .option("--guarded", "使用本地保守刷新，不调用服务端更新")
    .option(
      "--conflict-strategy <strategy>",
      "manual | keep-local | accept-remote（默认 manual；rename 冲突始终 manual）"
    )
    .option(
      "--resolve <path=strategy>",
      "单路径覆盖 keep-local|accept-remote（可重复）",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .action(async (options: UpdateOptions) => {
      exitCode = await runUpdate(
        { ...program.opts<UpdateOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("push"))
    .description("创建受治理的变更提案")
    .option("--skip-sensitive-scan", "显式跳过敏感扫描阻断（非交互需配合 --yes）")
    .action(async (options: PushOptions) => {
      exitCode = await runPush({ ...program.opts<PushOptions>(), ...options }, dependencies);
    });
  addCommonOptions(program.command("cleanup"))
    .description("清理已完成事务和过期服务端缓存")
    .action(async (options: CleanupCommandOptions) => {
      exitCode = await runCleanup(
        { ...program.opts<CleanupCommandOptions>(), ...options },
        dependencies
      );
    });
  program.command("rules-sync")
    .description("收敛公共规则、刷新 Agent 投影并提炼历史规则候选")
    .option("--agents <csv>")
    .option("--codebuddy-surface <surface>")
    .option("--no-learn", "只同步规则，不读取历史 review/test 证据")
    .option("--json")
    .action(async (options: RulesSyncCommandOptions) => {
      exitCode = await runRulesSync(
        { ...program.opts<RulesSyncCommandOptions>(), ...options },
        dependencies
      );
    });
  program.command("rules-review")
    .description("导出待评审公共规则候选，或应用经用户确认的规则决策")
    .option("--apply <file>", "应用包含候选 revision 和目标 hash 的决策 JSON")
    .option("--json")
    .action(async (options: RulesReviewCommandOptions) => {
      exitCode = await runRulesReview(
        { ...program.opts<RulesReviewCommandOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("sync"))
    .description("执行一次有界的 Harness 元数据同步并生成可校验报告")
    .option("--project <path>", "项目根目录")
    .option("--profile <profile>", "interactive | general | java", "interactive")
    .option("--progress <mode>", "jsonl | text | none", "jsonl")
    .option("--check", "完整、纯只读评估所有组件（--dry-run 兼容别名）")
    .option("--apply <mode>", "执行安全修复；当前支持 safe")
    .option("--fix <remediation-id>", "执行指定 remediation")
    .option("--verbose", "在 JSON 中包含完整组件 receipts")
    .option("--include-components", "兼容别名：在 JSON 中包含完整组件 receipts")
    .action(async (options: SyncCommandOptions) => {
      exitCode = await runSync(
        { ...program.opts<SyncCommandOptions>(), ...options },
        dependencies
      );
    });
  program.command("doctor")
    .description("检查 Harness 运行时与受管文件结构")
    .option("--runtime")
    .option("--managed-blocks")
    .option("--json")
    .action(async (options: DoctorCommandOptions) => {
      exitCode = await runDoctor(options, dependencies);
    });
  const config = program.command("config")
    .description("查看 Harness 配置来源");
  config.command("show")
    .option("--origins")
    .option("--json")
    .action(async (options: ConfigShowOptions) => {
      exitCode = await runConfigShow(options, dependencies);
    });
  program.command("capabilities")
    .description("输出 CLI 与 workflow 的机器可读能力契约")
    .option("--json")
    .action(async () => {
      exitCode = await runCapabilities(program, dependencies);
    });
  program.command("status")
    .description("只读查看 Hunter Harness 恢复状态")
    .option("--recovery-root <path>")
    .option("--json")
    .action(async (options: RecoveryCommandOptions) => {
      exitCode = await runRecoveryStatus(
        { ...program.opts<RecoveryCommandOptions>(), ...options },
        dependencies
      );
    });
  program.command("recover [recoveryId]")
    .description("检查或处理未完成事务")
    .option("--action <action>", "inspect | resume | rollback | diagnose")
    .option("--non-interactive")
    .option("--yes")
    .option("--recovery-root <path>")
    .option("--json")
    .action(async (
      recoveryId: string | undefined,
      options: RecoveryCommandOptions
    ) => {
      exitCode = await runRecoveryCommand(
        recoveryId,
        { ...program.opts<RecoveryCommandOptions>(), ...options },
        dependencies
      );
    });
  program.command("resume [recoveryId]")
    .description("继续或显式处理未完成事务")
    .option("--action <action>", "resume | rollback | inspect", "resume")
    .option("--non-interactive")
    .option("--yes")
    .option("--recovery-root <path>")
    .option("--json")
    .action(async (
      recoveryId: string | undefined,
      options: RecoveryCommandOptions
    ) => {
      exitCode = await runRecoveryCommand(
        recoveryId,
        { ...program.opts<RecoveryCommandOptions>(), ...options },
        dependencies,
        "resume"
      );
    });

  try {
    await program.parseAsync(["node", "hunter-harness", ...argv]);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === "commander.helpDisplayed" ? 0 : 3;
    }
    throw error;
  }
}

/** Windows npm workspaces 经 junction 调用时 argv 路径与 import.meta.url 实路径不一致。 */
export function isDirectCliEntrypoint(
  entry = process.argv[1],
  metaUrl = import.meta.url
): boolean {
  if (entry === undefined) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return metaUrl === pathToFileURL(entry).href;
  }
}

if (isDirectCliEntrypoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
