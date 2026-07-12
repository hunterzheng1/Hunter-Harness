import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { upsertManagedBlock } from "../src/managed/managed-block.js";
import {
  AGENTS_MANAGED_BLOCK_CONTENT,
  CLAUDE_MANAGED_BLOCK_CONTENT,
  HARNESS_GENERAL_RULES_CONTENT,
  HARNESS_JAVA_RULES_CONTENT
} from "../src/project/managed-content.js";
import { initializeProject } from "../src/project/initialize.js";
import {
  loadMigrationManifests,
  type HarnessProfile
} from "../src/project/profile-bundle.js";
import { refreshProject } from "../src/project/refresh.js";

const resourcesRoot = fileURLToPath(new URL("../../../resources", import.meta.url));
const v011BundlesRoot = fileURLToPath(
  new URL("./fixtures/v0.1.1-bundles", import.meta.url)
);
const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";

async function walkFiles(directory: string, base = directory): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walkFiles(full, base));
    if (entry.isFile()) {
      paths.push(full.slice(base.length + 1).replaceAll("\\", "/"));
    }
  }
  return paths;
}

/** Load frozen 0.1.1 published bytes (pre semantic-adaptation) for migration fixtures. */
async function loadV011BundleFiles(
  profile: HarnessProfile
): Promise<Map<string, Uint8Array>> {
  const root = join(v011BundlesRoot, profile);
  const files = new Map<string, Uint8Array>();
  for (const relative of await walkFiles(root)) {
    files.set(relative, await readFile(join(root, relative)));
  }
  return files;
}

function uuid(): string {
  return randomUUID();
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

// 模拟已发布的 0.1.1 安装：旧投影（agents 双重安装到 .claude/skills/agents/ 与 .claude/agents/）、
// schema-v1 state（仅路径无 hash）、context-index bundle_hash 指向 0.1.1 迁移 manifest。
async function installV1Style(root: string, profile: HarnessProfile): Promise<void> {
  const legacyFiles = await loadV011BundleFiles(profile);
  const migration = (await loadMigrationManifests(resourcesRoot)).find((m) => m.profile === profile);
  if (migration === undefined) throw new Error(`no migration manifest for ${profile}`);

  for (const [path, bytes] of legacyFiles) {
    const skillTarget = join(root, ".claude", "skills", path);
    await mkdir(dirname(skillTarget), { recursive: true });
    await writeFile(skillTarget, bytes);
    const agent = /^agents\/([^/]+\.md)$/.exec(path);
    if (agent) {
      await mkdir(join(root, ".claude", "agents"), { recursive: true });
      await writeFile(join(root, ".claude", "agents", agent[1]), bytes);
    }
  }
  await mkdir(join(root, ".claude", "rules"), { recursive: true });
  await writeFile(join(root, ".claude", "rules", "harness-general.md"), HARNESS_GENERAL_RULES_CONTENT);
  if (profile === "java") {
    await writeFile(join(root, ".claude", "rules", "harness-profile-java.md"), HARNESS_JAVA_RULES_CONTENT);
  }

  await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
  await mkdir(join(root, ".harness", "state", "baseline"), { recursive: true });
  await mkdir(join(root, ".harness", "knowledge"), { recursive: true });

  const projectConfig = {
    harness: { name: "hunter-harness", schema_version: 1 },
    project: { name: "v1-fixture", root: ".", local_project_key: uuid(), project_id: null, profiles: [profile] },
    server: { url: null, token_env: "HUNTER_HARNESS_TOKEN" },
    adapters: { enabled: ["claude-code"] }
  };
  await writeFile(join(root, ".harness", "project.yaml"), stringifyYaml(projectConfig, { sortMapEntries: true }));
  await writeFile(join(root, ".harness", "context-index.json"), JSON.stringify({
    schema_version: 1,
    project: { claude_md: "CLAUDE.md", agents_md: "AGENTS.md" },
    rules: [".claude/rules/harness-general.md"],
    knowledge: { index: ".harness/knowledge/index.json" },
    codebase: { map: ".harness/codebase/map", status: "missing" },
    skill_bundle: { registry_version: migration.bundle_version, bundle_hash: migration.bundle_manifest_hash }
  }, null, 2) + "\n");
  await writeFile(join(root, ".harness", "knowledge", "index.json"), JSON.stringify({ schema_version: 1, generated_at: null, entries: [] }, null, 2) + "\n");
  await writeFile(join(root, ".harness", "state", "baseline", "manifest.json"), JSON.stringify({ schema_version: 1, project_id: null, complete_project_version: null, artifact_manifest_hash: null, files: {} }, null, 2) + "\n");

  const v1Files: string[] = [];
  for (const [path, bytes] of legacyFiles) {
    const skillPath = `.claude/skills/${path}`;
    v1Files.push(skillPath);
    const agent = /^agents\/([^/]+\.md)$/.exec(path);
    if (agent) v1Files.push(`.claude/agents/${agent[1]}`);
    const expected = migration.projection.find((entry) => entry.target_path === skillPath);
    if (expected !== undefined) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected.sha256) {
        throw new Error(`v0.1.1 fixture hash drift for ${skillPath}`);
      }
    }
  }
  if (profile === "java") v1Files.push(".claude/rules/harness-profile-java.md");
  v1Files.sort();
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify({ schema_version: 1, profile, files: v1Files }, null, 2) + "\n");

  await writeFile(join(root, "AGENTS.md"), upsertManagedBlock("", AGENTS_MANAGED_BLOCK_CONTENT));
  await writeFile(join(root, "CLAUDE.md"), upsertManagedBlock("", CLAUDE_MANAGED_BLOCK_CONTENT));
}

