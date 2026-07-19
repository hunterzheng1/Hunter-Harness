import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { refreshProject, type RefreshResult } from "../src/project/refresh.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

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
  profile?: string;
  profiles?: Record<string, string>;
  adapters?: string[];
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
      agents: ["claude-code"],
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

  it("preserves the codebase-map status maintained by harness-codebase-map", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-codebase-status-"));
    await installFirst(root, "general");
    const contextIndexPath = join(root, ".harness", "context-index.json");
    const contextIndex = JSON.parse(await readFile(contextIndexPath, "utf8")) as {
      codebase: { map: string; status: string };
    };
    contextIndex.codebase = { map: ".harness/codebase/map", status: "fresh" };
    await writeFile(contextIndexPath, JSON.stringify(contextIndex, null, 2) + "\n");

    await refreshProject({
      projectRoot: root,
      resourcesRoot,
      profile: "general",
      agents: ["claude-code"],
      dryRun: false,
      forceManaged: false
    });

    const refreshed = JSON.parse(await readFile(contextIndexPath, "utf8")) as {
      codebase: { map: string; status: string };
    };
    expect(refreshed.codebase).toEqual({
      map: ".harness/codebase/map",
      status: "fresh"
    });
  });

  it("adds a missing Bundle target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-add-"));
    await installFirst(root, "general");
    await rm(join(root, REVIEWER_TARGET), { force: true });

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
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
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
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
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
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
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: true
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
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
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
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
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
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: true, forceManaged: false
    });

    expect(result.dry_run).toBe(true);
    expect(result.applied.some((i) => i.target_path === REVIEWER_TARGET)).toBe(true);
    expect(await exists(join(root, REVIEWER_TARGET))).toBe(false);
    expect(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")).toBe(stateBefore);
  });

  it("writes schema-v4 installed state with per-agent profiles and sorted hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-schema-"));
    await installFirst(root, "general");
    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
    });
    const state = await readInstalledState(root);
    expect(state.schema_version).toBe(4);
    expect(state.profiles).toEqual({ "claude-code": "general" });
    expect((state as typeof state & { manifests?: unknown[] }).manifests).toHaveLength(1);
    const targets = state.files.map((f) => (typeof f === "string" ? f : f.target_path));
    expect([...targets].sort((a, b) => a.localeCompare(b))).toEqual(targets);
    for (const file of state.files) {
      if (typeof file !== "string") {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.source_path).toBeDefined();
      }
    }
  });

  it("adds only the newly enabled codex projection and keeps one shared AGENTS block", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-add-codex-"));
    await installFirst(root, "general");
    const claudeTarget = await readFile(join(root, REVIEWER_TARGET), "utf8");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general",
      agents: ["claude-code", "codex"], dryRun: false, forceManaged: false
    });

    expect(result.applied.some((entry) => entry.target_path.startsWith(".agents/skills/"))).toBe(true);
    expect(await readFile(join(root, REVIEWER_TARGET), "utf8")).toBe(claudeTarget);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/hunter-harness:start id=hunter-harness-core/g)).toHaveLength(1);
  });

  it("touches only selected agents and keeps every unselected namespace byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-transition-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code", "codex"], profile: "general" }, dryRun: false
    });
    const claudeBefore = await readFile(join(root, REVIEWER_TARGET));
    const codexPath = join(root, ".agents", "skills", "harness-review", "SKILL.md");
    const codexBefore = await readFile(codexPath);
    const claudeInstructionsBefore = await readFile(join(root, "CLAUDE.md"));

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "java",
      agents: ["cursor"], dryRun: false, forceManaged: false
    });

    expect(await readFile(join(root, REVIEWER_TARGET))).toEqual(claudeBefore);
    expect(await readFile(codexPath)).toEqual(codexBefore);
    expect(await readFile(join(root, "CLAUDE.md"))).toEqual(claudeInstructionsBefore);
    expect(await exists(join(root, ".claude", "rules", "harness-profile-java.md"))).toBe(false);
    expect(await exists(join(root, ".cursor", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".cursor", "rules", "harness-profile-java.mdc"))).toBe(true);
    expect(result.removed.some((entry) => entry.target_path.startsWith(".claude/"))).toBe(false);
    expect(result.removed.some((entry) => entry.target_path.startsWith(".agents/"))).toBe(false);

    const state = await readInstalledState(root);
    expect(state.schema_version).toBe(4);
    expect(state.adapters).toEqual(["claude-code", "codex", "cursor"]);
    expect(state.profiles).toEqual({
      "claude-code": "general",
      codex: "general",
      cursor: "java"
    });
  }, 120_000);

  it("upgrades a v2 Claude state and legacy blocks in place to v4", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-v2-v3-"));
    await installFirst(root, "general");
    const initial = await readInstalledState(root);
    await writeInstalledState(root, {
      schema_version: 2, profile: "general", bundle_version: "0.1.1",
      bundle_manifest_hash: initial.bundle_manifest_hash ?? "unknown",
      installed_at: "2026-07-11T00:00:00.000Z",
      files: initial.files.map((entry) => {
        if (typeof entry === "string") return entry;
        return { source_path: entry.source_path, target_path: entry.target_path, sha256: entry.sha256 };
      })
    });
    await writeFile(join(root, "AGENTS.md"), "<!-- hunter-harness:start -->\nold\n<!-- hunter-harness:end -->\n");
    await writeFile(join(root, "CLAUDE.md"), "<!-- hunter-harness:start -->\nold\n<!-- hunter-harness:end -->\n");

    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general",
      agents: ["claude-code"], dryRun: false, forceManaged: false
    });

    const state = await readInstalledState(root) as typeof initial & {
      adapters: string[]; files: Array<{ owner?: string; target_path: string }>;
    };
    expect(state.schema_version).toBe(4);
    expect(state.adapters).toEqual(["claude-code"]);
    expect(state.files.every((entry) => entry.owner === "claude-code")).toBe(true);
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const content = await readFile(join(root, file), "utf8");
      expect(content).toContain("hunter-harness:start id=");
      expect(content.match(/hunter-harness:start/g)).toHaveLength(1);
    }
  });

  it("does not let forged v3 paths authorize unrelated changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-forged-v3-"));
    await installFirst(root, "general");
    await writeFile(join(root, "notes.txt"), "keep notes\n");
    await writeFile(join(root, ".env"), "SECRET=keep\n");
    await writeInstalledState(root, {
      schema_version: 3, profile: "general", adapters: ["claude-code"],
      installed_at: "2026-07-11T00:00:00.000Z", manifests: [],
      managed_blocks: [], files: [
        { owner: "claude-code", source_path: "notes.txt", target_path: "notes.txt", sha256: "forged" },
        { owner: "claude-code", source_path: ".env", target_path: ".env", sha256: "forged" },
        { owner: "claude-code", source_path: "x", target_path: "C:/absolute.txt", sha256: "forged" }
      ]
    });

    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general",
      agents: ["claude-code"], dryRun: false, forceManaged: false
    });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep notes\n");
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=keep\n");
  });

  it("keeps installed_at and state bytes unchanged for an idempotent refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-idempotent-"));
    await installFirst(root, "general");
    const before = await readFile(join(root, INSTALLED_STATE_PATH), "utf8");
    const beforeStat = await stat(join(root, INSTALLED_STATE_PATH));
    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general",
      agents: ["claude-code"], dryRun: false, forceManaged: false
    });
    expect(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")).toBe(before);
    expect((await stat(join(root, INSTALLED_STATE_PATH))).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("applies a profile transition across every enabled agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-multi-profile-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code", "cursor"], profile: "general" }, dryRun: false
    });
    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "java",
      agents: ["claude-code", "cursor"], dryRun: false, forceManaged: false
    });
    expect(await exists(join(root, ".claude", "rules", "harness-profile-java.md"))).toBe(true);
    expect(await exists(join(root, ".cursor", "rules", "harness-profile-java.mdc"))).toBe(true);

    await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general",
      agents: ["claude-code", "cursor"], dryRun: false, forceManaged: false
    });
    expect(await exists(join(root, ".claude", "rules", "harness-profile-java.md"))).toBe(false);
    expect(await exists(join(root, ".cursor", "rules", "harness-profile-java.mdc"))).toBe(false);
  }, 120_000);

  it("does not let a forged state hash authorize deleting a locally modified old-agent target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-forged-delete-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code", "codex"], profile: "general" }, dryRun: false
    });
    const state = await readInstalledState(root);
    const codexTarget = state.files
      .map((entry) => (typeof entry === "string" ? entry : entry.target_path))
      .find((target) => target.startsWith(".agents/skills/"));
    expect(codexTarget).toBeDefined();
    const targetPath = codexTarget as string;

    const edited = "user rewrote this codex skill\n";
    await writeFile(join(root, targetPath), edited);
    // 攻击者篡改 installed state：把该目标的 sha256 设为“用户已改内容”的哈希，
    // 企图让删除分支把脏文件误判为 clean（§19.5）。
    await writeInstalledState(root, {
      ...state,
      files: (state.files as Array<{ target_path: string; sha256?: string }>).map((entry) =>
        typeof entry === "string"
          ? entry
          : entry.target_path === targetPath
            ? { ...entry, sha256: hex(edited) }
            : entry
      )
    });

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general",
      agents: ["claude-code"], dryRun: false, forceManaged: false
    });

    expect(await exists(join(root, targetPath))).toBe(true);
    expect(await readFile(join(root, targetPath), "utf8")).toBe(edited);
    expect(result.removed.some((entry) => entry.target_path === targetPath)).toBe(false);
    expect(result.conflicts.some((entry) => entry.target_path === targetPath)).toBe(false);
  }, 120_000);
});

// silence unused import in some runs
void (undefined as unknown as RefreshResult);
