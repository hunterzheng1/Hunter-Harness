import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { synchronizeProjectRules } from "../src/project/project-rules.js";

describe("project rule projections", () => {
  it("projects canonical rules to every selected agent and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(join(root, ".harness", "rules", "team.md"), "# Team\n\nUse TDD.\n", "utf8");

    const first = await synchronizeProjectRules(
      root, ["claude-code", "codex", "cursor", "codebuddy"], "both"
    );
    const receiptPath = join(root, ".harness", "state", "local", "rule-projections.json");
    const receiptBefore = await stat(receiptPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await synchronizeProjectRules(
      root, ["claude-code", "codex", "cursor", "codebuddy"], "both"
    );
    const receiptAfter = await stat(receiptPath);

    expect(first.written).toHaveLength(5);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(5);
    expect(receiptAfter.mtimeMs).toBe(receiptBefore.mtimeMs);
    for (const relative of [
      ".claude/rules/team.md",
      ".cursor/rules/team.mdc",
      ".codebuddy/.rules/team.mdc",
      ".codebuddy/rules/team.md"
    ]) {
      expect(await readFile(join(root, relative), "utf8")).toBe("# Team\n\nUse TDD.\n");
      expect((await stat(join(root, relative))).isSymbolicLink()).toBe(false);
    }
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(".harness/rules/team.md");
  });

  it("updates clean projections but preserves locally modified targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    const canonical = join(root, ".harness", "rules", "team.md");
    await writeFile(canonical, "v1\n", "utf8");
    await synchronizeProjectRules(root, ["claude-code", "cursor"], "both");
    await writeFile(join(root, ".cursor", "rules", "team.mdc"), "local\n", "utf8");
    await writeFile(canonical, "v2\n", "utf8");

    const result = await synchronizeProjectRules(root, ["claude-code", "cursor"], "both");

    expect(await readFile(join(root, ".claude", "rules", "team.md"), "utf8")).toBe("v2\n");
    expect(await readFile(join(root, ".cursor", "rules", "team.mdc"), "utf8")).toBe("local\n");
    expect(result.conflicts).toEqual([".cursor/rules/team.mdc"]);
  });

  it("migrates existing Claude custom rules into the canonical directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await writeFile(join(root, ".claude", "rules", "team.md"), "shared\n", "utf8");

    const result = await synchronizeProjectRules(root, ["claude-code", "cursor"], "both");

    expect(result.migrated).toEqual([".harness/rules/team.md"]);
    expect(await readFile(join(root, ".harness", "rules", "team.md"), "utf8")).toBe("shared\n");
    expect(await readFile(join(root, ".cursor", "rules", "team.mdc"), "utf8")).toBe("shared\n");
  });

  it("converges identical custom rules from every agent into one canonical rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    for (const relative of [
      ".claude/rules/team.md",
      ".cursor/rules/team.mdc",
      ".codebuddy/.rules/team.mdc",
      ".codebuddy/rules/team.md"
    ]) {
      await mkdir(join(root, relative, ".."), { recursive: true });
      await writeFile(join(root, relative), "shared\r\n", "utf8");
    }

    const result = await synchronizeProjectRules(
      root, ["claude-code", "cursor", "codebuddy"], "both"
    );

    expect(result.migrated).toEqual([".harness/rules/team.md"]);
    expect(result.conflicts).toEqual([]);
    expect(await readFile(join(root, ".harness", "rules", "team.md"), "utf8")).toBe("shared\n");
  });

  it("reports divergent agent rules without choosing a winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(join(root, ".claude", "rules", "team.md"), "claude\n", "utf8");
    await writeFile(join(root, ".cursor", "rules", "team.mdc"), "cursor\n", "utf8");

    const result = await synchronizeProjectRules(root, ["claude-code", "cursor"], "both");

    expect(result.migrated).toEqual([]);
    expect(result.conflicts).toEqual([
      ".claude/rules/team.md",
      ".cursor/rules/team.mdc"
    ]);
    await expect(readFile(join(root, ".harness", "rules", "team.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps path-scoped MDC rules agent-specific", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(
      join(root, ".cursor", "rules", "frontend.mdc"),
      "---\ndescription: frontend\nglobs: src/**/*.tsx\n---\nUse components.\n",
      "utf8"
    );

    const result = await synchronizeProjectRules(root, ["cursor"], "both");

    expect(result.agent_specific).toEqual([".cursor/rules/frontend.mdc"]);
    expect(result.migrated).toEqual([]);
  });

  it("treats global Cursor frontmatter as adapter metadata instead of a rule conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(
      join(root, ".harness", "rules", "team.md"),
      "# Team\n\nUse focused tests.\n",
      "utf8"
    );
    const cursorRule = [
      "---",
      "description: Team development policy",
      "alwaysApply: true",
      "---",
      "",
      "# Team",
      "",
      "Use focused tests.",
      ""
    ].join("\n");
    await writeFile(join(root, ".cursor", "rules", "team.mdc"), cursorRule, "utf8");

    const result = await synchronizeProjectRules(root, ["cursor"], "both");

    expect(result.conflicts).toEqual([]);
    expect(result.unchanged).toContain(".cursor/rules/team.mdc");
    expect(await readFile(join(root, ".cursor", "rules", "team.mdc"), "utf8"))
      .toBe(cursorRule);
  });

  it("updates a clean Cursor projection body without deleting its global frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    const canonical = join(root, ".harness", "rules", "team.md");
    await writeFile(canonical, "# Team\n\nUse focused tests.\n", "utf8");
    await synchronizeProjectRules(root, ["cursor"], "both");
    const projected = join(root, ".cursor", "rules", "team.mdc");
    await writeFile(
      projected,
      [
        "---",
        "description: Team development policy",
        "alwaysApply: true",
        "---",
        "",
        "# Team",
        "",
        "Use focused tests.",
        ""
      ].join("\n"),
      "utf8"
    );
    await synchronizeProjectRules(root, ["cursor"], "both");
    await writeFile(canonical, "# Team\n\nUse focused regression tests.\n", "utf8");

    const result = await synchronizeProjectRules(root, ["cursor"], "both");
    const updated = await readFile(projected, "utf8");

    expect(result.conflicts).toEqual([]);
    expect(result.written).toContain(".cursor/rules/team.mdc");
    expect(updated).toContain("description: Team development policy");
    expect(updated).toContain("alwaysApply: true");
    expect(updated).toContain("Use focused regression tests.");
  });

  it("removes only the Codex projection block when Codex is deselected", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-"));
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(join(root, ".harness", "rules", "team.md"), "shared\n", "utf8");
    await writeFile(join(root, "AGENTS.md"), "# User instructions\n", "utf8");
    await synchronizeProjectRules(root, ["codex"], "both");

    await synchronizeProjectRules(root, ["claude-code"], "both");

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("# User instructions");
    expect(agents).not.toContain("hunter-harness-project-rules");
  });

  it("previews every rule projection without writing project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rules-check-"));
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(join(root, ".harness", "rules", "team.md"), "shared\n", "utf8");

    const result = await synchronizeProjectRules(
      root,
      ["claude-code", "codex", "cursor"],
      "both",
      { dryRun: true }
    );

    expect(result.written).toEqual([
      ".claude/rules/team.md",
      ".cursor/rules/team.mdc",
      "AGENTS.md"
    ]);
    await expect(readFile(join(root, ".claude", "rules", "team.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".harness", "state", "local", "rule-projections.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
