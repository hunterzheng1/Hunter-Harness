import {
  harnessAgentSchema,
  sortHarnessAgents,
  type CodeBuddySurface,
  type HarnessAgent,
  type ProjectConfig
} from "@hunter-harness/contracts";
import {
  synchronizeProjectRules,
  synchronizeRuleCandidates,
  uuidV7
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { detectProject } from "./refresh.js";
import { parseAgentsInput } from "../config/init-config.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface RulesSyncCommandOptions {
  agents?: string;
  codebuddySurface?: string;
  json?: boolean;
  learn?: boolean;
}

function configuredAgents(config: ProjectConfig): HarnessAgent[] {
  const agents = config.adapters.enabled.flatMap((value) => {
    const parsed = harnessAgentSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  return sortHarnessAgents(agents.length > 0 ? agents : ["claude-code"]);
}

function configuredSurface(config: ProjectConfig, override?: string): CodeBuddySurface {
  const value = override ?? config.adapter_options?.codebuddy?.surface ?? "both";
  if (value === "both" || value === "ide" || value === "cli") return value;
  throw new Error("codebuddy surface 必须为 both、ide 或 cli");
}

export async function runRulesSync(
  options: RulesSyncCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const detection = await detectProject(dependencies.cwd);
  if (detection.status === "absent") {
    dependencies.stderr("尚未初始化 Hunter Harness；请先运行 `hunter-harness`。\n");
    return 3;
  }
  if (detection.status === "invalid") {
    dependencies.stderr("PROJECT_CONFIG_INVALID：.harness/project.yaml 无效\n");
    return 3;
  }
  try {
    const agents = options.agents === undefined
      ? configuredAgents(detection.config)
      : parseAgentsInput(options.agents);
    const projections = await synchronizeProjectRules(
      dependencies.cwd,
      agents,
      configuredSurface(detection.config, options.codebuddySurface)
    );
    const learning = options.learn === false
      ? null
      : await synchronizeRuleCandidates(dependencies.cwd);
    const exitCode = projections.conflicts.length > 0 ? 5 : 0;
    const payload: CliResult = {
      schema_version: 1 as const,
      command: "rules-sync",
      request_id: uuidV7(),
      dry_run: false,
      ok: exitCode === 0,
      exit_code: exitCode,
      project_id: detection.config.project.project_id,
      summary: {
        migrated: projections.migrated.length,
        projected: projections.written.length,
        removed: projections.removed.length,
        unchanged: projections.unchanged.length,
        conflicts: projections.conflicts.length,
        agent_specific: projections.agent_specific.length,
        rule_candidates: learning?.candidates ?? 0
      },
      items: [
        ...projections.migrated.map((path) => ({ path, status: "migrated" })),
        ...projections.written.map((path) => ({ path, status: "projected" })),
        ...projections.agent_specific.map((path) => ({ path, status: "agent-specific" })),
        ...(learning === null ? [] : [{
          path: learning.path,
          status: learning.changed ? "updated" : "unchanged",
          candidates: learning.candidates,
          scanned: learning.scanned
        }])
      ],
      warnings: [
        ...projections.conflicts.map((path) => `规则分歧未覆盖：${path}`),
        ...projections.agent_specific.map((path) => `保留 Agent 专属规则：${path}`)
      ],
      errors: []
    };
    if (options.json === true) {
      dependencies.stdout(serializeCliResult(payload));
    } else {
      dependencies.stdout(
        `规则同步：迁移 ${payload.summary.migrated}，投影 ${payload.summary.projected}，` +
        `冲突 ${payload.summary.conflicts}，候选 ${payload.summary.rule_candidates}。\n`
      );
      for (const warning of payload.warnings) dependencies.stderr(warning + "\n");
    }
    return exitCode;
  } catch (error) {
    dependencies.stderr((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}
