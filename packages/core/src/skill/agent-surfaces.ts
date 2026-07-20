import { isAbsolute, join, relative, resolve } from "node:path";

import type { SkillTargetAgent } from "@hunter-harness/contracts";

export type SkillInstallScope = "project" | "user";
export type SubagentFormat = "markdown" | "toml";

export interface AgentSurface {
  readonly agent: SkillTargetAgent;
  readonly skillRoots: Readonly<Record<SkillInstallScope, string>>;
  readonly subagentRoots: Readonly<Record<SkillInstallScope, string>>;
  readonly subagentFormat: SubagentFormat;
  readonly subagentExtension: ".md" | ".toml";
  readonly nativeSkillAliases: readonly string[];
}

const SURFACES: Readonly<Record<SkillTargetAgent, AgentSurface>> = Object.freeze({
  "claude-code": Object.freeze({
    agent: "claude-code",
    skillRoots: Object.freeze({ project: ".claude/skills", user: ".claude/skills" }),
    subagentRoots: Object.freeze({ project: ".claude/agents", user: ".claude/agents" }),
    subagentFormat: "markdown",
    subagentExtension: ".md",
    nativeSkillAliases: Object.freeze([])
  }),
  codex: Object.freeze({
    agent: "codex",
    skillRoots: Object.freeze({ project: ".agents/skills", user: ".agents/skills" }),
    subagentRoots: Object.freeze({ project: ".codex/agents", user: ".codex/agents" }),
    subagentFormat: "toml",
    subagentExtension: ".toml",
    nativeSkillAliases: Object.freeze([])
  }),
  cursor: Object.freeze({
    agent: "cursor",
    skillRoots: Object.freeze({ project: ".cursor/skills", user: ".cursor/skills" }),
    subagentRoots: Object.freeze({ project: ".cursor/agents", user: ".cursor/agents" }),
    subagentFormat: "markdown",
    subagentExtension: ".md",
    nativeSkillAliases: Object.freeze([".agents/skills"])
  }),
  codebuddy: Object.freeze({
    agent: "codebuddy",
    skillRoots: Object.freeze({ project: ".codebuddy/skills", user: ".codebuddy/skills" }),
    subagentRoots: Object.freeze({ project: ".codebuddy/agents", user: ".codebuddy/agents" }),
    subagentFormat: "markdown",
    subagentExtension: ".md",
    nativeSkillAliases: Object.freeze([])
  })
});

function assertSafeName(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

export function getAgentSurface(agent: SkillTargetAgent): AgentSurface {
  return SURFACES[agent];
}

export function resolveSkillDestination(
  surface: AgentSurface,
  scope: SkillInstallScope,
  root: string,
  slug: string
): string {
  assertSafeName(slug, "skill slug");
  return assertDestinationWithinSurface(root, surface.skillRoots[scope], join(
    root,
    surface.skillRoots[scope],
    slug
  ));
}

export function resolveSubagentDestination(
  surface: AgentSurface,
  scope: SkillInstallScope,
  root: string,
  componentName: string
): string {
  assertSafeName(componentName, "subagent name");
  return assertDestinationWithinSurface(root, surface.subagentRoots[scope], join(
    root,
    surface.subagentRoots[scope],
    componentName + surface.subagentExtension
  ));
}

export function assertDestinationWithinSurface(
  root: string,
  surfaceRoot: string,
  destination: string
): string {
  if (isAbsolute(surfaceRoot)) throw new Error("agent surface root must be relative");
  const allowed = resolve(root, surfaceRoot);
  const target = resolve(destination);
  const remainder = relative(allowed, target);
  if (remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))) {
    return target;
  }
  throw new Error(`destination escapes agent surface: ${destination}`);
}

export const SKILL_TARGET_AGENTS = Object.freeze([
  "claude-code",
  "codex",
  "cursor",
  "codebuddy"
] as const satisfies readonly SkillTargetAgent[]);
