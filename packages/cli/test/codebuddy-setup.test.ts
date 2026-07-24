import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyCodeBuddySetup,
  inspectCodeBuddySetup
} from "../src/config/codebuddy-setup.js";

describe("CodeBuddy setup", () => {
  it("copies safe Claude rules, skips credentials, and merges CodeGraph MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-setup-"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, ".codebuddy", "rules"), { recursive: true });
    await mkdir(join(root, ".codegraph"), { recursive: true });
    await writeFile(join(root, ".claude", "rules", "team.md"), "# Team\nUse remote staging hosts.\n");
    await writeFile(join(root, ".claude", "rules", "secret.md"), "token = abc123\n");
    await writeFile(join(root, ".codebuddy", "rules", "team.md"), "keep existing\n");
    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { existing: { command: "existing" } }, note: "keep"
    }));

    const plan = await inspectCodeBuddySetup(root);
    expect(plan).toMatchObject({
      claudeRules: ["secret.md", "team.md"],
      hasCodeGraphIndex: true,
      codeGraphConfigured: false
    });

    const result = await applyCodeBuddySetup({
      projectRoot: root,
      surface: "both",
      syncClaudeRules: true,
      configureCodeGraph: true
    });
    expect(result.skippedSensitive).toEqual(["secret.md"]);
    expect(await readFile(join(root, ".codebuddy", ".rules", "team.mdc"), "utf8"))
      .toContain("remote staging");
    expect(await readFile(join(root, ".codebuddy", "rules", "team.md"), "utf8"))
      .toBe("keep existing\n");
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      note: string;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(mcp.note).toBe("keep");
    expect(mcp.mcpServers.existing?.command).toBe("existing");
    expect(mcp.mcpServers.codegraph).toEqual({
      command: "codegraph", args: ["serve", "--mcp"]
    });
  });

  it("preserves malformed .mcp.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-mcp-"));
    await writeFile(join(root, ".mcp.json"), "{ malformed");
    const result = await applyCodeBuddySetup({
      projectRoot: root,
      surface: "cli",
      syncClaudeRules: false,
      configureCodeGraph: true
    });
    expect(result.mcpUpdated).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe("{ malformed");
  });

  it("does not propose Claude rules that are already synchronized", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-current-rules-"));
    const content = "# Team\nUse remote staging hosts.\n";
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, ".codebuddy", ".rules"), { recursive: true });
    await mkdir(join(root, ".codebuddy", "rules"), { recursive: true });
    await writeFile(join(root, ".claude", "rules", "team.md"), content);
    await writeFile(join(root, ".codebuddy", ".rules", "team.mdc"), content);
    await writeFile(join(root, ".codebuddy", "rules", "team.md"), content);

    const plan = await inspectCodeBuddySetup(root, "both");

    expect(plan.claudeRules).toEqual([]);
    expect(plan.currentClaudeRules).toEqual(["team.md"]);
    expect(plan.conflictingClaudeRules).toEqual([]);
  });

  it("classifies divergent CodeBuddy targets as conflicts instead of current", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-conflicting-rules-"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, ".codebuddy", "rules"), { recursive: true });
    await writeFile(join(root, ".claude", "rules", "team.md"), "# Team\nnew\n");
    await writeFile(join(root, ".codebuddy", "rules", "team.md"), "# Team\nlocal edit\n");

    const plan = await inspectCodeBuddySetup(root, "cli");

    expect(plan.claudeRules).toEqual([]);
    expect(plan.currentClaudeRules).toEqual([]);
    expect(plan.conflictingClaudeRules).toEqual(["team.md"]);
  });
});
