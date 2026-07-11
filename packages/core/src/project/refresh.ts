import { createHash } from "node:crypto";
import { readFile, readdir, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJson, projectConfigSchema } from "@hunter-harness/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import { refreshManagedBlock } from "../managed/managed-block.js";
import { runTransaction } from "../transaction/transaction.js";
import type { TransactionOperation } from "../transaction/journal.js";
import {
  AGENTS_MANAGED_BLOCK_CONTENT,
  CLAUDE_MANAGED_BLOCK_CONTENT
} from "./managed-content.js";
import {
  loadMigrationManifests,
  loadProfileBundle,
  managedTargets,
  parseHarnessProfile,
  type HarnessProfile,
  type ProjectedBundleFile
} from "./profile-bundle.js";

// Conservative Refresh：本地安全协调，不触碰 server-backed update 语义（design §2/§3）。
// 分类依据 design §4.3：absent→add；current==incoming→unchanged；current==trusted→干净替换；
// 否则冲突保留（--force-managed 仅对 Bundle 可信目标强制替换）。删除目标只来自 Bundle 差集，
// 永不由本地 state 文件授权（design §4.3 末段）。

export type RefreshReason =
  | "MISSING_TARGET"
  | "BASELINE_CLEAN"
  | "ALREADY_CURRENT"
  | "LOCAL_MODIFICATION"
  | "MALFORMED_MANAGED_BLOCK"
  | "LEGACY_PROFILE_FILE_MODIFIED"
  | "LEGACY_BASELINE_UNKNOWN"
  | "FORCE_MANAGED";

export interface RefreshItem {
  source_path: string;
  target_path: string;
  action: "add" | "replace" | "delete" | "preserve" | "unchanged";
  reason: RefreshReason;
  old_sha256: string | null;
  incoming_sha256: string | null;
}

export interface RefreshConflict {
  source_path: string;
  target_path: string;
  reason: RefreshReason;
  old_sha256: string | null;
  incoming_sha256: string | null;
}

export interface RefreshResult {
  profile: HarnessProfile;
  previous_profile: HarnessProfile | null;
  dry_run: boolean;
  applied: RefreshItem[];
  removed: RefreshItem[];
  preserved: RefreshItem[];
  unchanged: RefreshItem[];
  conflicts: RefreshConflict[];
}

export interface RefreshOptions {
  projectRoot: string;
  resourcesRoot: string;
  profile: HarnessProfile;
  dryRun: boolean;
  forceManaged: boolean;
}

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const CONTEXT_INDEX_PATH = ".harness/context-index.json";

