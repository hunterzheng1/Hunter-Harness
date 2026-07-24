import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { CodeBuddySurface } from "@hunter-harness/contracts";

const MANAGED_RULE_NAMES = new Set([
  "harness-general.md", "harness-general.mdc",
  "harness-profile-java.md", "harness-profile-java.mdc"
]);
const SENSITIVE_ASSIGNMENT = /(?:password|passwd|token|secret|access[_-]?key|private[_-]?key)\s*[:=]\s*[^\s#]+/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;

export interface CodeBuddySetupPlan {
  claudeRules: string[];
  currentClaudeRules: string[];
  conflictingClaudeRules: string[];
  hasCodeGraphIndex: boolean;
  codeGraphConfigured: boolean;
}

export interface CodeBuddySetupResult {
  copied: string[];
  preserved: string[];
  skippedSensitive: string[];
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
  projectRoot: string,
  surface: CodeBuddySurface = "both"
): Promise<CodeBuddySetupPlan> {
  const rulesRoot = join(projectRoot, ".claude", "rules");
  let ruleNames: string[] = [];
  try {
    ruleNames = (await readdir(rulesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && [".md", ".mdc"].includes(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .filter((name) => !MANAGED_RULE_NAMES.has(name))
      .sort();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const claudeRules: string[] = [];
  const currentClaudeRules: string[] = [];
  const conflictingClaudeRules: string[] = [];
  for (const name of ruleNames) {
    const sourceContent = await readFile(join(rulesRoot, name), "utf8");
    const targetContents = await Promise.all(
      destinationTargets(projectRoot, surface, name).map(async (target) => {
        try {
          return await readFile(target, "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      })
    );
    if (targetContents.some((content) => content === null)) claudeRules.push(name);
    if (targetContents.some((content) => content !== null && content !== sourceContent)) {
      conflictingClaudeRules.push(name);
    } else if (targetContents.length > 0 && targetContents.every((content) => content === sourceContent)) {
      currentClaudeRules.push(name);
    }
  }
  const mcp = await readJsonObject(join(projectRoot, ".mcp.json"));
  const servers = mcp?.mcpServers;
  const configured = servers !== null && typeof servers === "object" && !Array.isArray(servers) &&
    Object.prototype.hasOwnProperty.call(servers, "codegraph");
  return {
    claudeRules,
    currentClaudeRules,
    conflictingClaudeRules,
    hasCodeGraphIndex: await exists(join(projectRoot, ".codegraph")),
    codeGraphConfigured: configured
  };
}

function destinationTargets(root: string, surface: CodeBuddySurface, name: string): string[] {
  const stem = basename(name, extname(name));
  const targets: string[] = [];
  if (surface !== "cli") targets.push(join(root, ".codebuddy", ".rules", `${stem}.mdc`));
  if (surface !== "ide") targets.push(join(root, ".codebuddy", "rules", `${stem}.md`));
  return targets;
}

export async function applyCodeBuddySetup(options: {
  projectRoot: string;
  surface: CodeBuddySurface;
  syncClaudeRules: boolean;
  configureCodeGraph: boolean;
}): Promise<CodeBuddySetupResult> {
  const result: CodeBuddySetupResult = {
    copied: [], preserved: [], skippedSensitive: [], mcpUpdated: false, warnings: []
  };
  if (options.syncClaudeRules) {
    const plan = await inspectCodeBuddySetup(options.projectRoot, options.surface);
    for (const name of plan.claudeRules) {
      const source = join(options.projectRoot, ".claude", "rules", name);
      const content = await readFile(source, "utf8");
      if (SENSITIVE_ASSIGNMENT.test(content) || PRIVATE_KEY_BLOCK.test(content)) {
        result.skippedSensitive.push(name);
        continue;
      }
      for (const target of destinationTargets(options.projectRoot, options.surface, name)) {
        if (await exists(target)) {
          result.preserved.push(target);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: "utf8", flag: "wx" });
        result.copied.push(target);
      }
    }
  }

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
