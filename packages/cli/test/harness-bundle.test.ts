import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const resources = join(root, "resources", "harness");
const packagedResources = join(root, "packages", "workflow-data-harness");
const AGENTS = ["claude-code", "codex", "cursor", "codebuddy"] as const;
const PROFILES = ["general", "java"] as const;

interface ManifestV2 {
  schema_version: 2;
  profile: "general" | "java";
  adapter: string;
  files: Array<{ path: string; sha256: string }>;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function filePaths(directory: string, base = directory): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filePaths(full, base));
    if (entry.isFile()) paths.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return paths;
}

describe("embedded Harness Bundles", () => {
  it.each(PROFILES)("matches every %s agent manifest hash", async (profile) => {
    for (const agent of AGENTS) {
      const manifest = JSON.parse(await readFile(
        join(resources, "manifests", profile, `${agent}.json`), "utf8"
      )) as ManifestV2;
      expect(manifest.schema_version).toBe(2);
      expect(manifest.profile).toBe(profile);
      expect(manifest.adapter).toBe(agent);
      expect(manifest.files.length).toBeGreaterThan(0);
      for (const item of manifest.files) {
        const bytes = await readFile(join(resources, "bundles", profile, agent, item.path));
        expect(createHash("sha256").update(bytes).digest("hex"), `${agent}:${item.path}`)
          .toBe(item.sha256);
      }
    }
  });

  it("keeps source-only material out of runtime bundles", async () => {
    for (const profile of PROFILES) {
      for (const agent of AGENTS) {
        const bundleRoot = join(resources, "bundles", profile, agent);
        expect(await exists(join(bundleRoot, "redesign"))).toBe(false);
        expect(await exists(join(bundleRoot, "scripts", "tests"))).toBe(false);
        expect(await exists(join(bundleRoot, "shared"))).toBe(false);
        expect(await exists(join(bundleRoot, "overlays"))).toBe(false);
        expect((await filePaths(bundleRoot)).some((path) =>
          path.split("/").includes("tests")
        )).toBe(false);
      }
    }
  });

  it("keeps legacy bootstrap resources out of the workflow data package staging tree", async () => {
    expect(await exists(join(
      resources, "bundles", "general", "claude-code", "harness-plan", "SKILL.md"
    ))).toBe(true);
    expect(await exists(join(packagedResources, "bootstrap-ir"))).toBe(false);
    expect(await exists(join(packagedResources, "skills"))).toBe(false);
  });
});
