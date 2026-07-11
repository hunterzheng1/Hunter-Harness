import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type HarnessProfile = "general" | "java";

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

export function bundleTargetContents(bundle: ProfileBundle): Map<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  for (const [path, bytes] of bundle.files) {
    const skillTarget = `.claude/skills/${path}`;
    contents.set(skillTarget, bytes);
    const agent = /^agents\/([^/]+\.md)$/.exec(path);
    if (agent?.[1] !== undefined) {
      const agentTarget = `.claude/agents/${agent[1]}`;
      contents.set(agentTarget, bytes);
    }
  }
  return contents;
}

export function parseHarnessProfile(value: unknown): HarnessProfile | null {
  return isProfile(value) ? value : null;
}
