import { parse as parseYaml } from "yaml";

import { skillIrSchema, type SkillIr } from "@hunter-harness/contracts";

export type SkillFileTree = { path: string; content: string }[];

export class SkillIrError extends Error {
  constructor(
    public readonly code: "SKILL_IR_NOT_FOUND" | "SKILL_IR_INVALID",
    message: string
  ) {
    super(message);
    this.name = "SkillIrError";
  }
}

const ENTRY_PRIORITY = ["skill.yaml", "skill.yml", "skill.json", "hunter-skill-ir.json"];
const ENTRY_PATTERN = /(^|\/)(skill\.ya?ml|skill\.json|hunter-skill-ir\.json)$/i;

function basename(path: string): string {
  const parts = path.split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function priority(path: string): number {
  const idx = ENTRY_PRIORITY.indexOf(basename(path));
  return idx === -1 ? 99 : idx;
}

function depth(path: string): number {
  return path.split("/").length;
}

export function findSkillIr(files: SkillFileTree): SkillIr {
  const matches = files.filter((f) => ENTRY_PATTERN.test(f.path));
  if (matches.length === 0) {
    throw new SkillIrError("SKILL_IR_NOT_FOUND", "no canonical Skill IR file found in tree");
  }
  matches.sort((a, b) => {
    const pa = priority(a.path);
    const pb = priority(b.path);
    if (pa !== pb) return pa - pb;
    return depth(a.path) - depth(b.path);
  });
  const entry = matches[0];
  if (entry === undefined) {
    throw new SkillIrError("SKILL_IR_NOT_FOUND", "no canonical Skill IR file found in tree");
  }
  const isJson = /\.json$/i.test(entry.path);
  let parsed: unknown;
  try {
    parsed = isJson ? JSON.parse(entry.content) : parseYaml(entry.content);
  } catch (error) {
    throw new SkillIrError("SKILL_IR_INVALID", "Skill IR parse failed: " + (error as Error).message);
  }
  try {
    return skillIrSchema.parse(parsed);
  } catch (error) {
    throw new SkillIrError("SKILL_IR_INVALID", "Skill IR schema validation failed: " + (error as Error).message);
  }
}
