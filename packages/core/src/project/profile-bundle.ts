import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessAgent } from "@hunter-harness/contracts";

import { assertNoCaseCollisions, normalizeManagedPath } from "../fs/path-safety.js";
import {
  getAdapter,
  managedTargetsFor,
  type AdapterContext
} from "./agent-adapters.js";

export type HarnessProfile = "general" | "java";

export interface ProjectedBundleFile {
  source_path: string;
  target_path: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface AgentBundleManifestV2 {
  schema_version: 2;
  profile: HarnessProfile;
  adapter: HarnessAgent;
  bundle_version: string;
  generator: "harness_deploy.py";
  files: Array<{ path: string; sha256: string }>;
}

/** @deprecated Prefer AgentBundleManifestV2 */
export interface ProfileBundleManifest {
  schema_version: 1 | 2;
  profile: HarnessProfile;
  adapter?: HarnessAgent;
  bundle_version: string;
  generator: "harness_deploy.py";
  files: Array<{ path: string; sha256: string }>;
}

export interface LoadedAgentBundle {
  manifest: AgentBundleManifestV2;
  files: Map<string, Uint8Array>;
}

/**
 * Offline Agent Bundle 完整性错误。exitCode 7 对应设计 §18 的
 * Bundle 完整性/安全错误退出码。
 */
export class AdapterBundleError extends Error {
  readonly exitCode = 7;

  constructor(
    readonly code: "ADAPTER_BUNDLE_MISSING" | "ADAPTER_BUNDLE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "AdapterBundleError";
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** @deprecated Prefer LoadedAgentBundle */
export type ProfileBundle = {
  manifest: ProfileBundleManifest;
  files: Map<string, Uint8Array>;
};

function isProfile(value: unknown): value is HarnessProfile {
  return value === "general" || value === "java";
}

function isAgent(value: unknown): value is HarnessAgent {
  return value === "claude-code" || value === "codex" ||
    value === "cursor" || value === "codebuddy";
}

function validateRelativeBundlePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") ||
      path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("invalid Harness Bundle path");
  }
}

export async function loadAgentBundle(
  resourcesRoot: string,
  profile: HarnessProfile,
  agent: HarnessAgent
): Promise<LoadedAgentBundle> {
  const manifestPath = join(resourcesRoot, "harness", "manifests", profile, `${agent}.json`);
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_MISSING",
        `offline Harness Bundle manifest missing: ${profile}/${agent}`
      );
    }
    throw error;
  }
  let raw: Partial<AgentBundleManifestV2>;
  try {
    raw = JSON.parse(manifestText) as Partial<AgentBundleManifestV2>;
  } catch {
    throw new AdapterBundleError(
      "ADAPTER_BUNDLE_INVALID",
      `unparseable ${profile}/${agent} Harness Bundle manifest`
    );
  }
  if (raw.schema_version !== 2 || raw.profile !== profile || raw.adapter !== agent ||
      typeof raw.bundle_version !== "string" || raw.generator !== "harness_deploy.py" ||
      !Array.isArray(raw.files)) {
    throw new AdapterBundleError(
      "ADAPTER_BUNDLE_INVALID",
      `invalid ${profile}/${agent} Harness Bundle manifest`
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const item of raw.files) {
    try {
      validateRelativeBundlePath(item.path);
    } catch {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `invalid ${profile}/${agent} Harness Bundle path`
      );
    }
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        files.has(item.path)) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `invalid ${profile}/${agent} Harness Bundle manifest entry`
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(
        join(resourcesRoot, "harness", "bundles", profile, agent, item.path)
      );
    } catch (error) {
      if (isEnoent(error)) {
        throw new AdapterBundleError(
          "ADAPTER_BUNDLE_MISSING",
          `offline Harness Bundle file missing: ${profile}/${agent}/${item.path}`
        );
      }
      throw error;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `Harness Bundle hash mismatch: ${profile}/${agent}/${item.path}`
      );
    }
    files.set(item.path, bytes);
  }
  return { manifest: raw as AgentBundleManifestV2, files };
}

/** Temporary bridge: load Claude Code bundle for callers not yet migrated. */
export async function loadProfileBundle(
  resourcesRoot: string,
  profile: HarnessProfile
): Promise<LoadedAgentBundle> {
  return loadAgentBundle(resourcesRoot, profile, "claude-code");
}

/**
 * Paths excluded from push proposal upload/scan: Bundle working copies only.
 * Generated rules / instruction files stay scannable (see push makePreview).
 */
export async function managedBundleTargets(
  resourcesRoot: string,
  profile: HarnessProfile,
  agent: HarnessAgent = "claude-code"
): Promise<Set<string>> {
  const bundle = await loadAgentBundle(resourcesRoot, profile, agent);
  const adapter = getAdapter(agent);
  const context: AdapterContext = { profile, codebuddySurface: "both" };
  const targets = new Set(
    adapter.projectBundle(bundle, context).map((t) => t.target_path)
  );
  // Legacy quirk preserved: java profile rule was treated as bundle-adjacent.
  if (profile === "java" && agent === "claude-code") {
    targets.add(".claude/rules/harness-profile-java.md");
  }
  return targets;
}

/** Claude-only projection kept for transitional callers. */
export function projectBundle(bundle: LoadedAgentBundle | ProfileBundle): ProjectedBundleFile[] {
  const adapter = getAdapter(
    bundle.manifest.adapter === undefined ? "claude-code" : bundle.manifest.adapter
  );
  return [...adapter.projectBundle(bundle as LoadedAgentBundle, {
    profile: bundle.manifest.profile,
    codebuddySurface: "both"
  })];
}

export function bundleTargetContents(
  bundle: LoadedAgentBundle | ProfileBundle
): Map<string, Uint8Array> {
  return new Map(projectBundle(bundle).map((record) => [record.target_path, record.bytes]));
}

/** Claude-only managed targets (bridge until initialize uses multi-agent). */
export async function managedTargets(
  resourcesRoot: string,
  profile: HarnessProfile
): Promise<ProjectedBundleFile[]> {
  const bundle = await loadAgentBundle(resourcesRoot, profile, "claude-code");
  const adapter = getAdapter("claude-code");
  return managedTargetsFor(adapter, bundle, { profile, codebuddySurface: "both" });
}

export function parseHarnessProfile(value: unknown): HarnessProfile | null {
  return isProfile(value) ? value : null;
}

export interface MigrationManifest {
  schema_version: 1 | 2;
  profile: HarnessProfile;
  adapter: HarnessAgent;
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
    adapter?: unknown;
    bundle_version?: unknown;
    bundle_manifest_hash?: unknown;
    projection?: unknown;
  };
  const schemaVersion = record.schema_version;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || !isProfile(record.profile) ||
      typeof record.bundle_version !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(String(record.bundle_manifest_hash)) ||
      !Array.isArray(record.projection)) {
    throw new Error("invalid Harness migration manifest");
  }
  const adapter: HarnessAgent = schemaVersion === 1
    ? "claude-code"
    : (isAgent(record.adapter) ? record.adapter : (() => {
      throw new Error("invalid Harness migration manifest adapter");
    })());
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
    if (schemaVersion === 1 && !targetPath.startsWith(".claude/")) {
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
    schema_version: schemaVersion,
    profile: record.profile,
    adapter,
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
