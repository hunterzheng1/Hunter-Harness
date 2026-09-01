import { createHash } from "node:crypto";
import { readFile, readdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  projectConfigSchema,
  sortHarnessAgents,
  type CodeBuddySurface,
  type HarnessAgent
} from "@hunter-harness/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { aggregateInstalledContentHash, sha256Bytes } from "../fs/hash.js";
import { assessCodebaseMapOnDisk } from "../codebase/map.js";
import { collectProtectedLocalRootsInventory } from "./local-state.js";
import type { RecoveryStoreOptions } from "../transaction/recovery-store.js";
import {
  assertExpectedPlanHash,
  runTransaction,
  transactionPlanHash
} from "../transaction/transaction.js";
import type { TransactionOperation } from "../transaction/journal.js";
import {
  loadMigrationManifests,
  loadAgentBundle,
  parseHarnessProfile,
  type HarnessProfile,
  type LoadedAgentBundle,
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
  /** Hash of the canonical bundle source that refresh did not apply. */
  source_content_sha256: string | null;
  /** Hash of the locally edited adapter target that refresh preserved. */
  adapter_content_sha256: string | null;
  /** Last trusted projection hash, when a baseline is available. */
  baseline_content_sha256: string | null;
  old_sha256: string | null;
  incoming_sha256: string | null;
  diff_summary: {
    kind: "CONTENT_DIFFERENT" | "SOURCE_REMOVED";
    source_bytes: number | null;
    adapter_bytes: number | null;
    source_lines: number | null;
    adapter_lines: number | null;
  };
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
  plan_hash: string;
  recovery_id: string | null;
}

export interface RefreshOptions {
  projectRoot: string;
  resourcesRoot: string;
  profile?: HarnessProfile;
  agents: HarnessAgent[];
  /** Explicit uninstall set. Unselected agents remain a no-op; only these are removed. */
  removeAgents?: HarnessAgent[];
  codebuddySurface?: CodeBuddySurface;
  dryRun: boolean;
  forceManaged: boolean;
  expectedPlanHash?: string;
  planTimestamp?: string;
  cliVersion?: string;
  recoveryStore?: Omit<RecoveryStoreOptions, "managedPaths">;
}

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const CONTEXT_INDEX_PATH = ".harness/context-index.json";
const RETIRED_ARCHIVE_RENDERER_TARGETS: Readonly<Record<HarnessAgent, string>> = {
  "claude-code": ".claude/skills/harness-archive/templates/render-summary.mjs",
  codex: ".agents/skills/harness-archive/templates/render-summary.mjs",
  cursor: ".cursor/skills/harness-archive/templates/render-summary.mjs",
  codebuddy: ".codebuddy/skills/harness-archive/templates/render-summary.mjs",
  pi: ".pi/skills/harness-archive/templates/render-summary.mjs"
};
const RETIRED_ARCHIVE_RENDERER_HASHES = new Set([
  "fb171bc2a3aaa3a99bf298f3d9697f9dd7025881b0437851a7af4937d224ef30",
  "6fab9fab77dae08f6e111342a5245e8efbf1faa683db1d379e480076618d22af",
  "fbfde9bdf16dba8aff1ef638e582a517064e81ea4681ed4831ff2e7c55f5ab9c",
  "f15d2b541649fe677d56de46bc7ac8deccaeab12e57c530f5cd64fb340f17df4",
  "7478a27f71b006b206443fee7ac8c2ee9722d21c78e6b2a82d3a1300de41d391",
  "7cd1b29dab74510048a0077a7363775f19f47010ba8d46553b88755335e73496",
  "9e027c4c26dc5d076c35bb485fc618929d425b1f2b0ac097d45caad9817b29b4",
  "57547ca3c3a4c967ef1e0dc7778249e5b6cfb1a32517d975145db8af371ceff4",
  "b437798e93e4bf1afc31305de9e448e4f292ed57513b059ffab59bc53f6dc347",
  "6f5198906276a80859e1dc17793113c39dea8fb510c51678e0c1f91e40fddfa0",
  "a4d1a98de2cf6a6ab74ddba33b6529459f7f5b009f31c5a7021f6abe2c0afef0",
  "970585dcd1c590a6fc985289954b60c41b2cf012df7ea2dd790260e452e404c9"
]);

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
      value === "claude-code" || value === "codex" || value === "cursor" || value === "codebuddy" ||
      value === "pi"
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

