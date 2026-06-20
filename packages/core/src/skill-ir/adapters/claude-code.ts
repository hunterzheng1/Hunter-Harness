import type { SkillIr } from "@hunter-harness/contracts";

function section(title: string, items: readonly string[]): string {
  return "## " + title + "\n\n" + items.map((item) => "- " + item).join("\n");
}

export function renderClaudeCodeSkill(
  skill: SkillIr,
  sourceIrHash: string,
  compilerVersion: string
): string {
  const frontmatter = [
    "---",
    "name: " + skill.name,
    "description: " + JSON.stringify(skill.description),
    "version: " + skill.version,
    "adapter: claude-code",
    "source_ir_hash: " + sourceIrHash,
    "compiler_version: " + compilerVersion,
    "---"
  ].join("\n");
  const parts = [
    frontmatter,
    "# " + skill.name,
    skill.description,
    section("Triggers", skill.triggers),
    section("Required context", skill.required_context),
    section("Instructions", skill.instructions ?? []),
    section("Outputs", skill.outputs),
    section("Forbidden actions", skill.forbidden_actions)
  ];
  if (skill.allowed_capabilities !== undefined) {
    parts.push(section("Allowed capabilities", skill.allowed_capabilities));
  }
  return parts.join("\n\n") + "\n";
}
