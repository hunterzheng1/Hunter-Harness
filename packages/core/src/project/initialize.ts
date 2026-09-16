import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
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

import { aggregateInstalledContentHash, sha256Bytes } from "../fs/hash.js";
import { upsertManagedBlockById } from "../managed/managed-block.js";
import { collectProtectedLocalRootsInventory } from "./local-state.js";
import type { TransactionOperation } from "../transaction/journal.js";
import type { RecoveryStoreOptions } from "../transaction/recovery-store.js";
import {
  assertExpectedPlanHash,
  runTransaction,
  transactionPlanHash
} from "../transaction/transaction.js";
import {
  contextIndexEntryFor,
  projectBundleToSurface,
  type ContextIndexEntry
} from "./agent-adapters.js";
import { detectLegacyProjectionResidue, formatLegacyResidueWarnings } from "./legacy.js";
import {
  AGENTS_CORE_BLOCK_ID,
  AGENTS_LEARNED_RULES_BLOCK_ID,
  AGENTS_LEARNED_RULES_EMPTY_CONTENT,
  AGENTS_MANAGED_BLOCK_CONTENT
} from "./managed-content.js";
import {
  PROJECTION_SURFACES,
  loadBundle,
  type LoadedAgentBundle,
  type ProjectedBundleFile,
  type ProjectionSurface
} from "./profile-bundle.js";
import { uuidV7 } from "./uuid-v7.js";

const CONTEXT_INDEX_PATH = ".harness/context-index.json";

