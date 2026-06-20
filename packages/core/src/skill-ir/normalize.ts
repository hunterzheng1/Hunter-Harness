import {
  skillIrSchema,
  type SkillIr
} from "@hunter-harness/contracts";

function sortedUnique(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function normalizeSkillIr(input: SkillIr): SkillIr {
  const parsed = skillIrSchema.parse(input);
  const normalized: SkillIr = {
    ...parsed,
    triggers: sortedUnique(parsed.triggers) ?? [],
    inputs: sortedUnique(parsed.inputs) ?? [],
    outputs: sortedUnique(parsed.outputs) ?? [],
    forbidden_actions: sortedUnique(parsed.forbidden_actions) ?? [],
    required_context: sortedUnique(parsed.required_context) ?? [],
    profiles: Object.fromEntries(
      Object.entries(parsed.profiles).sort(([left], [right]) => left.localeCompare(right))
    ),
    adapters: Object.fromEntries(
      Object.entries(parsed.adapters).sort(([left], [right]) => left.localeCompare(right))
    )
  };
  if (parsed.instructions !== undefined) {
    normalized.instructions = sortedUnique(parsed.instructions);
  }
  if (parsed.allowed_capabilities !== undefined) {
    normalized.allowed_capabilities = sortedUnique(parsed.allowed_capabilities);
  }
  return normalized;
}
