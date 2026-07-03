import { describe, expect, it } from "vitest";

import type { SkillCheckResult, SourceFile } from "@hunter-harness/contracts";

import { buildFixPatch } from "../src/skill/fixer.js";

const fm = (extra: Record<string, unknown> = {}): string => {
  const lines = ["---", "name: harness-x", "description: d"];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "body");
  return lines.join("\n");
};

const checksOf = (items: { id: string; fixable: boolean; status: "green" | "yellow" | "red" }[]): SkillCheckResult => ({
  items: items.map((i) => ({ id: i.id, label: i.id, status: i.status, message: i.id, filePath: null, fixable: i.fixable })),
  summary: { green: 0, yellow: 0, red: 0 },
  checkedAt: "2026-07-03T00:00:00Z"
});

const skillFile = (content: string): SourceFile => ({ path: "SKILL.md", content });

describe("buildFixPatch (source-file driven)", () => {
  it("UT-013 produces mergedFiles editing source, no fixedIr", () => {
    const plan = buildFixPatch({
      sourceFiles: [skillFile(fm({ version: "1.0.0" }))],
      checks: checksOf([{ id: "VERSION", fixable: true, status: "red" }]),
      aiChecks: null,
      latestVersion: "1.0.0",
      checkIds: null
    });
    expect(plan.items.find((i) => i.checkId === "VERSION")?.action).toBe("auto");
    expect(plan.mergedFiles).toHaveLength(1);
    expect(plan.mergedFiles[0]?.path).toBe("SKILL.md");
    expect(plan.mergedFiles[0]?.status).toBe("modified");
    expect(plan.mergedFiles[0]?.draftContent).toMatch(/1\.0\.1/);
    expect((plan as Record<string, unknown>).fixedIr).toBeUndefined();
  });

  it("UT-014 degrades non-VERSION fixable to suggest (degraded marker)", () => {
    const plan = buildFixPatch({
      sourceFiles: [skillFile(fm())],
      checks: checksOf([{ id: "DESCRIPTION", fixable: true, status: "yellow" }]),
      aiChecks: null,
      latestVersion: null,
      checkIds: null
    });
    const item = plan.items.find((i) => i.checkId === "DESCRIPTION");
    expect(item?.action).toBe("suggest");
    expect(item?.riskDelta).toMatch(/degraded/);
  });

  it("UT-015 empty items when checkId not found", () => {
    const plan = buildFixPatch({
      sourceFiles: [skillFile(fm())],
      checks: checksOf([{ id: "VERSION", fixable: true, status: "red" }]),
      aiChecks: null,
      latestVersion: null,
      checkIds: ["NONEXISTENT"]
    });
    expect(plan.items).toEqual([]);
  });

  it("surfaces aiChecks fixable as suggest without source change", () => {
    const aiChecks = checksOf([{ id: "AI_USAGE_EXAMPLES", fixable: true, status: "yellow" }]);
    const plan = buildFixPatch({
      sourceFiles: [skillFile(fm())],
      checks: null,
      aiChecks,
      latestVersion: null,
      checkIds: null
    });
    const ai = plan.items.find((i) => i.checkId === "AI_USAGE_EXAMPLES");
    expect(ai?.action).toBe("suggest");
    expect(ai?.affectedPaths).toEqual([]);
    expect(plan.mergedFiles).toEqual([]);
  });

  it("returns empty plan when no fixable items", () => {
    const plan = buildFixPatch({
      sourceFiles: [skillFile(fm())],
      checks: checksOf([]),
      aiChecks: null,
      latestVersion: null,
      checkIds: null
    });
    expect(plan.items).toEqual([]);
    expect(plan.mergedFiles).toEqual([]);
    expect(plan.summary.autoCount).toBe(0);
  });
});