async function conflict(
  root: string,
  target: ProjectedBundleFile,
  reason: RefreshReason,
  oldSha: string | null,
  incomingSha: string | null,
  baselineSha: string | null
): Promise<RefreshConflict> {
  let adapterBytes: number | null = null;
  let adapterLines: number | null = null;
  if (oldSha !== null) {
    try {
      const adapterContent = await readFile(join(root, target.target_path));
      adapterBytes = adapterContent.byteLength;
      adapterLines = new TextDecoder().decode(adapterContent).split("\n").length;
    } catch {
      // Hash evidence remains useful even if a concurrent edit removes the target.
    }
  }
  const sourcePresent = incomingSha !== null;
  return {
    source_path: target.source_path,
    target_path: target.target_path,
    reason,
    source_content_sha256: incomingSha,
    adapter_content_sha256: oldSha,
    baseline_content_sha256: baselineSha,
    old_sha256: oldSha,
    incoming_sha256: incomingSha,
    diff_summary: {
      kind: sourcePresent ? "CONTENT_DIFFERENT" : "SOURCE_REMOVED",
      source_bytes: sourcePresent ? target.bytes.byteLength : null,
      adapter_bytes: adapterBytes,
      source_lines: sourcePresent
        ? new TextDecoder().decode(target.bytes).split("\n").length
        : null,
      adapter_lines: adapterLines
    }
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
  codebuddySurface: CodeBuddySurface,
  verifications: ReadonlyMap<HarnessAgent, FreshnessIdentity>
): Promise<TransactionOperation | null> {
  const existing = await readOptionalText(join(root, CONTEXT_INDEX_PATH));
  let existingSkillBundles: Record<string, Record<string, unknown>> = {};
  try {
    const parsed = JSON.parse(existing) as {
      skill_bundles?: Record<string, Record<string, unknown>>;
    };
    existingSkillBundles = parsed.skill_bundles ?? {};
  } catch {
    // Invalid context-index is replaced by the fully validated projection.
  }
  const mapAssessment = await assessCodebaseMapOnDisk(root);
  const codebase: { map: string; status: "missing" | "stale" | "fresh" } = {
    map: ".harness/codebase/map",
    status: mapAssessment.status
  };
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
    knowledge: {
      source: "remote",
      local_index: null,
      query: "npx hunter-harness knowledge query"
    },
    codebase,
    skill_bundles: Object.fromEntries(manifests.map((manifest) => {
      const ver = verifications.get(manifest.adapter as HarnessAgent);
      const previous = existingSkillBundles[manifest.adapter];
      const mismatchDetails = ver?.mismatchDetails ?? [];
      const verificationUnchanged = previous !== undefined &&
        previous.registry_version === manifest.bundle_version &&
        previous.bundle_hash === manifest.bundle_manifest_hash &&
        previous.installedContentHash === (ver?.installedContentHash ?? null) &&
        previous.verificationStatus === (ver?.verificationStatus ?? "unknown") &&
        JSON.stringify(previous.mismatchDetails ?? []) ===
          JSON.stringify(mismatchDetails);
      return [
        manifest.adapter,
        {
          registry_version: manifest.bundle_version,
          bundle_hash: manifest.bundle_manifest_hash,
          installedContentHash: ver?.installedContentHash ?? null,
          verifiedAt: verificationUnchanged
            ? previous.verifiedAt ?? null
            : ver?.verifiedAt ?? null,
          verificationStatus: ver?.verificationStatus ?? "unknown",
          mismatchDetails
        }
      ];
    }))
  };
  const next = JSON.stringify(record, null, 2) + "\n";
  if (existing === next) return null;
  return {
    operation: existing === "" ? "add" : "modify",
    path: CONTEXT_INDEX_PATH,
    content: next
  };
}

