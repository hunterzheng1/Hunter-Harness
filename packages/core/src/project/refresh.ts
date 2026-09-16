import { createHash } from "node:crypto";
import { readFile, readdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  projectConfigSchema
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

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
  PROJECTION_SURFACES,
  loadBundle,
  type LoadedAgentBundle,
  type ProjectedBundleFile,
  type ProjectionSurface
} from "./profile-bundle.js";
import {
  contextIndexEntryFor,
  projectBundleToSurface,
  pruneBoundaries
} from "./agent-adapters.js";
import { detectLegacyProjectionResidue, formatLegacyResidueWarnings } from "./legacy.js";
import {
  TargetCollisionError,
  type InstalledBundleStateV5
} from "./initialize.js";

// Conservative Refresh：本地安全协调，不触碰 server-backed update 语义（design §2/§3）。
// 分类依据 design §4.3：absent→add；current==incoming→unchanged；current==trusted→干净替换；
// 否则冲突保留（--force-managed 仅对 Bundle 可信目标强制替换）。
// v1.0：固定双投影面（codex + codebuddy），无 agent/profile 选择；删除授权来自
// v5 installed state 的 per-file 哈希（current==trusted 才删除，本地已改文件保留）。

export type RefreshReason =
  | "MISSING_TARGET"
  | "BASELINE_CLEAN"
  | "ALREADY_CURRENT"
  | "LOCAL_MODIFICATION"
  | "LEGACY_FILE_MODIFIED"
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
  dry_run: boolean;
  applied: RefreshItem[];
  removed: RefreshItem[];
  preserved: RefreshItem[];
  unchanged: RefreshItem[];
  conflicts: RefreshConflict[];
  /** Pre-1.0 projection residue / legacy state warnings (informational). */
  legacy_warnings: string[];
  plan_hash: string;
  recovery_id: string | null;
}

export interface RefreshOptions {
  projectRoot: string;
  resourcesRoot: string;
  dryRun: boolean;
  forceManaged: boolean;
  expectedPlanHash?: string;
  planTimestamp?: string;
  cliVersion?: string;
  recoveryStore?: Omit<RecoveryStoreOptions, "managedPaths">;
}

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const CONTEXT_INDEX_PATH = ".harness/context-index.json";
const RETIRED_ARCHIVE_RENDERER_TARGETS: Readonly<Record<ProjectionSurface, string>> = {
  codex: ".agents/skills/harness-archive/templates/render-summary.mjs",
  codebuddy: ".codebuddy/skills/harness-archive/templates/render-summary.mjs"
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
  schemaVersion: number | null;
  /** True when a state file exists but is not schema v5 (pre-1.0 install). */
  legacy: boolean;
  trusted: Map<string, string>;
  files: InstalledBundleStateV5["files"];
  manifests: InstalledBundleStateV5["manifests"];
  managedBlocks: InstalledBundleStateV5["managed_blocks"];
}

const EMPTY_STATE: InstalledState = {
  schemaVersion: null,
  legacy: false,
  trusted: new Map(),
  files: [],
  manifests: [],
  managedBlocks: []
};

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

/**
 * v1.0 hard cutover: only schema_version 5 is honored. Any older schema (or an
 * unparseable state file) is treated as a legacy install — the refresh then
 * behaves like a fresh projection and reports a legacy warning instead of
 * attempting in-place migration.
 */
