import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { atomicWriteJson } from "../src/state/atomic.js";
import { ensureStateLayout } from "../src/state/layout.js";
import { initializeProject } from "../src/project/initialize.js";

const resourcesRoot = fileURLToPath(new URL("../../../resources", import.meta.url));

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const REQUIRED_CORE_LAYOUT = [
  ".harness/project.yaml",
  ".harness/context-index.json",
  ".harness/knowledge/index.json",
  ".harness/state/baseline/manifest.json",
  ".harness/state/local/installed-harness-bundle.json"
];

const OPTIONAL_MUST_NOT_EXIST = [
  ".harness/cache",
  ".harness/cache/server-artifacts",
  ".harness/reports",
  ".harness/codebase/map",
  ".harness/knowledge/_candidates",
  ".harness/knowledge/project-local",
  ".harness/README.md",
  ".harness/state/local/.gitkeep",
  ".harness/knowledge/_candidates/.gitkeep",
  ".harness/codebase/map/.gitkeep"
];

describe("minimal first installation", () => {
  it("creates only the required .harness core layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-min-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });

    for (const required of REQUIRED_CORE_LAYOUT) {
      expect(await exists(join(root, required)), required).toBe(true);
    }
    for (const optional of OPTIONAL_MUST_NOT_EXIST) {
      expect(await exists(join(root, optional)), optional).toBe(false);
    }
  });

  it("preserves unrelated existing .harness files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-min-keep-"));
    await mkdir(join(root, ".harness", "deep"), { recursive: true });
    await writeFile(join(root, ".harness", "custom.txt"), "keep me\n");
    await writeFile(join(root, ".harness", "deep", "note.md"), "deep\n");

    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });

    expect(await readFile(join(root, ".harness", "custom.txt"), "utf8")).toBe("keep me\n");
    expect(await readFile(join(root, ".harness", "deep", "note.md"), "utf8")).toBe("deep\n");
  });

  it("does not pre-create cache or reports directories via the transaction layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-min-layout-"));
    await ensureStateLayout(root);

    // 事务基础设施只能创建 state/{baseline,transactions,locks,local}；
    // cache/server-artifacts 与 reports 必须由各自 feature 懒创建。
    expect(await exists(join(root, ".harness", "state", "transactions"))).toBe(true);
    expect(await exists(join(root, ".harness", "state", "locks"))).toBe(true);
    expect(await exists(join(root, ".harness", "cache"))).toBe(false);
    expect(await exists(join(root, ".harness", "reports"))).toBe(false);
  });

  it("lets features lazily create optional directories before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-min-lazy-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });

    // 一个 feature 向可选目录写入时，必须能自行创建目录，而非依赖首次安装预创建。
    await atomicWriteJson(
      join(root, ".harness", "cache", "server-artifacts", "art_1", "manifest.json"),
      { artifact_id: "art_1" }
    );
    expect(await exists(join(root, ".harness", "cache", "server-artifacts", "art_1", "manifest.json"))).toBe(true);
  });
});

