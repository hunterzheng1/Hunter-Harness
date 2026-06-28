import {
  canonicalJson,
  registrySlugSchema,
  type FixPlan,
  type FixPlanItem,
  type SkillCheckResult,
  type SkillIr
} from "@hunter-harness/contracts";

import { computeDiff } from "./diff.js";
import { bumpPatch, compareSemver } from "./semver.js";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function countChangedLines(published: string, draft: string): number {
  const a = published.split("\n");
  const b = draft.split("\n");
  const max = Math.max(a.length, b.length);
  let count = 0;
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? "") !== (b[i] ?? "")) count += 1;
  }
  return count;
}

export interface FixPatchOutput extends FixPlan {
  fixedIr: SkillIr;
}

export function buildFixPatch(input: {
  ir: SkillIr;
  checks: SkillCheckResult | null;
  aiChecks: SkillCheckResult | null;
  latestVersion: string | null;
  checkIds: string[] | null;
}): FixPatchOutput {
  const { ir, checks, aiChecks, latestVersion, checkIds } = input;
  const fixedIr: SkillIr = structuredClone(ir);
  const items: FixPlanItem[] = [];

  const programFixable = (checks?.items ?? []).filter((i) => i.fixable);
  const aiFixable = (aiChecks?.items ?? []).filter((i) => i.fixable);
  const targetProgram = checkIds === null
    ? programFixable
    : programFixable.filter((i) => checkIds.includes(i.id));
  const targetAi = checkIds === null
    ? aiFixable
    : aiFixable.filter((i) => checkIds.includes(i.id));

  const versionCheck = targetProgram.find((i) => i.id === "VERSION");
  if (versionCheck !== undefined && versionCheck.status !== "green" && latestVersion !== null) {
    if (compareSemver(ir.version, latestVersion) <= 0) {
      fixedIr.version = bumpPatch(latestVersion);
    }
    items.push({
      checkId: "VERSION",
      action: "auto",
      label: versionCheck.label,
      affectedPaths: ["skill-ir.json"],
      riskDelta: null,
      message: `version ${ir.version} → ${fixedIr.version}`
    });
  }

  const namingCheck = targetProgram.find((i) => i.id === "NAMING");
  if (namingCheck !== undefined && namingCheck.status !== "green") {
    if (!registrySlugSchema.safeParse(ir.name).success) {
      fixedIr.name = slugify(ir.name);
    }
    items.push({
      checkId: "NAMING",
      action: "auto",
      label: namingCheck.label,
      affectedPaths: ["skill-ir.json"],
      riskDelta: "changes ir.name (affects published name)",
      message: `name ${ir.name} → ${fixedIr.name}`
    });
  }

  const permCheck = targetProgram.find((i) => i.id === "PERMISSIONS");
  if (permCheck !== undefined && permCheck.status !== "green") {
    const caps = [...(fixedIr.allowed_capabilities ?? [])];
    const instrText = (fixedIr.instructions ?? []).join("\n");
    const hasNetworkInInstr = /https?:\/\//.test(instrText);
    const hasNetworkCap = caps.some((c) => c.startsWith("network"));
    const networkUndeclared = hasNetworkInInstr && !hasNetworkCap;
    const dangerousCap = caps.some((c) => /^Bash\(/.test(c));
    const dangerousCmd = /rm\s+-rf|drop\s+table|curl\s+|wget\s+|sudo\s+/i.test(instrText + "\n" + caps.join("\n"));
    let riskDelta: string | null = null;
    if (networkUndeclared && !caps.includes("network")) caps.push("network");
    if (networkUndeclared) fixedIr.allowed_capabilities = caps;
    if (dangerousCap || dangerousCmd) riskDelta = "contains dangerous capability/command — manual narrowing required (not auto-fixed)";
    items.push({
      checkId: "PERMISSIONS",
      action: networkUndeclared ? "confirm" : "suggest",
      label: permCheck.label,
      affectedPaths: networkUndeclared ? ["skill-ir.json"] : [],
      riskDelta,
      message: permCheck.message
    });
  }

  for (const ai of targetAi) {
    items.push({
      checkId: ai.id,
      action: "suggest",
      label: ai.label,
      affectedPaths: [],
      riskDelta: null,
      message: ai.message
    });
  }

  const baselineContent = canonicalJson(ir);
  const fixedContent = canonicalJson(fixedIr);
  const mergedFiles = computeDiff(
    [{ path: "skill-ir.json", content: baselineContent }],
    [{ path: "skill-ir.json", content: fixedContent }]
  );
  const changedLines = countChangedLines(baselineContent, fixedContent);

  return {
    items,
    mergedFiles,
    summary: {
      autoCount: items.filter((i) => i.action === "auto").length,
      confirmCount: items.filter((i) => i.action === "confirm").length,
      suggestCount: items.filter((i) => i.action === "suggest").length,
      changedFiles: mergedFiles.length,
      changedLines
    },
    fixedIr
  };
}
