import {
  canonicalJson,
  type SkillIr
} from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { renderClaudeCodeSkill } from "./adapters/claude-code.js";
import {
  mergeSkillIr,
  type SkillOverlay
} from "./overlay.js";

export interface CompileSkillOptions {
  profile: string;
  projectOverride?: SkillOverlay;
  adapter: "claude-code" | "codex" | "generic" | "mcp";
  compilerVersion: string;
}

export interface CompiledSkill {
  path: string;
  content: string;
  sourceIrHash: string;
  compilerVersion: string;
  adapter: string;
}

function placeholder(skill: SkillIr, adapter: string, hash: string): string {
  return [
    "# Adapter contract placeholder",
    "",
    "Skill: " + skill.name,
    "Adapter: " + adapter,
    "Source IR: " + hash,
    "",
    "This output reserves the validated adapter contract. It is not an executable skill."
  ].join("\n") + "\n";
}

export function compileSkill(
  source: SkillIr,
  options: CompileSkillOptions
): CompiledSkill {
  const merged = mergeSkillIr(source, options);
  const sourceIrHash = sha256Bytes(canonicalJson(merged));
  if (options.adapter === "claude-code") {
    return {
      path: ".claude/skills/" + merged.name + "/SKILL.md",
      content: renderClaudeCodeSkill(merged, sourceIrHash, options.compilerVersion),
      sourceIrHash,
      compilerVersion: options.compilerVersion,
      adapter: options.adapter
    };
  }
  const directory = options.adapter === "codex"
    ? ".harness/generated/codex/"
    : ".harness/generated/" + options.adapter + "/";
  return {
    path: directory + merged.name + ".md",
    content: placeholder(merged, options.adapter, sourceIrHash),
    sourceIrHash,
    compilerVersion: options.compilerVersion,
    adapter: options.adapter
  };
}