async function readInstalledState(root: string): Promise<InstalledState> {
  const content = await readOptionalText(join(root, INSTALLED_STATE_PATH));
  if (content === "") return EMPTY_STATE;
  let parsed: {
    schema_version?: unknown;
    files?: unknown;
    manifests?: unknown;
    managed_blocks?: unknown;
  };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return { ...EMPTY_STATE, legacy: true, trusted: new Map() };
  }
  if (parsed.schema_version !== 5) {
    return {
      ...EMPTY_STATE,
      schemaVersion: typeof parsed.schema_version === "number" ? parsed.schema_version : null,
      legacy: true,
      trusted: new Map()
    };
  }
  const trusted = new Map<string, string>();
  if (Array.isArray(parsed.files)) {
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
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((entry): entry is InstalledBundleStateV5["files"][number] =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { target_path?: unknown }).target_path === "string" &&
      typeof (entry as { source_path?: unknown }).source_path === "string" &&
      typeof (entry as { sha256?: unknown }).sha256 === "string" &&
      ("owner" in entry)
    )
    : [];
  const manifests = Array.isArray(parsed.manifests)
    ? parsed.manifests.filter((entry): entry is InstalledBundleStateV5["manifests"][number] =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { surface?: unknown }).surface === "string" &&
      typeof (entry as { bundle_version?: unknown }).bundle_version === "string"
    )
    : [];
  const managedBlocks = Array.isArray(parsed.managed_blocks)
    ? parsed.managed_blocks.filter((entry): entry is InstalledBundleStateV5["managed_blocks"][number] =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { target_path?: unknown }).target_path === "string" &&
      typeof (entry as { block_id?: unknown }).block_id === "string"
    )
    : [];
  return {
    schemaVersion: 5,
    legacy: false,
    trusted,
    files,
    manifests,
    managedBlocks
  };
}

