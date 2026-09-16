import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { refreshProject } from "../src/project/refresh.js";
import { miniResources } from "./mini-resources.js";

// mini bundle（见 mini-resources.ts）：refresh 断言只涉及 harness-review /
// harness-explorer 两个 skill，验证/幂等语义与 bundle 文件数无关。
let resourcesRoot: string;

beforeAll(async () => {
  resourcesRoot = await miniResources();
});

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";

function hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// 种子安装：固定投影只真实部署一次整套 bundle，后续用例用目录拷贝复用。
let refreshSeed: string | undefined;

async function installFirst(root: string): Promise<void> {
  if (refreshSeed === undefined) {
    refreshSeed = await mkdtemp(join(tmpdir(), "hunter-refresh-seed-"));
    await initializeProject({
      projectRoot: refreshSeed,
      resourcesRoot,
      config: {},
      dryRun: false
    });
  }
  await rm(root, { recursive: true, force: true });
  await cp(refreshSeed, root, { recursive: true });
}

async function readInstalledState(root: string): Promise<{
  schema_version: number;
  surfaces?: string[];
  manifests?: Array<Record<string, unknown>>;
  files: Array<{ owner?: string; source_path?: string; target_path: string; sha256?: string } | string>;
}> {
  return JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8"));
}

async function writeInstalledState(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify(value, null, 2) + "\n");
}

const REVIEW_TARGET = ".agents/skills/harness-review/SKILL.md";
const REVIEW_SOURCE = "harness-review/SKILL.md";
const EXPLORER_TARGET = ".agents/skills/harness-explorer/SKILL.md";
const RETIRED_RENDERER_TARGET = ".agents/skills/harness-archive/templates/render-summary.mjs";

async function refresh(root: string, extra?: Partial<Parameters<typeof refreshProject>[0]>) {
  return await refreshProject({
    projectRoot: root,
    resourcesRoot,
    dryRun: false,
    forceManaged: false,
    ...extra
  });
}

