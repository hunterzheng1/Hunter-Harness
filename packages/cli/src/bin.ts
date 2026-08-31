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
import { runPlanFinalize, type PlanFinalizeOptions } from "./commands/plan-finalize.js";
import { runPlanEvidencePack, type PlanEvidencePackOptions } from "./commands/plan-evidence-pack.js";
import { runPlanReviewRecord, type PlanReviewRecordOptions } from "./commands/plan-review-record.js";
import { runPlanPublish, type PlanPublishOptions } from "./commands/plan-publish.js";
import { runArchiveOutboxGc, type ArchiveOutboxGcOptions } from "./commands/archive-outbox-gc.js";
import { composeArchiveProduction } from "./archive-production/compose.js";
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
  runKnowledgeStatus,
  type KnowledgeStatusOptions
} from "./commands/knowledge-status.js";
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
import { runScanSensitive } from "./commands/scan-sensitive.js";
import { runConfigShow, type ConfigShowOptions } from "./commands/config-origins.js";
import { runDoctor, type DoctorCommandOptions } from "./commands/doctor.js";
import { planSyncPush, runSync, type SyncCommandOptions } from "./commands/sync.js";
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
  runRepublishArchive,
  type ArchivePublishInput,
  type ArchiveRepublishResult,
  type PushPullCommandOptions
} from "./commands/push-pull.js";
import {
  createPushPullOrchestration,
  mergeLocalCredentials,
  readLocalCredentials,
  RemoteSyncModule,
  writeLocalCredentials,
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
  republishArchive?: (change: string, dryRun: boolean) => Promise<ArchiveRepublishResult>;
}

