import type { SkillIr } from "@hunter-harness/contracts";

import { section } from "./shared.js";

/**
 * 渲染 cursor adapter 产出：.cursor/rules/<name>.mdc（MDC YAML frontmatter + 章节 body）。
 */
export function renderCursorSkill(
  skill: SkillIr,
  sourceIrHash: string,
  compilerVersion: string
): string {
  const frontmatter = [
    "---",
    "description: " + JSON.stringify(skill.description),
    "globs: []",
    "alwaysApply: false",
    "adapter: cursor",
    "source_ir_hash: " + sourceIrHash,
    "compiler_version: " + compilerVersion,
    "---"
  ].join("\n");
  const body = [
    "# " + skill.name,
    skill.description,
    section("Triggers", skill.triggers),
    section("Required context", skill.required_context),
    section("Instructions", skill.instructions ?? []),
    section("Outputs", skill.outputs),
    section("Forbidden actions", skill.forbidden_actions)
  ];
  if (skill.allowed_capabilities !== undefined) {
    body.push(section("Allowed capabilities", skill.allowed_capabilities));
  }
  return [frontmatter, ...body].join("\n\n") + "\n";
}
