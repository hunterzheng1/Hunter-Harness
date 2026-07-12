import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { refreshProject, type RefreshResult } from "../src/project/refresh.js";

const resourcesRoot = fileURLToPath(new URL("../../../resources", import.meta.url));

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

async function installFirst(root: string, profile: "general" | "java"): Promise<void> {
  await initializeProject({
    projectRoot: root,
    resourcesRoot,
    config: { agents: ["claude-code"], profile },
    dryRun: false
  });
}

async function readInstalledState(root: string): Promise<{
  schema_version: number;
  profile: string;
  bundle_manifest_hash?: string;
  files: Array<{ source_path?: string; target_path: string; sha256?: string } | string>;
}> {
  return JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8"));
}

async function writeInstalledState(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify(value, null, 2) + "\n");
}

const REVIEWER_TARGET = ".claude/agents/harness-reviewer.md";
const REVIEWER_SOURCE = "agents/harness-reviewer.md";

describe("Conservative Refresh", () => {
  it("does not reset project identity or state on an existing project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-id-"));
    await installFirst(root, "general");
    const projectBefore = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    const baselineBefore = await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    );
    const knowledgeBefore = await readFile(
      join(root, ".harness", "knowledge", "index.json"), "utf8"
    );

    const result = await refreshProject({
      projectRoot: root,
      resourcesRoot,
      profile: "general",
      dryRun: false,
      forceManaged: false
    });

    expect(result.previous_profile).toBe("general");
    expect(result.profile).toBe("general");
    expect(await readFile(join(root, ".harness", "project.yaml"), "utf8")).toBe(projectBefore);
    expect(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    )).toBe(baselineBefore);
    expect(await readFile(join(root, ".harness", "knowledge", "index.json"), "utf8")).toBe(knowledgeBefore);
    expect(result.conflicts).toHaveLength(0);
  });

  it("adds a missing Bundle target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-add-"));
    await installFirst(root, "general");
    await rm(join(root, REVIEWER_TARGET), { force: true });

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    const added = result.applied.find((item) => item.target_path === REVIEWER_TARGET);
    expect(added, "reviewer should be added").toBeDefined();
    expect(added?.action).toBe("add");
    expect(await exists(join(root, REVIEWER_TARGET))).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("replaces a clean (trusted) target with the incoming bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-clean-"));
    await installFirst(root, "general");

    // 把已安装文件改写为“旧内容”，并把 trusted hash 同步为旧内容 hash → 视为干净可替换。
    const oldBytes = new TextEncoder().encode("old canonical content\n");
    await writeFile(join(root, REVIEWER_TARGET), oldBytes);
    const state = await readInstalledState(root);
    for (const file of state.files) {
      if (typeof file !== "string" && file.target_path === REVIEWER_TARGET) {
        file.sha256 = hex(oldBytes);
      }
    }
    await writeInstalledState(root, state);

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    const replaced = result.applied.find((item) => item.target_path === REVIEWER_TARGET);
    expect(replaced, "reviewer should be replaced").toBeDefined();
    expect(replaced?.action).toBe("replace");
    expect(replaced?.reason).toBe("BASELINE_CLEAN");
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "general", "claude-code", REVIEWER_SOURCE
    ));
    expect(await readFile(join(root, REVIEWER_TARGET))).toEqual(incoming);
    expect(result.conflicts).toHaveLength(0);
  });

  it("preserves a modified target, still updates safe targets, and exits with conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-conflict-"));
    await installFirst(root, "general");

    // 修改一个目标 → 冲突保留。
    await writeFile(join(root, REVIEWER_TARGET), "user edited\n");
    // 另一个目标设为干净旧内容 → 安全替换。
    const explorerTarget = ".claude/agents/harness-explorer.md";
    const oldExplorer = new TextEncoder().encode("old explorer\n");
    await writeFile(join(root, explorerTarget), oldExplorer);
    const state = await readInstalledState(root);
    for (const file of state.files) {
      if (typeof file !== "string" && file.target_path === explorerTarget) {
        file.sha256 = hex(oldExplorer);
      }
    }
    await writeInstalledState(root, state);

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    expect(result.conflicts.some((c) => c.target_path === REVIEWER_TARGET)).toBe(true);
    const preserved = result.preserved.find((item) => item.target_path === REVIEWER_TARGET);
    expect(preserved?.reason).toBe("LOCAL_MODIFICATION");
    expect(await readFile(join(root, REVIEWER_TARGET), "utf8")).toBe("user edited\n");
    const replaced = result.applied.find((item) => item.target_path === explorerTarget);
    expect(replaced?.action).toBe("replace");
  });

  it("force-managed replaces only a trusted managed target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-force-"));
    await installFirst(root, "general");
    await writeFile(join(root, REVIEWER_TARGET), "user edited\n");
    // 一个非 Bundle 受管文件必须不受 --force-managed 影响。
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "keep\n");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: true
    });

    const replaced = result.applied.find((item) => item.target_path === REVIEWER_TARGET);
    expect(replaced?.reason).toBe("FORCE_MANAGED");
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "general", "claude-code", REVIEWER_SOURCE
    ));
    expect(await readFile(join(root, REVIEWER_TARGET))).toEqual(incoming);
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep\n");
  });

  it("forged installed state cannot authorize deletion or overwrite of an unrelated file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-forged-"));
    await installFirst(root, "general");
    await writeFile(join(root, "notes.txt"), "keep this user file\n");
    // 伪造 state 声称 notes.txt 是受管文件。
    await writeInstalledState(root, {
      schema_version: 2,
      profile: "general",
      bundle_version: "0.1.0",
      bundle_manifest_hash: "sha256:forged",
      installed_at: "2026-07-11T00:00:00.000Z",
      files: [{ source_path: "notes.txt", target_path: "notes.txt", sha256: "forgedhash" }]
    });

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep this user file\n");
    // notes.txt 不在 Bundle 投影中，故不出现在结果里。
    expect(result.applied.some((i) => i.target_path === "notes.txt")).toBe(false);
    expect(result.removed.some((i) => i.target_path === "notes.txt")).toBe(false);
  });

  it("keeps knowledge, baseline, reports, cache, and unrelated .harness files byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-preserve-"));
    await installFirst(root, "general");
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

    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

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
    await installFirst(root, "general");
    await rm(join(root, REVIEWER_TARGET), { force: true });
    const stateBefore = await readFile(join(root, INSTALLED_STATE_PATH), "utf8");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: true, forceManaged: false
    });

    expect(result.dry_run).toBe(true);
    expect(result.applied.some((i) => i.target_path === REVIEWER_TARGET)).toBe(true);
    expect(await exists(join(root, REVIEWER_TARGET))).toBe(false);
    expect(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")).toBe(stateBefore);
  });

  it("writes schema-v2 installed state with per-file hashes sorted by target path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-schema-"));
    await installFirst(root, "general");
    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });
    const state = await readInstalledState(root);
    expect(state.schema_version).toBe(2);
    expect(state.profile).toBe("general");
    expect(typeof state.bundle_manifest_hash).toBe("string");
    const targets = state.files.map((f) => (typeof f === "string" ? f : f.target_path));
    expect([...targets].sort((a, b) => a.localeCompare(b))).toEqual(targets);
    for (const file of state.files) {
      if (typeof file !== "string") {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.source_path).toBeDefined();
      }
    }
  });
});

// silence unused import in some runs
void (undefined as unknown as RefreshResult);
