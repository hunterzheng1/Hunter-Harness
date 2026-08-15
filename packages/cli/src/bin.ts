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
import { runConnect, type ConnectOptions } from "./commands/connect.js";
import { runEventsSync, type EventsSyncOptions } from "./commands/events-sync.js";
import { runPush, type PushOptions } from "./commands/push.js";
import {
  runArchiveUpload,
  type ArchiveUploadOptions
} from "./commands/archive-upload.js";
import {
  runKnowledgeQuery,
  type KnowledgeQueryOptions
} from "./commands/knowledge-query.js";
import {
  runInstructionApply,
  runInstructionAudit,
  type InstructionApplyOptions,
  type InstructionAuditOptions
} from "./commands/instructions.js";
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
  runRunCancel,
  runRunLog,
  runRunStart,
  runRunStatus,
  type RunCommandOptions
} from "./commands/run.js";
import {
  runServiceEnsure,
  runServiceLinkSuperseder,
  runServiceRetireStale,
  runServiceStatus,
  runServiceStop,
  type ServiceCommandOptions
} from "./commands/service.js";
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
import {
  createPushPullCliPort,
  type PushPullCliPort
} from "./push-pull-adapter/index.js";
import { createRemoteSyncHttpPort } from "./push-pull-adapter/remote-http.js";
import {
  resolvePushPullSource,
  runPushPull,
  type ArchivePublishInput,
  type PushPullCommandOptions
} from "./commands/push-pull.js";
import {
  createPushPullOrchestration,
  RemoteSyncModule,
  type SourceRef
} from "@hunter-harness/core";

export interface CliDependencies extends Partial<CommandDependencies> {
  cwd?: string;
  resourcesRoot?: string;
  pacoteExtract?: ResolveWorkflowDataOptions["pacoteExtract"];
  /** Stage 03 command adapter seam; omitted dependencies remain fail closed. */
  pushPull?: PushPullCliPort;
  pushPullSource?: (input: Readonly<{
    direction: "push" | "pull";
    branch?: string;
  }>) => Promise<SourceRef>;
  pushPullArchive?: (change: string) => Promise<ArchivePublishInput>;
}

