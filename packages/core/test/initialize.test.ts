import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { atomicWriteJson } from "../src/state/atomic.js";
import { ensureStateLayout } from "../src/state/layout.js";
import { initializeProject } from "../src/project/initialize.js";
import { miniResources } from "./mini-resources.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

// 合成 mini bundle（见 mini-resources.ts）：init 的布局、幂等与内容逻辑和
// bundle 文件数无关；真实 bundle 的端到端保真由下方真实资源用例承担。

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
  ".harness/state/baseline/manifest.json",
  ".harness/state/local/installed-harness-bundle.json"
];

const OPTIONAL_MUST_NOT_EXIST = [
  ".harness/cache",
  ".harness/cache/server-artifacts",
  ".harness/reports",
  ".harness/codebase/map",
  ".harness/knowledge",
  ".harness/knowledge/_candidates",
  ".harness/knowledge/project-local",
  ".harness/README.md",
  ".harness/rules",
  ".harness/state/local/.gitkeep",
  ".harness/knowledge/_candidates/.gitkeep",
  ".harness/codebase/map/.gitkeep"
];

// v1.0 起不再投影的旧 agent 根与指令文件。
const RETIRED_PROJECTION_PATHS = [
  ".claude",
  ".cursor",
  ".pi",
  "CLAUDE.md",
  "CODEBUDDY.md"
];

describe("minimal first installation", () => {
  it("creates only the required .harness core layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-min-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
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
      resourcesRoot: await miniResources(),
      config: {},
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
      resourcesRoot: await miniResources(),
      config: {},
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

describe("fixed dual-surface projection", () => {
  it("projects .agents/skills + .codebuddy/skills and AGENTS.md managed blocks only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-fixed-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
      dryRun: false
    });

    expect(await exists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".codebuddy", "skills", "harness-review", "SKILL.md"))).toBe(true);
    for (const retired of RETIRED_PROJECTION_PATHS) {
      expect(await exists(join(root, retired)), retired).toBe(false);
    }

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("hunter-harness:start id=hunter-harness-core");
    expect(agents).toContain("hunter-harness:start id=hunter-harness-learned-rules");
  });

  it("preserves existing user AGENTS.md content and appends managed blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-agents-keep-"));
    const existing = "# My Project\n\nUser-written guidance.\n";
    await writeFile(join(root, "AGENTS.md"), existing);

    await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
      dryRun: false
    });

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain(existing.trimEnd());
    expect(agents).toContain("hunter-harness:start id=hunter-harness-core");
    expect(agents).toContain("hunter-harness:start id=hunter-harness-learned-rules");
  });

  it("never reads or rewrites an existing CLAUDE.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-claude-keep-"));
    const existing = "# Existing Claude instructions\n";
    await writeFile(join(root, "CLAUDE.md"), existing);

    const result = await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
      dryRun: false
    });

    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(existing);
    // 无 hunter-harness 受管块的 CLAUDE.md 不算旧版投影残留。
    expect(result.legacyWarnings).toEqual([]);
  });

  it("warns about pre-1.0 projection residue without deleting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-legacy-"));
    await mkdir(join(root, ".claude", "skills", "harness-review"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "harness-review", "SKILL.md"), "old\n");

    const result = await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
      dryRun: false
    });

    expect(result.legacyWarnings.length).toBeGreaterThan(0);
    expect(result.legacyWarnings.join("\n")).toContain(".claude/skills");
    expect(await readFile(join(root, ".claude", "skills", "harness-review", "SKILL.md"), "utf8")).toBe("old\n");
  });

  it("installs the real bundle to both surfaces with context v2 and state v5", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-real-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: {},
      dryRun: false
    });

    expect(await exists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".codebuddy", "skills", "harness-review", "SKILL.md"))).toBe(true);
    for (const retired of RETIRED_PROJECTION_PATHS) {
      expect(await exists(join(root, retired)), retired).toBe(false);
    }
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Harness Core Instructions");
    expect(agents).toContain("hunter-harness:start id=hunter-harness-core");

    const index = JSON.parse(
      await readFile(join(root, ".harness", "context-index.json"), "utf8")
    ) as {
      schema_version: number;
      project: { adapters: Record<string, unknown> };
      skill_bundles: Record<string, unknown>;
    };
    expect(index.schema_version).toBe(2);
    expect(Object.keys(index.project.adapters).sort()).toEqual(["codebuddy", "codex"]);
    expect(Object.keys(index.skill_bundles).sort()).toEqual(["codebuddy", "codex"]);

    const state = JSON.parse(
      await readFile(join(root, ".harness", "state", "local", "installed-harness-bundle.json"), "utf8")
    ) as {
      schema_version: number;
      surfaces: string[];
      files: Array<{ owner: string; target_path: string }>;
      managed_blocks: Array<{ block_id: string }>;
    };
    expect(state.schema_version).toBe(5);
    expect(state.surfaces).toEqual(["codex", "codebuddy"]);
    const owners = new Set(state.files.map((f) => f.owner));
    expect([...owners].sort()).toEqual(["codebuddy", "codex"]);
    const targets = state.files.map((f) => f.target_path);
    expect(new Set(targets).size).toBe(targets.length);
    expect(state.managed_blocks.map((block) => block.block_id).sort()).toEqual([
      "hunter-harness-core",
      "hunter-harness-learned-rules"
    ]);
  }, 240_000);

  it("is idempotent across two installs except installed_at", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-ins-idem-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
      dryRun: false
    });
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
    await initializeProject({
      projectRoot: root,
      resourcesRoot: await miniResources(),
      config: {},
      dryRun: false
    });
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
  }, 240_000);
});
