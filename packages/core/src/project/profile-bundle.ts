import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// v1.0 fixed projection surfaces. `codex` is the canonical agents.md surface
// (`.agents/skills`); `codebuddy` is the derived skills double-write
// (`.codebuddy/skills`). The keys double as bundle identity values validated
// by the gate (`harness_gate.py`), which is why historical names are kept.
export const PROJECTION_SURFACES = ["codex", "codebuddy"] as const;
export type ProjectionSurface = (typeof PROJECTION_SURFACES)[number];

/** Only the general profile exists; the token stays for marker/state compat. */
export const FIXED_PROFILE = "general" as const;
export type FixedProfile = typeof FIXED_PROFILE;

export interface ProjectedBundleFile {
  source_path: string;
  target_path: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface AgentBundleManifestV2 {
  schema_version: 2;
  profile: FixedProfile;
  adapter: ProjectionSurface;
  bundle_version: string;
  generator: "harness_deploy.py";
  files: Array<{ path: string; sha256: string }>;
}

export interface LoadedAgentBundle {
  manifest: AgentBundleManifestV2;
  files: Map<string, Uint8Array>;
}

/**
 * Offline Bundle 完整性错误。exitCode 7 对应设计 §18 的
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

export function validateRelativeBundlePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") ||
      path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("invalid Harness Bundle path");
  }
}

// 模块级缓存：同进程内同键重复调用跳过数百次 readFile + sha256 校验。
// 返回浅拷贝 Map 防止外部突变污染缓存（引用拷贝是微秒级，远小于磁盘读取）。
const bundleCache = new Map<string, LoadedAgentBundle>();

/**
 * Load the flattened offline bundle for one projection surface
 * (`harness/manifests/<surface>.json` + `harness/bundles/<surface>/...`).
 */
export async function loadBundle(
  resourcesRoot: string,
  surface: ProjectionSurface
): Promise<LoadedAgentBundle> {
  // 未知 surface 先 fail-closed，不触碰文件系统（type boundary 之外的调用方）。
  if (!(PROJECTION_SURFACES as readonly string[]).includes(surface)) {
    throw new AdapterBundleError(
      "ADAPTER_BUNDLE_INVALID",
      `unknown projection surface: ${surface as string}`
    );
  }
  const cacheKey = `${resolve(resourcesRoot)}:${surface}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) {
    return { manifest: cached.manifest, files: new Map(cached.files) };
  }
  const manifestPath = join(resourcesRoot, "harness", "manifests", `${surface}.json`);
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_MISSING",
        `offline Harness Bundle manifest missing: ${surface}`
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
      `unparseable ${surface} Harness Bundle manifest`
    );
  }
  if (raw.schema_version !== 2 || raw.profile !== FIXED_PROFILE || raw.adapter !== surface ||
      typeof raw.bundle_version !== "string" || raw.generator !== "harness_deploy.py" ||
      !Array.isArray(raw.files)) {
    throw new AdapterBundleError(
      "ADAPTER_BUNDLE_INVALID",
      `invalid ${surface} Harness Bundle manifest`
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const item of raw.files) {
    try {
      validateRelativeBundlePath(item.path);
    } catch {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `invalid ${surface} Harness Bundle path`
      );
    }
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        files.has(item.path)) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `invalid ${surface} Harness Bundle manifest entry`
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(
        join(resourcesRoot, "harness", "bundles", surface, item.path)
      );
    } catch (error) {
      if (isEnoent(error)) {
        throw new AdapterBundleError(
          "ADAPTER_BUNDLE_MISSING",
          `offline Harness Bundle file missing: ${surface}/${item.path}`
        );
      }
      throw error;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `Harness Bundle hash mismatch: ${surface}/${item.path}`
      );
    }
    files.set(item.path, bytes);
  }
  const result: LoadedAgentBundle = { manifest: raw as AgentBundleManifestV2, files };
  bundleCache.set(cacheKey, result);
  return { manifest: result.manifest, files: new Map(result.files) };
}