interface ResolvedCliDependencies extends CommandDependencies {
  pushPull: PushPullCliPort;
  pushPullSource: NonNullable<CliDependencies["pushPullSource"]>;
  pushPullArchive: CliDependencies["pushPullArchive"] | undefined;
  republishArchive: NonNullable<CliDependencies["republishArchive"]>;
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

const REMOTE_SYNC_COMMANDS = new Set(["harness-push", "harness-pull", "pull"]);

/** Best-effort actor_id 补全：用已齐备的 url/token 调 key-info（connect 同款只读接口）。 */
async function fetchRemoteSyncActorId(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(
      serverUrl.replace(/\/+$/, "") + "/api/v1/auth/key-info",
      { headers: { Accept: "application/json", Authorization: "Bearer " + token } }
    );
    if (!response.ok) return undefined;
    const info: unknown = await response.json();
    if (info === null || typeof info !== "object" || Array.isArray(info)) return undefined;
    const actor = (info as { actor_id?: unknown }).actor_id;
    return typeof actor === "string" && actor.trim().length > 0 ? actor.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function defaultDependencies(
  overrides: CliDependencies,
  options: { healActor?: boolean } = {}
): Promise<ResolvedCliDependencies> {
  const env = overrides.env ?? process.env;
  const workspaceRoot = overrides.cwd ?? process.cwd();
  let remoteSyncUrl = env.HUNTER_REMOTE_SYNC_URL?.trim();
  let remoteSyncToken = env.HUNTER_REMOTE_SYNC_TOKEN?.trim();
  let remoteSyncActor = env.HUNTER_REMOTE_SYNC_ACTOR_ID?.trim();
  const missing = (value: string | undefined): boolean => value === undefined || value === "";
  let local: Awaited<ReturnType<typeof readLocalCredentials>> = null;
  if (missing(remoteSyncUrl) || missing(remoteSyncToken) || missing(remoteSyncActor)) {
    // env 优先，缺失字段回退到 `hunter-harness connect` 写入的绑定凭据。
    local = await readLocalCredentials(workspaceRoot);
    if (missing(remoteSyncUrl)) remoteSyncUrl = local?.server_url;
    if (missing(remoteSyncToken)) remoteSyncToken = local?.token;
    if (missing(remoteSyncActor)) remoteSyncActor = local?.actor_id;
  }
  if (options.healActor === true && missing(remoteSyncActor) &&
      !missing(remoteSyncUrl) && !missing(remoteSyncToken)) {
    const healed = await fetchRemoteSyncActorId(
      remoteSyncUrl as string, remoteSyncToken as string,
      overrides.fetch ?? globalThis.fetch
    );
    if (healed !== undefined) {
      remoteSyncActor = healed;
      if (local !== null) {
        // 写回绑定文件（best-effort），之后不再依赖网络补全；env-only 场景不落盘。
        try {
          await writeLocalCredentials(workspaceRoot, mergeLocalCredentials(local, { actor_id: healed }));
        } catch { /* 写回失败不影响本次运行 */ }
      }
    }
  }
  if (options.healActor === true && missing(remoteSyncActor) &&
      !missing(remoteSyncUrl) && !missing(remoteSyncToken)) {
    (overrides.stderr ?? ((value) => process.stderr.write(value)))(
      "缺少 actor_id（key-info 自动补全未成功）：重新运行 hunter-harness connect，" +
      "或设置 HUNTER_REMOTE_SYNC_ACTOR_ID。\n"
    );
  }
  const remoteConfigured = !missing(remoteSyncUrl) && !missing(remoteSyncToken) &&
    !missing(remoteSyncActor);
  const remoteSyncModule = remoteConfigured
    ? new RemoteSyncModule(createRemoteSyncHttpPort({
      serverUrl: remoteSyncUrl as string,
      token: remoteSyncToken as string,
      actorId: remoteSyncActor as string,
      workspaceRoot,
      fetch: overrides.fetch ?? globalThis.fetch
    }))
    : undefined;
  const remoteOrchestration = remoteSyncModule === undefined
    ? undefined
    : createPushPullOrchestration(remoteSyncModule);
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
    // 06B-3 W4：archive 生产组合单实例（adapter 的 zip_reader 与 claim 供应共享项目上下文）
    ...(overrides.pushPullArchive === undefined && remoteOrchestration !== undefined
      ? (() => {
          const archiveComposition = composeArchiveProduction({
            projectRoot: overrides.cwd ?? process.cwd(),
            publisher: remoteSyncModule as never,
            resolveSource: () =>
              resolvePushPullSource(overrides.cwd ?? process.cwd(), { direction: "push" })
          });
          return {
            pushPull: overrides.pushPull ?? createPushPullCliPort({
              orchestration: remoteOrchestration,
              archive: archiveComposition.remoteAdapter as never
            }),
            pushPullSource: overrides.pushPullSource ?? ((input) =>
              resolvePushPullSource(overrides.cwd ?? process.cwd(), input)),
            pushPullArchive: archiveComposition.pushPullArchive
            ,republishArchive: overrides.republishArchive ?? ((change, dryRun) =>
              runRepublishArchive(change, dryRun, {
                cwd: overrides.cwd ?? process.cwd(),
                resourcesRoot: overrides.resourcesRoot ?? process.cwd(),
                stdout: () => undefined,
                stderr: (value) => process.stderr.write(value),
                prompt: async () => "",
                fetch: globalThis.fetch,
                env
              }))
          };
        })()
      : {
          pushPull: overrides.pushPull ?? createPushPullCliPort(
            remoteOrchestration === undefined ? {} : { orchestration: remoteOrchestration }
          ),
          pushPullSource: overrides.pushPullSource ?? ((input) =>
            resolvePushPullSource(overrides.cwd ?? process.cwd(), input)),
          pushPullArchive: overrides.pushPullArchive
          ,republishArchive: overrides.republishArchive ?? ((change, dryRun) =>
            runRepublishArchive(change, dryRun, {
              cwd: overrides.cwd ?? process.cwd(),
              resourcesRoot: overrides.resourcesRoot ?? process.cwd(),
              stdout: () => undefined,
              stderr: (value) => process.stderr.write(value),
              prompt: async () => "",
              fetch: globalThis.fetch,
              env
            }))
        }),
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
  const dependencies = await defaultDependencies(overrides, {
    healActor: REMOTE_SYNC_COMMANDS.has(argv.find((value) => !value.startsWith("-")) ?? "")
  });
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
    .description("RemoteSync 未配置时安全失败；优先读 HUNTER_REMOTE_SYNC_URL/TOKEN/ACTOR_ID，缺失时回退 connect 写入的 credentials.local.yaml")
    .option("--scope <scopes>", "config,rules,architecture,instructions,branch_files,archive 或 all")
    .option("--branch <branch>", "显式来源分支")
    .option("--change <change-key>", "仅配合 --scope archive 使用")
    .option("--allow-sensitive", "确认所有敏感命中并继续（非交互需配合 --yes）")
    .option("--sensitive-reason <reason>", "记入覆盖证据的原因，配合 --allow-sensitive")
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
    .description("RemoteSync 未配置时安全失败；优先读 HUNTER_REMOTE_SYNC_URL/TOKEN/ACTOR_ID，缺失时回退 connect 写入的 credentials.local.yaml")
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
    .option("--validate", "只做服务端只读预检（不落盘、不占收据），用于排障 422")
    .action(async (options: ArchiveUploadOptions) => {
      exitCode = await runArchiveUpload(
        { ...program.opts<ArchiveUploadOptions>(), ...options },
        dependencies
      );
    });
  const outbox = archive.command("outbox").description("Archive outbox 维护（06B-3 生产接线）");
  outbox.command("gc")
    .description("回收终态 outbox 记录引用的 CAS 对象（默认 dry-run，必须显式 --entry 或 --retain-days）")
    .option("--apply", "实际执行删除（默认只预览）", false)
    .option("--entry <id...>", "显式 entry_id 列表")
    .option("--retain-days <n>", "只回收 updated_at 早于 n 天的终态记录")
    .action(async (options: ArchiveOutboxGcOptions) => {
      exitCode = await runArchiveOutboxGc(options, dependencies);
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
  addCommonOptions(knowledge.command("status"))
    .description("知识管道自查：fence 代数、job 状态计数、可查询条目数（诊断查询为空的缺口）")
    .action(async (options: KnowledgeStatusOptions) => {
      exitCode = await runKnowledgeStatus(
        { ...program.opts<KnowledgeStatusOptions>(), ...options },
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
  const planCmd = program.command("plan").description("Plan v2 产物与最终化");
  planCmd.command("evidence-pack")
    .description("把规划自然产出组装为 plan finalize 可消费的证据包（阶段 14 桥）")
    .option("--input <file>", "结构化规划输入 JSON（intent/审批/tasks/scenarios）")
    .option("--output <file>", "证据包输出路径")
    .option("--print-template", "打印 --input 文件的结构骨架到 stdout 后退出（不读写文件）")
    .action(async (options: PlanEvidencePackOptions) => {
      if (options.printTemplate !== true
        && (options.input === undefined || options.output === undefined)) {
        dependencies.stderr(
          "error: --input 与 --output 为必填；先用 --print-template 获取输入结构骨架\n"
        );
        exitCode = 1;
        return;
      }
      exitCode = await runPlanEvidencePack(options, dependencies);
    });
  planCmd.command("review-record")
    .description("记录对抗评审收据：内部算权威 input_hash/findings_hash 并写回证据包（assurance 发布前用）")
    .option("--input <file>", "证据包 JSON（plan evidence-pack 的产物）")
    .option("--receipt <file>", "收据草稿 JSON：{ reviewer_identity, review_mode?, findings?, completed_at? }")
    .option("--output <file>", "写回路径（缺省覆盖 --input）")
    .option("--renew", "续签现有收据：沿用 findings 重绑重建后 pack 的 input_hash（与 --receipt 互斥）")
    .option("--print-template", "打印合法草稿骨架（findings 键集与 severity 枚举）")
    .action(async (options: PlanReviewRecordOptions) => {
      exitCode = await runPlanReviewRecord(options, dependencies);
    });
  planCmd.command("finalize")
    .description("v2 Plan 最终化：质量门 + FS 发布 + 事件 outbox（输入为编排方产出的结构化证据包）")
    .requiredOption("--input <file>", "结构化证据包 JSON（trusted/publication/context/baseline）")
    .option("--change-dir <path>", "change 目录（默认按 context.change_key 推导）")
    .action(async (options: PlanFinalizeOptions) => {
      exitCode = await runPlanFinalize(options, dependencies);
    });
  planCmd.command("publish")
    .description("HP-18 编排收口：evidence-pack → 基线/attempt 自动记账 →（--renew-review 续签）→ finalize，一条命令发布")
    .requiredOption("--input <file>", "自然输入 JSON（meta/plan-evidence-input.json）")
    .option("--output <file>", "证据包输出路径（缺省与输入同目录的 plan-evidence.json）")
    .option("--change-dir <path>", "change 目录（默认 <cwd>/.harness/changes/<change_key>）")
    .option("--renew-review", "评审收据因重建过期且 findings 未变时自动续签（review-record --renew）")
    .action(async (options: PlanPublishOptions) => {
      exitCode = await runPlanPublish(options, dependencies);
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
    .option(
      "--push [scopes]",
      "体检通过后顺带推送一次；省略值时推 config,rules,architecture,instructions"
    )
    .action(async (options: SyncCommandOptions) => {
      const merged = { ...program.opts<SyncCommandOptions>(), ...options };
      exitCode = await runSync(merged, dependencies);
      // 体检与推送是两件事：sync 的退出码先定下来，推送只在状态可用时追加执行，
      // 且推送失败不会把一次成功的体检改写成失败（反之亦然由 planSyncPush 拦住）。
      const plan = planSyncPush(merged, exitCode);
      if (plan.reasonCode !== undefined) {
        dependencies.stderr(`${plan.reasonCode}\n`);
      }
      if (plan.push && plan.scopes !== undefined) {
        const pushExitCode = await runPushPull(
          "push",
          { ...merged, scope: plan.scopes },
          dependencies
        );
        if (pushExitCode !== 0) exitCode = pushExitCode;
      }
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
  program.command("scan-sensitive")
    .description("用发布同款规则扫描指定文件（归档上传前预检）")
    .option("--file <path...>", "相对 --root 的文件路径，可重复")
    .option("--root <path>", "路径基准目录，默认当前工作目录")
    .option("--json")
    .action(async (options: { file?: string[]; root?: string; json?: boolean }) => {
      exitCode = await runScanSensitive(
        { files: options.file, root: options.root, json: options.json },
        dependencies
      );
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
