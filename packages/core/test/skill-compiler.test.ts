import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SkillIr } from "@hunter-harness/contracts";
import {
  ADAPTERS,
  compileSkill,
  loadBootstrapBundle,
  mergeSkillIr,
  normalizeSkillIr,
  renderCodexSkill,
  renderCursorSkill,
  renderGenericSkill,
  renderMcpContract
} from "../src/index.js";

const baseSkill: SkillIr = {
  name: "harness-review",
  kind: "workflow",
  description: "Review changes.",
  triggers: ["review"],
  inputs: ["change_ref"],
  outputs: ["review_report"],
  forbidden_actions: ["claim_unverified_success"],
  required_context: ["AGENTS.md"],
  profiles: {
    java: {
      enabled: true,
      overlay: {
        triggers: ["review java"],
        required_context: [".harness/knowledge/index.json"],
        forbidden_actions: ["skip_tests"]
      }
    }
  },
  adapters: {
    "claude-code": {
      enabled: true,
      overlay: {
        triggers: ["claude review"],
        required_context: [".harness/context-index.json"]
      }
    },
    "codex": { enabled: true },
    "cursor": { enabled: true },
    "generic": { enabled: true },
    "mcp": { enabled: true }
  },
  version: "1.0.0",
  instructions: ["Inspect the diff.", "Report evidence."],
  allowed_capabilities: ["read", "search", "test"]
};