interface ResolvedCliDependencies extends CommandDependencies {
  pushPull: PushPullCliPort;
  pushPullSource: NonNullable<CliDependencies["pushPullSource"]>;
  pushPullArchive: CliDependencies["pushPullArchive"] | undefined;
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

function defaultDependencies(overrides: CliDependencies): ResolvedCliDependencies {
  const env = overrides.env ?? process.env;
  const remoteSyncUrl = env.HUNTER_REMOTE_SYNC_URL?.trim();
  const remoteSyncToken = env.HUNTER_REMOTE_SYNC_TOKEN?.trim();
  const remoteSyncActor = env.HUNTER_REMOTE_SYNC_ACTOR_ID?.trim();
  const workspaceRoot = overrides.cwd ?? process.cwd();
  const remoteOrchestration = remoteSyncUrl !== undefined && remoteSyncUrl !== "" &&
      remoteSyncToken !== undefined && remoteSyncToken !== "" &&
      remoteSyncActor !== undefined && remoteSyncActor !== ""
    ? createPushPullOrchestration(new RemoteSyncModule(createRemoteSyncHttpPort({
      serverUrl: remoteSyncUrl,
      token: remoteSyncToken,
      actorId: remoteSyncActor,
      workspaceRoot,
      fetch: overrides.fetch ?? globalThis.fetch
    })))
    : undefined;
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
    env,
    pushPull: overrides.pushPull ?? createPushPullCliPort(
      remoteOrchestration === undefined ? {} : { orchestration: remoteOrchestration }
    ),
    pushPullSource: overrides.pushPullSource ?? ((input) =>
      resolvePushPullSource(overrides.cwd ?? process.cwd(), input)),
    pushPullArchive: overrides.pushPullArchive,
    ...(overrides.terminalColumns !== undefined
      ? { terminalColumns: overrides.terminalColumns }
      : typeof process.stdout.columns === "number"
        ? { terminalColumns: process.stdout.columns }
        : {})
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
    .description("现有兼容入口：应用已批准的服务端产物；Stage 03 Pull 生产接线完成前继续使用本命令")
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
    .description("现有兼容入口：创建受治理的变更提案；Stage 03 Push 生产接线完成前继续使用本命令")
    .option("--skip-sensitive-scan", "显式跳过敏感扫描阻断（非交互需配合 --yes）")
    .action(async (options: PushOptions) => {
      exitCode = await runPush({ ...program.opts<PushOptions>(), ...options }, dependencies);
    });
  addCommonOptions(program.command("harness-push"))
    .description("RemoteSync 未配置时安全失败；配置 HUNTER_REMOTE_SYNC_URL/TOKEN/ACTOR_ID 后使用生产 HTTP Adapter")
    .option("--scope <scopes>", "config,rules,architecture,instructions,branch_files 或 all")
    .option("--branch <branch>", "显式来源分支")
    .option("--change <change-key>", "仅配合 --scope archive 使用")
    .option(
      "--resolve <path=resolution>",
      "逐路径选择 keep-local|accept-remote|skip（可重复）",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .action(async (options: PushPullCommandOptions) => {
      exitCode = await runPushPull(
        "push",
        { ...program.opts<PushPullCommandOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("harness-pull"))
    .alias("pull")
    .description("RemoteSync 未配置时安全失败；配置 HUNTER_REMOTE_SYNC_URL/TOKEN/ACTOR_ID 后使用生产 HTTP Adapter")
    .option("--scope <scopes>", "config,rules,architecture,instructions 或 branch_files")
    .option("--branch <branch>", "恢复 branch_files 时必需的来源分支")
    .option(
      "--resolve <path=resolution>",
      "逐路径选择 keep-local|accept-remote|skip（可重复）",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .action(async (options: PushPullCommandOptions) => {
      exitCode = await runPushPull(
        "pull",
        { ...program.opts<PushPullCommandOptions>(), ...options },
        dependencies
      );
    });
  const archive = program.command("archive")
    .description("管理核心变更归档包");
  addCommonOptions(archive.command("upload"))
    .description("上传一个确定性 ZIP，并由服务端解包和建立知识索引")
    .requiredOption("--file <path>", "归档 ZIP 路径")
    .requiredOption("--change-key <key>", "变更标识")
    .action(async (options: ArchiveUploadOptions) => {
      exitCode = await runArchiveUpload(
        { ...program.opts<ArchiveUploadOptions>(), ...options },
        dependencies
      );
    });
  const knowledge = program.command("knowledge")
    .description("访问远端项目知识库（无本地索引或离线回退）");
  addCommonOptions(knowledge.command("query <query>"))
    .description("只查询远端语义知识；远端不可用时直接失败")
    .option("--limit <count>", "最多返回 1-10 条", (value: string) => Number(value), 10)
    .action(async (query: string, options: KnowledgeQueryOptions) => {
      exitCode = await runKnowledgeQuery(
        query,
        { ...program.opts<KnowledgeQueryOptions>(), ...options },
        dependencies
      );
    });
  const instructions = program.command("instructions")
    .description("审计、预览并应用中文项目指令与规则提案");
  addCommonOptions(instructions.command("audit"))
    .description("上传小型项目证据，由服务端生成不带托管标记的中文提案")
    .action(async (options: InstructionAuditOptions) => {
      exitCode = await runInstructionAudit(
        { ...program.opts<InstructionAuditOptions>(), ...options },
        dependencies
      );
    });
  instructions.command("apply")
    .description("按基线哈希事务式应用已审阅提案")
    .requiredOption("--proposal <path>", "提案 JSON 路径")
    .option("--yes")
    .option("--json")
    .action(async (options: InstructionApplyOptions) => {
      exitCode = await runInstructionApply(
        { ...program.opts<InstructionApplyOptions>(), ...options },
        dependencies
      );
    });
  program.command("connect <url>")
    .description("绑定平台：校验项目 API Key 并写入 .harness/credentials.local.yaml")
    .option("--key <key>", "项目 API Key（省略则交互式输入）")
    .option("--rebind", "允许将本地 project_id 改绑到 API Key 对应项目（--yes 不足以改绑）")
    .option("--non-interactive")
    .option("--json")
    .action(async (url: string, options: ConnectOptions) => {
      exitCode = await runConnect(url, options, dependencies);
    });
  program.command("events-sync")
    .description("将本地 events.ndjson 增量上报到平台 Run 监控（batch + heartbeat）")
    .option("--change-dir <path>", "仅同步指定 change 目录")
    .option("--heartbeat-only", "只发送心跳，不上报事件")
    .option("--json")
    .action(async (options: EventsSyncOptions) => {
      exitCode = await runEventsSync(options, dependencies);
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
    .description("兼容入口：远端审计并生成中文规则提案，不直接改写项目文件")
    .option("--agents <csv>")
    .option("--codebuddy-surface <surface>")
    .option("--no-learn", "兼容参数；规则候选始终只作为提案，不自动应用")
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
    .description("检查 Harness 运行时与受管文件结构；--fix 自动重建可再生状态")
    .option("--runtime")
    .option("--managed-blocks")
    .option("--fix", "重建可再生投影（execution-log 渲染、知识索引修复）")
    .option("--json")
    .action(async (options: DoctorCommandOptions) => {
      exitCode = await runDoctor(options, dependencies);
    });
  const run = program.command("run")
    .description("管理可重连的受管后台执行会话");
  run.command("start [argv...]")
    .description("以结构化 argv 启动受管 run session")
    .requiredOption("--verification <name>")
    .option("--state-root <path>")
    .option("--working-directory <path>")
    .option("--timeout-seconds <seconds>", "wall timeout", (value: string) => Number(value))
    .option("--heartbeat-seconds <seconds>", "heartbeat interval", (value: string) => Number(value))
    .option("--expected-duration-seconds <seconds>", "expected duration", (value: string) => Number(value))
    .option("--product-identity <identity>")
    .option("--resource-lock <name>", "重复指定独占资源", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--json")
    .allowUnknownOption(true)
    .action(async (argv: string[], options: RunCommandOptions) => {
      exitCode = await runRunStart(options, argv, dependencies);
    });
  run.command("status")
    .description("读取受管 run session 状态")
    .requiredOption("--session-id <id>")
    .option("--state-root <path>")
    .option("--json")
    .action(async (options: RunCommandOptions) => {
      exitCode = await runRunStatus(options, dependencies);
    });
  run.command("log")
    .description("按 byte cursor 读取受管 run 日志")
    .requiredOption("--session-id <id>")
    .option("--state-root <path>")
    .option("--stream <stream>", "stdout | stderr", "stdout")
    .option("--cursor <cursor>", "byte cursor", (value: string) => Number(value), 0)
    .option("--max-bytes <bytes>", "maximum bytes", (value: string) => Number(value), 64 * 1024)
    .option("--json")
    .action(async (options: RunCommandOptions) => {
      exitCode = await runRunLog(options, dependencies);
    });
  run.command("cancel")
    .description("取消已证明归属的受管 run session")
    .requiredOption("--session-id <id>")
    .option("--state-root <path>")
    .option("--json")
    .action(async (options: RunCommandOptions) => {
      exitCode = await runRunCancel(options, dependencies);
    });

  const service = program.command("service")
    .description("管理受管后台服务身份与生命周期");
  service.command("ensure")
    .description("按 profile argvTemplate 启动或复用服务")
    .requiredOption("--change-dir <path>")
    .requiredOption("--project <path>")
    .option("--files <csv>")
    .option("--change-name <name>")
    .option("--overlay <path>")
    .option("--leased-port <port>", "leased port", (value: string) => Number(value))
    .option("--lease-owner <runId>")
    .option("--worktree-root <path>")
    .option("--execution-root <path>")
    .option("--attempt-id <id>")
    .option("--json")
    .action(async (options: ServiceCommandOptions) => {
      exitCode = await runServiceEnsure(options, dependencies);
    });
  service.command("status")
    .description("读取服务会话与身份状态")
    .requiredOption("--change-dir <path>")
    .option("--files <csv>")
    .option("--json")
    .action(async (options: ServiceCommandOptions) => {
      exitCode = await runServiceStatus(options, dependencies);
    });
  service.command("stop")
    .description("只停止已证明归属的服务")
    .requiredOption("--change-dir <path>")
    .option("--if-started-by-ai")
    .option("--json")
    .action(async (options: ServiceCommandOptions) => {
      exitCode = await runServiceStop(options, dependencies);
    });
  service.command("retire-stale")
    .description("退休 stale Harness 状态，不触碰未知进程")
    .requiredOption("--change-dir <path>")
    .option("--json")
    .action(async (options: ServiceCommandOptions) => {
      exitCode = await runServiceRetireStale(options, dependencies);
    });
  service.command("link-superseder")
    .description("以 receipt CAS 链接未来服务 generation")
    .requiredOption("--change-dir <path>")
    .requiredOption("--retirement-receipt <path>")
    .option("--json")
    .action(async (options: ServiceCommandOptions) => {
      exitCode = await runServiceLinkSuperseder(options, dependencies);
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
