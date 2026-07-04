import { describe, expect, it } from "vitest";

import type { SourceFile } from "@hunter-harness/contracts";

import { SkillEntryError } from "../src/skill/errors.js";
import { findEntryFile, parseFrontmatter } from "../src/skill/frontmatter.js";

describe("parseFrontmatter", () => {
  it("UT-001 parses valid frontmatter with name+description", () => {
    const meta = parseFrontmatter("---\nname: harness-x\ndescription: d\n---\nbody");
    expect(meta.name).toBe("harness-x");
    expect(meta.description).toBe("d");
  });

  it("UT-002 throws FRONTMATTER_INVALID when no frontmatter", () => {
    expect(() => parseFrontmatter("# no frontmatter body")).toThrow(SkillEntryError);
    try {
      parseFrontmatter("# no frontmatter body");
    } catch (error) {
      expect((error as SkillEntryError).code).toBe("FRONTMATTER_INVALID");
    }
  });

  it("UT-002b preserves extra undeclared fields via passthrough (RED#1)", () => {
    const meta = parseFrontmatter("---\nname: harness-x\ndescription: d\nauthor: someone\ntags: [a]\n---\n");
    expect(meta.name).toBe("harness-x");
    expect((meta as Record<string, unknown>).author).toBe("someone");
    expect((meta as Record<string, unknown>).tags).toEqual(["a"]);
  });

  it("UT-002c throws FRONTMATTER_INVALID when unclosed", () => {
    expect(() => parseFrontmatter("---\nname: harness-x\nbody 无闭合")).toThrow(SkillEntryError);
  });

  it("UT-003 rejects name not matching slug regex", () => {
    expect(() => parseFrontmatter("---\nname: Foo Bar\ndescription: d\n---\n")).toThrow(SkillEntryError);
  });

  it("UT-004 accepts missing optional fields", () => {
    const meta = parseFrontmatter("---\nname: harness-x\ndescription: d\n---\n");
    expect(meta.triggers).toBeUndefined();
    expect(meta.kind).toBeUndefined();
    expect(meta.forbidden_actions).toBeUndefined();
  });

  it("U-09 frontmatter 缺 name → 友好 message 含 '缺少必填字段 name'", () => {
    try {
      parseFrontmatter("---\ndescription: d\n---\n");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillEntryError);
      expect((error as SkillEntryError).code).toBe("FRONTMATTER_INVALID");
      expect((error as SkillEntryError).message).toContain("缺少必填字段 name");
    }
  });

  it("U-10 frontmatter name 格式错 → 友好 message 含 'name:' 且非 Zod 原始 JSON", () => {
    try {
      parseFrontmatter("---\nname: Foo Bar\ndescription: d\n---\n");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillEntryError);
      expect((error as SkillEntryError).code).toBe("FRONTMATTER_INVALID");
      const msg = (error as SkillEntryError).message;
      expect(msg).toContain("name");
      // 不应是 Zod 原始 JSON
      expect(msg).not.toContain("[{");
      expect(msg).not.toContain('"expected"');
    }
  });

  it("U-02 frontmatter name: my-skill 通过（无 harness- 前缀）", () => {
    const meta = parseFrontmatter("---\nname: my-skill\ndescription: d\n---\n");
    expect(meta.name).toBe("my-skill");
  });
});

describe("findEntryFile", () => {
  const f = (path: string, content = ""): SourceFile => ({ path, content });

  it("UT-005 claude-code finds SKILL.md", () => {
    const files = [f("ref.md"), f("SKILL.md")];
    expect(findEntryFile(files, "claude-code").path).toBe("SKILL.md");
  });

  it("UT-006 SKILL.md in subdirectory", () => {
    const files = [f("pkg/SKILL.md")];
    expect(findEntryFile(files, "claude-code").path).toBe("pkg/SKILL.md");
  });

  it("UT-007 throws SKILL_ENTRY_NOT_FOUND when no entry", () => {
    expect(() => findEntryFile([f("ref.md")], "claude-code")).toThrow(SkillEntryError);
    try {
      findEntryFile([f("ref.md")], "claude-code");
    } catch (error) {
      expect((error as SkillEntryError).code).toBe("SKILL_ENTRY_NOT_FOUND");
    }
  });

  it("UT-008 cursor finds .mdc", () => {
    const files = [f("x.mdc")];
    expect(findEntryFile(files, "cursor").path).toBe("x.mdc");
  });
});
