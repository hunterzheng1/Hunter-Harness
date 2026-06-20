import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  baselineManifestSchema,
  initConfigSchema,
  projectConfigSchema,
  type InitConfig,
  type ProjectConfig
} from "@hunter-harness/contracts";
import {
  parse as parseYaml,
  stringify as stringifyYaml
} from "yaml";

import { upsertManagedBlock } from "../managed/managed-block.js";
import { loadBootstrapBundle } from "../skill-ir/bundle.js";
import { compileSkill } from "../skill-ir/compiler.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction } from "../transaction/transaction.js";
import { uuidV7 } from "./uuid-v7.js";

export interface InitializeProjectOptions {
  projectRoot: string;
  resourcesRoot: string;
  config: InitConfig;
  dryRun: boolean;
}

export interface InitializeProjectResult {
  projectConfig: ProjectConfig;
  paths: string[];
  bundleHash: string;
  registryVersion: string;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function existingProjectConfig(root: string): Promise<ProjectConfig | null> {
  const path = join(root, ".harness", "project.yaml");
  const content = await readOptional(path);
  return content === "" ? null : projectConfigSchema.parse(parseYaml(content));
}

async function operationFor(
  root: string,
  path: string,
  content: string
): Promise<TransactionOperation> {
  return await exists(join(root, path))
    ? { operation: "modify", path, content }
    : { operation: "add", path, content };
}

export async function initializeProject(
  options: InitializeProjectOptions
): Promise<InitializeProjectResult> {
  const root = resolve(options.projectRoot);
  const config = initConfigSchema.parse(options.config);
  const existing = await existingProjectConfig(root);
  const bundle = await loadBootstrapBundle(options.resourcesRoot);
  const projectConfig = projectConfigSchema.parse({
    harness: { name: "hunter-harness", schema_version: 1 },
    project: {
      name: existing?.project.name ?? basename(root),
      root: ".",
      local_project_key: existing?.project.local_project_key ?? uuidV7(),
      project_id: config.project_id ?? existing?.project.project_id ?? null,
      profiles: [config.profile]
    },
    server: {
      url: config.server_url ?? existing?.server.url ?? null,
      token_env: config.token_env ?? existing?.server.token_env ??
        "HUNTER_HARNESS_TOKEN"
    },
    adapters: { enabled: [config.adapter] }
  });

  const baseline = baselineManifestSchema.parse({
    schema_version: 1,
    project_id: projectConfig.project.project_id,
    complete_project_version: null,
    artifact_manifest_hash: null,
    files: {}
  });
  const agentsContent = upsertManagedBlock(
    await readOptional(join(root, "AGENTS.md")),
    [
      "# Hunter Harness",
      "",
      "Use .harness/context-index.json to route rules, Knowledge, and codebase maps.",
      "Treat .claude/skills/harness-* as editable adapter working copies.",
      "Do not modify .harness/state or .harness/cache directly."
    ].join("\n")
  );
  const claudeContent = upsertManagedBlock(
    await readOptional(join(root, "CLAUDE.md")),
    [
      "@AGENTS.md",
      "",
      "# Hunter Harness",
      "",
      "- Rules: .claude/rules/",
      "- Skills: .claude/skills/harness-*/",
      "- Knowledge: .harness/knowledge/",
      "- Codebase map: .harness/codebase/map/"
    ].join("\n")
  );

  const files = new Map<string, string>([
    [
      ".harness/project.yaml",
      stringifyYaml(projectConfig, { sortMapEntries: true })
    ],
    [
      ".harness/state/baseline/manifest.json",
      JSON.stringify(baseline, null, 2) + "\n"
    ],
    [
      ".harness/context-index.json",
      JSON.stringify({
        schema_version: 1,
        project: { claude_md: "CLAUDE.md", agents_md: "AGENTS.md" },
        rules: [".claude/rules/harness-general.md"],
        knowledge: { index: ".harness/knowledge/index.json" },
        codebase: { map: ".harness/codebase/map", status: "missing" },
        skill_bundle: {
          registry_version: bundle.registryVersion,
          bundle_hash: bundle.bundleHash,
          compiler_version: bundle.compilerVersion
        }
      }, null, 2) + "\n"
    ],
    [
      ".harness/knowledge/index.json",
      JSON.stringify({ schema_version: 1, generated_at: null, entries: [] }, null, 2) +
        "\n"
    ],
    [".harness/knowledge/_candidates/.gitkeep", ""],
    [".harness/knowledge/project-local/.gitkeep", ""],
    [".harness/codebase/map/.gitkeep", ""],
    [".harness/state/local/.gitkeep", ""],
    [".harness/cache/server-artifacts/.gitkeep", ""],
    [".harness/reports/.gitkeep", ""],
    [
      ".harness/README.md",
      "# Hunter Harness\n\nUse npx hunter-harness, update, and push.\n"
    ],
    ["AGENTS.md", agentsContent],
    ["CLAUDE.md", claudeContent],
    [
      ".claude/rules/harness-general.md",
      "# Hunter Harness Rules\n\n- Report evidence honestly.\n- Do not execute destructive actions without confirmation.\n"
    ]
  ]);
  if (config.profile === "java") {
    files.set(
      ".claude/rules/harness-profile-java.md",
      "# Java Profile\n\n- Verify builds and tests with the project build tool.\n"
    );
  }
  for (const skill of bundle.skills) {
    if (skill.profiles[config.profile]?.enabled !== true) {
      continue;
    }
    const compiled = compileSkill(skill, {
      profile: config.profile,
      adapter: config.adapter,
      compilerVersion: bundle.compilerVersion
    });
    files.set(compiled.path, compiled.content);
  }

  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right));
  if (!options.dryRun) {
    const operations = await Promise.all(
      paths.map(async (path) => operationFor(root, path, files.get(path) ?? ""))
    );
    await runTransaction(root, operations);
  }
  return {
    projectConfig,
    paths,
    bundleHash: bundle.bundleHash,
    registryVersion: bundle.registryVersion
  };
}
