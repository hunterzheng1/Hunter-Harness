import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const resources = join(root, "resources", "harness");
const packagedResources = join(root, "packages", "cli", "resources");

interface Manifest {
  schema_version: 1;
  profile: "general" | "java";
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
  it.each(["general", "java"] as const)("matches every %s manifest hash", async (profile) => {
    const manifest = JSON.parse(await readFile(
      join(resources, "manifests", `${profile}.json`), "utf8"
    )) as Manifest;
    expect(manifest.profile).toBe(profile);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const item of manifest.files) {
      const bytes = await readFile(join(resources, profile, item.path));
      expect(createHash("sha256").update(bytes).digest("hex"), item.path).toBe(item.sha256);
    }
  });

  it("keeps source-only material out of runtime bundles", async () => {
    for (const profile of ["general", "java"]) {
      expect(await exists(join(resources, profile, "redesign"))).toBe(false);
      expect(await exists(join(resources, profile, "scripts", "tests"))).toBe(false);
      expect(await exists(join(resources, profile, "shared"))).toBe(false);
      expect(await exists(join(resources, profile, "overlays"))).toBe(false);
      expect((await filePaths(join(resources, profile))).some((path) =>
        path.split("/").includes("tests")
      )).toBe(false);
    }
  });

  it("keeps legacy bootstrap resources out of the CLI package staging tree", async () => {
    expect(await exists(join(packagedResources, "harness", "general", "harness-plan", "SKILL.md"))).toBe(true);
    expect(await exists(join(packagedResources, "bootstrap-ir"))).toBe(false);
    expect(await exists(join(packagedResources, "skills"))).toBe(false);
  });
});
