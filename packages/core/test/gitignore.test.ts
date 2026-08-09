import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ensureHarnessGitignore } from "../src/project/gitignore.js";

const execFileAsync = promisify(execFile);

describe("Harness .gitignore maintenance", () => {
  async function writeInstalledTargets(root: string, targets: string[]): Promise<void> {
    const statePath = join(root, ".harness", "state", "local", "installed-harness-bundle.json");
    await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      schema_version: 4,
      adapters: ["codebuddy"],
      profiles: { codebuddy: "general" },
      installed_at: "2026-08-09T00:00:00.000Z",
      manifests: [],
      files: targets.map((target_path) => ({
        owner: "codebuddy",
        source_path: target_path,
        target_path,
        sha256: "a".repeat(64)
      })),
      managed_blocks: []
    }, null, 2) + "\n", "utf8");
  }

  it("uses effective Git semantics per pattern without letting an unrelated negation block updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, ".gitignore"), "/.claude/\n!/.cursor/user-settings/\n", "utf8");

    const result = await ensureHarnessGitignore(root);
    const content = await readFile(join(root, ".gitignore"), "utf8");

    expect(content.match(/^\/\.claude\/$/gm)).toHaveLength(1);
    expect(content).toContain("/.cursor/");
    expect(result.patternResults).toContainEqual({
      pattern: "/.claude/",
      status: "already-ignored"
    });
    expect(result.patternResults).toContainEqual({
      pattern: "/.cursor/",
      status: "added"
    });
  });

  it("ignores each local Agent workspace as one top-level directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-pycache-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });

    await ensureHarnessGitignore(root);
    const content = await readFile(join(root, ".gitignore"), "utf8");

    for (const adapterRoot of [".claude", ".agents", ".cursor", ".codebuddy"]) {
      const pattern = `/${adapterRoot}/`;
      expect(content).toContain(pattern);
      await expect(execFileAsync("git", [
        "check-ignore", "--no-index", "--",
        `${adapterRoot}/skills/scripts/__pycache__/harness_events.cpython-311.pyc`
      ], { cwd: root, windowsHide: true })).resolves.toBeDefined();
    }
  });

  it("reports a generated root document as tracked instead of ignoring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-tracked-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "AGENTS.md"), "# team-owned\n", "utf8");
    await execFileAsync("git", ["add", "AGENTS.md"], { cwd: root, windowsHide: true });

    await ensureHarnessGitignore(root, { generatedRootDocuments: ["AGENTS.md"] });
    const result = await ensureHarnessGitignore(root, { platformBound: true });

    expect(result.patternResults).toContainEqual({ pattern: "/AGENTS.md", status: "tracked" });
    expect(await readFile(join(root, ".gitignore"), "utf8")).not.toMatch(/^\/AGENTS\.md$/m);
  });

  it("keeps a UTF-8 BOM at byte zero and preserves CRLF", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-bom-"));
    await writeFile(join(root, ".gitignore"), "\uFEFFnode_modules/\r\n", "utf8");

    await ensureHarnessGitignore(root);

    const bytes = await readFile(join(root, ".gitignore"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text.slice(1)).not.toContain("\uFEFF");
    expect(text).toContain("/.harness/\r\n");
    expect(text).toContain("node_modules/\r\n");
  });

  it("does not expand installed projections when their Agent directory is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-projections-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeInstalledTargets(root, [
      ".codebuddy/skills/CONTEXT.md",
      ".codebuddy/skills/contracts/workflow-policy.json",
      ".codebuddy/skills/protocols/state.md",
      ".codebuddy/skills/scripts/harness_events.py",
      ".codebuddy/skills/harness-plan/SKILL.md",
      "src/index.ts"
    ]);

    const result = await ensureHarnessGitignore(root);
    const content = await readFile(join(root, ".gitignore"), "utf8");

    expect(content).toContain("/.codebuddy/");
    expect(content).not.toContain("# hunter-harness:generated-projections:start");
    expect(content).not.toContain("/.codebuddy/skills/CONTEXT.md");
    expect(content).not.toContain("/.codebuddy/skills/contracts/");
    expect(content).not.toContain("/.codebuddy/skills/protocols/");
    expect(content).not.toContain("/.codebuddy/skills/scripts/");
    expect(content).not.toContain("/.codebuddy/skills/contracts/workflow-policy.json");
    expect(content).not.toContain("/.codebuddy/skills/protocols/state.md");
    expect(content).not.toContain("/.codebuddy/skills/scripts/harness_events.py");
    expect(content).not.toContain("/src/index.ts");
    expect(result.patternResults).toContainEqual({ pattern: "/.codebuddy/", status: "added" });
    await expect(execFileAsync("git", [
      "check-ignore", "--no-index", "--",
      ".codebuddy/skills/CONTEXT.md",
      ".codebuddy/skills/contracts/workflow-policy.json",
      ".codebuddy/skills/scripts/harness_events.py",
      ".codebuddy/skills/harness-plan/SKILL.md"
    ], { cwd: root, windowsHide: true })).resolves.toBeDefined();
    await expect(execFileAsync("git", [
      "check-ignore", "--no-index", "--",
      ".codebuddy/skills/custom/personal.md"
    ], { cwd: root, windowsHide: true })).resolves.toBeDefined();

    const repeated = await ensureHarnessGitignore(root);
    expect(repeated.changed).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(content);
  });

  it("reports tracked projections while retaining the top-level Agent rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-projection-lifecycle-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await mkdir(join(root, ".codebuddy", "skills"), { recursive: true });
    await writeFile(join(root, ".codebuddy", "skills", "CONTEXT.md"), "team owned\n", "utf8");
    await execFileAsync("git", ["add", ".codebuddy/skills/CONTEXT.md"], {
      cwd: root,
      windowsHide: true
    });
    await writeInstalledTargets(root, [
      ".codebuddy/skills/CONTEXT.md",
      ".codebuddy/skills/scripts/harness_events.py"
    ]);

    const first = await ensureHarnessGitignore(root);
    expect(first.patternResults).toContainEqual({
      pattern: "/.codebuddy/skills/CONTEXT.md",
      status: "tracked"
    });
    expect(first.trackedMigrationNotice).toMatchObject({
      shouldDisplay: true,
      patterns: ["/.codebuddy/skills/CONTEXT.md"]
    });
    const repeated = await ensureHarnessGitignore(root);
    expect(repeated.trackedMigrationNotice?.shouldDisplay).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toContain("/.codebuddy/");

    await writeInstalledTargets(root, []);
    await ensureHarnessGitignore(root);
    const afterUninstall = await readFile(join(root, ".gitignore"), "utf8");
    expect(afterUninstall).toContain("/.codebuddy/");
    expect(afterUninstall).not.toContain("# hunter-harness:generated-projections:start");
  });
});
