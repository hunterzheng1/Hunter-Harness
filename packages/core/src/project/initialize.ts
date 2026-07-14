import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  canonicalJson,
  baselineManifestSchema,
  initConfigSchema,
  projectConfigSchema,
  sortHarnessAgents,
  type HarnessAgent,
  type InitConfig,
  type ProjectConfig
} from "@hunter-harness/contracts";
import {
  parse as parseYaml,
  stringify as stringifyYaml
} from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import { upsertManagedBlockById } from "../managed/managed-block.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction } from "../transaction/transaction.js";
import { getAdapter, managedTargetsFor } from "./agent-adapters.js";
import {
  AGENTS_CORE_BLOCK_ID,
  AGENTS_MANAGED_BLOCK_CONTENT,
  CLAUDE_BLOCK_ID,
  CLAUDE_MANAGED_BLOCK_CONTENT,
  CODEBUDDY_BLOCK_ID,
  CODEBUDDY_MANAGED_BLOCK_CONTENT
} from "./managed-content.js";
import {
  loadAgentBundle,
  type HarnessProfile,
  type ProjectedBundleFile
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

/** @deprecated Prefer InstalledBundleStateV3 */
export interface InstalledBundleStateV2 {
  schema_version: 2;
  profile: HarnessProfile;
  bundle_version: string;
  bundle_manifest_hash: string;
  installed_at: string;
  files: Array<{ source_path: string; target_path: string; sha256: string }>;
}

export interface InstalledBundleStateV3 {
  schema_version: 3;
  profile: HarnessProfile;
  adapters: HarnessAgent[];
  installed_at: string;
  manifests: Array<{
    adapter: HarnessAgent;
    bundle_version: string;
    bundle_manifest_hash: string;
  }>;
  files: Array<{
    owner: HarnessAgent | "shared";
    source_path: string;
    target_path: string;
    sha256: string;
  }>;
  managed_blocks: Array<{
    owner: HarnessAgent | "shared";
    target_path: string;
    block_id: string;
    content_sha256: string;
  }>;
}

export interface InstalledBundleStateV4 {
  schema_version: 4;
  adapters: HarnessAgent[];
  profiles: Partial<Record<HarnessAgent, HarnessProfile>>;
  installed_at: string;
  manifests: Array<{
    adapter: HarnessAgent;
    profile: HarnessProfile;
    bundle_version: string;
    bundle_manifest_hash: string;
  }>;
  files: InstalledBundleStateV3["files"];
  managed_blocks: InstalledBundleStateV3["managed_blocks"];
}

export class TargetCollisionError extends Error {
  readonly code = "TARGET_COLLISION";
  readonly exitCode = 7;

  constructor(targetPath: string) {
    super(`TARGET_COLLISION: conflicting bytes for ${targetPath}`);
    this.name = "TargetCollisionError";
  }
}

function hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
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

interface OwnedTarget extends ProjectedBundleFile {
  owner: HarnessAgent;
}

function mergeOwnedTargets(owned: OwnedTarget[]): Array<{
  owner: HarnessAgent | "shared";
  source_path: string;
  target_path: string;
  sha256: string;
  bytes: Uint8Array;
}> {
  const byTarget = new Map<string, OwnedTarget[]>();
  for (const item of owned) {
    const list = byTarget.get(item.target_path) ?? [];
    list.push(item);
    byTarget.set(item.target_path, list);
  }
  const merged: Array<{
    owner: HarnessAgent | "shared";
    source_path: string;
    target_path: string;
    sha256: string;
    bytes: Uint8Array;
  }> = [];
  for (const [targetPath, items] of [...byTarget.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const first = items[0];
    if (first === undefined) {
      throw new Error(`missing projected targets for ${targetPath}`);
    }
    for (const item of items.slice(1)) {
      if (!bytesEqual(first.bytes, item.bytes) || first.sha256 !== item.sha256) {
        throw new TargetCollisionError(targetPath);
      }
    }
    const owners = new Set(items.map((item) => item.owner));
    merged.push({
      owner: owners.size === 1 ? first.owner : "shared",
      source_path: first.source_path,
      target_path: targetPath,
      sha256: first.sha256,
      bytes: first.bytes
    });
  }
  return merged.sort((left, right) => {
    const byTarget = left.target_path.localeCompare(right.target_path);
    return byTarget !== 0 ? byTarget : left.source_path.localeCompare(right.source_path);
  });
}

// 首次安装：仅在没有既有 Harness 项目时调用（configure 检测到既有有效项目会改走 refresh）。
// 创建 design §9 的最小 .harness 布局，不预创建 cache/reports/codebase-map 等可选目录。
export async function initializeProject(
  options: InitializeProjectOptions
): Promise<InitializeProjectResult> {
  const root = resolve(options.projectRoot);
  const config = initConfigSchema.parse(options.config);
  const existing = await existingProjectConfig(root);

  const profile = config.profile as HarnessProfile;
  const enabledAgents = sortHarnessAgents(config.agents);
  const surface = config.codebuddy_surface;
  const adapterContext = { profile, codebuddySurface: surface };

  const owned: OwnedTarget[] = [];
  const manifests: InstalledBundleStateV4["manifests"] = [];
  const adaptersIndex: Record<string, {
    instructions: string;
    skills_root: string;
    rules: string[];
  }> = {};
  const skillBundles: Record<string, { registry_version: string; bundle_hash: string }> = {};

  let primaryBundleHash = "";
  let primaryRegistryVersion = "";

  for (const agent of enabledAgents) {
    const bundle = await loadAgentBundle(options.resourcesRoot, profile, agent);
    const adapter = getAdapter(agent);
    const targets = managedTargetsFor(adapter, bundle, adapterContext);
    const bundleHash = sha256Bytes(canonicalJson(bundle.manifest.files));
    if (primaryBundleHash === "") {
      primaryBundleHash = bundleHash;
      primaryRegistryVersion = bundle.manifest.bundle_version;
    }
    manifests.push({
      adapter: agent,
      profile,
      bundle_version: bundle.manifest.bundle_version,
      bundle_manifest_hash: bundleHash
    });
    skillBundles[agent] = {
      registry_version: bundle.manifest.bundle_version,
      bundle_hash: bundleHash
    };
    adaptersIndex[agent] = adapter.contextIndex(adapterContext);
    for (const target of targets) {
      owned.push({ ...target, owner: agent });
    }
  }

  const mergedTargets = mergeOwnedTargets(owned);

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
    adapters: { enabled: enabledAgents },
    ...(enabledAgents.includes("codebuddy")
      ? { adapter_options: { codebuddy: { surface: config.codebuddy_surface } } }
      : {})
  });

  const baseline = baselineManifestSchema.parse({
    schema_version: 1,
    project_id: projectConfig.project.project_id,
    complete_project_version: null,
    artifact_manifest_hash: null,
    latest_artifact_id: null,
    files: {}
  });

  const managedBlocks: InstalledBundleStateV3["managed_blocks"] = [];
  let agentsContent = await readOptional(join(root, "AGENTS.md"));
  agentsContent = upsertManagedBlockById(
    agentsContent,
    AGENTS_CORE_BLOCK_ID,
    AGENTS_MANAGED_BLOCK_CONTENT
  );
  managedBlocks.push({
    owner: "shared",
    target_path: "AGENTS.md",
    block_id: AGENTS_CORE_BLOCK_ID,
    content_sha256: hex(AGENTS_MANAGED_BLOCK_CONTENT)
  });

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
        schema_version: 2,
        project: {
          shared_instructions: "AGENTS.md",
          adapters: adaptersIndex
        },
        knowledge: { index: ".harness/knowledge/index.json" },
        codebase: { map: ".harness/codebase/map", status: "missing" },
        skill_bundles: skillBundles
      }, null, 2) + "\n"
    ],
    [
      ".harness/knowledge/index.json",
      JSON.stringify({ schema_version: 1, generated_at: null, entries: [] }, null, 2) +
        "\n"
    ],
    ["AGENTS.md", agentsContent]
  ]);

  if (enabledAgents.includes("claude-code")) {
    let claudeContent = await readOptional(join(root, "CLAUDE.md"));
    claudeContent = upsertManagedBlockById(
      claudeContent,
      CLAUDE_BLOCK_ID,
      CLAUDE_MANAGED_BLOCK_CONTENT
    );
    files.set("CLAUDE.md", claudeContent);
    managedBlocks.push({
      owner: "claude-code",
      target_path: "CLAUDE.md",
      block_id: CLAUDE_BLOCK_ID,
      content_sha256: hex(CLAUDE_MANAGED_BLOCK_CONTENT)
    });
  }

  if (enabledAgents.includes("codebuddy")) {
    let codebuddyContent = await readOptional(join(root, "CODEBUDDY.md"));
    codebuddyContent = upsertManagedBlockById(
      codebuddyContent,
      CODEBUDDY_BLOCK_ID,
      CODEBUDDY_MANAGED_BLOCK_CONTENT
    );
    files.set("CODEBUDDY.md", codebuddyContent);
    managedBlocks.push({
      owner: "codebuddy",
      target_path: "CODEBUDDY.md",
      block_id: CODEBUDDY_BLOCK_ID,
      content_sha256: hex(CODEBUDDY_MANAGED_BLOCK_CONTENT)
    });
  }

  for (const target of mergedTargets) {
    files.set(target.target_path, target.bytes);
  }

  managedBlocks.sort((left, right) => {
    const byTarget = left.target_path.localeCompare(right.target_path);
    return byTarget !== 0 ? byTarget : left.block_id.localeCompare(right.block_id);
  });

  const installedState: InstalledBundleStateV4 = {
    schema_version: 4,
    adapters: enabledAgents,
    profiles: Object.fromEntries(enabledAgents.map((agent) => [agent, profile])) as Partial<Record<
      HarnessAgent,
      HarnessProfile
    >>,
    installed_at: new Date().toISOString(),
    manifests,
    files: mergedTargets.map((target) => ({
      owner: target.owner,
      source_path: target.source_path,
      target_path: target.target_path,
      sha256: target.sha256
    })),
    managed_blocks: managedBlocks
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
    bundleHash: primaryBundleHash,
    registryVersion: primaryRegistryVersion
  };
}
