import { describe, it, expect } from "vitest";

import { buildFixPatch } from "@hunter-harness/core";
import type { SkillCheckResult, SkillIr } from "@hunter-harness/contracts";

function makeIr(overrides: Partial<SkillIr> = {}): SkillIr {
  return {
    name: "my-skill",
    kind: "tooling",
    description: "a skill",
    triggers: ["run"],
    inputs: [],
    outputs: [],
    forbidden_actions: [],
    required_context: [],
    profiles: { default: { enabled: true } },
    adapters: { "claude-code": { enabled: true } },
    version: "1.0.0",
    allowed_capabilities: [],
    instructions: [],
    ...overrides
  } as unknown as SkillIr;
}

function checksOf(items: { id: string; fixable: boolean; status: "green" | "yellow" | "red" }[]): SkillCheckResult {
  return {
    items: items.map((i) => ({ id: i.id, label: i.id, status: i.status, message: i.id, filePath: null, fixable: i.fixable })),
    summary: { green: 0, yellow: 0, red: 0 },
    checkedAt: "2026-06-28T00:00:00.000Z"
  };
}

describe("buildFixPatch", () => {
  it("bumps VERSION when not forward (auto)", () => {
    const ir = makeIr({ version: "1.0.0" });
    const plan = buildFixPatch({ ir, checks: checksOf([{ id: "VERSION", fixable: true, status: "red" }]), aiChecks: null, latestVersion: "1.0.0", checkIds: null });
    const versionItem = plan.items.find((i) => i.checkId === "VERSION");
    expect(versionItem?.action).toBe("auto");
    expect(plan.fixedIr.version).toBe("1.0.1");
    expect(plan.mergedFiles).toHaveLength(1);
  });

  it("slugifies NAMING when not kebab (auto)", () => {
    const ir = makeIr({ name: "My Skill" });
    const plan = buildFixPatch({ ir, checks: checksOf([{ id: "NAMING", fixable: true, status: "red" }]), aiChecks: null, latestVersion: null, checkIds: null });
    expect(plan.fixedIr.name).toBe("my-skill");
    expect(plan.items.find((i) => i.checkId === "NAMING")?.action).toBe("auto");
  });

  it("adds network capability for PERMISSIONS networkUndeclared (confirm)", () => {
    const ir = makeIr({ instructions: ["see https://example.com"], allowed_capabilities: [] });
    const plan = buildFixPatch({ ir, checks: checksOf([{ id: "PERMISSIONS", fixable: true, status: "yellow" }]), aiChecks: null, latestVersion: null, checkIds: null });
    expect(plan.fixedIr.allowed_capabilities).toContain("network");
    expect(plan.items.find((i) => i.checkId === "PERMISSIONS")?.action).toBe("confirm");
  });

  it("marks dangerous command as suggest (no ir change)", () => {
    const ir = makeIr({ instructions: ["run rm -rf /tmp"], allowed_capabilities: [] });
    const plan = buildFixPatch({ ir, checks: checksOf([{ id: "PERMISSIONS", fixable: true, status: "red" }]), aiChecks: null, latestVersion: null, checkIds: null });
    const perm = plan.items.find((i) => i.checkId === "PERMISSIONS");
    expect(perm?.action).toBe("suggest");
    expect(perm?.riskDelta).not.toBeNull();
    expect(plan.fixedIr.allowed_capabilities).toEqual([]);
  });

  it("surfaces aiChecks.fixable as suggest without ir change", () => {
    const aiChecks = checksOf([{ id: "AI_USAGE_EXAMPLES", fixable: true, status: "yellow" }]);
    const plan = buildFixPatch({ ir: makeIr(), checks: null, aiChecks, latestVersion: null, checkIds: null });
    const ai = plan.items.find((i) => i.checkId === "AI_USAGE_EXAMPLES");
    expect(ai?.action).toBe("suggest");
    expect(ai?.affectedPaths).toEqual([]);
  });

  it("returns empty plan when no fixable items", () => {
    const plan = buildFixPatch({ ir: makeIr(), checks: checksOf([]), aiChecks: null, latestVersion: null, checkIds: null });
    expect(plan.items).toEqual([]);
    expect(plan.mergedFiles).toEqual([]);
    expect(plan.summary.autoCount).toBe(0);
  });

  it("single-item filter via checkIds", () => {
    const ir = makeIr({ version: "1.0.0", name: "My Skill" });
    const checks = checksOf([
      { id: "VERSION", fixable: true, status: "red" },
      { id: "NAMING", fixable: true, status: "red" }
    ]);
    const plan = buildFixPatch({ ir, checks, aiChecks: null, latestVersion: "1.0.0", checkIds: ["NAMING"] });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.checkId).toBe("NAMING");
  });
});