async function fileHex(path: string): Promise<string | null> {
  try {
    const data = await readFile(path);
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

async function readExistingSkillBundles(
  root: string
): Promise<Map<string, Record<string, unknown>>> {
  const text = await readOptional(join(root, CONTEXT_INDEX_PATH));
  if (text === "") return new Map();
  try {
    const parsed = JSON.parse(text) as { skill_bundles?: Record<string, Record<string, unknown>> };
    const bundles = parsed.skill_bundles ?? {};
    return new Map(Object.entries(bundles));
  } catch {
    return new Map();
  }
}

export interface InitializeProjectOptions {
  projectRoot: string;
  resourcesRoot: string;
  config: InitConfig;
  dryRun: boolean;
  expectedPlanHash?: string;
  localProjectKey?: string;
  planTimestamp?: string;
  cliVersion?: string;
  recoveryStore?: Omit<RecoveryStoreOptions, "managedPaths">;
}

export interface InitializeProjectResult {
  projectConfig: ProjectConfig;
  paths: string[];
  bundleHash: string;
  registryVersion: string;
  planHash: string;
  recoveryId: string | null;
  /** Pre-1.0 projection residue detected on disk (informational warnings). */
  legacyWarnings: string[];
}

/**
 * v1.0 installed state. Older schema versions (1-4) are not migrated: they are
 * treated as legacy residue — refresh reinstalls from scratch and warns the
 * user to run `npx hunter-harness uninstall` for full cleanup.
 */
export interface InstalledBundleStateV5 {
  schema_version: 5;
  surfaces: ProjectionSurface[];
  installed_at: string;
  manifests: Array<{
    surface: ProjectionSurface;
    bundle_version: string;
    bundle_manifest_hash: string;
  }>;
  files: Array<{
    owner: ProjectionSurface | "shared";
    source_path: string;
    target_path: string;
    sha256: string;
  }>;
  managed_blocks: Array<{
    owner: ProjectionSurface | "shared";
    target_path: string;
    block_id: string;
    content_sha256: string;
  }>;
}

export class TargetCollisionError extends Error {
  readonly code = "TARGET_COLLISION";
  readonly exitCode = 7;

  constructor(targetPath: string) {
    super(`TARGET_COLLISION: conflicting bytes for ${targetPath}`);
    this.name = "TargetCollisionError";
  }
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
  owner: ProjectionSurface;
}

function mergeOwnedTargets(owned: OwnedTarget[]): Array<{
  owner: ProjectionSurface | "shared";
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
    owner: ProjectionSurface | "shared";
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
// v1.0：固定双投影面（.agents/skills + .codebuddy/skills）+ AGENTS.md 单指令文件，
// 无 agent/profile 选择维度。
export async function initializeProject(
  options: InitializeProjectOptions
): Promise<InitializeProjectResult> {
  const root = resolve(options.projectRoot);
  const config = initConfigSchema.parse(options.config);
  const existing = await existingProjectConfig(root);

  // v1.0 hard cutover: pre-1.0 residue is reported, never auto-deleted.
  const legacyWarnings = formatLegacyResidueWarnings(await detectLegacyProjectionResidue(root));

  const owned: OwnedTarget[] = [];
  const manifests: InstalledBundleStateV5["manifests"] = [];
  const adaptersIndex: Record<string, ContextIndexEntry> = {};
  const skillBundles: Record<string, Record<string, unknown>> = {};
  // Preserve per-file verification fields from an existing context-index so
  // re-installs don't churn verifiedAt (retro §5.1 idempotency).
  const existingContextBundles = await readExistingSkillBundles(root);

  let primaryBundleHash = "";
  let primaryRegistryVersion = "";

  // 并行加载各投影面 Bundle（同一 Bundle 由模块级缓存复用，磁盘读互不依赖）。
  const loadedSurfaces = await Promise.all(PROJECTION_SURFACES.map(async (surface) => {
    const bundle = await loadBundle(options.resourcesRoot, surface);
    const targets = projectBundleToSurface(bundle, surface);
    const bundleHash = sha256Bytes(canonicalJson(bundle.manifest.files));
    return { surface, bundle, targets, bundleHash };
  }));
  for (const { surface, bundle, targets, bundleHash } of loadedSurfaces) {
    if (primaryBundleHash === "") {
      primaryBundleHash = bundleHash;
      primaryRegistryVersion = bundle.manifest.bundle_version;
    }
    manifests.push({
      surface,
      bundle_version: bundle.manifest.bundle_version,
      bundle_manifest_hash: bundleHash
    });
    skillBundles[surface] = {
      registry_version: bundle.manifest.bundle_version,
      bundle_hash: bundleHash,
      ...(existingContextBundles.get(surface) ?? {})
    };
    adaptersIndex[surface] = contextIndexEntryFor(surface);
    for (const target of targets) {
      owned.push({ ...target, owner: surface });
    }
  }

  const mergedTargets = mergeOwnedTargets(owned);

  const projectConfig = projectConfigSchema.parse({
    harness: { name: "hunter-harness", schema_version: 1 },
    project: {
      name: existing?.project.name ?? basename(root),
      root: ".",
      local_project_key: existing?.project.local_project_key ??
        options.localProjectKey ?? uuidV7(),
      project_id: config.project_id ?? existing?.project.project_id ?? null
    },
    server: {
      url: config.server_url ?? existing?.server.url ?? null,
      token_env: config.token_env ?? existing?.server.token_env ??
        "HUNTER_HARNESS_TOKEN"
    }
  });

  const baseline = baselineManifestSchema.parse({
    schema_version: 1,
    project_id: projectConfig.project.project_id,
    complete_project_version: null,
    artifact_manifest_hash: null,
    latest_artifact_id: null,
    files: {}
  });

  // AGENTS.md：核心受管块 + 经验规则受管段（幂等 upsert，用户手写内容不受影响）。
  let agentsContent = await readOptional(join(root, "AGENTS.md"));
  agentsContent = upsertManagedBlockById(agentsContent, AGENTS_CORE_BLOCK_ID, AGENTS_MANAGED_BLOCK_CONTENT);
  agentsContent = upsertManagedBlockById(
    agentsContent,
    AGENTS_LEARNED_RULES_BLOCK_ID,
    AGENTS_LEARNED_RULES_EMPTY_CONTENT
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
        schema_version: 2,
        project: {
          shared_instructions: "AGENTS.md",
          adapters: adaptersIndex
        },
        knowledge: {
          source: "remote",
          local_index: null,
          query: "npx hunter-harness knowledge query"
        },
        codebase: { map: ".harness/codebase/map", status: "missing" },
        skill_bundles: skillBundles
      }, null, 2) + "\n"
    ],
    ["AGENTS.md", agentsContent]
  ]);

  for (const target of mergedTargets) {
    files.set(target.target_path, target.bytes);
  }

  const managedBlocks: InstalledBundleStateV5["managed_blocks"] = [
    {
      owner: "shared",
      target_path: "AGENTS.md",
      block_id: AGENTS_CORE_BLOCK_ID,
      content_sha256: sha256Bytes(AGENTS_MANAGED_BLOCK_CONTENT)
    },
    {
      owner: "shared",
      target_path: "AGENTS.md",
      block_id: AGENTS_LEARNED_RULES_BLOCK_ID,
      content_sha256: sha256Bytes(AGENTS_LEARNED_RULES_EMPTY_CONTENT)
    }
  ];

  const installedState: InstalledBundleStateV5 = {
    schema_version: 5,
    surfaces: [...PROJECTION_SURFACES],
    installed_at: options.planTimestamp ?? new Date().toISOString(),
    // 与 refresh.ts 保持同一确定性排序，确保首次 refresh 不改写 state（幂等）。
    manifests: [...manifests].sort((left, right) => left.surface.localeCompare(right.surface)),
    files: mergedTargets.map((target) => ({
      owner: target.owner,
      source_path: target.source_path,
      target_path: target.target_path,
      sha256: target.sha256
    })).sort((left, right) => left.target_path.localeCompare(right.target_path) || left.source_path.localeCompare(right.source_path)),
    managed_blocks: managedBlocks
  };
  files.set(INSTALLED_BUNDLE_PATH, JSON.stringify(installedState, null, 2) + "\n");

  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right));
  const writeOperations = await Promise.all(
    [...files.entries()].map(async ([path, content]) =>
      operationFor(root, path, content)
    )
  );
  const transactionIdentity = {
    kind: "init" as const,
    projectIdentity: projectConfig.project.local_project_key,
    cliVersion: options.cliVersion ?? "unknown",
    targetBundleVersion: primaryRegistryVersion,
    ownershipManifestHash: primaryBundleHash
  };
  const planHash = transactionPlanHash(
    writeOperations,
    transactionIdentity,
    await collectProtectedLocalRootsInventory(root)
  );
  assertExpectedPlanHash(options.expectedPlanHash, planHash);
  let recoveryId: string | null = null;
  if (!options.dryRun) {
    const transaction = await runTransaction(root, writeOperations, {
      ...transactionIdentity,
      ...(options.recoveryStore === undefined
        ? {}
        : {
          recoveryStore: {
            ...options.recoveryStore,
            managedPaths: paths
          }
        })
    });
    recoveryId = transaction.recoveryId;

    // Per-file content verification (retro §5.1): now that managed files are
    // on disk, compute installedContentHash/verificationStatus for each
    // surface and enrich context-index so it carries per-file proof, not
    // just the aggregate bundle hash.
    await enrichContextIndexWithVerification(root, options.resourcesRoot);
  }
  return {
    projectConfig,
    paths,
    bundleHash: primaryBundleHash,
    registryVersion: primaryRegistryVersion,
    planHash,
    recoveryId,
    legacyWarnings
  };
}