// 删除目标后剪除因之变空的父目录；边界由 agent-adapters.pruneBoundaries 固定给出。
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
  manifests: InstalledBundleStateV5["manifests"],
  verifications: ReadonlyMap<ProjectionSurface, FreshnessIdentity>
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
      adapters: Object.fromEntries(PROJECTION_SURFACES.map((surface) => [
        surface, contextIndexEntryFor(surface)
      ]))
    },
    knowledge: {
      source: "remote",
      local_index: null,
      query: "npx hunter-harness knowledge query"
    },
    codebase,
    skill_bundles: Object.fromEntries(manifests.map((manifest) => {
      const ver = verifications.get(manifest.surface);
      const previous = existingSkillBundles[manifest.surface];
      const mismatchDetails = ver?.mismatchDetails ?? [];
      const verificationUnchanged = previous !== undefined &&
        previous.registry_version === manifest.bundle_version &&
        previous.bundle_hash === manifest.bundle_manifest_hash &&
        previous.installedContentHash === (ver?.installedContentHash ?? null) &&
        previous.verificationStatus === (ver?.verificationStatus ?? "unknown") &&
        JSON.stringify(previous.mismatchDetails ?? []) ===
          JSON.stringify(mismatchDetails);
      return [
        manifest.surface,
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

interface OwnedTarget extends ProjectedBundleFile {
  owner: ProjectionSurface;
}

function mergeTargets(
  targets: OwnedTarget[]
): Array<Omit<OwnedTarget, "owner"> & { owner: ProjectionSurface | "shared" }> {
  const grouped = new Map<string, OwnedTarget[]>();
  for (const target of targets) {
    grouped.set(target.target_path, [...(grouped.get(target.target_path) ?? []), target]);
  }
  return [...grouped.entries()].map(([path, values]) => {
    const first = values[0];
    if (first === undefined) throw new TargetCollisionError(path);
    if (values.some((value) => value.sha256 !== first.sha256)) throw new TargetCollisionError(path);
    const owner: ProjectionSurface | "shared" = new Set(values.map((value) => value.owner)).size === 1
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
  const legacyWarnings: string[] = [];
  if (installed.legacy) {
    legacyWarnings.push(
      `检测到旧版安装状态（${INSTALLED_STATE_PATH}，schema_version=${installed.schemaVersion ?? "未知"}）：` +
      "本次刷新按全新投影处理，本地已修改的旧文件将全部保留为冲突；" +
      "建议运行 `npx hunter-harness uninstall` 彻底清理后重新 init。"
    );
  }
  legacyWarnings.push(...formatLegacyResidueWarnings(await detectLegacyProjectionResidue(root)));

  const owned: OwnedTarget[] = [];
  const manifests: InstalledBundleStateV5["manifests"] = [];
  // 并行加载两个投影面 Bundle：同一 Bundle 在进程内由模块级缓存复用。
  const loadedSurfaces = await Promise.all(PROJECTION_SURFACES.map(async (surface) => {
    const bundle = await loadBundle(options.resourcesRoot, surface);
    return { surface, bundle };
  }));
  for (const { surface, bundle } of loadedSurfaces) {
    manifests.push({
      surface,
      bundle_version: bundle.manifest.bundle_version,
      bundle_manifest_hash: sha256Bytes(canonicalJson(bundle.manifest.files))
    });
    for (const target of projectBundleToSurface(bundle, surface)) {
      owned.push({ ...target, owner: surface });
    }
  }
  const newManaged = mergeTargets(owned);
  const trusted = installed.trusted;

  const newTargetSet = new Set(newManaged.map((target) => target.target_path));
  // 旧投影目标 = v5 state 中记录过、但已不在当前 Bundle 投影内的文件。
  // 删除授权：盘上内容仍等于 state 记录哈希（clean）才删除；否则保留为冲突。
  const oldOnly: ProjectedBundleFile[] = [];
  for (const entry of installed.files) {
    if (!newTargetSet.has(entry.target_path)) {
      oldOnly.push({
        source_path: entry.source_path,
        target_path: entry.target_path,
        sha256: entry.sha256,
        bytes: new Uint8Array()
      });
    }
  }

  const applied: RefreshItem[] = [];
  const removed: RefreshItem[] = [];
  const preserved: RefreshItem[] = [];
  const unchanged: RefreshItem[] = [];
  const conflicts: RefreshConflict[] = [];
  const ops: TransactionOperation[] = [];
  const newStateFiles: InstalledBundleStateV5["files"] = [];

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
    const trustedHash = target.sha256 !== "" ? target.sha256 : undefined;
    const clean = trustedHash !== undefined && current === trustedHash;
    if (clean || options.forceManaged) {
      const reason: RefreshReason = clean ? "BASELINE_CLEAN" : "FORCE_MANAGED";
      removed.push(item(target, "delete", reason, current, null));
      ops.push({ operation: "delete", path: target.target_path });
    } else {
      const reason: RefreshReason = trustedHash === undefined ? "LEGACY_BASELINE_UNKNOWN" : "LEGACY_FILE_MODIFIED";
      preserved.push(item(target, "preserve", reason, current, null));
      conflicts.push(await conflict(
        root,
        target,
        reason,
        current,
        null,
        trustedHash ?? null
      ));
      // 保留的冲突文件不再受管（design §8），不进入新 state。
    }
  }

  // `final-summary.html` 已由平台监控取代。这里仅删除路径与内容哈希都在
  // 内置退役清单中的旧渲染器；本地改写过的同名文件继续保留，且本地 state
  // 不能伪造删除授权。
  const oldOnlyTargets = new Set(oldOnly.map((target) => target.target_path));
  for (const surface of PROJECTION_SURFACES) {
    const targetPath = RETIRED_ARCHIVE_RENDERER_TARGETS[surface];
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
        "LEGACY_FILE_MODIFIED",
        current,
        null
      ));
      conflicts.push(await conflict(
        root,
        target,
        "LEGACY_FILE_MODIFIED",
        current,
        null,
        null
      ));
    }
  }

  // Verify the planned post-transaction view for every surface so the
  // context-index carries per-file verification proof after refresh.
  const verifications = new Map<ProjectionSurface, FreshnessIdentity>();
  for (const { surface, bundle } of loadedSurfaces) {
    const verifyTargets = projectBundleToSurface(bundle, surface);
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
    verifications.set(surface, {
      adapter: surface,
      bundleVersion: bundle.manifest.bundle_version,
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

  const contextOperation = await reconcileContextIndex(root, manifests, verifications);
  if (contextOperation !== null) ops.push(contextOperation);

  const installedState: InstalledBundleStateV5 = {
    schema_version: 5,
    surfaces: [...PROJECTION_SURFACES],
    installed_at: options.planTimestamp ?? new Date().toISOString(),
    manifests: manifests.sort((left, right) => left.surface.localeCompare(right.surface)),
    files: newStateFiles.sort((left, right) => left.target_path.localeCompare(right.target_path) || left.source_path.localeCompare(right.source_path)),
    managed_blocks: installed.managedBlocks
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
      .map((entry) => entry.bundle_version)
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
      removed.map((entry) => entry.target_path),
      pruneBoundaries()
    );
  }

  return {
    dry_run: options.dryRun,
    applied: sortByTarget(applied),
    removed: sortByTarget(removed),
    preserved: sortByTarget(preserved),
    unchanged: sortByTarget(unchanged),
    conflicts: sortByTarget(conflicts),
    legacy_warnings: legacyWarnings,
    plan_hash: planHash,
    recovery_id: recoveryId
  };
}

// ---------------------------------------------------------------------------
// Post-adaptation freshness projection（变更簇 D / task 12，RET-29..33）。
//
// 只读：复用 loadBundle + projectBundleToSurface 的 post-adaptation projection，
// 绝不调用 raw build 产物做字节比较。五态判定顺序（implementation-detail §5.1）：
//   1. identity/schema 不足 → UNVERIFIABLE
//   2. 正式发布身份落后 → VERSION_BEHIND
//   3. managed target 缺失 → MISSING
//   4. installed 文件相对正式 manifest 漂移 → LOCALLY_MODIFIED
//   5. 全部一致 → CURRENT
// ---------------------------------------------------------------------------

export type FreshnessStatus =
  | "CURRENT"
  | "LOCALLY_MODIFIED"
  | "MISSING"
  | "VERSION_BEHIND"
  | "UNVERIFIABLE";

export interface FreshnessIdentity {
  adapter: ProjectionSurface;
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
  agent: ProjectionSurface;
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
}

function freshnessEntry(
  agent: ProjectionSurface,
  status: FreshnessStatus,
  identity: FreshnessIdentity
): AgentFreshness {
  return { agent, status, identity, driftedFiles: [], missingFiles: [] };
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

/** Read-only freshness collector: classifies each projection surface into the five states. */
export async function collectFreshness(
  options: FreshnessOptions
): Promise<FreshnessReport> {
  const root = resolve(options.projectRoot);
  const installed = await readInstalledState(root);
  const agents: AgentFreshness[] = [];

  for (const agent of PROJECTION_SURFACES) {
    const installedManifest = installed.manifests.find(
      (entry) => entry.surface === agent
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
      bundle = await loadBundle(options.resourcesRoot, agent);
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
      installed.legacy ||
      installed.schemaVersion === null ||
      installedManifest === undefined ||
      bundle === null
    ) {
      agents.push(freshnessEntry(agent, "UNVERIFIABLE", identity));
      continue;
    }

    // Post-adaptation projection（read-only）：为所有后续状态提供 installed marker
    // 身份与 drift/missing 比对；分类顺序仍按 §5.1 判定，不受影响。
    const targets = projectBundleToSurface(bundle, agent);
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
    // 盘上文件哈希校验相互独立：逐目标串行 sha256（每个 = stat + 整文件读）会
    // 叠加磁盘时延（多 Agent / 大 Bundle 时是 refresh 的主要等待项），并行读取。
    const verifications = await Promise.all(targets.map(async (target) => {
      const rel = target.target_path.replace(/\\/g, "/");
      const actual = await fileHex(join(root, target.target_path));
      return { rel, actual, expected: target.sha256 };
    }));
    for (const { rel, actual, expected } of verifications) {
      contentEntries.push({ relpath: rel, sha256: actual ?? "" });
      if (actual === null) {
        mismatchDetails.push({ relpath: rel, expected, actual: "<missing>" });
      } else if (actual !== expected) {
        mismatchDetails.push({ relpath: rel, expected, actual });
      }
    }
    identity.installedContentHash = aggregateInstalledContentHash(contentEntries);
    identity.verifiedAt = new Date().toISOString();
    identity.verificationStatus = mismatchDetails.length === 0 ? "verified" : "degraded";
    identity.mismatchDetails = mismatchDetails;

    // 2. 正式发布身份落后 → VERSION_BEHIND
    if (
      installedManifest.bundle_manifest_hash !== officialHash ||
      installedManifest.bundle_version !== officialVersion
    ) {
      agents.push(freshnessEntry(agent, "VERSION_BEHIND", identity));
      continue;
    }

    // 3/4. post-adaptation projection vs installed files
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
      const entry = freshnessEntry(agent, "MISSING", identity);
      entry.missingFiles = missing.sort();
      entry.driftedFiles = drifted.sort();
      agents.push(entry);
      continue;
    }
    if (drifted.length > 0) {
      const entry = freshnessEntry(agent, "LOCALLY_MODIFIED", identity);
      entry.driftedFiles = drifted.sort();
      agents.push(entry);
      continue;
    }

    // 5. 全部一致 → CURRENT
    agents.push(freshnessEntry(agent, "CURRENT", identity));
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents
  };
}
