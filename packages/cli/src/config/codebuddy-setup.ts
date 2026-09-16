import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// v1.0：CodeBuddy 双写由固定投影（.codebuddy/skills）承担，不再复制 Claude
// rules 文件；此处只保留 CodeGraph MCP 合并这一个附加配置步骤。

export interface CodeBuddySetupPlan {
  hasCodeGraphIndex: boolean;
  codeGraphConfigured: boolean;
}

export interface CodeBuddySetupResult {
  mcpUpdated: boolean;
  warnings: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    return null;
  }
}

export async function inspectCodeBuddySetup(
  projectRoot: string
): Promise<CodeBuddySetupPlan> {
  const mcp = await readJsonObject(join(projectRoot, ".mcp.json"));
  const servers = mcp?.mcpServers;
  const configured = servers !== null && typeof servers === "object" && !Array.isArray(servers) &&
    Object.prototype.hasOwnProperty.call(servers, "codegraph");
  return {
    hasCodeGraphIndex: await exists(join(projectRoot, ".codegraph")),
    codeGraphConfigured: configured
  };
}

export async function applyCodeBuddySetup(options: {
  projectRoot: string;
  configureCodeGraph: boolean;
}): Promise<CodeBuddySetupResult> {
  const result: CodeBuddySetupResult = { mcpUpdated: false, warnings: [] };

  if (options.configureCodeGraph) {
    const path = join(options.projectRoot, ".mcp.json");
    const current = await readJsonObject(path);
    if (current === null) {
      result.warnings.push(".mcp.json 不是有效 JSON，已保留原文件并跳过 CodeGraph MCP 配置");
    } else {
      const currentServers = current.mcpServers;
      const servers = currentServers !== null && typeof currentServers === "object" &&
        !Array.isArray(currentServers) ? currentServers as Record<string, unknown> : {};
      if (!Object.prototype.hasOwnProperty.call(servers, "codegraph")) {
        const next = {
          ...current,
          mcpServers: {
            ...servers,
            codegraph: { command: "codegraph", args: ["serve", "--mcp"] }
          }
        };
        await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
        result.mcpUpdated = true;
      }
    }
  }
  return result;
}
