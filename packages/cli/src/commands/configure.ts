import {
  ensureHarnessGitignore,
  existingRootInstructionDocuments,
  initializeProject,
  readLocalCredentials,
  resolveRecoveryRoot,
  ROOT_INSTRUCTION_DOCUMENTS,
  uuidV7
} from "@hunter-harness/core";

import {
  harnessErrorInfo,
  resolveInitConfig,
  type InitFlagValues
} from "../config/init-config.js";
import {
  serializeCliResult,
  type CliResult
} from "../output/json.js";
import {
  applyCodeBuddySetup,
  inspectCodeBuddySetup
} from "../config/codebuddy-setup.js";
import {
  detectProject
} from "./refresh.js";
import {
  runPlatformConnectionMenu
} from "./project-menu.js";
import { readCliVersion } from "../version.js";
import {
  formatWorkflowVersionLine,
  readWorkflowFamilyManifest
} from "../workflow-data/resolve.js";

export interface ConfigureOptions extends InitFlagValues {
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  forceManaged?: boolean;
  recoveryRoot?: string;
}

export interface CommandDependencies {
  cwd: string;
  resourcesRoot: string;
  stdout(value: string): void;
  stderr(value: string): void;
  prompt(question: string): Promise<string>;
  promptSecret?(question: string): Promise<string>;
  fetch: typeof globalThis.fetch;
  env: Readonly<Record<string, string | undefined>>;
  /** Actual TTY width when available; preferred over the optional COLUMNS environment hint. */
  terminalColumns?: number;
  /**
   * git 只读命令执行接缝（可选）：plan evidence-pack 的 capabilities 探针与
   * risk_signals 次源使用；缺省为真实 `git` execFile。测试注入假实现以避免
   * 依赖 tmpdir 是不是 git 仓库。
   */
  gitExec?: (args: readonly string[], cwd: string) => Promise<string>;
}

/** v1.0：附加配置只剩 CodeGraph MCP 合并（检测到 .codegraph 索引时）。 */
async function configureAgentExtras(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<void> {
  const plan = await inspectCodeBuddySetup(dependencies.cwd);
  if (!plan.hasCodeGraphIndex || plan.codeGraphConfigured) return;
  const configureCodeGraph = options.nonInteractive === true
    ? options.yes === true
    : /^(?:|y|yes)$/i.test((await dependencies.prompt(
      "检测到 .codegraph 索引，是否合并 CodeGraph MCP 到项目 .mcp.json？[Y/n]："
    )).trim());
  if (!configureCodeGraph) return;
  if (options.dryRun === true) {
    dependencies.stdout("附加配置处于 dry-run，未写入 .mcp.json。\n");
    return;
  }
  const result = await applyCodeBuddySetup({
    projectRoot: dependencies.cwd,
    configureCodeGraph
  });
  if (result.mcpUpdated) dependencies.stdout("已合并 CodeGraph MCP 到 .mcp.json。\n");
  for (const warning of result.warnings) dependencies.stderr(warning + "\n");
}

async function runFirstInstall(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  try {
    const warnings: string[] = [];
    const config = await resolveInitConfig(dependencies.cwd, options, warnings);
    for (const warning of warnings) {
      dependencies.stderr(warning + "\n");
    }
    if (options.nonInteractive === true && options.yes !== true &&
        options.dryRun !== true) {
      dependencies.stderr("非交互模式执行写入操作需要 --yes\n");
      return 2;
    }
    const planTimestamp = new Date().toISOString();
    const preexistingRootDocuments = await existingRootInstructionDocuments(dependencies.cwd);
    const localProjectKey = uuidV7();
    const cliVersion = await readCliVersion();
    const workflowManifest = await readWorkflowFamilyManifest(dependencies.resourcesRoot);
    const recoveryStore = {
      root: options.recoveryRoot ?? resolveRecoveryRoot(dependencies.env)
    };
    const preview = await initializeProject({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot,
      config,
      dryRun: true,
      localProjectKey,
      planTimestamp,
      cliVersion
    });
    const result = options.dryRun === true
      ? preview
      : await initializeProject({
        projectRoot: dependencies.cwd,
        resourcesRoot: dependencies.resourcesRoot,
        config,
        dryRun: false,
        expectedPlanHash: preview.planHash,
        localProjectKey,
        planTimestamp,
        cliVersion,
        recoveryStore
      });
    await configureAgentExtras(options, dependencies);
    const generatedRootDocuments = ROOT_INSTRUCTION_DOCUMENTS.filter((path) =>
      result.paths.includes(path) && !preexistingRootDocuments.has(path)
    );
    const localCredentials = await readLocalCredentials(dependencies.cwd);
    const gitignore = await ensureHarnessGitignore(dependencies.cwd, {
      dryRun: options.dryRun === true,
      generatedRootDocuments,
      platformBound: localCredentials?.server_url !== undefined &&
        localCredentials.token !== undefined && localCredentials.project_id !== undefined
    });
    const outputPaths = gitignore.changed && !result.paths.includes(gitignore.path)
      ? [...result.paths, gitignore.path]
      : result.paths;
    const output: CliResult = {
      schema_version: 1,
      command: "configure",
      request_id: requestId,
      dry_run: options.dryRun === true,
      ok: true,
      exit_code: 0,
      project_id: result.projectConfig.project.project_id,
      summary: { planned: outputPaths.length, applied: options.dryRun === true ? 0 : outputPaths.length },
      items: outputPaths.map((path) => ({ path, status: options.dryRun === true ? "planned" : "applied" })),
      warnings: [
        ...result.legacyWarnings.map((message) => ({
          code: "LEGACY_RESIDUE_DETECTED",
          message
        })),
        ...gitignore.trackedMigrationNotice?.shouldDisplay === true
          ? [{
              code: "TRACKED_HARNESS_FILES_NEED_MIGRATION",
              message: gitignore.trackedMigrationNotice.message,
              paths: gitignore.trackedMigrationNotice.patterns
            }]
          : []
      ],
      errors: [],
      plan_hash: result.planHash,
      recovery_id: result.recoveryId
    };
    dependencies.stdout(options.json === true
      ? serializeCliResult(output)
      : "Hunter Harness 初始化完成，共处理 " + outputPaths.length + " 个文件。\n" +
        formatWorkflowVersionLine(cliVersion, workflowManifest) + "\n" +
        (result.legacyWarnings.length > 0
          ? result.legacyWarnings.map((warning) => `提示：${warning}\n`).join("")
          : "") +
        (gitignore.trackedMigrationNotice?.shouldDisplay === true
          ? `迁移提示：${gitignore.trackedMigrationNotice.message}\n涉及：${gitignore.trackedMigrationNotice.patterns.join("、")}\n`
          : ""));
    if (
      options.nonInteractive !== true &&
      options.dryRun !== true &&
      options.json !== true
    ) {
      return runPlatformConnectionMenu(options, dependencies, "skip");
    }
    return 0;
  } catch (error) {
    const info = harnessErrorInfo(error);
    const exitCode = info.exitCode ?? 1;
    const code = info.code;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr((code !== undefined ? code + ": " : "") + message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "configure",
        request_id: requestId,
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: exitCode as CliResult["exit_code"],
        project_id: null,
        summary: { planned: 0, applied: 0 },
        items: [],
        warnings: [],
        errors: [{ ...(code === undefined ? {} : { code }), message }]
      }));
    }
    return exitCode;
  }
}

