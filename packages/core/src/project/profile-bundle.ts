import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { assertNoCaseCollisions, normalizeManagedPath } from "../fs/path-safety.js";

import {
  HARNESS_GENERAL_RULES_CONTENT,
  HARNESS_JAVA_RULES_CONTENT
} from "./managed-content.js";

export type HarnessProfile = "general" | "java";

// Installation Projection：Bundle source_path → 运行时 target_path 的确定性映射。
// agents/<name>.md 仅投射到 .claude/agents/<name>.md（不再重复安装到 .claude/skills/agents/）；
// 其余路径投射到 .claude/skills/<source_path>。字节原样保留，不重序列化、不注入 header。
export interface ProjectedBundleFile {
  source_path: string;
  target_path: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface ProfileBundleManifest {
  schema_version: 1;
  profile: HarnessProfile;
  bundle_version: string;
  generator: "harness_deploy.py";
  files: Array<{ path: string; sha256: string }>;
}

export interface ProfileBundle {
  manifest: ProfileBundleManifest;
  files: Map<string, Uint8Array>;
}

function isProfile(value: unknown): value is HarnessProfile {
  return value === "general" || value === "java";
}

function validateRelativeBundlePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") ||
      path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("invalid Harness Bundle path");
  }
}

export async function loadProfileBundle(
  resourcesRoot: string,
  profile: HarnessProfile
): Promise<ProfileBundle> {
  const raw = JSON.parse(await readFile(
    join(resourcesRoot, "harness", "manifests", `${profile}.json`), "utf8"
  )) as Partial<ProfileBundleManifest>;
  if (raw.schema_version !== 1 || raw.profile !== profile ||
      typeof raw.bundle_version !== "string" || raw.generator !== "harness_deploy.py" ||
      !Array.isArray(raw.files)) {
    throw new Error(`invalid ${profile} Harness Bundle manifest`);
  }
  const files = new Map<string, Uint8Array>();
  for (const item of raw.files) {
    validateRelativeBundlePath(item.path);
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        files.has(item.path)) {
      throw new Error(`invalid ${profile} Harness Bundle manifest entry`);
    }
    const bytes = await readFile(join(resourcesRoot, "harness", profile, item.path));
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
      throw new Error(`Harness Bundle hash mismatch: ${item.path}`);
    }
    files.set(item.path, bytes);
  }
  return { manifest: raw as ProfileBundleManifest, files };
}

export async function managedBundleTargets(
  resourcesRoot: string,
  profile: HarnessProfile
): Promise<Set<string>> {
  const bundle = await loadProfileBundle(resourcesRoot, profile);
  const targets = new Set(bundleTargetContents(bundle).keys());
  if (profile === "java") targets.add(".claude/rules/harness-profile-java.md");
  return targets;
}

const AGENT_SOURCE_PATH = /^agents\/([^/]+\.md)$/;

// 把已加载的 Bundle 投影为受管安装目标记录。集中所有路径与 SHA 校验：
// 1. 复用 validateRelativeBundlePath 拒绝恶意 source（绝对/驱动器/.. /空段）；
// 2. 对投射后的 target 再过 normalizeManagedPath，杜绝逃逸；
// 3. assertNoCaseCollisions 拒绝重复或大小写冲突的 target；
// 4. sha256 取自 manifest（已在 loadProfileBundle 校验），与 Bundle manifests 一致（纯 hex 无前缀）。
export function projectBundle(bundle: ProfileBundle): ProjectedBundleFile[] {
  const records: ProjectedBundleFile[] = [];
  for (const [sourcePath, bytes] of bundle.files) {
    validateRelativeBundlePath(sourcePath);
    const agent = AGENT_SOURCE_PATH.exec(sourcePath);
    const projectedTarget = agent?.[1] !== undefined
      ? `.claude/agents/${agent[1]}`
      : `.claude/skills/${sourcePath}`;
    const manifestEntry = bundle.manifest.files.find((entry) => entry.path === sourcePath);
    if (manifestEntry === undefined) {
      throw new Error(`Harness Bundle missing manifest entry: ${sourcePath}`);
    }
    records.push({
      source_path: sourcePath,
      target_path: normalizeManagedPath(projectedTarget),
      sha256: manifestEntry.sha256,
      bytes
    });
  }
  assertNoCaseCollisions(records.map((record) => record.target_path));
  return records.sort((left, right) => left.target_path.localeCompare(right.target_path));
}

