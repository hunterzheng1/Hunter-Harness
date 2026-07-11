import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  projectConfigSchema,
  type ProjectConfig
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import {
  refreshProject,
  uuidV7,
  type HarnessProfile,
  type RefreshResult
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface RefreshCommandOptions {
  profile?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  forceManaged?: boolean;
  confirmed?: boolean;
}

export type ProjectDetection =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; config: ProjectConfig };

export async function detectProject(root: string): Promise<ProjectDetection> {
  let content: string;
  try {
    content = await readFile(join(root, ".harness", "project.yaml"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "absent" };
    }
    throw error;
  }
  const parsed = projectConfigSchema.safeParse(parseYaml(content));
  if (!parsed.success) {
    return { status: "invalid" };
  }
  return { status: "valid", config: parsed.data };
}

function parseProfile(value: string | undefined, current: HarnessProfile): HarnessProfile {
  if (value === undefined || value === "") {
    return current;
  }
  if (value === "1" || value === "general") return "general";
  if (value === "2" || value === "java") return "java";
  throw new Error("profile must be general or java");
}

function summarize(result: RefreshResult): CliResult {
  const items = [
    ...result.applied.map((item) => ({ ...item, status: result.dry_run ? "planned" : "applied" })),
    ...result.removed.map((item) => ({ ...item, status: result.dry_run ? "planned" : "removed" })),
    ...result.preserved.map((item) => ({ ...item, status: "preserved" })),
    ...result.unchanged.map((item) => ({ ...item, status: "unchanged" }))
  ];
  const exitCode = result.conflicts.length > 0 ? 5 : 0;
  return {
    schema_version: 1,
    command: "refresh",
    request_id: uuidV7(),
    dry_run: result.dry_run,
    ok: exitCode === 0,
    exit_code: exitCode,
    project_id: null,
    summary: {
      applied: result.dry_run ? 0 : result.applied.length,
      removed: result.dry_run ? 0 : result.removed.length,
      preserved: result.preserved.length,
      unchanged: result.unchanged.length,
      conflicts: result.conflicts.length
    },
    items,
    warnings: result.conflicts,
    errors: []
  };
}

function renderProfileTransitionPreview(result: RefreshResult): string {
  const items = [
    ...result.applied,
    ...result.removed,
    ...result.preserved,
    ...result.unchanged
  ];
  return "Preview profile transition:\n" + items
    .map((item) => `- ${item.action}: ${item.target_path} (${item.reason})`)
    .join("\n") + "\n";
}

// 显式 `hunter-harness refresh` 与 bare 命令在既有项目上的派发共用此入口；
// 核心协调统一走 core.refreshProject（design §3.4：不复制算法）。
export async function runRefresh(
  options: RefreshCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  const detection = await detectProject(dependencies.cwd);
  if (detection.status === "absent") {
    dependencies.stderr("Hunter Harness is not initialized; run `hunter-harness` first.\n");
    return 3;
  }
  if (detection.status === "invalid") {
    dependencies.stderr("PROJECT_CONFIG_INVALID: .harness/project.yaml is invalid\n");
    return 3;
  }

  const currentProfile = (detection.config.project.profiles[0] ?? "general") as HarnessProfile;
  let targetProfile: HarnessProfile;
  try {
    targetProfile = parseProfile(options.profile, currentProfile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    return 3;
  }

  const dryRun = options.dryRun === true;
  if (targetProfile !== currentProfile && !dryRun) {
    try {
      const preview = await refreshProject({
        projectRoot: dependencies.cwd,
        resourcesRoot: dependencies.resourcesRoot,
        profile: targetProfile,
        dryRun: true,
        forceManaged: options.forceManaged === true
      });
      const rendered = renderProfileTransitionPreview(preview);
      if (options.json === true) {
        dependencies.stderr(rendered);
      } else {
        dependencies.stdout(rendered);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.stderr(message + "\n");
      return 1;
    }
  }
  if (options.confirmed !== true) {
    if (options.nonInteractive === true) {
      if (!options.yes && !dryRun) {
        dependencies.stderr("non-interactive refresh requires --yes\n");
        return 2;
      }
    } else if (!options.yes && !dryRun) {
      const label = targetProfile === currentProfile
        ? `Refresh current profile (${currentProfile})`
        : `Switch profile ${currentProfile} -> ${targetProfile}`;
      const answer = await dependencies.prompt(`${label}? [y/N]: `);
      if (!/^(?:y|yes)$/i.test(answer.trim())) {
        return 2;
      }
    }
  }

  try {
    const result = await refreshProject({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot,
      profile: targetProfile,
      dryRun,
      forceManaged: options.forceManaged === true
    });
    const output = summarize(result);
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({ ...output, request_id: requestId }));
    } else {
      const parts: string[] = [];
      if (result.applied.length > 0) parts.push(`applied ${result.applied.length}`);
      if (result.removed.length > 0) parts.push(`removed ${result.removed.length}`);
      if (result.preserved.length > 0) parts.push(`preserved ${result.preserved.length}`);
      if (result.unchanged.length > 0) parts.push(`unchanged ${result.unchanged.length}`);
      dependencies.stdout(`Harness refresh (${targetProfile}): ${parts.join(", ") || "no changes"}.\n`);
    }
    return output.exit_code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "refresh",
        request_id: requestId,
        dry_run: dryRun,
        ok: false,
        exit_code: 1,
        project_id: null,
        summary: { applied: 0, removed: 0, preserved: 0, unchanged: 0, conflicts: 0 },
        items: [],
        warnings: [],
        errors: [{ message }]
      }));
    }
    return 1;
  }
}
