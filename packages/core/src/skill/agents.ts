import type { RegistryAgent } from "@hunter-harness/contracts";

/**
 * Agent 安装描述符（取代已删除的 skill-ir/adapters ADAPTERS 的元数据面）。
 *
 * 新模型删除 compileSkill/render 编译链，agent 支持由上传存在性 + fallback 决定；
 * 此处仅保留 installable / installTarget / installMode / blockId 元数据，
 * 供 server buildArtifactFor（制品 manifest target_path）与 skill-cli install（解压定位）使用。
 *
 * installMode 语义：
 * - folder：解压全部 sourceFiles 到 installTarget 目录根（claude-code，target_path 为文件夹根）
 * - file：只装 entry 文件到 installTarget 路径（cursor/generic）
 * - managed_block：entry 内容写入 installTarget 文件的 per-id managed block（codex → AGENTS.md）
 */
export interface AgentDescriptor {
  agent: RegistryAgent;
  installable: boolean;
  installTarget: (slug: string) => string;
  installMode: "folder" | "file" | "managed_block";
  blockId?: (slug: string) => string;
}

export const AGENT_DESCRIPTORS: Record<RegistryAgent, AgentDescriptor> = {
  "claude-code": {
    agent: "claude-code",
    installable: true,
    installTarget: (slug) => `.claude/skills/${slug}/`,
    installMode: "folder"
  },
  codex: {
    agent: "codex",
    installable: true,
    installTarget: () => "AGENTS.md",
    installMode: "managed_block",
    blockId: (slug) => `harness-skill-${slug}`
  },
  cursor: {
    agent: "cursor",
    installable: true,
    installTarget: (slug) => `.cursor/rules/${slug}.mdc`,
    installMode: "file"
  },
  generic: {
    agent: "generic",
    installable: true,
    installTarget: (slug) => `.agent-skills/${slug}.md`,
    installMode: "file"
  },
  mcp: {
    agent: "mcp",
    installable: false,
    installTarget: () => "",
    installMode: "file"
  }
};

/** installable agent 集合（mcp 排除）。agentsFor 用此遍历候选 agent。 */
export const INSTALLABLE_AGENTS: readonly RegistryAgent[] = (Object.keys(AGENT_DESCRIPTORS) as RegistryAgent[])
  .filter((agent) => AGENT_DESCRIPTORS[agent]?.installable === true);
