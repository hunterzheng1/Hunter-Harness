import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  initConfigSchema,
  type InitConfig
} from "@hunter-harness/contracts";

// v1.0：固定双投影面（.agents/skills + AGENTS.md 与 .codebuddy/skills 派生），
// init 不再有 agents/profile/codebuddy_surface 选择——旧 init 配置文件中的
// 这些字段在此剥离并给出 deprecation warning（软着陆）。

export interface InitFlagValues {
  config?: string;
  serverUrl?: string;
  tokenEnv?: string;
}

export class InitConfigurationError extends Error {
  readonly exitCode = 4;

  constructor(message: string) {
    super(message);
    this.name = "InitConfigurationError";
  }
}

const LEGACY_INIT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["agents", "--agents"],
  ["adapter", "adapter"],
  ["profile", "--profile"],
  ["codebuddy_surface", "--codebuddy-surface"]
];

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function harnessErrorInfo(error: unknown): { code?: string; exitCode?: number } {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {})
  };
}

export async function resolveInitConfig(
  cwd: string,
  flags: InitFlagValues,
  warnings: string[] = []
): Promise<InitConfig> {
  let fileConfig: Record<string, unknown> = {};
  if (flags.config !== undefined) {
    const path = isAbsolute(flags.config) ? flags.config : join(cwd, flags.config);
    try {
      fileConfig = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new InitConfigurationError(`INIT_CONFIG_MISSING: 配置文件不存在：${path}`);
      }
      throw new InitConfigurationError(`INIT_CONFIG_INVALID_JSON: ${path}`);
    }
    if (fileConfig === null || typeof fileConfig !== "object" || Array.isArray(fileConfig)) {
      throw new InitConfigurationError("INIT_CONFIG_INVALID_SHAPE: init config must be an object");
    }
  }
  const legacyFieldFlags = new Map<string, string>(LEGACY_INIT_FIELDS);
  const filteredConfig: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fileConfig)) {
    const flag = legacyFieldFlags.get(key);
    if (flag !== undefined) {
      warnings.push(
        `DEPRECATION: init config 字段 "${key}"（原 ${flag}）已在 v1.0 移除，已忽略`
      );
      continue;
    }
    filteredConfig[key] = entry;
  }
  const candidate = {
    server_url: filteredConfig.server_url ?? flags.serverUrl ?? null,
    token_env: filteredConfig.token_env ?? flags.tokenEnv ?? "HUNTER_HARNESS_TOKEN",
    project_id: filteredConfig.project_id ?? null,
    ...(hasOwn(filteredConfig, "features") ? { features: filteredConfig.features } : {})
  };
  const parsed = initConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InitConfigurationError(
      "INIT_CONFIG_INVALID: " + parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
