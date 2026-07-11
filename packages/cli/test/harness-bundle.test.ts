import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const resources = join(root, "resources", "harness");

interface Manifest {
  schema_version: 1;
  profile: "general" | "java";
  files: Array<{ path: string; sha256: string }>;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
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
    }
  });
});
