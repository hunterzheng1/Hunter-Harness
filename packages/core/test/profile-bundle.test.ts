import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadProfileBundle,
  parseMigrationManifest,
  projectBundle,
  type ProfileBundle
} from "../src/project/profile-bundle.js";

const resourcesRoot = fileURLToPath(new URL("../../../resources", import.meta.url));

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// 合成 bundle 用于纯投影逻辑测试，绕过 loadProfileBundle 的文件读取，
// 直接驱动 projectBundle 的路径校验与目标去重。
function syntheticBundle(
  entries: Array<{ path: string; bytes: Uint8Array }>
): ProfileBundle {
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) files.set(entry.path, entry.bytes);
  return {
    manifest: {
      schema_version: 2,
      profile: "general",
      adapter: "claude-code",
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

describe("Installation Projection", () => {
  it("keeps agents definitions in the canonical Bundle with manifest-valid hashes", async () => {
    const bundle = await loadProfileBundle(resourcesRoot, "general");
    const agents = bundle.manifest.files.filter((f) => f.path.startsWith("agents/"));
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      const bytes = bundle.files.get(agent.path);
      expect(bytes, agent.path).toBeDefined();
      expect(shaHex(bytes as Uint8Array)).toBe(agent.sha256);
    }
  });

  it("routes agent definitions only to .claude/agents, never to .claude/skills/agents", async () => {
    const bundle = await loadProfileBundle(resourcesRoot, "general");
    const projected = projectBundle(bundle);
    const agentTargets = projected.filter((p) => p.target_path.startsWith(".claude/agents/"));
    expect(agentTargets.length).toBeGreaterThan(0);
    for (const agent of agentTargets) {
      expect(agent.source_path).toMatch(/^agents\/[^/]+\.md$/);
      expect(agent.target_path).toBe(`.claude/agents/${agent.source_path.slice("agents/".length)}`);
    }
    // 投影不得产生 .claude/skills/agents/ 下的任何目标（消除旧的双重安装）。
    expect(projected.some((p) => p.target_path.startsWith(".claude/skills/agents/"))).toBe(false);
  });

  it("routes every non-agent Bundle path to .claude/skills/<source-path>", async () => {
    const bundle = await loadProfileBundle(resourcesRoot, "general");
    const projected = projectBundle(bundle);
    const nonAgents = projected.filter((p) => !p.source_path.startsWith("agents/"));
    expect(nonAgents.length).toBeGreaterThan(0);
    for (const item of nonAgents) {
      expect(item.target_path).toBe(`.claude/skills/${item.source_path}`);
    }
  });

  it("records byte-identical content and manifest hash for each projected file", async () => {
    const bundle = await loadProfileBundle(resourcesRoot, "general");
    const projected = projectBundle(bundle);
    for (const item of projected) {
      const manifestEntry = bundle.manifest.files.find((f) => f.path === item.source_path);
      expect(manifestEntry, item.source_path).toBeDefined();
      expect(item.sha256).toBe(manifestEntry?.sha256);
      expect(shaHex(item.bytes)).toBe(item.sha256);
      expect(item.bytes).toBe(bundle.files.get(item.source_path));
    }
  });

  it("sorts projected files by target path deterministically", async () => {
    const bundle = await loadProfileBundle(resourcesRoot, "general");
    const targets = projectBundle(bundle).map((p) => p.target_path);
    expect([...targets].sort((a, b) => a.localeCompare(b))).toEqual(targets);
  });

  it("rejects a malicious source path that would escape the project", () => {
    const bundle = syntheticBundle([
      { path: "agents/../../escape.md", bytes: new TextEncoder().encode("x") }
    ]);
    expect(() => projectBundle(bundle)).toThrow();
  });

  it("rejects an absolute or drive-bearing source path", () => {
    const bundle = syntheticBundle([
      { path: "/etc/passwd", bytes: new TextEncoder().encode("x") }
    ]);
    expect(() => projectBundle(bundle)).toThrow();
  });

  it("rejects duplicate projected targets that collide case-insensitively", () => {
    const bundle = syntheticBundle([
      { path: "agents/Foo.md", bytes: new TextEncoder().encode("a") },
      { path: "agents/foo.md", bytes: new TextEncoder().encode("b") }
    ]);
    expect(() => projectBundle(bundle)).toThrow(/collision/i);
  });

  it("rejects an unsafe migration projection before it can become trusted metadata", () => {
    expect(() => parseMigrationManifest({
      schema_version: 1,
      profile: "general",
      bundle_version: "0.1.1",
      bundle_manifest_hash: "sha256:" + "a".repeat(64),
      projection: [{
        source_path: "agents/harness-reviewer.md",
        target_path: "../../notes.txt",
        sha256: "b".repeat(64)
      }]
    })).toThrow();
  });

  it("parses a safe migration projection as trusted metadata", () => {
    const parsed = parseMigrationManifest({
      schema_version: 1,
      profile: "general",
      bundle_version: "0.1.1",
      bundle_manifest_hash: "sha256:" + "a".repeat(64),
      projection: [{
        source_path: "agents/harness-reviewer.md",
        target_path: ".claude/agents/harness-reviewer.md",
        sha256: "b".repeat(64)
      }]
    });
    expect(parsed.profile).toBe("general");
  });
});