async function enrichContextIndexWithVerification(
  root: string,
  resourcesRoot: string
): Promise<void> {
  const contextPath = join(root, CONTEXT_INDEX_PATH);
  const existing = await readOptional(contextPath);
  if (existing === "") return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    return;
  }
  const bundles = (parsed.skill_bundles as Record<string, Record<string, unknown>>) ?? {};
  // 各投影面的盘上文件校验互不依赖，并行执行后统一落盘一份 context-index。
  await Promise.all(PROJECTION_SURFACES.map(async (surface) => {
    const entry = bundles[surface];
    if (!entry) return;
    let loadedBundle: LoadedAgentBundle;
    try {
      loadedBundle = await loadBundle(resourcesRoot, surface);
    } catch {
      return;
    }
    const targets = projectBundleToSurface(loadedBundle, surface);
    const mismatches: Array<{ relpath: string; expected: string; actual: string }> = [];
    const entries: Array<{ relpath: string; sha256: string }> = [];
    // 各目标盘上哈希互不依赖：串行 fileHex（stat + 整文件读）会叠加磁盘时延，
    // 并行读取后再统一汇总。
    const verifications = await Promise.all(targets.map(async (target) => {
      const rel = target.target_path.replace(/\\/g, "/");
      const actual = await fileHex(join(root, target.target_path));
      return { rel, actual, expected: target.sha256 };
    }));
    for (const { rel, actual, expected } of verifications) {
      entries.push({ relpath: rel, sha256: actual ?? "" });
      if (actual === null) {
        mismatches.push({ relpath: rel, expected, actual: "<missing>" });
      } else if (actual !== expected) {
        mismatches.push({ relpath: rel, expected, actual });
      }
    }
    entry.installedContentHash = aggregateInstalledContentHash(entries);
    // Preserve verifiedAt when content is still verified to keep installs
    // idempotent (otherwise the timestamp alone makes context-index churn).
    const newStatus = mismatches.length === 0 ? "verified" : "degraded";
    if (newStatus === "verified" && typeof entry.verifiedAt === "string" && entry.verifiedAt !== "") {
      // keep existing verifiedAt
    } else {
      entry.verifiedAt = new Date().toISOString();
    }
    entry.verificationStatus = newStatus;
    entry.mismatchDetails = mismatches;
  }));
  await writeFile(contextPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}
