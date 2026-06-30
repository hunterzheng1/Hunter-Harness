import type { SkillIr } from "@hunter-harness/contracts";

import { section } from "./shared.js";

/**
 * 渲染 codex adapter 产出：AGENTS.md managed block 体（Codex-flavored markdown + harness 头注释）。
 * 安装时由 upsertManagedBlockById 按 blockId=`harness-skill-<name>` 插入 AGENTS.md，block 外内容不动。
 */
export function renderCodexSkill(
  skill: SkillIr,
  sourceIrHash: string,
  compilerVersion: string
): string {
  const header = `<!-- harness: adapter=codex source_ir_hash=${sourceIrHash} compiler_version=${compilerVersion} -->`;
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
  return [header, ...body].join("\n\n") + "\n";
}
