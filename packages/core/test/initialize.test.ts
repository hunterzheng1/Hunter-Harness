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