async function projectedFileHex(
  root: string,
  path: string,
  operations: readonly TransactionOperation[]
): Promise<string | null> {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation === undefined) continue;
    if (operation.operation === "rename") {
      if (operation.to_path === path) {
        return createHash("sha256").update(operation.content).digest("hex");
      }
      if (operation.from_path === path) return null;
      continue;
    }
    if (operation.path !== path) continue;
    if (operation.operation === "delete") return null;
    return createHash("sha256").update(operation.content).digest("hex");
  }
  return fileHex(join(root, path));
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
  const removeSet = new Set<HarnessAgent>(sortHarnessAgents(options.removeAgents ?? []));
  const selectedAgents = sortHarnessAgents(options.agents);
  const selectedSet = new Set<HarnessAgent>(selectedAgents);
  const agents = sortHarnessAgents(
    [...new Set([...oldAgents, ...selectedAgents])].filter((agent) => !removeSet.has(agent))
  );
  if (agents.length === 0) {
    throw new Error("不能移除全部工具，请至少保留一个。");
  }
  const profiles = new Map(installed.profiles);
  for (const agent of removeSet) profiles.delete(agent);
  if (options.profile !== undefined) {
    for (const agent of selectedAgents) {
      if (!removeSet.has(agent)) profiles.set(agent, options.profile);
    }
  }
  const profile = options.profile ?? selectedAgents
    .map((agent) => profiles.get(agent))
    .find((value): value is HarnessProfile => value !== undefined) ??
    agents
      .map((agent) => profiles.get(agent))
      .find((value): value is HarnessProfile => value !== undefined) ??
    installed.profile ?? "general";
  const previousProfile = selectedAgents
    .map((agent) => installed.profiles.get(agent))
    .find((value): value is HarnessProfile => value !== undefined) ?? installed.profile;
  const codebuddySurface = options.codebuddySurface ?? "both";
  const owned: OwnedTarget[] = [];
  const manifests: InstalledBundleStateV4["manifests"] = [];
  // 并行加载各 Agent Bundle：同一 Bundle 在进程内由模块级缓存复用，
  // 多 Agent 的磁盘读（每个 ~718 文件 + 逐文件 sha256 校验）互不依赖，
  // 串行会放大 Windows 上的 I/O 时延（实测 --agents all 加载占大头）。
  const loadedAgents = await Promise.all(agents.map(async (agent) => {
    const agentProfile = profiles.get(agent) ?? profile;
    profiles.set(agent, agentProfile);
    const bundle = await loadAgentBundle(options.resourcesRoot, agentProfile, agent);
    return { agent, agentProfile, bundle };
  }));
  for (const { agent, agentProfile, bundle } of loadedAgents) {
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
    const agentsForOldTargets = sortHarnessAgents([
      ...selectedAgents,
      ...[...removeSet].filter((agent) => oldAgents.includes(agent))
    ]);
    for (const agent of agentsForOldTargets) {
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
  const remainingOwnerSet = new Set<HarnessAgent | "shared">(["shared", ...agents]);
  const newStateFiles: InstalledBundleStateV4["files"] = installed.files.filter((entry) =>
    remainingOwnerSet.has(entry.owner) &&
    (entry.owner === "shared" || !selectedSet.has(entry.owner))
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
      conflicts.push(await conflict(
        root,
        target,
        reason,
        current,
        incoming,
        trustedHash ?? null
      ));
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
      conflicts.push(await conflict(
        root,
        target,
        reason,
        current,
        null,
        trustedHash ?? null
      ));
      // 保留的旧 profile 冲突文件不再受管（design §8），不进入新 state。
    }
  }

  // `final-summary.html` 已由平台监控取代。这里仅删除路径与内容哈希都在
  // 内置退役清单中的旧渲染器；本地改写过的同名文件继续保留，且本地 state
  // 不能伪造删除授权。
  const oldOnlyTargets = new Set(oldOnly.map((target) => target.target_path));
  for (const agent of selectedAgents) {
    const targetPath = RETIRED_ARCHIVE_RENDERER_TARGETS[agent];
    if (newTargetSet.has(targetPath) || oldOnlyTargets.has(targetPath)) continue;
    const current = await fileHex(join(root, targetPath));
    if (current === null) continue;
    const target: ProjectedBundleFile = {
      source_path: "harness-archive/templates/render-summary.mjs",
      target_path: targetPath,
      sha256: "",
      bytes: new Uint8Array()
    };
    const clean = RETIRED_ARCHIVE_RENDERER_HASHES.has(current);
    if (clean || options.forceManaged) {
      removed.push(item(
        target,
        "delete",
        clean ? "BASELINE_CLEAN" : "FORCE_MANAGED",
        current,
        null
      ));
      ops.push({ operation: "delete", path: targetPath });
    } else {
      preserved.push(item(
        target,
        "preserve",
        "LEGACY_PROFILE_FILE_MODIFIED",
        current,
        null
      ));
      conflicts.push(await conflict(
        root,
        target,
        "LEGACY_PROFILE_FILE_MODIFIED",
        current,
        null,
        null
      ));
    }
  }

  const projectOperation = await projectTransitionOperation(
    root, agents, profiles, codebuddySurface
  );
  if (projectOperation !== null) ops.push(projectOperation);

  // Verify the planned post-transaction view for every installed adapter.
  // Selected agents control writes; they must not make unselected adapters
  // regress from verified to unknown.
  const verifications = new Map<HarnessAgent, FreshnessIdentity>();
  for (const agent of agents) {
    const agentProfile = profiles.get(agent) ?? profile;
    let bundleForVerify: LoadedAgentBundle;
    try {
      bundleForVerify = await loadAgentBundle(options.resourcesRoot, agentProfile, agent);
    } catch {
      continue;
    }
    const verifyTargets = managedTargetsFor(getAdapter(agent), bundleForVerify, {
      profile: agentProfile,
      codebuddySurface
    });
    const verifyMismatches: Array<{ relpath: string; expected: string; actual: string }> = [];
    const verifyEntries: Array<{ relpath: string; sha256: string }> = [];
    for (const target of verifyTargets) {
      const rel = target.target_path.replace(/\\/g, "/");
      const actual = await projectedFileHex(root, target.target_path, ops);
      verifyEntries.push({ relpath: rel, sha256: actual ?? "" });
      if (actual === null) {
        verifyMismatches.push({ relpath: rel, expected: target.sha256, actual: "<missing>" });
      } else if (actual !== target.sha256) {
        verifyMismatches.push({ relpath: rel, expected: target.sha256, actual });
      }
    }
    verifications.set(agent, {
      adapter: agent,
      bundleVersion: bundleForVerify.manifest.bundle_version,
      installedBundleVersion: null,
      manifestHash: null,
      installedManifestHash: null,
      coreHash: null,
      installedCoreHash: null,
      adapterHash: null,
      installedAdapterHash: null,
      installedContentHash: aggregateInstalledContentHash(verifyEntries),
      verifiedAt: options.planTimestamp ?? new Date().toISOString(),
      verificationStatus: verifyMismatches.length === 0 ? "verified" : "degraded",
      mismatchDetails: verifyMismatches
    });
  }

  const contextOperation = await reconcileContextIndex(
    root, agents, profiles, manifests, codebuddySurface, verifications
  );
  if (contextOperation !== null) ops.push(contextOperation);

  const managedBlocks: InstalledBundleStateV4["managed_blocks"] = [];
  const filesByTarget = new Map(newStateFiles.map((entry) => [entry.target_path, entry]));
  const installedState: InstalledBundleStateV4 = {
    schema_version: 4,
    adapters: agents,
    profiles: Object.fromEntries(agents.map((agent) => [
      agent,
      profiles.get(agent) ?? "general"
    ])),
    installed_at: options.planTimestamp ?? new Date().toISOString(),
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

  const projectConfigText = await readOptionalText(
    join(root, ".harness", "project.yaml")
  );
  const parsedProject = projectConfigSchema.safeParse(
    parseYaml(projectConfigText)
  );
  const transactionIdentity = {
    kind: "refresh" as const,
    projectIdentity: parsedProject.success
      ? parsedProject.data.project.local_project_key
      : sha256Bytes(resolve(root).replaceAll("\\", "/")),
    cliVersion: options.cliVersion ?? "unknown",
    targetBundleVersion: manifests
      .map((item) => item.bundle_version)
      .sort()
      .join("+") || "unknown",
    ownershipManifestHash: sha256Bytes(canonicalJson(manifests))
  };
  const planHash = transactionPlanHash(
    ops,
    transactionIdentity,
    await collectProtectedLocalRootsInventory(root)
  );
  assertExpectedPlanHash(options.expectedPlanHash, planHash);
  let recoveryId: string | null = null;
  if (!options.dryRun && ops.length > 0) {
    const transaction = await runTransaction(root, ops, {
      ...transactionIdentity,
      ...(options.recoveryStore === undefined
        ? {}
        : {
          recoveryStore: {
            ...options.recoveryStore,
            managedPaths: ops.flatMap((operation) =>
              operation.operation === "rename"
                ? [operation.from_path, operation.to_path]
                : [operation.path]
            )
          }
        })
    });
    recoveryId = transaction.recoveryId;
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
    conflicts: sortByTarget(conflicts),
    plan_hash: planHash,
    recovery_id: recoveryId
  };
}

// ---------------------------------------------------------------------------
// Post-adaptation freshness projection（变更簇 D / task 12，RET-29..33）。
//
// 只读：复用 loadAgentBundle + managedTargetsFor 的 post-adaptation projection，
// 绝不调用 raw build 产物做字节比较。六态判定顺序（implementation-detail §5.1）：
//   1. identity/schema 不足 → UNVERIFIABLE
//   2. agent/profile 不匹配 → PROFILE_MISMATCH
//   3. 正式发布身份落后 → VERSION_BEHIND
//   4. managed target 缺失 → MISSING
//   5. installed 文件相对正式 manifest 漂移 → LOCALLY_MODIFIED
//   6. 全部一致 → CURRENT
// ---------------------------------------------------------------------------

export type FreshnessStatus =
  | "CURRENT"
  | "LOCALLY_MODIFIED"
  | "MISSING"
  | "VERSION_BEHIND"
  | "PROFILE_MISMATCH"
  | "UNVERIFIABLE";

export interface FreshnessIdentity {
  adapter: HarnessAgent;
  bundleVersion: string | null;
  installedBundleVersion: string | null;
  manifestHash: string | null;
  installedManifestHash: string | null;
  /** 正式 bundle 构建 marker（.harness-build.json）的 coreHash；marker 缺失/无效为 null。 */
  coreHash: string | null;
  /** 安装侧 .harness-build.json marker 的 coreHash；不可读/无效为 null。 */
  installedCoreHash: string | null;
  /** 官方 post-adaptation 投影（target path + expected sha256）的稳定哈希。 */
  adapterHash: string | null;
  /** 安装侧同一 target 集合当前字节的稳定哈希；缺文件时仍包含 null。 */
  installedAdapterHash: string | null;
  /**
   * Per-file aggregate hash over actually-installed managed files (retro §5.1).
   * Unlike installedAdapterHash, this is the canonical content hash shared with
   * the bundle manifest contract — null when no managed files can be read.
   */
  installedContentHash: string | null;
  /** Timestamp (ISO8601) of the last per-file verification; null when unknown. */
  verifiedAt: string | null;
  /** Per-file verification status: verified | stale | degraded | unknown. */
  verificationStatus: "verified" | "stale" | "degraded" | "unknown";
  /** Per-file mismatch details (relpath/expected/actual); empty when verified. */
  mismatchDetails: ReadonlyArray<{
    relpath: string;
    expected: string;
    actual: string;
  }>;
}

export interface AgentFreshness {
  agent: HarnessAgent;
  profile: HarnessProfile | null;
  status: FreshnessStatus;
  identity: FreshnessIdentity;
  driftedFiles: string[];
  missingFiles: string[];
}

export interface FreshnessReport {
  schema_version: 1;
  generated_at: string;
  agents: AgentFreshness[];
}

export interface FreshnessOptions {
  projectRoot: string;
  resourcesRoot: string;
  profile?: HarnessProfile;
  agents: HarnessAgent[];
  codebuddySurface?: CodeBuddySurface;
}

function freshnessEntry(
  agent: HarnessAgent,
  profile: HarnessProfile | null,
  status: FreshnessStatus,
  identity: FreshnessIdentity
): AgentFreshness {
  return { agent, profile, status, identity, driftedFiles: [], missingFiles: [] };
}

function emptyVerification(): Pick<
  FreshnessIdentity,
  "installedContentHash" | "verifiedAt" | "verificationStatus" | "mismatchDetails"
> {
  return {
    installedContentHash: null,
    verifiedAt: null,
    verificationStatus: "unknown",
    mismatchDetails: []
  };
}

const BUILD_MARKER_BUNDLE_PATH = ".harness-build.json";

/** Extract `coreHash` from a `.harness-build.json` marker text; null when invalid. */
function buildMarkerCoreHash(text: string | null): string | null {
  if (text === null || text === "") return null;
  try {
    const parsed = JSON.parse(text) as { coreHash?: unknown };
    return typeof parsed.coreHash === "string" && parsed.coreHash.length > 0
      ? parsed.coreHash
      : null;
  } catch {
    return null;
  }
}

/** Read-only freshness collector: classifies each agent into the six states. */
export async function collectFreshness(
  options: FreshnessOptions
): Promise<FreshnessReport> {
  const root = resolve(options.projectRoot);
  const installed = await readInstalledState(root);
  const codebuddySurface = options.codebuddySurface ?? "both";
  const agents: AgentFreshness[] = [];

  for (const agent of sortHarnessAgents(options.agents)) {
    const installedProfile = installed.profiles.get(agent) ?? installed.profile;
    const requestedProfile = options.profile ?? installedProfile ?? "general";
    const installedManifest = installed.manifests.find(
      (entry) => entry.adapter === agent
    );
    const identity: FreshnessIdentity = {
      adapter: agent,
      bundleVersion: null,
      installedBundleVersion: installedManifest?.bundle_version ?? null,
      manifestHash: null,
      installedManifestHash: installedManifest?.bundle_manifest_hash ?? null,
      coreHash: null,
      installedCoreHash: null,
      adapterHash: null,
      installedAdapterHash: null,
      ...emptyVerification()
    };

    // Official bundle identity is loaded for every state we can verify.
    let officialHash: string | null = null;
    let officialVersion: string | null = null;
    let bundle: LoadedAgentBundle | null;
    try {
      bundle = await loadAgentBundle(options.resourcesRoot, requestedProfile, agent);
      officialHash = sha256Bytes(canonicalJson(bundle.manifest.files));
      officialVersion = bundle.manifest.bundle_version;
      identity.bundleVersion = officialVersion;
      identity.manifestHash = officialHash;
      const markerBytes = bundle.files.get(BUILD_MARKER_BUNDLE_PATH);
      identity.coreHash = markerBytes === undefined
        ? null
        : buildMarkerCoreHash(new TextDecoder().decode(markerBytes));
    } catch {
      bundle = null;
    }

    // 1. identity/schema 不足 → UNVERIFIABLE
    if (
      installed.schemaVersion === null ||
      !installed.adapters.includes(agent) ||
      installedProfile === null ||
      installedProfile === undefined ||
      installedManifest === undefined ||
      bundle === null
    ) {
      agents.push(freshnessEntry(agent, installedProfile ?? null, "UNVERIFIABLE", identity));
      continue;
    }

    // Post-adaptation projection（read-only）：为所有后续状态提供 installed marker
    // 身份与 drift/missing 比对；分类顺序仍按 §5.1 判定，不受影响。
    const targets = managedTargetsFor(getAdapter(agent), bundle, {
      profile: installedProfile,
      codebuddySurface
    });
    identity.adapterHash = sha256Bytes(canonicalJson(
      targets
        .map((target) => ({ path: target.target_path.replace(/\\/g, "/"), sha256: target.sha256 }))
        .sort((a, b) => a.path.localeCompare(b.path))
    ));
    const installedProjection = await Promise.all(
      targets.map(async (target) => ({
        path: target.target_path.replace(/\\/g, "/"),
        sha256: await fileHex(join(root, target.target_path))
      }))
    );
    identity.installedAdapterHash = sha256Bytes(canonicalJson(
      installedProjection.sort((a, b) => a.path.localeCompare(b.path))
    ));
    const markerTarget = targets.find((target) =>
      target.target_path.replace(/\\/g, "/").endsWith(`/${BUILD_MARKER_BUNDLE_PATH}`) ||
      target.target_path === BUILD_MARKER_BUNDLE_PATH
    );
    if (markerTarget !== undefined) {
      identity.installedCoreHash = buildMarkerCoreHash(
        await readOptionalText(join(root, markerTarget.target_path))
      );
    }

    // Per-file content verification (retro §5.1): compare each managed
    // target's actual sha256 against the official bundle projection. This
    // is the per-file proof that registry_version+bundle_hash alone cannot
    // provide; it feeds installedContentHash/verificationStatus/mismatchDetails.
    const mismatchDetails: Array<{ relpath: string; expected: string; actual: string }> = [];
    const contentEntries: Array<{ relpath: string; sha256: string }> = [];
    for (const target of targets) {
      const rel = target.target_path.replace(/\\/g, "/");
      const actual = await fileHex(join(root, target.target_path));
      contentEntries.push({ relpath: rel, sha256: actual ?? "" });
      if (actual === null) {
        mismatchDetails.push({ relpath: rel, expected: target.sha256, actual: "<missing>" });
      } else if (actual !== target.sha256) {
        mismatchDetails.push({ relpath: rel, expected: target.sha256, actual });
      }
    }
    identity.installedContentHash = aggregateInstalledContentHash(contentEntries);
    identity.verifiedAt = new Date().toISOString();
    identity.verificationStatus = mismatchDetails.length === 0 ? "verified" : "degraded";
    identity.mismatchDetails = mismatchDetails;

    // 2. agent/profile 不匹配 → PROFILE_MISMATCH
    if (requestedProfile !== installedProfile) {
      agents.push(freshnessEntry(agent, installedProfile, "PROFILE_MISMATCH", identity));
      continue;
    }

    // 3. 正式发布身份落后 → VERSION_BEHIND
    if (
      installedManifest.bundle_manifest_hash !== officialHash ||
      installedManifest.bundle_version !== officialVersion
    ) {
      agents.push(freshnessEntry(agent, installedProfile, "VERSION_BEHIND", identity));
      continue;
    }

    // 4/5. post-adaptation projection vs installed files
    const drifted: string[] = [];
    const missing: string[] = [];
    for (const target of targets) {
      const current = await fileHex(join(root, target.target_path));
      if (current === null) {
        missing.push(target.target_path);
      } else if (current !== target.sha256) {
        drifted.push(target.target_path);
      }
    }
    if (missing.length > 0) {
      const entry = freshnessEntry(agent, installedProfile, "MISSING", identity);
      entry.missingFiles = missing.sort();
      entry.driftedFiles = drifted.sort();
      agents.push(entry);
      continue;
    }
    if (drifted.length > 0) {
      const entry = freshnessEntry(agent, installedProfile, "LOCALLY_MODIFIED", identity);
      entry.driftedFiles = drifted.sort();
      agents.push(entry);
      continue;
    }

    // 6. 全部一致 → CURRENT
    agents.push(freshnessEntry(agent, installedProfile, "CURRENT", identity));
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents
  };
}