describe("0.1.1 migration", () => {
  it("real 0.1.1 general fixture refreshes to schema v2 and removes duplicate skills agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-mig-general-"));
    await installV1Style(root, "general");
    expect(await exists(join(root, ".claude", "skills", "agents", "harness-reviewer.md"))).toBe(true);

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    expect(result.conflicts).toHaveLength(0);
    // 旧重复目标 .claude/skills/agents/* 已被干净删除。
    expect(await exists(join(root, ".claude", "skills", "agents"))).toBe(false);
    // .claude/agents/* 共享目标保留且为当前字节。
    const reviewer = await readFile(join(root, ".claude", "agents", "harness-reviewer.md"));
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "general", "claude-code", "agents", "harness-reviewer.md"
    ));
    expect(reviewer).toEqual(incoming);
    // schema v2 state 已写入。
    const state = JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")) as { schema_version: number };
    expect(state.schema_version).toBe(2);
  });

  it("real 0.1.1 java fixture refreshes and removes clean duplicate skills agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-mig-java-"));
    await installV1Style(root, "java");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "java", dryRun: false, forceManaged: false
    });

    expect(result.conflicts).toHaveLength(0);
    expect(await exists(join(root, ".claude", "skills", "agents"))).toBe(false);
    expect(await exists(join(root, ".claude", "agents", "harness-reviewer.md"))).toBe(true);
  });

  it("preserves a modified duplicate skills agent as unmanaged conflict (exit 5)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-mig-modified-"));
    await installV1Style(root, "general");
    const dupTarget = join(root, ".claude", "skills", "agents", "harness-reviewer.md");
    await writeFile(dupTarget, "user modified duplicate\n");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.some((c) => c.target_path === ".claude/skills/agents/harness-reviewer.md")).toBe(true);
    expect(await readFile(dupTarget, "utf8")).toBe("user modified duplicate\n");
    // 修改的重复文件不再进入新 state（不再受管）。
    const state = JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")) as {
      schema_version: number; files: Array<{ target_path: string }>;
    };
    expect(state.schema_version).toBe(2);
    expect(state.files.some((f) => f.target_path === ".claude/skills/agents/harness-reviewer.md")).toBe(false);
  });

  it("unknown legacy Bundle hash never authorizes deletion of duplicate files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-mig-unknown-"));
    await installV1Style(root, "general");
    // 破坏 context-index bundle_hash → 无迁移匹配。
    const ci = JSON.parse(await readFile(join(root, ".harness", "context-index.json"), "utf8")) as { skill_bundle: { bundle_hash: string } };
    ci.skill_bundle.bundle_hash = "sha256:unknownlegacy";
    await writeFile(join(root, ".harness", "context-index.json"), JSON.stringify(ci, null, 2) + "\n");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    // 无可信 hash → 不删除旧重复目标（design §7.5）。
    expect(await exists(join(root, ".claude", "skills", "agents", "harness-reviewer.md"))).toBe(true);
    expect(result.removed.some((r) => r.target_path.includes("skills/agents/"))).toBe(false);
  });
});

describe("Profile Transition", () => {
  it("general to java adds Java-only files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-trans-gj-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" }, dryRun: false
    });
    expect(await exists(join(root, ".claude", "skills", "harness-apidoc", "SKILL.md"))).toBe(false);

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "java", dryRun: false, forceManaged: false
    });

    expect(result.applied.some((i) => i.target_path === ".claude/skills/harness-apidoc/SKILL.md")).toBe(true);
    expect(await exists(join(root, ".claude", "skills", "harness-apidoc", "SKILL.md"))).toBe(true);
    expect(await exists(join(root, ".claude", "rules", "harness-profile-java.md"))).toBe(true);
    const project = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    expect(project).toContain("- java");
  });

  it("java to general removes clean Java-only files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-trans-jg-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code"], profile: "java" }, dryRun: false
    });

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    expect(result.removed.some((r) => r.target_path === ".claude/skills/harness-apidoc/SKILL.md")).toBe(true);
    expect(await exists(join(root, ".claude", "skills", "harness-apidoc", "SKILL.md"))).toBe(false);
    expect(await exists(join(root, ".claude", "rules", "harness-profile-java.md"))).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  it("modified Java-only file survives transition and produces exit code 5", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-trans-modified-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code"], profile: "java" }, dryRun: false
    });
    const apidoc = join(root, ".claude", "skills", "harness-apidoc", "SKILL.md");
    await writeFile(apidoc, "user edited apidoc\n");

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", dryRun: false, forceManaged: false
    });

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.some((c) => c.target_path === ".claude/skills/harness-apidoc/SKILL.md")).toBe(true);
    expect(await readFile(apidoc, "utf8")).toBe("user edited apidoc\n");
  });
});

describe("migration manifest integrity", () => {
  it("keeps the embedded 0.1.1 migration hashes captured from the published package", async () => {
    const migrations = await loadMigrationManifests(resourcesRoot);
    expect(migrations.length).toBe(2);
    expect(migrations.find((m) => m.profile === "general")?.bundle_manifest_hash).toBe(
      "sha256:2fb84084b893e2250981740f1ed7b1b1236720817ec82f37e4b1ce8cb73cf1e8"
    );
    expect(migrations.find((m) => m.profile === "java")?.bundle_manifest_hash).toBe(
      "sha256:e839d5f548f17094bfe626af747536669a8c5f0aa2d67cf13972251f76887230"
    );
  });
});
