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
    const second = await synchronizeProjectRules(
      root, ["claude-code", "codex", "cursor", "codebuddy"], "both"
    );

    expect(first.written).toHaveLength(5);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(5);
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
});
