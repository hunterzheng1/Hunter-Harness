import type { SkillIr } from "@hunter-harness/contracts";

import { normalizeSkillIr } from "./normalize.js";

export interface SkillOverlay {
  description?: string;
  triggers?: string[];
  inputs?: string[];
  outputs?: string[];
  forbidden_actions?: string[];
  required_context?: string[];
  instructions?: string[];
  allowed_capabilities?: string[];
}

export interface MergeSkillOptions {
  profile: string;
  projectOverride?: SkillOverlay;
  adapter: string;
}

function asOverlay(value: Record<string, unknown> | undefined): SkillOverlay {
  if (value === undefined) {
    return {};
  }
  const overlay: SkillOverlay = {};
  for (const key of [
    "description",
    "triggers",
    "inputs",
    "outputs",
    "forbidden_actions",
    "required_context",
    "instructions",
    "allowed_capabilities"
  ] as const) {
    if (value[key] !== undefined) {
      Object.assign(overlay, { [key]: value[key] });
    }
  }
  return overlay;
}

function union(left: readonly string[] | undefined, right: readonly string[] | undefined): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])]
    .sort((a, b) => a.localeCompare(b));
}

function applyOverlay(skill: SkillIr, overlay: SkillOverlay): SkillIr {
  const result: SkillIr = {
    ...skill,
    description: overlay.description ?? skill.description,
    triggers: union(skill.triggers, overlay.triggers),
    inputs: union(skill.inputs, overlay.inputs),
    outputs: union(skill.outputs, overlay.outputs),
    forbidden_actions: union(skill.forbidden_actions, overlay.forbidden_actions),
    required_context: union(skill.required_context, overlay.required_context)
  };
  if (overlay.instructions !== undefined) {
    result.instructions = [...overlay.instructions];
  }
  if (overlay.allowed_capabilities !== undefined) {
    const allowed = new Set(overlay.allowed_capabilities);
    result.allowed_capabilities = (skill.allowed_capabilities ?? [])
      .filter((capability) => allowed.has(capability))
      .sort((a, b) => a.localeCompare(b));
  }
  return result;
}

export function mergeSkillIr(
  source: SkillIr,
  options: MergeSkillOptions
): SkillIr {
  let merged = normalizeSkillIr(source);
  const profile = merged.profiles[options.profile];
  if (profile?.enabled !== true) {
    throw new Error("skill is not enabled for profile " + options.profile);
  }
  merged = applyOverlay(merged, asOverlay(profile.overlay));
  merged = applyOverlay(merged, options.projectOverride ?? {});
  const adapter = merged.adapters[options.adapter];
  if (adapter?.enabled !== true) {
    throw new Error("skill is not enabled for adapter " + options.adapter);
  }
  merged = applyOverlay(merged, asOverlay(adapter.overlay));
  return normalizeSkillIr(merged);
}
