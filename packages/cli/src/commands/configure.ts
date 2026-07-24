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
  applyCodeBuddySetup,
  inspectCodeBuddySetup
} from "../config/codebuddy-setup.js";
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

function agentMenuLines(
  installedProfiles?: Partial<Record<HarnessAgent, string>>
): string {
  const lines = HARNESS_AGENT_ORDER.map((agent, index) => {
    const profile = installedProfiles?.[agent];
    const suffix = profile === undefined ? "" : `（已安装：${profile}）`;
    return `  ${index + 1}. ${AGENT_LABELS[agent]}${suffix}`;
  }).join("\n");
  return lines + "\n  5. 全部";
}

async function configureCodeBuddyExtras(
  agents: readonly HarnessAgent[],
  surface: "both" | "ide" | "cli",
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<void> {
  if (!agents.includes("codebuddy")) return;
  const plan = await inspectCodeBuddySetup(dependencies.cwd, surface);
  if (plan.conflictingClaudeRules.length > 0) {
    dependencies.stderr(
      `以下 CodeBuddy 规则与 Claude 源规则内容不同，已保留目标文件：${plan.conflictingClaudeRules.join(", ")}\n`
    );
  }
  let syncClaudeRules = false;
  let configureCodeGraph = false;
  if (plan.claudeRules.length > 0) {
    syncClaudeRules = options.nonInteractive === true
      ? options.yes === true
      : /^(?:|y|yes)$/i.test((await dependencies.prompt(
        `发现 ${plan.claudeRules.length} 个 Claude 自定义规则，是否复制到 CodeBuddy（保留源文件且不覆盖目标）？[Y/n]：`
      )).trim());
  }
  if (plan.hasCodeGraphIndex && !plan.codeGraphConfigured) {
    configureCodeGraph = options.nonInteractive === true
      ? options.yes === true
      : /^(?:|y|yes)$/i.test((await dependencies.prompt(
        "检测到 .codegraph 索引，是否合并 CodeGraph MCP 到项目 .mcp.json？[Y/n]："
      )).trim());
  }
  if (options.dryRun === true) {
    if (syncClaudeRules || configureCodeGraph) {
      dependencies.stdout("CodeBuddy 附加配置处于 dry-run，未写入规则或 .mcp.json。\n");
    }
    return;
  }
  const result = await applyCodeBuddySetup({
    projectRoot: dependencies.cwd,
    surface,
    syncClaudeRules,
    configureCodeGraph
  });
  if (result.copied.length > 0) {
    dependencies.stdout(`已安全复制 ${result.copied.length} 个 CodeBuddy 规则文件。\n`);
  }
  if (result.skippedSensitive.length > 0) {
    dependencies.stderr(
      `检测到 ${result.skippedSensitive.length} 个疑似含凭据的 Claude 规则，已保留原处且未复制。\n`
    );
  }
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
    const config = await resolveInitConfig(
      dependencies.cwd,
      options,
      options.nonInteractive === true
        ? {}
        : {
          agents: () => dependencies.prompt(
            "请选择目标 Agent（可多选，使用逗号分隔）\n" +
            agentMenuLines() +
            "\n请输入编号 [1]: "
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
    await configureCodeBuddyExtras(
      config.agents,
      config.codebuddy_surface,
      options,
      dependencies
    );
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
  currentProfile: "general" | "java",
  currentSurface: "both" | "ide" | "cli"
): Promise<number> {
  // exactOptionalPropertyTypes: 可选属性不接受显式 undefined，按字段条件赋值。
  const refreshOptions: RefreshCommandOptions = {};
  if (options.agents !== undefined) refreshOptions.agents = options.agents;
  if (options.codebuddySurface !== undefined) {
    refreshOptions.codebuddySurface = options.codebuddySurface;
  }
  if (options.profile !== undefined) refreshOptions.profile = options.profile;
  if (options.nonInteractive !== undefined) refreshOptions.nonInteractive = options.nonInteractive;
  if (options.yes !== undefined) refreshOptions.yes = options.yes;
  if (options.dryRun !== undefined) refreshOptions.dryRun = options.dryRun;
  if (options.json !== undefined) refreshOptions.json = options.json;
  if (options.forceManaged !== undefined) refreshOptions.forceManaged = options.forceManaged;
  const installed = await readInstalledAgentConfiguration(dependencies.cwd);
  const currentAgents = installed.agents.length > 0
    ? installed.agents
    : ["claude-code" as const];
  if (options.nonInteractive === true) {
    const selectedAgents = options.agents === undefined
      ? currentAgents
      : parseAgentsInput(options.agents);
    const code = await runRefresh(refreshOptions, dependencies);
    if (code === 0) {
      const surface = options.codebuddySurface === "ide" || options.codebuddySurface === "cli" ||
        options.codebuddySurface === "both" ? options.codebuddySurface : currentSurface;
      await configureCodeBuddyExtras(selectedAgents, surface, options, dependencies);
    }
    return code;
  }
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
      agentMenuLines(installed.profiles) +
      `\n请输入编号 [${defaultSelection}]，或输入 0 取消：`
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
  const selectedAgents = parseAgentsInput(refreshOptions.agents);
  const code = await runRefresh(refreshOptions, dependencies);
  if (code === 0) {
    const surface = options.codebuddySurface === "ide" || options.codebuddySurface === "cli" ||
      options.codebuddySurface === "both" ? options.codebuddySurface : currentSurface;
    await configureCodeBuddyExtras(selectedAgents, surface, options, dependencies);
  }
  return code;
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
    const currentSurface = detection.config.adapter_options?.codebuddy?.surface ?? "both";
    return runExistingProject(options, dependencies, currentProfile, currentSurface);
  }
  return runFirstInstall(options, dependencies);
}