interface InstalledState {
  profile: HarnessProfile | null;
  schemaVersion: number | null;
  trusted: Map<string, string>;
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

async function fileHex(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readInstalledState(root: string): Promise<InstalledState> {
  const content = await readOptionalText(join(root, INSTALLED_STATE_PATH));
  if (content === "") {
    return { profile: null, schemaVersion: null, trusted: new Map() };
  }
  let parsed: { schema_version?: number; profile?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(content) as { schema_version?: number; profile?: unknown; files?: unknown };
  } catch {
    return { profile: null, schemaVersion: null, trusted: new Map() };
  }
  const profile = parseHarnessProfile(parsed.profile);
  const trusted = new Map<string, string>();
  if (parsed.schema_version === 2 && Array.isArray(parsed.files)) {
    for (const entry of parsed.files) {
      if (entry !== null && typeof entry === "object" &&
          "target_path" in entry && "sha256" in entry) {
        const target = (entry as { target_path: unknown }).target_path;
        const sha = (entry as { sha256: unknown }).sha256;
        if (typeof target === "string" && typeof sha === "string") {
          trusted.set(target, sha);
        }
      }
    }
  }
  // schema v1（仅记路径无 hash）：profile 可读，但无 per-file trusted hash → 需迁移 manifest 补足。
  return { profile, schemaVersion: typeof parsed.schema_version === "number" ? parsed.schema_version : null, trusted };
}

async function readContextIndexBundleHash(root: string): Promise<string | null> {
  const content = await readOptionalText(join(root, CONTEXT_INDEX_PATH));
  if (content === "") return null;
  try {
    const record = JSON.parse(content) as { skill_bundle?: { bundle_hash?: unknown } };
    const hash = record.skill_bundle?.bundle_hash;
    return typeof hash === "string" ? hash : null;
  } catch {
    return null;
  }
}

// 删除旧 profile 独有目标后剪除因之变空的父目录（如 .claude/skills/agents/）。
// 边界止于 .claude、.claude/skills、.claude/agents——不删除这些顶层目录，也不越出 .claude。
async function pruneEmptyParentDirs(root: string, deletedPaths: readonly string[]): Promise<void> {
  const claudeRoot = join(root, ".claude");
  const boundaries = new Set([
    claudeRoot,
    join(claudeRoot, "skills"),
    join(claudeRoot, "agents")
  ]);
  for (const deleted of deletedPaths) {
    let dir = dirname(join(root, deleted));
    while (dir.startsWith(claudeRoot) && !boundaries.has(dir)) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        break;
      }
      if (entries.length > 0) break;
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
}

function item(
  target: ProjectedBundleFile,
  action: RefreshItem["action"],
  reason: RefreshReason,
  oldSha: string | null,
  incomingSha: string | null
): RefreshItem {
  return {
    source_path: target.source_path,
    target_path: target.target_path,
    action,
    reason,
    old_sha256: oldSha,
    incoming_sha256: incomingSha
  };
}

function conflict(
  target: ProjectedBundleFile,
  reason: RefreshReason,
  oldSha: string | null,
  incomingSha: string | null
): RefreshConflict {
  return {
    source_path: target.source_path,
    target_path: target.target_path,
    reason,
    old_sha256: oldSha,
    incoming_sha256: incomingSha
  };
}

function sortByTarget<T extends { target_path: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.target_path.localeCompare(right.target_path));
}

async function refreshMarkdownBlock(
  root: string,
  fileName: string,
  blockContent: string,
  ops: TransactionOperation[],
  conflicts: RefreshConflict[],
  preserved: RefreshItem[]
): Promise<void> {
  const original = await readOptionalText(join(root, fileName));
  const current = original === "" ? null : createHash("sha256").update(original).digest("hex");
  const refresh = refreshManagedBlock(original, blockContent);
  const synthetic: ProjectedBundleFile = {
    source_path: fileName,
    target_path: fileName,
    sha256: createHash("sha256").update(blockContent).digest("hex"),
    bytes: new TextEncoder().encode(blockContent)
  };
  if (refresh.conflict) {
    preserved.push(item(synthetic, "preserve", "MALFORMED_MANAGED_BLOCK", current, synthetic.sha256));
    conflicts.push(conflict(synthetic, "MALFORMED_MANAGED_BLOCK", current, synthetic.sha256));
    return;
  }
  if (refresh.content === original) {
    return; // 已是当前块，无需写入
  }
  ops.push({
    operation: original === "" ? "add" : "modify",
    path: fileName,
    content: refresh.content
  });
}

async function reconcileContextIndex(
  root: string,
  bundleVersion: string,
  bundleManifestHash: string
): Promise<TransactionOperation> {
  const existing = await readOptionalText(join(root, CONTEXT_INDEX_PATH));
  let record: Record<string, unknown> = {};
  if (existing !== "") {
    try {
      record = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      record = {};
    }
  }
  if (Object.keys(record).length === 0) {
    record = {
      schema_version: 1,
      project: { claude_md: "CLAUDE.md", agents_md: "AGENTS.md" },
      rules: [".claude/rules/harness-general.md"],
      knowledge: { index: ".harness/knowledge/index.json" },
      codebase: { map: ".harness/codebase/map", status: "missing" }
    };
  }
  record.skill_bundle = {
    registry_version: bundleVersion,
    bundle_hash: bundleManifestHash
  };
  return {
    operation: existing === "" ? "add" : "modify",
    path: CONTEXT_INDEX_PATH,
    content: JSON.stringify(record, null, 2) + "\n"
  };
}

async function profileTransitionOperation(
  root: string,
  previousProfile: HarnessProfile | null,
  profile: HarnessProfile
): Promise<TransactionOperation | null> {
  if (previousProfile === null || previousProfile === profile) return null;
  const path = ".harness/project.yaml";
  const content = await readOptionalText(join(root, path));
  const project = projectConfigSchema.parse(parseYaml(content));
  return {
    operation: "modify",
    path,
    content: stringifyYaml({
      ...project,
      project: { ...project.project, profiles: [profile] }
    }, { sortMapEntries: true })
  };
}

export async function refreshProject(options: RefreshOptions): Promise<RefreshResult> {
  const root = resolve(options.projectRoot);
  const profile = options.profile;
  const newManaged = await managedTargets(options.resourcesRoot, profile);
  const newBundle = await loadProfileBundle(options.resourcesRoot, profile);
  const bundleManifestHash = sha256Bytes(canonicalJson(newBundle.manifest.files));

  const installed = await readInstalledState(root);
  const previousProfile = installed.profile;
  let trusted = installed.trusted;
  // v1 state 无 per-file hash：按 context-index bundle_hash 匹配 0.1.1 迁移 manifest，
  // 命中则补足可信 hash + 旧投影目标集（含 .claude/skills/agents/* 重复项）。
  let migrationOldPaths: Set<string> | null = null;
  if (installed.schemaVersion === 1) {
    const contextHash = await readContextIndexBundleHash(root);
    if (contextHash !== null) {
      const migrations = await loadMigrationManifests(options.resourcesRoot);
      const match = migrations.find((m) =>
        m.bundle_manifest_hash === contextHash && m.profile === installed.profile
      );
      if (match !== undefined) {
        trusted = new Map(match.projection.map((entry) => [entry.target_path, entry.sha256]));
        migrationOldPaths = new Set(match.projection.map((entry) => entry.target_path));
      }
    }
  }

  // Profile Transition：旧 profile 独有目标（仅来自 Bundle 差集或迁移 manifest，绝不来自 state）。
  const newTargetSet = new Set(newManaged.map((target) => target.target_path));
  let oldOnly: ProjectedBundleFile[] = [];
  if (migrationOldPaths !== null) {
    for (const targetPath of migrationOldPaths) {
      if (!newTargetSet.has(targetPath)) {
        oldOnly.push({
          source_path: targetPath,
          target_path: targetPath,
          sha256: trusted.get(targetPath) ?? "",
          bytes: new Uint8Array()
        });
      }
    }
  } else if (previousProfile !== null && previousProfile !== profile) {
    const oldManaged = await managedTargets(options.resourcesRoot, previousProfile);
    oldOnly = oldManaged.filter((target) => !newTargetSet.has(target.target_path));
  }

  const applied: RefreshItem[] = [];
  const removed: RefreshItem[] = [];
  const preserved: RefreshItem[] = [];
  const unchanged: RefreshItem[] = [];
  const conflicts: RefreshConflict[] = [];
  const ops: TransactionOperation[] = [];
  const newStateFiles: Array<{ source_path: string; target_path: string; sha256: string }> = [];

  for (const target of newManaged) {
    const incoming = target.sha256;
    const current = await fileHex(join(root, target.target_path));
    if (current === null) {
      applied.push(item(target, "add", "MISSING_TARGET", null, incoming));
      ops.push({ operation: "add", path: target.target_path, content: target.bytes });
      newStateFiles.push({ source_path: target.source_path, target_path: target.target_path, sha256: incoming });
      continue;
    }
    if (current === incoming) {
      unchanged.push(item(target, "unchanged", "ALREADY_CURRENT", current, incoming));
      newStateFiles.push({ source_path: target.source_path, target_path: target.target_path, sha256: incoming });
      continue;
    }
    const trustedHash = trusted.get(target.target_path);
    if ((trustedHash !== undefined && current === trustedHash) || options.forceManaged) {
      const reason: RefreshReason = options.forceManaged ? "FORCE_MANAGED" : "BASELINE_CLEAN";
      applied.push(item(target, "replace", reason, current, incoming));
      ops.push({ operation: "modify", path: target.target_path, content: target.bytes });
      newStateFiles.push({ source_path: target.source_path, target_path: target.target_path, sha256: incoming });
    } else {
      const reason: RefreshReason = trustedHash === undefined ? "LEGACY_BASELINE_UNKNOWN" : "LOCAL_MODIFICATION";
      preserved.push(item(target, "preserve", reason, current, incoming));
      conflicts.push(conflict(target, reason, current, incoming));
      if (trustedHash !== undefined) {
        newStateFiles.push({ source_path: target.source_path, target_path: target.target_path, sha256: trustedHash });
      }
    }
  }

  for (const target of oldOnly) {
    const current = await fileHex(join(root, target.target_path));
    if (current === null) {
      continue; // 已不存在，无需操作
    }
    const trustedHash = trusted.get(target.target_path);
    const clean = trustedHash !== undefined && current === trustedHash;
    if (clean || options.forceManaged) {
      const reason: RefreshReason = clean ? "BASELINE_CLEAN" : "FORCE_MANAGED";
      removed.push(item(target, "delete", reason, current, null));
      ops.push({ operation: "delete", path: target.target_path });
      // 旧 profile 独有目标删除后不进入新 state。
    } else {
      const reason: RefreshReason = trustedHash === undefined ? "LEGACY_BASELINE_UNKNOWN" : "LEGACY_PROFILE_FILE_MODIFIED";
      preserved.push(item(target, "preserve", reason, current, null));
      conflicts.push(conflict(target, reason, current, null));
      // 保留的旧 profile 冲突文件不再受管（design §8），不进入新 state。
    }
  }

  await refreshMarkdownBlock(
    root, "AGENTS.md", AGENTS_MANAGED_BLOCK_CONTENT, ops, conflicts, preserved
  );
  await refreshMarkdownBlock(
    root, "CLAUDE.md", CLAUDE_MANAGED_BLOCK_CONTENT, ops, conflicts, preserved
  );

  const profileOperation = await profileTransitionOperation(root, previousProfile, profile);
  if (profileOperation !== null) ops.push(profileOperation);

  ops.push(await reconcileContextIndex(root, newBundle.manifest.bundle_version, bundleManifestHash));

  const installedState = {
    schema_version: 2,
    profile,
    bundle_version: newBundle.manifest.bundle_version,
    bundle_manifest_hash: bundleManifestHash,
    installed_at: new Date().toISOString(),
    files: newStateFiles.sort((left, right) => left.target_path.localeCompare(right.target_path))
  };
  ops.push({
    operation: (await exists(join(root, INSTALLED_STATE_PATH))) ? "modify" : "add",
    path: INSTALLED_STATE_PATH,
    content: JSON.stringify(installedState, null, 2) + "\n"
  });

  if (!options.dryRun) {
    await runTransaction(root, ops, { kind: "refresh" });
    await pruneEmptyParentDirs(
      root,
      removed.map((item) => item.target_path)
    );
  }

  return {
    profile,
    previous_profile: previousProfile,
    dry_run: options.dryRun,
    applied: sortByTarget(applied),
    removed: sortByTarget(removed),
    preserved: sortByTarget(preserved),
    unchanged: sortByTarget(unchanged),
    conflicts: sortByTarget(conflicts)
  };
}
