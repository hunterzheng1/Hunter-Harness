import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  type FixPlan,
  type FixPlanItem,
  type RegistryAgent,
  type SkillCheckResult,
  type SourceFile
} from "@hunter-harness/contracts";

import { computeDiff } from "../skill-ir/diff.js";
import { bumpPatch, compareSemver } from "../skill-ir/semver.js";

import { SkillEntryError } from "./errors.js";
import { findEntryFile, parseFrontmatter } from "./frontmatter.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * YAML round-trip 重写 frontmatter：parse → mutate → stringify → 重新拼接 body。
 * 用于 VERSION bump 等可精确定位字段的 auto-fix。
 */
function rewriteFrontmatter(content: string, mutate: (fm: Record<string, unknown>) => void): string {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return content;
  const raw = match[1] ?? "";
  const body = match[2] ?? "";
  const fm = parseYaml(raw) as Record<string, unknown>;
  mutate(fm);
  return `---\n${stringifyYaml(fm)}---\n${body}`;
}

function countChangedLines(a: string, b: string): number {
  const la = a.split("\n");
  const lb = b.split("\n");
  const max = Math.max(la.length, lb.length);
  let count = 0;
  for (let i = 0; i < max; i += 1) {
    if ((la[i] ?? "") !== (lb[i] ?? "")) count += 1;
  }
  return count;
}

/**
 * 源文件驱动 fix patch（取代旧 buildFixPatch 的 ir 入参 + fixedIr 输出）。
 * - VERSION：frontmatter version bump（YAML round-trip），action=auto
 * - 其他 program fixable：源文件区域难自动定位 → action=suggest + riskDelta 标 degraded（UT-014）
 * - ai fixable：action=suggest
 * - mergedFiles：SKILL.md → SKILL.md diff（不再是 skill-ir.json）
 * 输出无 fixedIr 字段（UT-013）。
 */
export function buildFixPatch(input: {
  sourceFiles: SourceFile[];
  agent?: RegistryAgent;
  checks: SkillCheckResult | null;
  aiChecks: SkillCheckResult | null;
  latestVersion: string | null;
  checkIds: string[] | null;
}): FixPlan {
  const { sourceFiles, agent = "claude-code", checks, aiChecks, latestVersion, checkIds } = input;
  const items: FixPlanItem[] = [];
  const rewritten: SourceFile[] = sourceFiles.map((f) => ({ ...f }));

  const programFixable = (checks?.items ?? []).filter((i) => i.fixable);
  const aiFixable = (aiChecks?.items ?? []).filter((i) => i.fixable);
  const targetProgram = checkIds === null ? programFixable : programFixable.filter((i) => checkIds.includes(i.id));
  const targetAi = checkIds === null ? aiFixable : aiFixable.filter((i) => checkIds.includes(i.id));

  let entryPath: string | null = null;
  let currentVersion: string | null = null;
  try {
    const entry = findEntryFile(sourceFiles, agent);
    entryPath = entry.path;
    const meta = parseFrontmatter(entry.content);
    currentVersion = meta.version ?? null;
  } catch (error) {
    if (!(error instanceof SkillEntryError)) throw error;
  }

  const versionCheck = targetProgram.find((i) => i.id === "VERSION");
  if (versionCheck !== undefined && versionCheck.status !== "green" && latestVersion !== null && entryPath !== null) {
    const oldVersion = currentVersion ?? "0.0.0";
    let newVersion = oldVersion;
    if (currentVersion === null || compareSemver(currentVersion, latestVersion) <= 0) {
      newVersion = bumpPatch(latestVersion);
    }
    if (newVersion !== oldVersion) {
      const idx = rewritten.findIndex((f) => f.path === entryPath);
      const target = idx >= 0 ? rewritten[idx] : undefined;
      if (target !== undefined) {
        const after = rewriteFrontmatter(target.content, (fm) => {
          fm["version"] = newVersion;
        });
        rewritten[idx] = { path: entryPath, content: after };
      }
    }
    items.push({
      checkId: "VERSION",
      action: "auto",
      label: versionCheck.label,
      affectedPaths: [entryPath],
      riskDelta: null,
      message: `version ${oldVersion} → ${newVersion}`
    });
  }

  for (const check of targetProgram) {
    if (check.id === "VERSION") continue;
    items.push({
      checkId: check.id,
      action: "suggest",
      label: check.label,
      affectedPaths: [],
      riskDelta: "degraded: source-file region not auto-fixable (manual edit required)",
      message: check.message
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

  const mergedFiles = computeDiff(sourceFiles, rewritten);
  const firstChanged = mergedFiles[0];
  const changedLines = firstChanged !== undefined
    ? countChangedLines(firstChanged.publishedContent ?? "", firstChanged.draftContent ?? "")
    : 0;

  return {
    items,
    mergedFiles,
    summary: {
      autoCount: items.filter((i) => i.action === "auto").length,
      confirmCount: items.filter((i) => i.action === "confirm").length,
      suggestCount: items.filter((i) => i.action === "suggest").length,
      changedFiles: mergedFiles.length,
      changedLines
    }
  };
}
