// v1.0: single instruction file. `AGENTS.md` is the only managed instruction
// surface (CLAUDE.md / CODEBUDDY.md projections retired; CodeBuddy loads
// AGENTS.md natively when CODEBUDDY.md is absent). Static rules file
// projections are gone — learned rules live in a dedicated AGENTS.md managed
// block, refreshed automatically by archive finalize.
export const AGENTS_CORE_BLOCK_ID = "hunter-harness-core";
export const AGENTS_LEARNED_RULES_BLOCK_ID = "hunter-harness-learned-rules";

export const AGENTS_MANAGED_BLOCK_CONTENT = [
  "## Harness Core Instructions",
  "",
  "- 本项目由 hunter-harness 管理。日常开发遵循下方工作流技能与项目约束。",
  "- 使用 `.harness/context-index.json` 查找 Agent 入口、技能、远端知识和 codebase map。",
  "- 使用 `.harness/codebase/map/` 下的代码库地图了解仓库结构与验证证据（缺失时由 /harness-codebase-map 生成）。"
].join("\n");

/** Empty-state body for the learned-rules block; archive finalize rewrites it. */
export const AGENTS_LEARNED_RULES_EMPTY_CONTENT = [
  "## Harness Learned Rules",
  "",
  "经验规则由归档流程自动沉淀与刷新，当前暂无。"
].join("\n");

/** Render the learned-rules block body from rule lines (idempotent refresh). */
export function renderLearnedRulesBlock(rules: readonly string[]): string {
  if (rules.length === 0) return AGENTS_LEARNED_RULES_EMPTY_CONTENT;
  return [
    "## Harness Learned Rules",
    "",
    "经验规则由归档流程自动沉淀与刷新。",
    "",
    ...rules.map((rule) => `- ${rule}`)
  ].join("\n");
}
