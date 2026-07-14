import {
  initializeProject,
  readInstalledAgentConfiguration,
  uuidV7
} from "@hunter-harness/core";
import {
  HARNESS_AGENT_ORDER,
  type HarnessAgent
} from "@hunter-harness/contracts";

import {
  harnessErrorInfo,
  parseAgentsInput,
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
  promptSecret?(question: string): Promise<string>;
  fetch: typeof globalThis.fetch;
  env: Readonly<Record<string, string | undefined>>;
}

const AGENT_LABELS: Record<HarnessAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  codebuddy: "CodeBuddy"
};

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

// 既有项目直接展示真实的多 Agent/Profile 状态，再选择本次要新增或刷新的
// Agent。未选择的命名空间是严格 no-op；不存在隐式停用或卸载。
async function runExistingProject(
  options: ConfigureOptions,
  dependencies: CommandDependencies,
  currentProfile: "general" | "java"
): Promise<number> {
  // exactOptionalPropertyTypes: 可选属性不接受显式 undefined，按字段条件赋值。
  const refreshOptions: RefreshCommandOptions = {};
  if (options.agents !== undefined) refreshOptions.agents = options.agents;
  if (options.profile !== undefined) refreshOptions.profile = options.profile;
  if (options.nonInteractive !== undefined) refreshOptions.nonInteractive = options.nonInteractive;
  if (options.yes !== undefined) refreshOptions.yes = options.yes;
  if (options.dryRun !== undefined) refreshOptions.dryRun = options.dryRun;
  if (options.json !== undefined) refreshOptions.json = options.json;
  if (options.forceManaged !== undefined) refreshOptions.forceManaged = options.forceManaged;
  if (options.nonInteractive === true) {
    return runRefresh(refreshOptions, dependencies);
  }
  const installed = await readInstalledAgentConfiguration(dependencies.cwd);
  const currentAgents = installed.agents.length > 0
    ? installed.agents
    : ["claude-code" as const];
  const currentLines = currentAgents.map((agent) =>
    `- ${AGENT_LABELS[agent]}：${installed.profiles[agent] ?? currentProfile}`
  ).join("\n");

  if (refreshOptions.agents === undefined) {
    const defaultSelection = currentAgents
      .map((agent) => String(HARNESS_AGENT_ORDER.indexOf(agent) + 1))
      .join(",");
    const answer = await dependencies.prompt(
      `Hunter Harness 当前配置：\n${currentLines}\n` +
      "请选择本次要新增或刷新的工具（可多选，逗号分隔；未选择的工具保持不变）：\n" +
      "  1. Claude Code\n" +
      "  2. Codex\n" +
      "  3. Cursor\n" +
      "  4. CodeBuddy\n" +
      `请输入编号 [${defaultSelection}]，或输入 0 取消：`
    );
    if (answer.trim() === "0" || /^c/i.test(answer.trim())) return 2;
    refreshOptions.agents = answer.trim() === ""
      ? currentAgents.join(",")
      : answer.trim();
  }

  if (refreshOptions.profile === undefined) {
    const selected = parseAgentsInput(refreshOptions.agents);
    const selectedProfiles = new Set(selected.flatMap((agent) => {
      const profile = installed.profiles[agent];
      return profile === undefined ? [] : [profile];
    }));
    const defaultProfile = selectedProfiles.size === 1
      ? [...selectedProfiles][0] ?? currentProfile
      : currentProfile;
    const answer = await dependencies.prompt(
      "请选择所选工具使用的 Harness 配置：\n" +
      "  1. 通用\n" +
      "  2. Java\n" +
      `请输入编号 [${defaultProfile === "java" ? "2" : "1"}]：`
    );
    refreshOptions.profile = answer.trim() === "" ? defaultProfile : answer.trim();
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
