import { HARNESS_AGENT_ORDER, type HarnessAgent } from "@hunter-harness/contracts";

export const AGENT_LABELS: Record<HarnessAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  codebuddy: "CodeBuddy"
};

/** User-facing profile name — always Chinese in interactive UI. */
export function profileLabel(profile: string | null | undefined): string {
  if (profile === "java") return "Java";
  if (profile === "general") return "通用";
  return profile === null || profile === undefined || profile === ""
    ? "未设置"
    : profile;
}

export function agentLabel(agent: HarnessAgent): string {
  return AGENT_LABELS[agent];
}

export function formatAgentLine(
  agent: HarnessAgent,
  profile: string | null | undefined
): string {
  return `${agentLabel(agent)}（${profileLabel(profile)}）`;
}

export function agentMenuLines(
  installedProfiles?: Partial<Record<HarnessAgent, string>>
): string {
  const lines = HARNESS_AGENT_ORDER.map((agent, index) => {
    const profile = installedProfiles?.[agent];
    const suffix = profile === undefined ? "" : `（已安装：${profileLabel(profile)}）`;
    return `  ${index + 1}. ${agentLabel(agent)}${suffix}`;
  }).join("\n");
  return lines + "\n  5. 全部";
}