export async function runConfigure(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const detection = await detectProject(dependencies.cwd);
  if (detection.status === "partial" || detection.status === "recovery-required") {
    const code = detection.reasonCode;
    const message = detection.status === "partial"
      ? "mature Harness evidence remains but .harness/project.yaml is missing; refusing automatic initialization"
      : "unfinished Harness transactions require recovery before configure can continue";
    dependencies.stderr(`${code}: ${message}\n`);
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "configure",
        request_id: uuidV7(),
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: 6,
        project_id: null,
        summary: { planned: 0, applied: 0 },
        items: [],
        warnings: [],
        errors: [{
          code,
          reasonCode: code,
          message,
          sentinels: detection.sentinels,
          protectedLocalRoots: detection.protectedLocalRoots,
          recoveryActions: [
            "restore .harness/project.yaml from a trusted backup",
            "inspect protected local roots before choosing explicit recovery",
            "run the recovery command for unfinished transactions"
          ],
          ...(detection.status === "recovery-required"
            ? { recoveryTransactions: detection.recoveryTransactions }
            : {})
        }]
      }));
    }
    return 6;
  }
  if (detection.status === "invalid") {
    dependencies.stderr("PROJECT_CONFIG_INVALID: .harness/project.yaml is invalid; not initializing over it.\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "configure",
        request_id: uuidV7(),
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: 3,
        project_id: null,
        summary: { planned: 0, applied: 0 },
        items: [],
        warnings: [],
        errors: [{ code: "PROJECT_CONFIG_INVALID", message: "project.yaml is invalid" }]
      }));
    }
    return 3;
  }
  if (detection.status === "valid") {
    // v1.0：投影面固定，已初始化项目不再有工具/配置选择——非交互直接刷新，
    // 交互进入主菜单。
    const { runRefresh } = await import("./refresh.js");
    if (options.nonInteractive === true) {
      return runRefresh({
        confirmed: true,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.json === undefined ? {} : { json: options.json }),
        ...(options.forceManaged === undefined ? {} : { forceManaged: options.forceManaged }),
        ...(options.recoveryRoot === undefined ? {} : { recoveryRoot: options.recoveryRoot })
      }, dependencies);
    }
    const { runInitializedProjectMenu } = await import("./project-menu.js");
    return runInitializedProjectMenu(options, dependencies);
  }
  return runFirstInstall(options, dependencies);
}

export async function runInit(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const detection = await detectProject(dependencies.cwd);
  if (detection.status !== "valid") {
    return runConfigure(options, dependencies);
  }
  const message = "Hunter Harness is already initialized; use refresh instead";
  dependencies.stderr("PROJECT_ALREADY_INITIALIZED: " + message + "\n");
  if (options.json === true) {
    dependencies.stdout(serializeCliResult({
      schema_version: 1,
      command: "configure",
      request_id: uuidV7(),
      dry_run: options.dryRun === true,
      ok: false,
      exit_code: 6,
      project_id: detection.config.project.project_id,
      summary: { planned: 0, applied: 0 },
      items: [],
      warnings: [],
      errors: [{
        code: "PROJECT_ALREADY_INITIALIZED",
        reasonCode: "PROJECT_ALREADY_INITIALIZED",
        message
      }]
    }));
  }
  return 6;
}
