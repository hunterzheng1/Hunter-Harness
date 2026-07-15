import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  getAdapter,
  HARNESS_AGENT_ORDER,
  managedTargetsFor
} from "../src/project/agent-adapters.js";
import {
  loadAgentBundle,
  type LoadedAgentBundle
} from "../src/project/profile-bundle.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syntheticBundle(
  agent: "claude-code" | "codex" | "cursor" | "codebuddy",
  entries: Array<{ path: string; bytes: Uint8Array }>
): LoadedAgentBundle {
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) files.set(entry.path, entry.bytes);
  return {
    manifest: {
      schema_version: 2,
      profile: "general",
      adapter: agent,
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

describe("agent adapters", () => {
  it("every adapter reports no executable hooks", () => {
    for (const name of HARNESS_AGENT_ORDER) {
      expect(getAdapter(name).supportsExecutableHooks).toBe(false);
    }
  });

  it("claude-code projects agents/ to .claude/agents and rest to .claude/skills", () => {
    const bundle = syntheticBundle("claude-code", [
      { path: "agents/demo.md", bytes: new TextEncoder().encode("a") },
      { path: "harness-demo/SKILL.md", bytes: new TextEncoder().encode("b") }
    ]);
    const projected = getAdapter("claude-code").projectBundle(bundle, {
      profile: "general", codebuddySurface: "both"
    });
    expect(projected.map((p) => p.target_path)).toEqual([
      ".claude/agents/demo.md",
      ".claude/skills/harness-demo/SKILL.md"
    ]);
  });

  it("codex projects everything to .agents/skills and has no rules", () => {
    const adapter = getAdapter("codex");
    expect(adapter.rulesRoot).toBeNull();
    expect(adapter.agentsRoot).toBeNull();
    const bundle = syntheticBundle("codex", [
      { path: "harness-demo/SKILL.md", bytes: new TextEncoder().encode("b") }
    ]);
    const projected = adapter.projectBundle(bundle, {
      profile: "general", codebuddySurface: "both"
    });
    expect(projected.map((p) => p.target_path)).toEqual([
      ".agents/skills/harness-demo/SKILL.md"
    ]);
    expect(adapter.contextIndex({ profile: "general", codebuddySurface: "both" }).rules)
      .toEqual([]);
  });

  it("cursor emits .mdc rules and .cursor/skills targets", () => {
    const adapter = getAdapter("cursor");
    const bundle = syntheticBundle("cursor", [
      { path: "harness-demo/SKILL.md", bytes: new TextEncoder().encode("b") }
    ]);
    const managed = managedTargetsFor(adapter, bundle, {
      profile: "java", codebuddySurface: "both"
    });
    expect(managed.some((t) => t.target_path === ".cursor/rules/harness-general.mdc")).toBe(true);
    expect(managed.some((t) => t.target_path === ".cursor/rules/harness-profile-java.mdc")).toBe(true);
    const mdc = managed.find((t) => t.target_path.endsWith("harness-general.mdc"));
    const text = new TextDecoder().decode(mdc?.bytes);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("alwaysApply: true");
  });

  it.each([
    ["both", [
      ".codebuddy/.rules/harness-general.mdc",
      ".codebuddy/.rules/harness-profile-java.mdc",
      ".codebuddy/rules/harness-general.md",
      ".codebuddy/rules/harness-profile-java.md"
    ]],
    ["ide", [
      ".codebuddy/.rules/harness-general.mdc",
      ".codebuddy/.rules/harness-profile-java.mdc"
    ]],
    ["cli", [
      ".codebuddy/rules/harness-general.md",
      ".codebuddy/rules/harness-profile-java.md"
    ]]
  ] as const)("codebuddy %s surface emits the matching managed rules", (surface, rules) => {
    const adapter = getAdapter("codebuddy");
    const bundle = syntheticBundle("codebuddy", [
      { path: "agents/demo.md", bytes: new TextEncoder().encode("a") },
      { path: "harness-demo/SKILL.md", bytes: new TextEncoder().encode("b") }
    ]);
    const managed = managedTargetsFor(adapter, bundle, {
      profile: "java", codebuddySurface: surface
    });
    expect(managed.map((t) => t.target_path).filter((path) => path.includes("rules/")))
      .toEqual(rules);
    expect(managed.map((t) => t.target_path)).toEqual(expect.arrayContaining([
      ".codebuddy/agents/demo.md", ".codebuddy/skills/harness-demo/SKILL.md"
    ]));
    expect(adapter.contextIndex({ profile: "java", codebuddySurface: surface }).rules)
      .toEqual(rules);
  });

  it("pruneBoundaries stay inside own root", () => {
    expect(getAdapter("codex").pruneBoundaries({
      profile: "general", codebuddySurface: "both"
    })).toEqual(expect.arrayContaining([".agents/skills", ".agents"]));
    expect(getAdapter("claude-code").pruneBoundaries({
      profile: "general", codebuddySurface: "both"
    })).toEqual(expect.arrayContaining([".claude/skills", ".claude/agents", ".claude"]));
  });

  it("loads real claude-code and codex bundles from new layout", async () => {
    const claude = await loadAgentBundle(resourcesRoot, "general", "claude-code");
    expect(claude.manifest.schema_version).toBe(2);
    expect(claude.manifest.adapter).toBe("claude-code");
    expect([...claude.files.keys()].some((p) => p.startsWith("agents/"))).toBe(true);

    const codex = await loadAgentBundle(resourcesRoot, "general", "codex");
    expect(codex.manifest.adapter).toBe("codex");
    expect([...codex.files.keys()].some((p) => p.startsWith("agents/"))).toBe(false);
  });
});
