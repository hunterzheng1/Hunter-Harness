import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  canonicalJson,
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

import { sha256Bytes } from "../fs/hash.js";
import { upsertManagedBlock } from "../managed/managed-block.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction } from "../transaction/transaction.js";
import {
  AGENTS_MANAGED_BLOCK_CONTENT,
  CLAUDE_MANAGED_BLOCK_CONTENT
} from "./managed-content.js";
import {
  loadProfileBundle,
  managedTargets,
  type HarnessProfile
} from "./profile-bundle.js";
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

// Installed Bundle state schema v2：记录 per-file trusted hash（hex，无前缀，与 Bundle manifest 一致），
// 供后续 Conservative Refresh 做干净/冲突分类。bundle_manifest_hash 带 sha256: 前缀（与 context-index 一致）。
export interface InstalledBundleStateV2 {
  schema_version: 2;
  profile: HarnessProfile;
  bundle_version: string;
  bundle_manifest_hash: string;
  installed_at: string;
  files: Array<{ source_path: string; target_path: string; sha256: string }>;
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
  content: string | Uint8Array
): Promise<TransactionOperation> {
  return await exists(join(root, path))
    ? { operation: "modify", path, content }
    : { operation: "add", path, content };
}

const INSTALLED_BUNDLE_PATH = ".harness/state/local/installed-harness-bundle.json";

// 首次安装：仅在没有既有 Harness 项目时调用（configure 检测到既有有效项目会改走 refresh）。
// 创建 design §9 的最小 .harness 布局，不预创建 cache/reports/codebase-map 等可选目录。
export async function initializeProject(
  options: InitializeProjectOptions
): Promise<InitializeProjectResult> {
  const root = resolve(options.projectRoot);
  const config = initConfigSchema.parse(options.config);
  const existing = await existingProjectConfig(root);

  const profile = config.profile as HarnessProfile;
  const bundle = await loadProfileBundle(options.resourcesRoot, profile);
  const managed = await managedTargets(options.resourcesRoot, profile);
  const bundleHash = sha256Bytes(canonicalJson(bundle.manifest.files));

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
    // Temporary bridge until multi-agent initialize (Task 8): first agent only.
    adapters: { enabled: [config.agents[0] ?? "claude-code"] }
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
    AGENTS_MANAGED_BLOCK_CONTENT
  );
  const claudeContent = upsertManagedBlock(
    await readOptional(join(root, "CLAUDE.md")),
    CLAUDE_MANAGED_BLOCK_CONTENT
  );

  const files = new Map<string, string | Uint8Array>([
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
          registry_version: bundle.manifest.bundle_version,
          bundle_hash: bundleHash
        }
      }, null, 2) + "\n"
    ],
    [
      ".harness/knowledge/index.json",
      JSON.stringify({ schema_version: 1, generated_at: null, entries: [] }, null, 2) +
        "\n"
    ],
    ["AGENTS.md", agentsContent],
    ["CLAUDE.md", claudeContent]
  ]);

  // 安装受管目标全集（Bundle 投影 + rules），字节原样写入。
  for (const target of managed) {
    files.set(target.target_path, target.bytes);
  }

  // schema-v2 installed state：per-file trusted hash，按 target_path 排序确定性输出。
  const installedState: InstalledBundleStateV2 = {
    schema_version: 2,
    profile,
    bundle_version: bundle.manifest.bundle_version,
    bundle_manifest_hash: bundleHash,
    installed_at: new Date().toISOString(),
    files: managed
      .map((target) => ({
        source_path: target.source_path,
        target_path: target.target_path,
        sha256: target.sha256
      }))
      .sort((left, right) => left.target_path.localeCompare(right.target_path))
  };
  files.set(INSTALLED_BUNDLE_PATH, JSON.stringify(installedState, null, 2) + "\n");

  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right));
  if (!options.dryRun) {
    const writeOperations = await Promise.all(
      [...files.entries()].map(async ([path, content]) => operationFor(root, path, content))
    );
    await runTransaction(root, writeOperations, { kind: "init" });
  }
  return {
    projectConfig,
    paths,
    bundleHash,
    registryVersion: bundle.manifest.bundle_version
  };
}