describe("multi-agent initialize", () => {
  it("INS-CODEX: projects only Codex roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-codex-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["codex"], profile: "general" },
      dryRun: false
    });
    expect(await exists(join(root, "AGENTS.md"))).toBe(true);
    expect(await exists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, "CLAUDE.md"))).toBe(false);
    expect(await exists(join(root, ".claude"))).toBe(false);
    expect(await exists(join(root, ".codex"))).toBe(false);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("id=hunter-harness-core");
  });

  it("INS-CURSOR: emits .mdc rules and cursor skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-cursor-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["cursor"], profile: "general" },
      dryRun: false
    });
    const mdc = await readFile(join(root, ".cursor", "rules", "harness-general.mdc"), "utf8");
    expect(mdc.startsWith("---\n")).toBe(true);
    expect(await exists(join(root, ".cursor", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".cursor", "rules", "harness-general.md"))).toBe(false);
  });

  it("INS-CB: projects CodeBuddy skills/agents and CODEBUDDY.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-cb-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["codebuddy"], profile: "general", codebuddy_surface: "both" },
      dryRun: false
    });
    const cb = await readFile(join(root, "CODEBUDDY.md"), "utf8");
    expect(cb).toContain("id=hunter-harness-codebuddy");
    expect(await exists(join(root, ".codebuddy", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".codebuddy", "agents", "harness-reviewer.md"))).toBe(true);
    expect(await exists(join(root, ".codebuddy", "settings.json"))).toBe(false);
    expect(await exists(join(root, ".codebuddy", "rules"))).toBe(false);
  });

  it("installs all four agents with shared AGENTS block, context v2, state v3", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-all-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: {
        agents: ["claude-code", "codex", "cursor", "codebuddy"],
        profile: "general"
      },
      dryRun: false
    });
    expect(await exists(join(root, ".claude", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".cursor", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".codebuddy", "skills", "harness-review", "SKILL.md"))).toBe(true);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect((agents.match(/hunter-harness:start/g) ?? []).length).toBe(1);

    const index = JSON.parse(
      await readFile(join(root, ".harness", "context-index.json"), "utf8")
    ) as {
      schema_version: number;
      project: { adapters: Record<string, unknown> };
      skill_bundles: Record<string, unknown>;
    };
    expect(index.schema_version).toBe(2);
    expect(Object.keys(index.project.adapters).sort()).toEqual(
      ["claude-code", "codebuddy", "codex", "cursor"]
    );
    expect(Object.keys(index.skill_bundles).sort()).toEqual(
      Object.keys(index.project.adapters).sort()
    );

    const state = JSON.parse(
      await readFile(join(root, ".harness", "state", "local", "installed-harness-bundle.json"), "utf8")
    ) as {
      schema_version: number;
      files: Array<{ owner: string; target_path: string }>;
      managed_blocks: Array<{ block_id: string }>;
    };
    expect(state.schema_version).toBe(3);
    const owners = new Set(state.files.map((f) => f.owner));
    expect(owners.has("claude-code")).toBe(true);
    expect(owners.has("codex")).toBe(true);
    expect(owners.has("cursor")).toBe(true);
    expect(owners.has("codebuddy")).toBe(true);
    const targets = state.files.map((f) => f.target_path);
    expect(new Set(targets).size).toBe(targets.length);
    expect(state.managed_blocks.some((b) => b.block_id === "hunter-harness-core")).toBe(true);
  }, 120_000);

  it("is idempotent across two installs except installed_at", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-idem-"));
    const config = {
      agents: ["claude-code", "codex"] as const,
      profile: "general" as const
    };
    await initializeProject({ projectRoot: root, resourcesRoot, config: { ...config }, dryRun: false });
    const firstState = JSON.parse(
      await readFile(join(root, ".harness", "state", "local", "installed-harness-bundle.json"), "utf8")
    ) as { installed_at: string };
    const snapshot = async (): Promise<Map<string, string>> => {
      const { createHash } = await import("node:crypto");
      const { readdir } = await import("node:fs/promises");
      const walk = async (dir: string, base = dir): Promise<string[]> => {
        const out: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) out.push(...await walk(full, base));
          else out.push(full.slice(base.length + 1).replaceAll("\\", "/"));
        }
        return out;
      };
      const map = new Map<string, string>();
      for (const rel of await walk(root)) {
        if (rel === ".harness/state/local/installed-harness-bundle.json") continue;
        if (rel.startsWith(".harness/state/transactions/")) continue;
        if (rel.startsWith(".harness/state/locks/")) continue;
        const bytes = await readFile(join(root, rel));
        map.set(rel, createHash("sha256").update(bytes).digest("hex"));
      }
      return map;
    };
    const before = await snapshot();
    await initializeProject({ projectRoot: root, resourcesRoot, config: { ...config }, dryRun: false });
    const after = await snapshot();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, hash] of before) {
      expect(after.get(path), path).toBe(hash);
    }
    const secondState = JSON.parse(
      await readFile(join(root, ".harness", "state", "local", "installed-harness-bundle.json"), "utf8")
    ) as { installed_at: string; files: unknown; manifests: unknown; managed_blocks: unknown };
    expect(secondState.installed_at).not.toBe(firstState.installed_at);
    expect(secondState.files).toEqual(
      (firstState as unknown as { files: unknown }).files
    );
    expect(secondState.manifests).toEqual(
      (firstState as unknown as { manifests: unknown }).manifests
    );
    expect(secondState.managed_blocks).toEqual(
      (firstState as unknown as { managed_blocks: unknown }).managed_blocks
    );
  }, 120_000);
});
