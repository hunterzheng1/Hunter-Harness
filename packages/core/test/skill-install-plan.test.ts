import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getAgentSurface,
  planSkillInstall,
  resolveSkillDestination,
  resolveSubagentDestination
} from "../src/index.js";

const portable = (path: string): string => path.replaceAll("\\", "/");

describe("skill installation planning", () => {
  it("resolves native project and current-user destinations", () => {
    const root = resolve("sandbox/project");
    const home = resolve("sandbox/home");
    expect(portable(resolveSkillDestination(getAgentSurface("codex"), "project", root, "demo"))
      .endsWith("/sandbox/project/.agents/skills/demo")).toBe(true);
    expect(portable(resolveSubagentDestination(getAgentSurface("codex"), "user", home, "reviewer"))
      .endsWith("/sandbox/home/.codex/agents/reviewer.toml")).toBe(true);
    expect(portable(resolveSkillDestination(getAgentSurface("cursor"), "user", home, "demo"))
      .endsWith("/sandbox/home/.cursor/skills/demo")).toBe(true);
    expect(portable(resolveSkillDestination(getAgentSurface("codebuddy"), "project", root, "demo"))
      .endsWith("/sandbox/project/.codebuddy/skills/demo")).toBe(true);
  });

  it("keeps ordinary resources inside each selected skill root", () => {
    const plan = planSkillInstall({
      slug: "demo",
      agents: ["claude-code", "codex", "cursor", "codebuddy"],
      scope: "project",
      projectRoot: resolve("sandbox/project"),
      files: ["SKILL.md", "scripts/check.ps1", "references/guide.md", "examples/prompt.md"]
    });
    expect(plan.variants.every((variant) => variant.status === "ready")).toBe(true);
    expect(plan.operations).toHaveLength(16);
    expect(plan.operations.every((operation) => portable(operation.destinationPath)
      .includes("/skills/demo/"))).toBe(true);
  });

  it("routes explicit subagents to native roots without cross-format copying", () => {
    const manifest = {
      apiVersion: "hunter-harness/v1" as const,
      kind: "SkillBundle" as const,
      components: [{ role: "skill" as const, source: "." }, {
        role: "subagent" as const,
        source: ".",
        name: "reviewer",
        variants: {
          "claude-code": "agents/reviewer.md",
          codex: "agents/reviewer.toml",
          cursor: "agents/reviewer.md",
          codebuddy: "agents/reviewer.md"
        }
      }]
    };
    const plan = planSkillInstall({
      slug: "demo",
      agents: ["claude-code", "codex", "cursor", "codebuddy"],
      scope: "user",
      userHome: resolve("sandbox/home"),
      files: ["SKILL.md", "agents/reviewer.md", "agents/reviewer.toml"],
      manifest
    });
    const subagents = plan.operations.filter((operation) => operation.role === "subagent");
    expect(subagents.map((operation) => portable(operation.destinationPath).split("/sandbox/home").at(-1)))
      .toEqual([
        "/.claude/agents/reviewer.md",
        "/.codex/agents/reviewer.toml",
        "/.cursor/agents/reviewer.md",
        "/.codebuddy/agents/reviewer.md"
      ]);
  });

  it("rejects a Markdown Codex subagent and path traversal", () => {
    expect(() => planSkillInstall({
      slug: "demo",
      agents: ["codex"],
      scope: "project",
      projectRoot: resolve("sandbox/project"),
      files: ["SKILL.md", "agents/reviewer.md"],
      manifest: {
        apiVersion: "hunter-harness/v1",
        kind: "SkillBundle",
        components: [{ role: "skill", source: "." }, {
          role: "subagent",
          source: ".",
          name: "reviewer",
          variants: { codex: "agents/reviewer.md" }
        }]
      }
    })).toThrow("codex subagent must use .toml");
    expect(() => planSkillInstall({
      slug: "demo",
      agents: ["cursor"],
      scope: "project",
      projectRoot: resolve("sandbox/project"),
      files: ["SKILL.md", "../outside"]
    })).toThrow("invalid bundle file path");
  });
});
