import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SkillIr } from "@hunter-harness/contracts";
import {
  compileSkill,
  loadBootstrapBundle,
  mergeSkillIr,
  normalizeSkillIr
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
    }
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
