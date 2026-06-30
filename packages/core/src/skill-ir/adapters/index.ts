import type { RegistryAgent, SkillIr } from "@hunter-harness/contracts";

import { renderClaudeCodeSkill } from "./claude-code.js";
import { renderCodexSkill } from "./codex.js";
import { renderCursorSkill } from "./cursor.js";
import { renderGenericSkill } from "./generic.js";

export interface AdapterDescriptor {
  id: RegistryAgent;
  render(skill: SkillIr, sourceIrHash: string, compilerVersion: string): string;
  targetPath(skill: SkillIr): string;
  installMode: "file" | "managed_block";
  blockId?(skill: SkillIr): string;
  installable: boolean;
}

function mcpPlaceholder(skill: SkillIr, sourceIrHash: string): string {
  return [
    "# Adapter contract placeholder",
    "",
    "Skill: " + skill.name,
    "Adapter: mcp",
    "Source IR: " + sourceIrHash,
    "",
    "This output reserves the validated adapter contract. It is not an executable skill."
  ].join("\n") + "\n";
}

/**
 * Adapter 注册表——compileSkill/buildArtifacts/checker 的单一真相源。
 * 每项声明 {id, render, targetPath, installMode, blockId?, installable}；
 * installable=false（mcp）= placeholder，server adapterPreview 抛 422 ADAPTER_NOT_IMPLEMENTED。
 */
export const ADAPTERS: Record<RegistryAgent, AdapterDescriptor> = {
  "claude-code": {
    id: "claude-code",
    render: renderClaudeCodeSkill,
    targetPath: (skill) => `.claude/skills/${skill.name}/SKILL.md`,
    installMode: "file",
    installable: true
  },
  "codex": {
    id: "codex",
    render: renderCodexSkill,
    targetPath: () => "AGENTS.md",
    installMode: "managed_block",
    blockId: (skill) => `harness-skill-${skill.name}`,
    installable: true
  },
  "cursor": {
    id: "cursor",
    render: renderCursorSkill,
    targetPath: (skill) => `.cursor/rules/${skill.name}.mdc`,
    installMode: "file",
    installable: true
  },
  "generic": {
    id: "generic",
    render: renderGenericSkill,
    targetPath: (skill) => `.agent-skills/${skill.name}.md`,
    installMode: "file",
    installable: true
  },
  "mcp": {
    id: "mcp",
    render: (skill, sourceIrHash) => mcpPlaceholder(skill, sourceIrHash),
    targetPath: (skill) => `.harness/generated/mcp/${skill.name}.md`,
    installMode: "file",
    installable: false
  }
};
