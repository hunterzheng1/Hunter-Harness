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

  it("bundle actual file set equals manifest declared set — API-012/UT-030", async () => {
    for (const profile of PROFILES) {
      for (const agent of AGENTS) {
        const manifest = JSON.parse(await readFile(
          join(resources, "manifests", profile, `${agent}.json`), "utf8"
        )) as ManifestV2;
        const bundleRoot = join(resources, "bundles", profile, agent);
        const actual = new Set(await filePaths(bundleRoot));
        const declared = new Set(manifest.files.map((f) => f.path));
        const extra = [...actual].filter((p) => !declared.has(p));
        const missing = [...declared].filter((p) => !actual.has(p));
        expect(extra, `${profile}/${agent} extra files`).toEqual([]);
        expect(missing, `${profile}/${agent} missing files`).toEqual([]);
      }
    }
  });

  it.each(PROFILES)(
    "every adapter bundle carries skill-referenced support files — UT-033",
    async (profile) => {
      // design §3.8: every adapter (incl. codex) must carry the reference.md /
      // checklist.md / protocols.md a Skill's SKILL.md references. Guards
      // against the ".agents/skills/harness-plan only has SKILL.md" regression.
      // Only progressive-disclosure "Read `xxx.md`" references count — a skill
      // that declares "暂无 reference.md" (rules inline in SKILL.md) is fine.
      for (const agent of AGENTS) {
        const bundleRoot = join(resources, "bundles", profile, agent);
        const entries = await readdir(bundleRoot, { withFileTypes: true });
        const skills = entries
          .filter((e) => e.isDirectory() && e.name.startsWith("harness-"))
          .map((e) => e.name);
        expect(skills.length, `${profile}/${agent} has harness-* skills`).toBeGreaterThan(0);
        for (const skill of skills) {
          const skillMd = await readFile(join(bundleRoot, skill, "SKILL.md"), "utf8");
          const refs = new Set<string>();
          for (const m of skillMd.matchAll(/Read\s+`?([a-zA-Z0-9_.-]+\.md)`?/g)) {
            refs.add(m[1]);
          }
          for (const ref of refs) {
            if (ref === "SKILL.md") continue;
            expect(
              await exists(join(bundleRoot, skill, ref)),
              `${profile}/${agent}/${skill} references ${ref} but it is missing`
            ).toBe(true);
          }
        }
      }
    }
  );
});
