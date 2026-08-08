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

    expect(content).not.toContain("/.claude/skills/harness-*/");
    expect(content).toContain("/.cursor/skills/harness-*/");
    expect(result.patternResults).toContainEqual({
      pattern: "/.claude/skills/harness-*/",
      status: "already-ignored"
    });
    expect(result.patternResults).toContainEqual({
      pattern: "/.cursor/skills/harness-*/",
      status: "added"
    });
  });

  it("ignores Python bytecode caches created by Harness support scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-pycache-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });

    await ensureHarnessGitignore(root);
    const content = await readFile(join(root, ".gitignore"), "utf8");

    for (const adapterRoot of [".claude", ".agents", ".cursor", ".codebuddy"]) {
      const pattern = `/${adapterRoot}/skills/scripts/__pycache__/`;
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

  it("ignores every untracked Harness projection from the installed bundle without hiding source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-gitignore-projections-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeInstalledTargets(root, [
      ".codebuddy/skills/CONTEXT.md",
      ".codebuddy/skills/contracts/workflow-policy.json",
      ".codebuddy/skills/scripts/harness_events.py",
      ".codebuddy/skills/harness-plan/SKILL.md",
      "src/index.ts"
    ]);

    const result = await ensureHarnessGitignore(root);
    const content = await readFile(join(root, ".gitignore"), "utf8");

    expect(content).toContain("/.codebuddy/skills/CONTEXT.md");
    expect(content).toContain("/.codebuddy/skills/contracts/workflow-policy.json");
    expect(content).toContain("/.codebuddy/skills/scripts/harness_events.py");
    expect(content).not.toContain("/src/index.ts");
    expect(result.patternResults).toContainEqual({
      pattern: "/.codebuddy/skills/CONTEXT.md",
      status: "added"
    });
    await expect(execFileAsync("git", [
      "check-ignore", "--no-index", "--",
      ".codebuddy/skills/CONTEXT.md",
      ".codebuddy/skills/contracts/workflow-policy.json",
      ".codebuddy/skills/scripts/harness_events.py",
      ".codebuddy/skills/harness-plan/SKILL.md"
    ], { cwd: root, windowsHide: true })).resolves.toBeDefined();

    const repeated = await ensureHarnessGitignore(root);
    expect(repeated.changed).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(content);
  });

  it("does not ignore a tracked projection and removes stale generated entries after uninstall", async () => {
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
    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toContain("/.codebuddy/skills/scripts/harness_events.py");

    await writeInstalledTargets(root, []);
    await ensureHarnessGitignore(root);
    const afterUninstall = await readFile(join(root, ".gitignore"), "utf8");
    expect(afterUninstall).not.toContain("/.codebuddy/skills/scripts/harness_events.py");
    expect(afterUninstall).not.toContain("/.codebuddy/skills/CONTEXT.md");
  });
});
