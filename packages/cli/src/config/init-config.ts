import { isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";

import {
  harnessAgentSchema,
  HARNESS_AGENT_ORDER,
  initConfigSchema,
  sortHarnessAgents,
  type HarnessAgent,
  type InitConfig
} from "@hunter-harness/contracts";

export interface InitFlagValues {
  agents?: string;
  codebuddySurface?: string;
  profile?: string;
  config?: string;
  serverUrl?: string;
  tokenEnv?: string;
  /** @deprecated legacy flag slot; CLI never published --adapter */
  adapter?: string;
}

export interface InitPrompts {
  agents?: () => Promise<string>;
  profile?: () => Promise<string>;
}

export class InitConfigurationError extends Error {
  readonly exitCode: 3 | 7;
  readonly code: string;

  constructor(
    message: string,
    exitCode: 3 | 7 = 3,
    code = "INIT_CONFIG_INVALID",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "InitConfigurationError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

const AGENT_BY_INDEX: Record<string, HarnessAgent> = {
  "1": "claude-code",
  "2": "codex",
  "3": "cursor",
  "4": "codebuddy"
};

function normalizeProfile(value: unknown): "general" | "java" | undefined {
  if (value === undefined) return undefined;
  if (value === "" || value === "1" || value === "general") return "general";
  if (value === "2" || value === "java") return "java";
  throw new InitConfigurationError("配置类型必须为 general 或 java");
}

export function parseAgentsInput(raw: string): HarnessAgent[] {
  const trimmed = raw.trim();
  if (trimmed === "") return ["claude-code"];
  if (trimmed === "all") return [...HARNESS_AGENT_ORDER];
  const agents: HarnessAgent[] = [];
  for (const token of trimmed.split(",")) {
    const value = token.trim();
    const byIndex = AGENT_BY_INDEX[value];
    if (byIndex !== undefined) {
      agents.push(byIndex);
      continue;
    }
    const byName = harnessAgentSchema.safeParse(value);
    if (byName.success) {
      agents.push(byName.data);
      continue;
    }
    throw new InitConfigurationError(`未知 Agent：${value}`, 3, "AGENT_UNSUPPORTED");
  }
  if (agents.length === 0) {
    throw new InitConfigurationError("Agent 列表为空", 3, "AGENTS_REQUIRED");
  }
  return sortHarnessAgents(agents);
}

function parseAgentsFromConfig(value: unknown): HarnessAgent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InitConfigurationError("Agent 列表为空", 3, "AGENTS_REQUIRED");
  }
  const agents: HarnessAgent[] = [];
  for (const item of value) {
    const parsed = harnessAgentSchema.safeParse(item);
    if (!parsed.success) {
      throw new InitConfigurationError(
        `未知 Agent：${String(item)}`,
        3,
        "AGENT_UNSUPPORTED"
      );
    }
    agents.push(parsed.data);
  }
  return sortHarnessAgents(agents);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export async function resolveInitConfig(
  cwd: string,
  flags: InitFlagValues,
  prompts: InitPrompts = {},
  warnings: string[] = []
): Promise<InitConfig> {
  let fileConfig: Record<string, unknown> = {};
  if (flags.config !== undefined) {
    const path = isAbsolute(flags.config) ? flags.config : join(cwd, flags.config);
    try {
      fileConfig = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new InitConfigurationError(
        "unable to read init config: " +
          (error instanceof Error ? error.message : String(error)),
        3,
        "INIT_CONFIG_INVALID",
        { cause: error }
      );
    }
  }

  const hasConfigAgents = hasOwn(fileConfig, "agents");
  const hasConfigAdapter = hasOwn(fileConfig, "adapter");
  if (hasConfigAgents && hasConfigAdapter) {
    throw new InitConfigurationError(
      "配置不能同时包含 agents 与 adapter",
      3,
      "AGENT_OPTIONS_CONFLICT"
    );
  }

  let agents: HarnessAgent[] | undefined;
  if (hasConfigAgents) {
    agents = parseAgentsFromConfig(fileConfig.agents);
  } else if (hasConfigAdapter) {
    if (fileConfig.adapter !== "claude-code") {
      throw new InitConfigurationError(
        `未知 Agent：${String(fileConfig.adapter)}`,
        3,
        "AGENT_UNSUPPORTED"
      );
    }
    agents = ["claude-code"];
    warnings.push(
      "DEPRECATION: init config field \"adapter\" is deprecated; use \"agents\" instead"
    );
  } else if (flags.agents !== undefined) {
    agents = parseAgentsInput(flags.agents);
  } else if (prompts.agents !== undefined) {
    agents = parseAgentsInput(await prompts.agents());
  } else {
    agents = ["claude-code"];
  }

  const surfaceFromConfig = hasOwn(fileConfig, "codebuddy_surface");
  const surfaceFromFlags = flags.codebuddySurface !== undefined;
  if ((surfaceFromConfig || surfaceFromFlags) && !agents.includes("codebuddy")) {
    throw new InitConfigurationError(
      "未选择 CodeBuddy 时不能指定 codebuddy_surface",
      3,
      "CODEBUDDY_SURFACE_UNUSED"
    );
  }

  const profile = normalizeProfile(
    fileConfig.profile ?? flags.profile ??
      (prompts.profile === undefined ? undefined : await prompts.profile())
  );

  const candidate = {
    agents,
    profile,
    codebuddy_surface: fileConfig.codebuddy_surface ?? flags.codebuddySurface ?? "both",
    server_url: fileConfig.server_url ?? flags.serverUrl ?? null,
    token_env: fileConfig.token_env ?? flags.tokenEnv ?? "HUNTER_HARNESS_TOKEN",
    project_id: fileConfig.project_id ?? null,
    features: fileConfig.features
  };
  if (candidate.profile === undefined) {
    throw new InitConfigurationError("profile is required");
  }
  const parsed = initConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InitConfigurationError(
      "init config schema validation failed: " + parsed.error.message,
      7,
      "INIT_CONFIG_INVALID"
    );
  }
  return parsed.data;
}
