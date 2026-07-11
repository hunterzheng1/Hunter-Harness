import { isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";

import {
  initConfigSchema,
  type InitConfig
} from "@hunter-harness/contracts";

export interface InitFlagValues {
  adapter?: string;
  profile?: string;
  config?: string;
  serverUrl?: string;
  tokenEnv?: string;
}

export class InitConfigurationError extends Error {
  readonly exitCode: 3 | 7;

  constructor(message: string, exitCode: 3 | 7 = 3, options?: ErrorOptions) {
    super(message, options);
    this.name = "InitConfigurationError";
    this.exitCode = exitCode;
  }
}

function normalizeProfile(value: unknown): "general" | "java" | undefined {
  if (value === undefined) return undefined;
  if (value === "" || value === "1" || value === "general") return "general";
  if (value === "2" || value === "java") return "java";
  throw new InitConfigurationError("配置类型必须为 general 或 java");
}

export async function resolveInitConfig(
  cwd: string,
  flags: InitFlagValues,
  promptMissing?: () => Promise<string>
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
        { cause: error }
      );
    }
  }

  const configuredAdapter = fileConfig.adapter ?? flags.adapter ?? "claude-code";
  if (configuredAdapter !== "claude-code") {
    throw new InitConfigurationError("only claude-code is supported");
  }
  const profile = normalizeProfile(
    fileConfig.profile ?? flags.profile ??
      (promptMissing === undefined ? undefined : await promptMissing())
  );
  const candidate = {
    adapter: "claude-code",
    profile,
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
      7
    );
  }
  return parsed.data;
}
