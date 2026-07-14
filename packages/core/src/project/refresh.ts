import { createHash } from "node:crypto";
import { readFile, readdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  sortHarnessAgents,
  type CodeBuddySurface,
  type HarnessAgent
} from "@hunter-harness/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import {
  refreshManagedBlockById,
  removeManagedBlock,
  removeManagedBlockById
} from "../managed/managed-block.js";
import { runTransaction } from "../transaction/transaction.js";
import type { TransactionOperation } from "../transaction/journal.js";
import {
  AGENTS_CORE_BLOCK_ID,
  AGENTS_MANAGED_BLOCK_CONTENT,
  CLAUDE_BLOCK_ID,
  CLAUDE_MANAGED_BLOCK_CONTENT,
  CODEBUDDY_BLOCK_ID,
  CODEBUDDY_MANAGED_BLOCK_CONTENT
} from "./managed-content.js";
import {
  loadMigrationManifests,
  loadAgentBundle,
  parseHarnessProfile,
  type HarnessProfile,
  type ProjectedBundleFile
} from "./profile-bundle.js";
import { getAdapter, getAdapters, managedTargetsFor } from "./agent-adapters.js";
import {
  TargetCollisionError,
  type InstalledBundleStateV4
} from "./initialize.js";

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
  profile?: HarnessProfile;
  agents: HarnessAgent[];
  codebuddySurface?: CodeBuddySurface;
  dryRun: boolean;
  forceManaged: boolean;
}

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const CONTEXT_INDEX_PATH = ".harness/context-index.json";

interface InstalledState {
  profile: HarnessProfile | null;
  schemaVersion: number | null;
  adapters: HarnessAgent[];
  profiles: Map<HarnessAgent, HarnessProfile>;
  trusted: Map<string, string>;
  files: InstalledBundleStateV4["files"];
  manifests: InstalledBundleStateV4["manifests"];
  managedBlocks: InstalledBundleStateV4["managed_blocks"];
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
    return {
      profile: null, schemaVersion: null, adapters: [], profiles: new Map(),
      trusted: new Map(), files: [], manifests: [], managedBlocks: []
    };
  }
  let parsed: {
    schema_version?: number;
    profile?: unknown;
    profiles?: unknown;
    adapters?: unknown;
    files?: unknown;
    manifests?: unknown;
    managed_blocks?: unknown;
  };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return {
      profile: null, schemaVersion: null, adapters: [], profiles: new Map(),
      trusted: new Map(), files: [], manifests: [], managedBlocks: []
    };
  }
  const profile = parseHarnessProfile(parsed.profile);
  const trusted = new Map<string, string>();
  if ((parsed.schema_version === 2 || parsed.schema_version === 3 ||
      parsed.schema_version === 4) &&
      Array.isArray(parsed.files)) {
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
  const schemaVersion = typeof parsed.schema_version === "number" ? parsed.schema_version : null;
  const adapters: HarnessAgent[] = (schemaVersion === 3 || schemaVersion === 4) &&
    Array.isArray(parsed.adapters)
    ? sortHarnessAgents(parsed.adapters.filter((value): value is HarnessAgent =>
      value === "claude-code" || value === "codex" || value === "cursor" || value === "codebuddy"
    ))
    : schemaVersion === 1 || schemaVersion === 2 ? ["claude-code"] : [];
  const profiles = new Map<HarnessAgent, HarnessProfile>();
  if (schemaVersion === 4 && parsed.profiles !== null &&
      typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)) {
    for (const agent of adapters) {
      const value = (parsed.profiles as Record<string, unknown>)[agent];
      const agentProfile = parseHarnessProfile(value);
      if (agentProfile !== null) profiles.set(agent, agentProfile);
    }
  } else if (profile !== null) {
    for (const agent of adapters) profiles.set(agent, profile);
  }
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((entry): entry is InstalledBundleStateV4["files"][number] =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { target_path?: unknown }).target_path === "string" &&
      typeof (entry as { source_path?: unknown }).source_path === "string" &&
      typeof (entry as { sha256?: unknown }).sha256 === "string" &&
      ("owner" in entry)
    )
    : [];
  const manifests = schemaVersion === 4 && Array.isArray(parsed.manifests)
    ? parsed.manifests.filter((entry): entry is InstalledBundleStateV4["manifests"][number] =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { adapter?: unknown }).adapter === "string" &&
      typeof (entry as { profile?: unknown }).profile === "string"
    )
    : [];
  const managedBlocks = Array.isArray(parsed.managed_blocks)
    ? parsed.managed_blocks.filter((entry): entry is InstalledBundleStateV4["managed_blocks"][number] =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { target_path?: unknown }).target_path === "string" &&
      typeof (entry as { block_id?: unknown }).block_id === "string"
    )
    : [];
  // schema v1（仅记路径无 hash）：profile 可读，但无 per-file trusted hash → 需迁移 manifest 补足。
  return {
    profile, schemaVersion, adapters, profiles, trusted, files, manifests,
    managedBlocks
  };
}

