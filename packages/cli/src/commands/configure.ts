import {
  initializeProject,
  TargetCollisionError,
  uuidV7
} from "@hunter-harness/core";

import {
  InitConfigurationError,
  resolveInitConfig,
  type InitFlagValues
} from "../config/init-config.js";
import {
  serializeCliResult,
  type CliResult
} from "../output/json.js";
import {
  detectProject,
  runRefresh,
  type RefreshCommandOptions
} from "./refresh.js";

export interface ConfigureOptions extends InitFlagValues {
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  forceManaged?: boolean;
}

export interface CommandDependencies {
  cwd: string;
  resourcesRoot: string;
  stdout(value: string): void;
  stderr(value: string): void;
  prompt(question: string): Promise<string>;
  fetch: typeof globalThis.fetch;
  env: Readonly<Record<string, string | undefined>>;
}

function otherProfile(current: "general" | "java"): "general" | "java" {
  return current === "general" ? "java" : "general";
}

async function runFirstInstall(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  try {
    const warnings: string[] = [];
    const config = await resolveInitConfig(
      dependencies.cwd,
      options,
      options.nonInteractive === true
        ? {}
        : {
          agents: () => dependencies.prompt(
            "请选择目标 Agent（可多选，使用逗号分隔）\n" +
            "  1. Claude Code\n" +
            "  2. Codex\n" +
            "  3. Cursor\n" +
            "  4. CodeBuddy\n" +
            "请输入编号 [1]: "
          ).then((answer) => answer.trim()),
          profile: () => dependencies.prompt(
            "请选择 Harness 类型：\n1. 通用（默认）\n2. Java\n请输入 1 或 2 [1]: "
          ).then((answer) => answer.trim())
        },
      warnings
    );
    for (const warning of warnings) {
      dependencies.stderr(warning + "\n");
    }
    if (options.nonInteractive === true && options.yes !== true &&
        options.dryRun !== true) {
      dependencies.stderr("非交互模式执行写入操作需要 --yes\n");
      return 2;
    }
    const result = await initializeProject({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot,
      config,
      dryRun: options.dryRun === true
    });
    const output: CliResult = {
      schema_version: 1,
      command: "configure",
      request_id: requestId,
      dry_run: options.dryRun === true,
      ok: true,
      exit_code: 0,
      project_id: result.projectConfig.project.project_id,
      summary: { planned: result.paths.length, applied: options.dryRun === true ? 0 : result.paths.length },
      items: result.paths.map((path) => ({ path, status: options.dryRun === true ? "planned" : "applied" })),
      warnings: [],
      errors: []
    };
    dependencies.stdout(options.json === true
      ? serializeCliResult(output)
      : "Hunter Harness 初始化完成，共处理 " + result.paths.length + " 个文件。\n");
    return 0;
  } catch (error) {
    const exitCode = error instanceof TargetCollisionError
      ? 7
      : error instanceof InitConfigurationError
        ? error.exitCode
        : 1;
    const code = error instanceof TargetCollisionError
      ? error.code
      : error instanceof InitConfigurationError
        ? error.code
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr((code !== undefined ? code + ": " : "") + message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "configure",
        request_id: requestId,
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: exitCode,
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

// 既有有效项目：bare 命令进入 Conservative Refresh 流程（design §3.1/§3.3）。
// 交互式呈现 3 选项（刷新当前/切换 profile/取消），非交互式按 --profile 决定 refresh/transition。
async function runExistingProject(
  options: ConfigureOptions,
  dependencies: CommandDependencies,
  currentProfile: "general" | "java"
): Promise<number> {
  // exactOptionalPropertyTypes: 可选属性不接受显式 undefined，按字段条件赋值。
  const refreshOptions: RefreshCommandOptions = {};
  if (options.profile !== undefined) refreshOptions.profile = options.profile;
  if (options.nonInteractive !== undefined) refreshOptions.nonInteractive = options.nonInteractive;
  if (options.yes !== undefined) refreshOptions.yes = options.yes;
  if (options.dryRun !== undefined) refreshOptions.dryRun = options.dryRun;
  if (options.json !== undefined) refreshOptions.json = options.json;
  if (options.forceManaged !== undefined) refreshOptions.forceManaged = options.forceManaged;
  if (options.nonInteractive === true) {
    return runRefresh(refreshOptions, dependencies);
  }
  const menu = await dependencies.prompt(
    `Hunter Harness 已初始化（profile: ${currentProfile}）。\n` +
    "1. 刷新当前配置（默认且推荐）\n" +
    "2. 切换到另一种配置\n" +
    "3. 取消\n" +
    "请选择 [1]: "
  );
  const choice = menu.trim();
  if (choice === "3" || /^c/i.test(choice)) {
    return 2;
  }
  if (choice === "2" || /^s/i.test(choice)) {
    refreshOptions.profile = otherProfile(currentProfile);
  } else {
    refreshOptions.profile = currentProfile;
  }
  refreshOptions.confirmed = true;
  return runRefresh(refreshOptions, dependencies);
}

export async function runConfigure(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const detection = await detectProject(dependencies.cwd);
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
    const currentProfile = (detection.config.project.profiles[0] ?? "general") as "general" | "java";
    return runExistingProject(options, dependencies, currentProfile);
  }
  return runFirstInstall(options, dependencies);
}
