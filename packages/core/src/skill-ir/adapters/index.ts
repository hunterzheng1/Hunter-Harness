import type { RegistryAgent, SkillIr } from "@hunter-harness/contracts";

import { renderClaudeCodeSkill } from "./claude-code.js";
import { renderCodexSkill } from "./codex.js";
import { renderCursorSkill } from "./cursor.js";
import { renderGenericSkill } from "./generic.js";
import { renderMcpContract } from "./mcp.js";

export interface AdapterDescriptor {
  id: RegistryAgent;
  render(skill: SkillIr, sourceIrHash: string, compilerVersion: string): string;
  targetPath(skill: SkillIr): string;
  installMode: "file" | "managed_block";
  blockId?(skill: SkillIr): string;
  installable: boolean;
}

/**
 * Adapter 注册表——compileSkill/buildArtifacts/checker 的单一真相源。
 * 每项声明 {id, render, targetPath, installMode, blockId?, installable}；
 * installable=false（mcp）= contract-only（产出 MCP tool 契约 JSON），server adapterPreview 抛 422 ADAPTER_NOT_IMPLEMENTED。
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
    render: renderMcpContract,
    targetPath: (skill) => `.harness/generated/mcp/${skill.name}.json`,
    installMode: "file",
    installable: false
  }
};
