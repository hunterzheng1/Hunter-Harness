import { describe, expect, it } from "vitest";

import type { SkillCheckItem, SkillDiffFile, SkillIr } from "@hunter-harness/contracts";

import { buildFixSuggestionPrompt, buildReleaseNotePrompt } from "../src/ai/prompt-builder.js";
import { parseFixSuggestionResult, parseReleaseNote } from "../src/ai/output-parser.js";

const ir = { name: "demo", version: "1.0.0", description: "d" } as unknown as SkillIr;
const checkItem: SkillCheckItem = {
  id: "AI_USAGE_EXAMPLES",
  label: "使用示例",
  status: "yellow",
  message: "缺少示例",
  filePath: null,
  fixable: true
};

describe("buildReleaseNotePrompt (UT-001~003)", () => {
  it("UT-001 serializes diff with status header + ir meta", () => {
    const diff: SkillDiffFile[] = [
      { path: "SKILL.md", status: "modified", publishedContent: "old", draftContent: "new" }
    ];
    const p = buildReleaseNotePrompt({ ir, diff });
    expect(p.system).toMatch(/release note/i);
    expect(p.user).toContain("--- SKILL.md [modified] ---");
    expect(p.user).toContain("demo");
  });

  it("UT-002 truncates large file diff", () => {
    const big = "x\n".repeat(5000);
    const p = buildReleaseNotePrompt({
      ir,
      diff: [{ path: "big.txt", status: "added", publishedContent: null, draftContent: big }]
    });
    expect(p.user.length).toBeLessThan(big.length + 2000);
    expect(p.user.toLowerCase()).toContain("truncated");
  });

  it("UT-003 first-publish empty diff", () => {
    const p = buildReleaseNotePrompt({ ir, diff: [] });
    expect(p.user).toMatch(/首次|first/i);
  });
});

describe("parseReleaseNote (UT-004~006)", () => {
  it("UT-004 trims plain text", () => {
    expect(parseReleaseNote("  本次新增 X 功能\n")).toBe("本次新增 X 功能");
  });

  it("UT-005 strips markdown fence", () => {
    expect(parseReleaseNote("```text\n新增 Y\n```")).toBe("新增 Y");
  });

  it("UT-006 empty returns null", () => {
    expect(parseReleaseNote("   ")).toBeNull();
    expect(parseReleaseNote("```text\n\n```")).toBeNull();
  });
});

describe("buildFixSuggestionPrompt (UT-007)", () => {
  it("UT-007 includes checkItem + appliesTo whitelist", () => {
    const p = buildFixSuggestionPrompt({ checkItem, ir, sourceFiles: [] });
    expect(p.system).toContain("JSON");
    expect(p.system).toContain("examples");
    expect(p.system).toContain("allowed_capabilities");
    expect(p.user).toContain("AI_USAGE_EXAMPLES");
    expect(p.user).toContain("缺少示例");
  });
});

describe("parseFixSuggestionResult (UT-008~010)", () => {
  it("UT-008 parses JSON with whitelist appliesTo", () => {
    const r = parseFixSuggestionResult(
      '```json\n{"suggestedContent":"[...]","explanation":"why","appliesTo":"examples"}\n```'
    );
    expect(r?.suggestedContent).toBe("[...]");
    expect(r?.explanation).toBe("why");
    expect(r?.appliesTo).toBe("examples");
  });

  it("UT-009 non-whitelist appliesTo → null (suggestedContent 保留)", () => {
    const r = parseFixSuggestionResult(
      '{"suggestedContent":"x","explanation":"y","appliesTo":"ir.secret"}'
    );
    expect(r?.appliesTo).toBeNull();
    expect(r?.suggestedContent).toBe("x");
  });

  it("UT-010 bad json → null", () => {
    expect(parseFixSuggestionResult("not json")).toBeNull();
    expect(parseFixSuggestionResult("")).toBeNull();
  });

  it("UT-010b missing/non-string fields → null", () => {
    expect(parseFixSuggestionResult('{"suggestedContent":123,"explanation":"y"}')).toBeNull();
    expect(parseFixSuggestionResult('{"suggestedContent":"x"}')).toBeNull();
  });
});