describe("Conservative Refresh (fixed dual surface)", () => {
  it("does not reset project identity or state on an existing project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-id-"));
    await installFirst(root);
    const projectBefore = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    const baselineBefore = await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    );

    const result = await refresh(root);

    expect(result.legacy_warnings).toEqual([]);
    expect(await readFile(join(root, ".harness", "project.yaml"), "utf8")).toBe(projectBefore);
    expect(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    )).toBe(baselineBefore);
    expect(await exists(join(root, ".harness", "knowledge"))).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  it("rebuilds codebase-map status from disk instead of preserving a stale display value", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-codebase-status-"));
    await installFirst(root);
    const contextIndexPath = join(root, ".harness", "context-index.json");
    const contextIndex = JSON.parse(await readFile(contextIndexPath, "utf8")) as {
      codebase: { map: string; status: string };
    };
    contextIndex.codebase = { map: ".harness/codebase/map", status: "fresh" };
    await writeFile(contextIndexPath, JSON.stringify(contextIndex, null, 2) + "\n");

    await refresh(root);

    const refreshed = JSON.parse(await readFile(contextIndexPath, "utf8")) as {
      codebase: { map: string; status: string };
    };
    expect(refreshed.codebase).toEqual({
      map: ".harness/codebase/map",
      status: "missing"
    });
  });

  it("SYNC-STATE-001 persists projected verification in the same refresh that repairs a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-projected-state-"));
    await installFirst(root);
    await rm(join(root, REVIEW_TARGET), { force: true });

    await refresh(root);

    const context = JSON.parse(
      await readFile(join(root, ".harness", "context-index.json"), "utf8")
    ) as {
      skill_bundles: Record<string, {
        verificationStatus: string;
        mismatchDetails: unknown[];
      }>;
    };
    expect(context.skill_bundles.codex?.verificationStatus).toBe("verified");
    expect(context.skill_bundles.codex?.mismatchDetails).toEqual([]);
    expect(context.skill_bundles.codebuddy?.verificationStatus).toBe("verified");
  });

  it("adds a missing Bundle target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-add-"));
    await installFirst(root);
    await rm(join(root, REVIEW_TARGET), { force: true });

    const result = await refresh(root);

    const added = result.applied.find((item) => item.target_path === REVIEW_TARGET);
    expect(added, "review skill should be added").toBeDefined();
    expect(added?.action).toBe("add");
    expect(await exists(join(root, REVIEW_TARGET))).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("replaces a clean (trusted) target with the incoming bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-clean-"));
    await installFirst(root);

    // 把已安装文件改写为“旧内容”，并把 trusted hash 同步为旧内容 hash → 视为干净可替换。
    const oldBytes = new TextEncoder().encode("old canonical content\n");
    await writeFile(join(root, REVIEW_TARGET), oldBytes);
    const state = await readInstalledState(root);
    for (const file of state.files) {
      if (typeof file !== "string" && file.target_path === REVIEW_TARGET) {
        file.sha256 = hex(oldBytes);
      }
    }
    await writeInstalledState(root, state);

    const result = await refresh(root);

    const replaced = result.applied.find((item) => item.target_path === REVIEW_TARGET);
    expect(replaced, "review skill should be replaced").toBeDefined();
    expect(replaced?.action).toBe("replace");
    expect(replaced?.reason).toBe("BASELINE_CLEAN");
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "codex", REVIEW_SOURCE
    ));
    expect(await readFile(join(root, REVIEW_TARGET))).toEqual(incoming);
    expect(result.conflicts).toHaveLength(0);
  });

  it("preserves a modified target, still updates safe targets, and exits with conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-conflict-"));
    await installFirst(root);

    // 修改一个目标 → 冲突保留。
    await writeFile(join(root, REVIEW_TARGET), "user edited\n");
    // 另一个目标设为干净旧内容 → 安全替换。
    const oldExplorer = new TextEncoder().encode("old explorer\n");
    await writeFile(join(root, EXPLORER_TARGET), oldExplorer);
    const state = await readInstalledState(root);
    for (const file of state.files) {
      if (typeof file !== "string" && file.target_path === EXPLORER_TARGET) {
        file.sha256 = hex(oldExplorer);
      }
    }
    await writeInstalledState(root, state);

    const result = await refresh(root);

    expect(result.conflicts.some((c) => c.target_path === REVIEW_TARGET)).toBe(true);
    const conflict = result.conflicts.find((item) => item.target_path === REVIEW_TARGET);
    expect(conflict).toMatchObject({
      source_path: REVIEW_SOURCE,
      target_path: REVIEW_TARGET,
      adapter_content_sha256: hex("user edited\n"),
      source_content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      diff_summary: expect.objectContaining({
        kind: "CONTENT_DIFFERENT",
        adapter_bytes: "user edited\n".length
      })
    });
    const preserved = result.preserved.find((item) => item.target_path === REVIEW_TARGET);
    expect(preserved?.reason).toBe("LOCAL_MODIFICATION");
    expect(await readFile(join(root, REVIEW_TARGET), "utf8")).toBe("user edited\n");
    const replaced = result.applied.find((item) => item.target_path === EXPLORER_TARGET);
    expect(replaced?.action).toBe("replace");
  });

  it("force-managed replaces only a trusted managed target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-force-"));
    await installFirst(root);
    await writeFile(join(root, REVIEW_TARGET), "user edited\n");
    // 一个非 Bundle 受管文件必须不受 --force-managed 影响。
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "keep\n");

    const result = await refresh(root, { forceManaged: true });

    const replaced = result.applied.find((item) => item.target_path === REVIEW_TARGET);
    expect(replaced?.reason).toBe("FORCE_MANAGED");
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "codex", REVIEW_SOURCE
    ));
    expect(await readFile(join(root, REVIEW_TARGET))).toEqual(incoming);
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep\n");
  });

  it("forged installed state cannot authorize deletion or overwrite of an unrelated file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-forged-"));
    await installFirst(root);
    await writeFile(join(root, "notes.txt"), "keep this user file\n");
    // 伪造 state 声称 notes.txt 是受管文件。
    await writeInstalledState(root, {
      schema_version: 5,
      surfaces: ["codex", "codebuddy"],
      bundle_version: "0.0.0-mini",
      installed_at: "2026-07-11T00:00:00.000Z",
      manifests: [],
      managed_blocks: [],
      files: [{ owner: "codex", source_path: "notes.txt", target_path: "notes.txt", sha256: "forgedhash" }]
    });

    const result = await refresh(root);

    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep this user file\n");
    // notes.txt 不在 Bundle 投影中；伪造哈希与盘上内容不符，既不删也不改。
    expect(result.applied.some((i) => i.target_path === "notes.txt")).toBe(false);
    expect(result.removed.some((i) => i.target_path === "notes.txt")).toBe(false);
  });

  it("a locally modified out-of-bundle file inside a prune boundary is preserved as conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-prune-conflict-"));
    await installFirst(root);
    // 已退役的受管 skill：state 里记录过原始哈希，用户改写了盘上内容。
    const orphan = ".agents/skills/harness-retired/SKILL.md";
    await mkdir(join(root, ".agents", "skills", "harness-retired"), { recursive: true });
    await writeFile(join(root, orphan), "user edited retired skill\n");
    const state = await readInstalledState(root);
    state.files.push({
      owner: "codex",
      source_path: "harness-retired/SKILL.md",
      target_path: orphan,
      sha256: hex("original retired skill bytes\n")
    });
    await writeInstalledState(root, state);

    const result = await refresh(root);

    expect(await readFile(join(root, orphan), "utf8")).toBe("user edited retired skill\n");
    expect(result.removed.some((entry) => entry.target_path === orphan)).toBe(false);
    expect(result.conflicts.some((entry) => entry.target_path === orphan)).toBe(true);
  });

  it("keeps knowledge, baseline, reports, cache, and unrelated .harness files byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-preserve-"));
    await installFirst(root);
    await mkdir(join(root, ".harness", "knowledge", "project-local"), { recursive: true });
    await mkdir(join(root, ".harness", "reports"), { recursive: true });
    await mkdir(join(root, ".harness", "cache", "server-artifacts"), { recursive: true });
    await writeFile(join(root, ".harness", "knowledge", "project-local", "note.md"), "keep\n");
    await writeFile(join(root, ".harness", "reports", "r.json"), "{}\n");
    await writeFile(join(root, ".harness", "cache", "server-artifacts", "c.json"), "{}\n");
    await writeFile(join(root, ".harness", "custom.txt"), "keep me\n");
    const baselineBefore = await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    );

    await refresh(root);

    expect(await readFile(join(root, ".harness", "knowledge", "project-local", "note.md"), "utf8")).toBe("keep\n");
    expect(await readFile(join(root, ".harness", "reports", "r.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(root, ".harness", "cache", "server-artifacts", "c.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(root, ".harness", "custom.txt"), "utf8")).toBe("keep me\n");
    expect(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    )).toBe(baselineBefore);
  });

  it("dry-run performs no writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-dry-"));
    await installFirst(root);
    await rm(join(root, REVIEW_TARGET), { force: true });
    const stateBefore = await readFile(join(root, INSTALLED_STATE_PATH), "utf8");

    const result = await refresh(root, { dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.applied.some((i) => i.target_path === REVIEW_TARGET)).toBe(true);
    expect(await exists(join(root, REVIEW_TARGET))).toBe(false);
    expect(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")).toBe(stateBefore);
  });

  it("writes schema-v5 installed state with per-surface manifests and sorted hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-schema-"));
    await installFirst(root);
    await refresh(root);
    const state = await readInstalledState(root);
    expect(state.schema_version).toBe(5);
    expect(state.surfaces).toEqual(["codex", "codebuddy"]);
    const manifestSurfaces = (state.manifests ?? []).map((entry) => entry.surface);
    expect(manifestSurfaces).toEqual(["codebuddy", "codex"]);
    const targets = state.files.map((f) => (typeof f === "string" ? f : f.target_path));
    expect([...targets].sort((a, b) => a.localeCompare(b))).toEqual(targets);
    for (const file of state.files) {
      if (typeof file !== "string") {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.source_path).toBeDefined();
        expect(["codex", "codebuddy"]).toContain(file.owner);
      }
    }
  });

  it("treats pre-1.0 installed state as legacy: warns and reinstalls to schema v5", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-legacy-state-"));
    await installFirst(root);
    const initial = await readInstalledState(root);
    await writeInstalledState(root, {
      schema_version: 2,
      profile: "general",
      bundle_version: "0.1.1",
      installed_at: "2026-07-11T00:00:00.000Z",
      files: initial.files
    });

    const result = await refresh(root);

    expect(result.legacy_warnings.join("\n")).toContain("旧版安装状态");
    expect(result.legacy_warnings.join("\n")).toContain("uninstall");
    const state = await readInstalledState(root);
    expect(state.schema_version).toBe(5);
    // 字节未变的文件保持 unchanged，不应误报冲突。
    expect(result.conflicts).toHaveLength(0);
  });

  it("warns about legacy projection residue without touching it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-residue-"));
    await installFirst(root);
    await mkdir(join(root, ".claude", "skills", "harness-review"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "harness-review", "SKILL.md"), "old\n");
    // 0.x 其余投影面：agents/commands/.rules 与 bundle 附属内容。
    await mkdir(join(root, ".codebuddy", "agents"), { recursive: true });
    await writeFile(join(root, ".codebuddy", "agents", "harness-explorer.md"), "agent\n");
    await mkdir(join(root, ".codebuddy", ".rules"), { recursive: true });
    await writeFile(join(root, ".codebuddy", ".rules", "harness-general.mdc"), "rules\n");
    await mkdir(join(root, ".claude", "skills", "contracts"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "contracts", "x.md"), "contracts\n");

    const result = await refresh(root);
    const warnings = result.legacy_warnings.join("\n");

    expect(warnings).toContain(".claude/skills");
    expect(warnings).toContain("contracts");
    expect(warnings).toContain(".codebuddy/agents");
    expect(warnings).toContain(".codebuddy/.rules");
    expect(await readFile(join(root, ".claude", "skills", "harness-review", "SKILL.md"), "utf8")).toBe("old\n");
    expect(await readFile(join(root, ".codebuddy", "agents", "harness-explorer.md"), "utf8")).toBe("agent\n");
    expect(await readFile(join(root, ".codebuddy", ".rules", "harness-general.mdc"), "utf8")).toBe("rules\n");
  });

  it("keeps installed_at and state bytes unchanged for an idempotent refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-idempotent-"));
    await installFirst(root);
    const before = await readFile(join(root, INSTALLED_STATE_PATH), "utf8");
    const beforeStat = await stat(join(root, INSTALLED_STATE_PATH));
    await refresh(root);
    expect(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")).toBe(before);
    expect((await stat(join(root, INSTALLED_STATE_PATH))).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("removes the retired archive HTML renderer only when its content is trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-retired-renderer-"));
    await installFirst(root);
    const historical = await readFile(fileURLToPath(new URL(
      "./fixtures/v0.1.1-bundles/general/harness-archive/templates/render-summary.mjs",
      import.meta.url
    )));
    await mkdir(join(root, ".agents", "skills", "harness-archive", "templates"), {
      recursive: true
    });
    await writeFile(join(root, RETIRED_RENDERER_TARGET), historical);

    const result = await refresh(root);

    expect(await exists(join(root, RETIRED_RENDERER_TARGET))).toBe(false);
    expect(result.removed).toContainEqual(expect.objectContaining({ target_path: RETIRED_RENDERER_TARGET }));
  });

  it("preserves a locally edited retired archive HTML renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-edited-renderer-"));
    await installFirst(root);
    await mkdir(join(root, ".agents", "skills", "harness-archive", "templates"), {
      recursive: true
    });
    await writeFile(join(root, RETIRED_RENDERER_TARGET), "用户保留的同名脚本\n");

    const result = await refresh(root);

    expect(await readFile(join(root, RETIRED_RENDERER_TARGET), "utf8")).toBe("用户保留的同名脚本\n");
    expect(result.removed.some((entry) => entry.target_path === RETIRED_RENDERER_TARGET)).toBe(false);
    expect(result.preserved).toContainEqual(expect.objectContaining({ target_path: RETIRED_RENDERER_TARGET }));
  });
});
