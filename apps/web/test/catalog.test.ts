import { describe, expect, it } from "vitest";

import { bootstrapSkills } from "../lib/catalog";

describe("catalog sourceFiles (T17)", () => {
  it("每个 bootstrap skill 含 SKILL.md entry 的 sourceFiles", () => {
    const first = bootstrapSkills[0];
    expect(first).toBeDefined();
    expect(first?.sourceFiles.length).toBeGreaterThan(0);
    const entry = first?.sourceFiles.find((f) => f.path === "SKILL.md");
    expect(entry).toBeDefined();
    expect(entry?.content).toContain("---");
    expect(entry?.content).toContain("name: " + (first?.name ?? ""));
  });

  it("SKILL.md frontmatter 含 kind/triggers/forbidden_actions 等元数据字段", () => {
    const sync = bootstrapSkills.find((s) => s.name === "harness-sync");
    expect(sync).toBeDefined();
    const entry = sync?.sourceFiles.find((f) => f.path === "SKILL.md");
    expect(entry?.content).toContain("kind: workflow");
    expect(entry?.content).toContain("triggers:");
    expect(entry?.content).toContain("forbidden_actions:");
    expect(entry?.content).toContain("required_context:");
  });

  it("BootstrapSkill 不再暴露 profiles/adapters 等 canonical IR 字段", () => {
    const s = bootstrapSkills[0];
    expect(s).toBeDefined();
    expect(s).not.toHaveProperty("profiles");
    expect(s).not.toHaveProperty("adapters");
    expect(s).not.toHaveProperty("triggers");
    expect(s).not.toHaveProperty("instructions");
  });
});
