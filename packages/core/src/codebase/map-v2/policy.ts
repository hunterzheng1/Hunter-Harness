import type { MapMode, MappingExecutionPolicy } from "./types.js";

export function selectMappingExecutionPolicy(input: {
  mode: MapMode;
  affected_topic_count: number;
}): MappingExecutionPolicy {
  const affected = Math.max(1, Math.floor(input.affected_topic_count));
  const common = {
    max_model_attempts: 2 as const,
    escalation_conditions: ["VALIDATION_FAILED", "HIGH_RISK_AMBIGUITY"] as const
  };
  if (input.mode === "quick") {
    return {
      mode: "quick",
      model_tier: "light",
      max_parallel_mappers: 1,
      timeout_ms: 120_000,
      token_budget: 8_000,
      ...common
    };
  }
  if (input.mode === "incremental") {
    return {
      mode: "incremental",
      model_tier: "light",
      max_parallel_mappers: Math.min(3, affected),
      timeout_ms: 240_000,
      token_budget: 24_000,
      ...common
    };
  }
  return {
    mode: "full",
    model_tier: "standard",
    max_parallel_mappers: 4,
    timeout_ms: 600_000,
    token_budget: 64_000,
    ...common
  };
}