export function bundleTargetContents(bundle: ProfileBundle): Map<string, Uint8Array> {
  return new Map(projectBundle(bundle).map((record) => [record.target_path, record.bytes]));
}

function ruleTarget(sourcePath: string, targetPath: string, content: string): ProjectedBundleFile {
  return {
    source_path: sourcePath,
    target_path: targetPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: new TextEncoder().encode(content)
  };
}

// 受管安装目标全集 = Bundle 投影 + 生成的 rules 文件（harness-general.md 恒有；java 额外
// harness-profile-java.md）。initialize 与 refresh 共用此构造，确保 v2 installed state 与
// 实际写入目标一致；结果按 target_path 排序，确定性输出。
export async function managedTargets(
  resourcesRoot: string,
  profile: HarnessProfile
): Promise<ProjectedBundleFile[]> {
  const bundle = await loadProfileBundle(resourcesRoot, profile);
  const records = projectBundle(bundle).map((record) => ({
    source_path: record.source_path,
    target_path: record.target_path,
    sha256: record.sha256,
    bytes: record.bytes
  }));
  records.push(ruleTarget(
    "rules/harness-general.md",
    ".claude/rules/harness-general.md",
    HARNESS_GENERAL_RULES_CONTENT
  ));
  if (profile === "java") {
    records.push(ruleTarget(
      "rules/harness-profile-java.md",
      ".claude/rules/harness-profile-java.md",
      HARNESS_JAVA_RULES_CONTENT
    ));
  }
  assertNoCaseCollisions(records.map((record) => record.target_path));
  return records.sort((left, right) => left.target_path.localeCompare(right.target_path));
}

export function parseHarnessProfile(value: unknown): HarnessProfile | null {
  return isProfile(value) ? value : null;
}

// 0.1.1 迁移 manifest（design §7）：为已发布的 0.1.1 安装（schema-v1 state，无 per-file hash）
// 提供可信 per-file hash + 旧投影目标集。bundle_manifest_hash 与 0.1.1 context-index 的
// skill_bundle.bundle_hash 匹配时启用，仅用于 dirty/clean 分类与旧重复目标的安全删除。
export interface MigrationManifest {
  schema_version: 1;
  profile: HarnessProfile;
  bundle_version: string;
  bundle_manifest_hash: string;
  projection: Array<{ source_path: string; target_path: string; sha256: string }>;
}

export function parseMigrationManifest(raw: unknown): MigrationManifest {
  if (raw === null || typeof raw !== "object") {
    throw new Error("invalid Harness migration manifest");
  }
  const record = raw as {
    schema_version?: unknown;
    profile?: unknown;
    bundle_version?: unknown;
    bundle_manifest_hash?: unknown;
    projection?: unknown;
  };
  if (record.schema_version !== 1 || !isProfile(record.profile) ||
      typeof record.bundle_version !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(String(record.bundle_manifest_hash)) ||
      !Array.isArray(record.projection)) {
    throw new Error("invalid Harness migration manifest");
  }
  const projection: MigrationManifest["projection"] = [];
  for (const entry of record.projection) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("invalid Harness migration manifest entry");
    }
    const item = entry as { source_path?: unknown; target_path?: unknown; sha256?: unknown };
    validateRelativeBundlePath(item.source_path);
    if (typeof item.target_path !== "string" ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error("invalid Harness migration manifest entry");
    }
    const targetPath = normalizeManagedPath(item.target_path);
    if (!targetPath.startsWith(".claude/")) {
      throw new Error("invalid Harness migration manifest target");
    }
    projection.push({
      source_path: item.source_path,
      target_path: targetPath,
      sha256: item.sha256
    });
  }
  assertNoCaseCollisions(projection.map((item) => item.target_path));
  return {
    schema_version: 1,
    profile: record.profile,
    bundle_version: record.bundle_version,
    bundle_manifest_hash: record.bundle_manifest_hash as string,
    projection
  };
}

export async function loadMigrationManifests(
  resourcesRoot: string
): Promise<MigrationManifest[]> {
  const migrationsRoot = join(resourcesRoot, "harness", "migrations");
  let versionDirs: string[];
  try {
    versionDirs = await readdir(migrationsRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const manifests: MigrationManifest[] = [];
  for (const versionDir of versionDirs) {
    let files: string[];
    try {
      files = await readdir(join(migrationsRoot, versionDir));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      manifests.push(parseMigrationManifest(JSON.parse(await readFile(
        join(migrationsRoot, versionDir, file), "utf8"
      ))));
    }
  }
  return manifests;
}