export interface InstalledAgentConfiguration {
  agents: HarnessAgent[];
  profiles: Partial<Record<HarnessAgent, HarnessProfile>>;
}

/** Read-only view used by the CLI to render the actual multi-Agent state. */
export async function readInstalledAgentConfiguration(
  projectRoot: string
): Promise<InstalledAgentConfiguration> {
  const installed = await readInstalledState(resolve(projectRoot));
  return {
    agents: installed.adapters,
    profiles: Object.fromEntries(installed.adapters.map((agent) => [
      agent,
      installed.profiles.get(agent) ?? installed.profile ?? "general"
    ]))
  };
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
async function pruneEmptyParentDirs(
  root: string, deletedPaths: readonly string[], boundaryPaths: readonly string[]
): Promise<void> {
  const boundaries = new Set(boundaryPaths.map((path) => join(root, path)));
  for (const deleted of deletedPaths) {
    let dir = dirname(join(root, deleted));
    while (dir.startsWith(root) && !boundaries.has(dir)) {
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

async function reconcileContextIndex(
  root: string,
  agents: HarnessAgent[],
  profiles: ReadonlyMap<HarnessAgent, HarnessProfile>,
  manifests: InstalledBundleStateV4["manifests"],
  codebuddySurface: CodeBuddySurface
): Promise<TransactionOperation | null> {
  const existing = await readOptionalText(join(root, CONTEXT_INDEX_PATH));
  const record = {
    schema_version: 2,
    project: {
      shared_instructions: "AGENTS.md",
      adapters: Object.fromEntries(agents.map((agent) => [
        agent, getAdapter(agent).contextIndex({
          profile: profiles.get(agent) ?? "general",
          codebuddySurface
        })
      ]))
    },
    knowledge: { index: ".harness/knowledge/index.json" },
    codebase: { map: ".harness/codebase/map", status: "missing" },
    skill_bundles: Object.fromEntries(manifests.map((manifest) => [
      manifest.adapter,
      { registry_version: manifest.bundle_version, bundle_hash: manifest.bundle_manifest_hash }
    ]))
  };
  const next = JSON.stringify(record, null, 2) + "\n";
  if (existing === next) return null;
  return {
    operation: existing === "" ? "add" : "modify",
    path: CONTEXT_INDEX_PATH,
    content: next
  };
}

async function projectTransitionOperation(
  root: string,
  agents: HarnessAgent[],
  profiles: ReadonlyMap<HarnessAgent, HarnessProfile>,
  codebuddySurface: CodeBuddySurface
): Promise<TransactionOperation | null> {
  const path = ".harness/project.yaml";
  const content = await readOptionalText(join(root, path));
  if (content === "") return null;
  const project = parseYaml(content) as Record<string, unknown>;
  const activeProfiles = [...new Set(agents.map((agent) =>
    profiles.get(agent) ?? "general"
  ))].sort();
  const next = stringifyYaml({
    ...project,
    project: { ...(project.project as object), profiles: activeProfiles },
    adapters: { enabled: agents },
    ...(agents.includes("codebuddy")
      ? { adapter_options: { codebuddy: { surface: codebuddySurface } } }
      : { adapter_options: undefined })
  }, { sortMapEntries: true });
  if (next === content) return null;
  return {
    operation: "modify",
    path,
    content: next
  };
}

interface OwnedTarget extends ProjectedBundleFile {
  owner: HarnessAgent;
}

function mergeTargets(
  targets: OwnedTarget[]
): Array<Omit<OwnedTarget, "owner"> & { owner: HarnessAgent | "shared" }> {
  const grouped = new Map<string, OwnedTarget[]>();
  for (const target of targets) {
    grouped.set(target.target_path, [...(grouped.get(target.target_path) ?? []), target]);
  }
  return [...grouped.entries()].map(([path, values]) => {
    const first = values[0];
    if (first === undefined) throw new TargetCollisionError(path);
    if (values.some((value) => value.sha256 !== first.sha256)) throw new TargetCollisionError(path);
    const owner: HarnessAgent | "shared" = new Set(values.map((value) => value.owner)).size === 1
      ? first.owner
      : "shared";
    return { ...first, owner };
  }).sort((left, right) => left.target_path.localeCompare(right.target_path));
}

async function reconcileMarkdownBlock(
  root: string, fileName: string, blockId: string, content: string, remove: boolean,
  ops: TransactionOperation[], conflicts: RefreshConflict[], preserved: RefreshItem[]
): Promise<void> {
  const original = await readOptionalText(join(root, fileName));
  const synthetic: ProjectedBundleFile = {
    source_path: fileName, target_path: fileName,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: new TextEncoder().encode(content)
  };
  let next: string;
  try {
    if (remove) {
      const hasId = original.includes(`<!-- hunter-harness:start id=${blockId} -->`);
      next = hasId ? removeManagedBlockById(original, blockId) : removeManagedBlock(original);
    } else {
      const refreshed = refreshManagedBlockById(original, blockId, content, { upgradeLegacy: true });
      if (refreshed.conflict) throw new Error("managed block conflict");
      next = refreshed.content;
    }
  } catch {
    const current = original === "" ? null : createHash("sha256").update(original).digest("hex");
    preserved.push(item(synthetic, "preserve", "MALFORMED_MANAGED_BLOCK", current, synthetic.sha256));
    conflicts.push(conflict(synthetic, "MALFORMED_MANAGED_BLOCK", current, synthetic.sha256));
    return;
  }
  if (next !== original) ops.push({
    operation: original === "" ? "add" : "modify", path: fileName, content: next
  });
}

function stateWithoutInstalledAt(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.installed_at;
  return copy;
}

export async function refreshProject(options: RefreshOptions): Promise<RefreshResult> {
  const root = resolve(options.projectRoot);
  const installed = await readInstalledState(root);
  const oldAgents: HarnessAgent[] = installed.adapters.length > 0
    ? installed.adapters
    : ["claude-code"];
  const selectedAgents = sortHarnessAgents(options.agents);
  const selectedSet = new Set<HarnessAgent>(selectedAgents);
  const agents = sortHarnessAgents([...oldAgents, ...selectedAgents]);
  const profiles = new Map(installed.profiles);
  if (options.profile !== undefined) {
    for (const agent of selectedAgents) profiles.set(agent, options.profile);
  }
  const profile = options.profile ?? selectedAgents
    .map((agent) => profiles.get(agent))
    .find((value): value is HarnessProfile => value !== undefined) ??
    installed.profile ?? "general";
  const previousProfile = selectedAgents
    .map((agent) => installed.profiles.get(agent))
    .find((value): value is HarnessProfile => value !== undefined) ?? installed.profile;
  const codebuddySurface = options.codebuddySurface ?? "both";
  const owned: OwnedTarget[] = [];
  const manifests: InstalledBundleStateV4["manifests"] = [];
  for (const agent of agents) {
    const agentProfile = profiles.get(agent) ?? profile;
    profiles.set(agent, agentProfile);
    const bundle = await loadAgentBundle(options.resourcesRoot, agentProfile, agent);
    manifests.push({
      adapter: agent,
      profile: agentProfile,
      bundle_version: bundle.manifest.bundle_version,
      bundle_manifest_hash: sha256Bytes(canonicalJson(bundle.manifest.files))
    });
    // Unselected Agent namespaces are a strict no-op. Their Bundle is loaded
    // only to reconstruct shared metadata when migrating an older state.
    if (selectedSet.has(agent)) {
      const context = { profile: agentProfile, codebuddySurface };
      for (const target of managedTargetsFor(getAdapter(agent), bundle, context)) {
        owned.push({ ...target, owner: agent });
      }
    }
  }
  const newManaged = mergeTargets(owned);
  let trusted = installed.trusted;
  // v1 state 无 per-file hash：按 context-index bundle_hash 匹配 0.1.1 迁移 manifest，
  // 命中则补足可信 hash + 旧投影目标集（含 .claude/skills/agents/* 重复项）。
  let migrationOldPaths: Set<string> | null = null;
  if (installed.schemaVersion === 1 && selectedSet.has("claude-code")) {
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
  } else {
    const oldTargets: ProjectedBundleFile[] = [];
    for (const agent of selectedAgents) {
      const oldProfile = installed.profiles.get(agent) ?? installed.profile;
      if (!oldAgents.includes(agent) || oldProfile === null || oldProfile === undefined) {
        continue;
      }
      const bundle = await loadAgentBundle(options.resourcesRoot, oldProfile, agent);
      oldTargets.push(...managedTargetsFor(getAdapter(agent), bundle, {
        profile: oldProfile,
        codebuddySurface
      }));
    }
    oldOnly = oldTargets.filter((target) => !newTargetSet.has(target.target_path));
  }

  const applied: RefreshItem[] = [];
  const removed: RefreshItem[] = [];
  const preserved: RefreshItem[] = [];
  const unchanged: RefreshItem[] = [];
  const conflicts: RefreshConflict[] = [];
  const ops: TransactionOperation[] = [];
  const newStateFiles: InstalledBundleStateV4["files"] = installed.files.filter((entry) =>
    entry.owner === "shared" || !selectedSet.has(entry.owner)
  );

  for (const target of newManaged) {
    const incoming = target.sha256;
    const current = await fileHex(join(root, target.target_path));
    if (current === null) {
      applied.push(item(target, "add", "MISSING_TARGET", null, incoming));
      ops.push({ operation: "add", path: target.target_path, content: target.bytes });
      newStateFiles.push({ owner: target.owner, source_path: target.source_path, target_path: target.target_path, sha256: incoming });
      continue;
    }
    if (current === incoming) {
      unchanged.push(item(target, "unchanged", "ALREADY_CURRENT", current, incoming));
      newStateFiles.push({ owner: target.owner, source_path: target.source_path, target_path: target.target_path, sha256: incoming });
      continue;
    }
    const trustedHash = trusted.get(target.target_path);
    if ((trustedHash !== undefined && current === trustedHash) || options.forceManaged) {
      const reason: RefreshReason = options.forceManaged ? "FORCE_MANAGED" : "BASELINE_CLEAN";
      applied.push(item(target, "replace", reason, current, incoming));
      ops.push({ operation: "modify", path: target.target_path, content: target.bytes });
      newStateFiles.push({ owner: target.owner, source_path: target.source_path, target_path: target.target_path, sha256: incoming });
    } else {
      const reason: RefreshReason = trustedHash === undefined ? "LEGACY_BASELINE_UNKNOWN" : "LOCAL_MODIFICATION";
      preserved.push(item(target, "preserve", reason, current, incoming));
      conflicts.push(conflict(target, reason, current, incoming));
      if (trustedHash !== undefined) {
        newStateFiles.push({ owner: target.owner, source_path: target.source_path, target_path: target.target_path, sha256: trustedHash });
      }
    }
  }

  for (const target of oldOnly) {
    const current = await fileHex(join(root, target.target_path));
    if (current === null) {
      continue; // 已不存在，无需操作
    }
    // 删除授权只能来自受信旧 Bundle 投影 / migration manifest 的哈希（target.sha256），
    // 不得来自 installed state（§14 / §19.5）。否则被篡改的 state 可让本地已改文件
    // 被误判为 clean 而删除。
    const trustedHash = target.sha256 !== "" ? target.sha256 : undefined;
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

  await reconcileMarkdownBlock(root, "AGENTS.md", AGENTS_CORE_BLOCK_ID, AGENTS_MANAGED_BLOCK_CONTENT, false, ops, conflicts, preserved);
  if (selectedSet.has("claude-code")) {
    await reconcileMarkdownBlock(root, "CLAUDE.md", CLAUDE_BLOCK_ID, CLAUDE_MANAGED_BLOCK_CONTENT, false, ops, conflicts, preserved);
  }
  if (selectedSet.has("codebuddy")) {
    await reconcileMarkdownBlock(root, "CODEBUDDY.md", CODEBUDDY_BLOCK_ID, CODEBUDDY_MANAGED_BLOCK_CONTENT, false, ops, conflicts, preserved);
  }

  const projectOperation = await projectTransitionOperation(
    root, agents, profiles, codebuddySurface
  );
  if (projectOperation !== null) ops.push(projectOperation);
  const contextOperation = await reconcileContextIndex(
    root, agents, profiles, manifests, codebuddySurface
  );
  if (contextOperation !== null) ops.push(contextOperation);

  const managedBlocks = ([
    ...installed.managedBlocks.filter((entry) =>
      entry.owner !== "shared" && !selectedSet.has(entry.owner)
    ),
    {
      owner: "shared", target_path: "AGENTS.md", block_id: AGENTS_CORE_BLOCK_ID,
      content_sha256: createHash("sha256").update(AGENTS_MANAGED_BLOCK_CONTENT).digest("hex")
    },
    ...(selectedSet.has("claude-code") ? [{
      owner: "claude-code" as const, target_path: "CLAUDE.md", block_id: CLAUDE_BLOCK_ID,
      content_sha256: createHash("sha256").update(CLAUDE_MANAGED_BLOCK_CONTENT).digest("hex")
    }] : []),
    ...(selectedSet.has("codebuddy") ? [{
      owner: "codebuddy" as const, target_path: "CODEBUDDY.md", block_id: CODEBUDDY_BLOCK_ID,
      content_sha256: createHash("sha256").update(CODEBUDDY_MANAGED_BLOCK_CONTENT).digest("hex")
    }] : [])
  ] satisfies InstalledBundleStateV4["managed_blocks"]).sort((left, right) =>
    left.target_path.localeCompare(right.target_path) || left.block_id.localeCompare(right.block_id)
  );
  const filesByTarget = new Map(newStateFiles.map((entry) => [entry.target_path, entry]));
  const installedState: InstalledBundleStateV4 = {
    schema_version: 4,
    adapters: agents,
    profiles: Object.fromEntries(agents.map((agent) => [
      agent,
      profiles.get(agent) ?? "general"
    ])),
    installed_at: new Date().toISOString(),
    manifests: manifests.sort((left, right) => left.adapter.localeCompare(right.adapter)),
    files: [...filesByTarget.values()].sort((left, right) => left.target_path.localeCompare(right.target_path) || left.source_path.localeCompare(right.source_path)),
    managed_blocks: managedBlocks
  };
  const existingState = await readOptionalText(join(root, INSTALLED_STATE_PATH));
  let existingParsed: unknown = null;
  try { existingParsed = existingState === "" ? null : JSON.parse(existingState); } catch { /* rewrite invalid state */ }
  if (JSON.stringify(stateWithoutInstalledAt(existingParsed)) !== JSON.stringify(stateWithoutInstalledAt(installedState))) {
    ops.push({
      operation: existingState === "" ? "add" : "modify",
      path: INSTALLED_STATE_PATH,
      content: JSON.stringify(installedState, null, 2) + "\n"
    });
  }

  if (!options.dryRun) {
    await runTransaction(root, ops, { kind: "refresh" });
    await pruneEmptyParentDirs(
      root,
      removed.map((item) => item.target_path),
      getAdapters(selectedAgents).flatMap((adapter) => adapter.pruneBoundaries({
        profile: profiles.get(adapter.name) ?? profile,
        codebuddySurface
      }))
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
