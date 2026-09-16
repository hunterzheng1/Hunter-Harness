import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_SURFACE,
  CODEBUDDY_SKILLS_ROOT,
  CODEBUDDY_SURFACE,
  contextIndexEntryFor,
  INSTRUCTION_FILE,
  PRIMARY_SKILLS_ROOT,
  projectBundleToSurface,
  pruneBoundaries,
  skillsRootFor
} from "../src/project/agent-adapters.js";
import {
  FIXED_PROFILE,
  loadBundle,
  PROJECTION_SURFACES,
  type ProjectionSurface
} from "../src/project/profile-bundle.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syntheticBundle(entries: Array<{ path: string; bytes: Uint8Array }>) {
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) files.set(entry.path, entry.bytes);
  return {
    manifest: {
      schema_version: 2 as const,
      profile: FIXED_PROFILE,
      adapter: CANONICAL_SURFACE,
      bundle_version: "0.0.0-test",
      generator: "harness_deploy.py",
      files: entries.map((entry) => ({
        path: entry.path,
        sha256: shaHex(entry.bytes)
      }))
    },
    files
  };
}

describe("v1.0 fixed projection surface constants", () => {
  it("fixes the projection to codex (.agents) + codebuddy (.codebuddy) with AGENTS.md", () => {
    expect(PROJECTION_SURFACES).toEqual(["codex", "codebuddy"]);
    expect(CANONICAL_SURFACE).toBe("codex");
    expect(CODEBUDDY_SURFACE).toBe("codebuddy");
    expect(INSTRUCTION_FILE).toBe("AGENTS.md");
    expect(skillsRootFor("codex")).toBe(".agents/skills");
    expect(skillsRootFor("codebuddy")).toBe(".codebuddy/skills");
    expect(PRIMARY_SKILLS_ROOT).toBe(".agents/skills");
    expect(CODEBUDDY_SKILLS_ROOT).toBe(".codebuddy/skills");
    expect(FIXED_PROFILE).toBe("general");
  });

  it("derives context-index entries per surface without static rules", () => {
    expect(contextIndexEntryFor("codex")).toEqual({
      instructions: "AGENTS.md",
      skills_root: ".agents/skills",
      rules: []
    });
    expect(contextIndexEntryFor("codebuddy")).toEqual({
      instructions: "AGENTS.md",
      skills_root: ".codebuddy/skills",
      rules: []
    });
  });

  it("prunes only the two managed skills roots", () => {
    expect(pruneBoundaries()).toEqual([".agents/skills", ".codebuddy/skills"]);
  });
});

describe("projectBundleToSurface", () => {
  it("routes every non-agents path to <surface skills root>/<source path>", async () => {
    const bundle = await loadBundle(resourcesRoot, "codex");
    const projected = projectBundleToSurface(bundle, "codex");
    expect(projected.length).toBeGreaterThan(0);
    for (const item of projected) {
      expect(item.target_path).toBe(`.agents/skills/${item.source_path}`);
    }
  });

  it("never projects agents/ definitions", async () => {
    const bundle = await loadBundle(resourcesRoot, "codebuddy");
    const projected = projectBundleToSurface(bundle, "codebuddy");
    expect(projected.some((p) => p.source_path.startsWith("agents/"))).toBe(false);
    expect(projected.some((p) => p.target_path.includes("/agents/"))).toBe(false);
  });

  it("rejects a malicious source path that would escape the project", () => {
    const bundle = syntheticBundle([
      { path: "skills/../../escape.md", bytes: new TextEncoder().encode("x") }
    ]);
    expect(() => projectBundleToSurface(bundle, "codex")).toThrow();
  });

  it("rejects an absolute or drive-bearing source path", () => {
    const bundle = syntheticBundle([
      { path: "/etc/passwd", bytes: new TextEncoder().encode("x") }
    ]);
    expect(() => projectBundleToSurface(bundle, "codex")).toThrow();
  });

  it("rejects duplicate projected targets that collide case-insensitively", () => {
    const bundle = syntheticBundle([
      { path: "skills/Foo/SKILL.md", bytes: new TextEncoder().encode("a") },
      { path: "skills/foo/SKILL.md", bytes: new TextEncoder().encode("b") }
    ]);
    expect(() => projectBundleToSurface(bundle, "codex")).toThrow(/collision/i);
  });

  it("rejects unknown surfaces at the type boundary", () => {
    const bundle = syntheticBundle([]);
    expect(() => projectBundleToSurface(bundle, "pi" as ProjectionSurface)).toThrow();
    expect(() => skillsRootFor("pi" as ProjectionSurface)).toThrow();
    expect(() => contextIndexEntryFor("pi" as ProjectionSurface)).toThrow();
  });
});

describe("loadBundle (flattened v1.0 layout)", () => {
  it("loads codex and codebuddy bundles with surface-matching manifests", async () => {
    for (const surface of PROJECTION_SURFACES) {
      const bundle = await loadBundle(resourcesRoot, surface);
      expect(bundle.manifest.adapter).toBe(surface);
      expect(bundle.manifest.profile).toBe(FIXED_PROFILE);
      expect(bundle.manifest.schema_version).toBe(2);
      expect(bundle.files.size).toBe(bundle.manifest.files.length);
    }
  });

  it("rejects a missing resources root with ADAPTER_BUNDLE_MISSING (exit 7)", async () => {
    const missingRoot = fileURLToPath(new URL("../test/__no_such_resources__", import.meta.url));
    await expect(loadBundle(missingRoot, "codex")).rejects.toMatchObject({
      name: "AdapterBundleError",
      code: "ADAPTER_BUNDLE_MISSING",
      exitCode: 7
    });
  });
});
