import { describe, expect, it } from "vitest";

import { findSkillIr, SkillIrError } from "../src/index.js";

const validIrYaml = `name: harness-x
kind: governance
description: demo skill
triggers: ["run"]
inputs: ["ctx"]
outputs: ["out"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
profiles:
  general:
    enabled: true
adapters:
  claude-code:
    enabled: true
version: "1.0.0"
`;

const jsonIr = (name: string): string => JSON.stringify({
  name,
  kind: "governance",
  description: "d",
  triggers: ["run"],
  inputs: [],
  outputs: ["out"],
  forbidden_actions: ["automatic_git_write"],
  required_context: ["AGENTS.md"],
  profiles: { general: { enabled: true } },
  adapters: { "claude-code": { enabled: true } },
  version: "1.0.0"
});

describe("findSkillIr", () => {
  it("recognizes skill.yaml entry", () => {
    expect(findSkillIr([{ path: "skill.yaml", content: validIrYaml }]).name).toBe("harness-x");
  });

  it("recognizes hunter-skill-ir.json entry", () => {
    expect(findSkillIr([{ path: "hunter-skill-ir.json", content: jsonIr("harness-json") }]).name).toBe("harness-json");
  });

  it("throws SKILL_IR_NOT_FOUND when no IR entry", () => {
    let thrown: unknown = null;
    try { findSkillIr([{ path: "readme.md", content: "x" }]); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SkillIrError);
    expect((thrown as SkillIrError).code).toBe("SKILL_IR_NOT_FOUND");
  });

  it("throws SKILL_IR_INVALID on yaml parse error", () => {
    let thrown: unknown = null;
    try { findSkillIr([{ path: "skill.yaml", content: ":bad" }]); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SkillIrError);
    expect((thrown as SkillIrError).code).toBe("SKILL_IR_INVALID");
  });

  it("picks skill.yaml over hunter-skill-ir.json when both present", () => {
    const ir = findSkillIr([
      { path: "hunter-skill-ir.json", content: jsonIr("harness-json") },
      { path: "skill.yaml", content: validIrYaml }
    ]);
    expect(ir.name).toBe("harness-x");
  });

  it("recognizes entry in subdirectory", () => {
    expect(findSkillIr([{ path: "sub/skill.yaml", content: validIrYaml }]).name).toBe("harness-x");
  });
});