describe("Skill IR compiler", () => {
  it("normalizes unordered collections deterministically", () => {
    const normalized = normalizeSkillIr({
      ...baseSkill,
      triggers: ["review", "alpha", "review"],
      required_context: ["z", "a", "z"]
    });
    expect(normalized.triggers).toEqual(["alpha", "review"]);
    expect(normalized.required_context).toEqual(["a", "z"]);
  });

  it("applies global, profile, project, then adapter overlays safely", () => {
    const merged = mergeSkillIr(baseSkill, {
      profile: "java",
      projectOverride: {
        description: "Project review.",
        forbidden_actions: ["automatic_git_write"],
        allowed_capabilities: ["read", "test", "shell"]
      },
      adapter: "claude-code"
    });

    expect(merged.description).toBe("Project review.");
    expect(merged.triggers).toEqual(expect.arrayContaining([
      "review",
      "review java",
      "claude review"
    ]));
    expect(merged.forbidden_actions).toEqual(expect.arrayContaining([
      "claim_unverified_success",
      "skip_tests",
      "automatic_git_write"
    ]));
    expect(merged.allowed_capabilities).toEqual(["read", "test"]);
  });

  it("compiles deterministic Claude Code SKILL.md output", () => {
    const first = compileSkill(baseSkill, {
      profile: "java",
      adapter: "claude-code",
      compilerVersion: "1.0.0"
    });
    const second = compileSkill(baseSkill, {
      profile: "java",
      adapter: "claude-code",
      compilerVersion: "1.0.0"
    });

    expect(first).toEqual(second);
    expect(first.path).toBe(".claude/skills/harness-review/SKILL.md");
    expect(first.sourceIrHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.content).toContain("name: harness-review");
    expect(first.content).toContain("source_ir_hash:");
    expect(first.content).toContain("## Forbidden actions");
  });

  it("loads a safe, complete bootstrap bundle", async () => {
    const resources = fileURLToPath(
      new URL("../../../resources/bootstrap-ir", import.meta.url)
    );
    const bundle = await loadBootstrapBundle(resources);
    const names = bundle.skills.map((skill) => skill.name);

    expect(names).toEqual(expect.arrayContaining([
      "harness-sync",
      "harness-plan",
      "harness-run",
      "harness-test",
      "harness-review",
      "harness-submit",
      "harness-archive",
      "harness-knowledge-ingest",
      "harness-skill-optimizer",
      "harness-codebase-map",
      "harness-apidoc",
      "harness-package"
    ]));
    expect(bundle.bundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const optimizer = bundle.skills.find(
      (skill) => skill.name === "harness-skill-optimizer"
    );
    expect(Object.keys(optimizer?.profiles ?? {})).toEqual(expect.arrayContaining([
      "general",
      "java",
      "node",
      "python",
      "docs",
      "personal-automation"
    ]));
    expect(Object.values(optimizer?.profiles ?? {}).every((item) => item.enabled))
      .toBe(true);

    for (const skill of bundle.skills) {
      const compiled = compileSkill(skill, {
        profile: skill.profiles.java?.enabled ? "java" : "general",
        adapter: "claude-code",
        compilerVersion: bundle.compilerVersion
      });
      expect(compiled.content).not.toMatch(/\.javadev|\.planning|javadev-env|harness-env/);
      expect(compiled.content).not.toMatch(/git (add|commit|push|pull|merge)/i);
    }
  });
});

describe("adapter registry + real renders (T3-T7)", () => {
  it("ADAPTERS has 5 adapters with correct installable flags", () => {
    expect(ADAPTERS).toBeDefined();
    expect(Object.keys(ADAPTERS).sort()).toEqual(["claude-code", "codex", "cursor", "generic", "mcp"]);
    expect(ADAPTERS.mcp.installable).toBe(false);
    expect(ADAPTERS["claude-code"].installable).toBe(true);
    expect(ADAPTERS.codex.installable).toBe(true);
    expect(ADAPTERS.cursor.installable).toBe(true);
    expect(ADAPTERS.generic.installable).toBe(true);
  });

  it("codex descriptor: managed_block + per-id blockId + AGENTS.md target", () => {
    expect(ADAPTERS).toBeDefined();
    expect(ADAPTERS.codex.installMode).toBe("managed_block");
    expect(ADAPTERS.codex.blockId?.(baseSkill)).toBe("harness-skill-harness-review");
    expect(ADAPTERS.codex.targetPath(baseSkill)).toBe("AGENTS.md");
  });

  it("codex render produces block body with harness header", () => {
    expect(typeof renderCodexSkill).toBe("function");
    const out = renderCodexSkill(baseSkill, "sha256:abc", "1.0.0");
    expect(out).toContain("<!-- harness: adapter=codex source_ir_hash=sha256:abc compiler_version=1.0.0 -->");
    expect(out).toContain("# harness-review");
    expect(out).toContain("## Forbidden actions");
    expect(out).toContain("## Instructions");
  });

  it("cursor render produces MDC frontmatter", () => {
    expect(typeof renderCursorSkill).toBe("function");
    const out = renderCursorSkill(baseSkill, "sha256:abc", "1.0.0");
    expect(out).toContain("description:");
    expect(out).toContain("globs: []");
    expect(out).toContain("alwaysApply: false");
    expect(out).toContain("adapter: cursor");
    expect(out).toContain("source_ir_hash: sha256:abc");
  });

  it("generic render has adapter:generic frontmatter", () => {
    expect(typeof renderGenericSkill).toBe("function");
    const out = renderGenericSkill(baseSkill, "sha256:abc", "1.0.0");
    expect(out).toContain("adapter: generic");
    expect(out).toContain("source_ir_hash: sha256:abc");
  });

  it("compileSkill codex -> AGENTS.md", () => {
    const compiled = compileSkill(baseSkill, { profile: "java", adapter: "codex", compilerVersion: "1.0.0" });
    expect(compiled.path).toBe("AGENTS.md");
    expect(compiled.content).toContain("<!-- harness: adapter=codex");
    expect(compiled.adapter).toBe("codex");
  });

  it("compileSkill cursor -> .cursor/rules/<name>.mdc", () => {
    const compiled = compileSkill(baseSkill, { profile: "java", adapter: "cursor", compilerVersion: "1.0.0" });
    expect(compiled.path).toBe(".cursor/rules/harness-review.mdc");
    expect(compiled.content).toContain("adapter: cursor");
  });

  it("compileSkill generic -> .agent-skills/<name>.md", () => {
    const compiled = compileSkill(baseSkill, { profile: "java", adapter: "generic", compilerVersion: "1.0.0" });
    expect(compiled.path).toBe(".agent-skills/harness-review.md");
    expect(compiled.content).toContain("adapter: generic");
  });

  it("compileSkill mcp -> contract JSON (installable=false) (INT-001)", () => {
    const compiled = compileSkill(baseSkill, { profile: "java", adapter: "mcp", compilerVersion: "1.0.0" });
    expect(compiled.path).toBe(".harness/generated/mcp/harness-review.json");
    expect(compiled.adapter).toBe("mcp");
    const parsed = JSON.parse(compiled.content) as {
      tool_name: string;
      description: string;
      input_schema: { type: string; properties: Record<string, unknown>; required: string[] };
      source_ir_hash: string;
      compiler_version: string;
      adapter: string;
    };
    expect(parsed.tool_name).toBe("harness-review");
    expect(parsed.description).toBe(baseSkill.description);
    expect(parsed.input_schema).toEqual({
      type: "object",
      properties: { change_ref: { type: "string" } },
      required: ["change_ref"]
    });
    expect(parsed.source_ir_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parsed.compiler_version).toBe("1.0.0");
    expect(parsed.adapter).toBe("mcp");
  });

  it("compileSkill is deterministic across all adapters", () => {
    const adapters = ["claude-code", "codex", "cursor", "generic", "mcp"] as const;
    for (const agent of adapters) {
      const a = compileSkill(baseSkill, { profile: "java", adapter: agent, compilerVersion: "1.0.0" });
      const b = compileSkill(baseSkill, { profile: "java", adapter: agent, compilerVersion: "1.0.0" });
      expect(a).toEqual(b);
    }
  });

  it("render tolerates missing instructions (fallback empty array)", () => {
    expect(typeof renderCodexSkill).toBe("function");
    const noInstr: SkillIr = { ...baseSkill, instructions: undefined };
    const out = renderCodexSkill(noInstr, "sha256:abc", "1.0.0");
    expect(out).toContain("## Instructions");
  });
});

describe("mcp render (UT-001~005)", () => {
  it("derives tool_name from skill.name (UT-001)", () => {
    const out = renderMcpContract(baseSkill, "sha256:abc", "1.0.0");
    const parsed = JSON.parse(out) as { tool_name: string };
    expect(parsed.tool_name).toBe(baseSkill.name);
  });

  it("derives description from skill.description (UT-002)", () => {
    const out = renderMcpContract(baseSkill, "sha256:abc", "1.0.0");
    const parsed = JSON.parse(out) as { description: string };
    expect(parsed.description).toBe(baseSkill.description);
  });

  it("derives input_schema from skill.inputs (UT-003)", () => {
    const skill: SkillIr = { ...baseSkill, inputs: ["doc", "path"] };
    const out = renderMcpContract(skill, "sha256:abc", "1.0.0");
    const parsed = JSON.parse(out) as { input_schema: { type: string; properties: Record<string, unknown>; required: string[] } };
    expect(parsed.input_schema).toEqual({
      type: "object",
      properties: { doc: { type: "string" }, path: { type: "string" } },
      required: ["doc", "path"]
    });
  });

  it("includes harness metadata (source_ir_hash/compiler_version/adapter) (UT-004)", () => {
    const out = renderMcpContract(baseSkill, "sha256:abc", "1.0.0");
    const parsed = JSON.parse(out) as { source_ir_hash: string; compiler_version: string; adapter: string };
    expect(parsed.source_ir_hash).toBe("sha256:abc");
    expect(parsed.compiler_version).toBe("1.0.0");
    expect(parsed.adapter).toBe("mcp");
  });

  it("handles empty inputs (UT-005)", () => {
    const skill: SkillIr = { ...baseSkill, inputs: [] };
    const out = renderMcpContract(skill, "sha256:abc", "1.0.0");
    const parsed = JSON.parse(out) as { input_schema: { type: string; properties: Record<string, unknown>; required: string[] } };
    expect(parsed.input_schema).toEqual({ type: "object", properties: {}, required: [] });
  });
});
