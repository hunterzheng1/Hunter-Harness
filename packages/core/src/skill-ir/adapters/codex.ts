import type { SkillIr } from "@hunter-harness/contracts";

import { section } from "./shared.js";

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
