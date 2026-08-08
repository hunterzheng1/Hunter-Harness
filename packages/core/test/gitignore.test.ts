import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ensureHarnessGitignore } from "../src/project/gitignore.js";

const execFileAsync = promisify(execFile);

describe("Harness .gitignore maintenance", () => {
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
});
