import { createHash } from "node:crypto";

import type {
  OmittedPlanPhase,
  PlanMode,
  PlanPhase,
  PlanProfile,
  PlanProfileReasonCode,
  PlanRiskSignal,
  PlanValidation,
  PlannedPhaseSet
} from "./types.js";

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodepoint(left, right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function stableHash(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

const ASSURANCE_SIGNALS = new Set<PlanRiskSignal>([
  "artifact_protocol", "auth", "breaking_contract", "concurrency", "delete",
  "irreversible_operation", "migration", "payment", "permission", "security",
  "shared_state"
]);

const STANDARD_SIGNALS = new Set<PlanRiskSignal>([
  "api_change", "cross_file", "production_code", "user_visible_behavior"
]);

export interface PlanModePolicy {
  readonly mode: PlanMode;
  readonly required_phases: readonly PlanPhase[];
  readonly optional_phases: readonly PlanPhase[];
  readonly required_validations: readonly PlanValidation[];
  readonly max_clarification_rounds: number;
  readonly reason_code: PlanProfileReasonCode;
}

const MODE_POLICY: Readonly<Record<PlanMode, PlanModePolicy>> = {
  quick: {
    mode: "quick",
    required_phases: ["plan", "run", "archive"],
    optional_phases: ["test", "review", "package", "apidoc", "submit", "merge"],
    required_validations: ["deterministic_check"],
    max_clarification_rounds: 1,
    reason_code: "low_risk_scope"
  },
  standard: {
    mode: "standard",
    required_phases: ["plan", "run", "test", "archive"],
    optional_phases: ["review", "package", "apidoc", "submit", "merge"],
    required_validations: ["deterministic_check", "semantic_consistency"],
    max_clarification_rounds: 3,
    reason_code: "ordinary_change"
  },
  assurance: {
    mode: "assurance",
    required_phases: ["plan", "run", "test", "review", "archive"],
    optional_phases: ["package", "apidoc", "submit", "merge"],
    required_validations: [
      "deterministic_check", "semantic_consistency", "adversarial_review"
    ],
    max_clarification_rounds: 7,
    reason_code: "high_risk_change"
  }
};

export function planPolicyForMode(mode: PlanMode): PlanModePolicy {
  return MODE_POLICY[mode];
}

export function derivePlanProfilePolicy(
  signals: readonly PlanRiskSignal[]
): PlanModePolicy {
  if (signals.some((signal) => ASSURANCE_SIGNALS.has(signal))) {
    return planPolicyForMode("assurance");
  }
  if (signals.some((signal) => STANDARD_SIGNALS.has(signal))) {
    return planPolicyForMode("standard");
  }
  return planPolicyForMode("quick");
}

export function derivePlannedPhaseSetOutcome(
  omittedPhases: readonly OmittedPlanPhase[]
): Pick<PlannedPhaseSet, "outcome" | "reason_code" | "blocking_interactions"> {
  const hasRequiredOmission = omittedPhases.some(
    ({ disposition }) => disposition === "required_but_omitted"
  );
  const hasRequiredUnavailable = omittedPhases.some(
    ({ disposition }) => disposition === "required_but_unavailable"
  );
  if (hasRequiredOmission) {
    return {
      outcome: "not_publishable",
      reason_code: "required_phase_omission_rejected",
      blocking_interactions: ["product_or_risk_decision"]
    };
  }
  if (hasRequiredUnavailable) {
    return {
      outcome: "not_publishable",
      reason_code: "required_phase_capability_missing",
      blocking_interactions: ["product_or_risk_decision"]
    };
  }
  return {
    outcome: "configured",
    reason_code: "phase_set_configured",
    blocking_interactions: []
  };
}

type PlanProfileClassificationFields = Pick<PlanProfile,
  | "schema_version"
  | "change_id"
  | "mode"
  | "risk_signals"
  | "required_phases"
  | "optional_phases"
  | "required_validations"
  | "interaction_budget"
  | "reason_codes"
>;

export function planProfileClassificationIdentityPayload(
  profile: PlanProfileClassificationFields
): PlanProfileClassificationFields {
  return {
    schema_version: profile.schema_version,
    change_id: profile.change_id,
    mode: profile.mode,
    risk_signals: profile.risk_signals,
    required_phases: profile.required_phases,
    optional_phases: profile.optional_phases,
    required_validations: profile.required_validations,
    interaction_budget: profile.interaction_budget,
    reason_codes: profile.reason_codes
  };
}

export function planProfileClassificationHash(
  profile: PlanProfileClassificationFields
): `sha256:${string}` {
  return stableHash(planProfileClassificationIdentityPayload(profile));
}

type PlanProfileVersionIdentityFields = Pick<PlanProfile,
  "change_id" | "classification_hash" | "profile_version" | "supersedes"
>;

export function planProfileVersionIdentityPayload(
  profile: PlanProfileVersionIdentityFields
): PlanProfileVersionIdentityFields {
  return {
    change_id: profile.change_id,
    classification_hash: profile.classification_hash,
    profile_version: profile.profile_version,
    supersedes: profile.supersedes
  };
}

export function planProfileId(
  profile: PlanProfileVersionIdentityFields
): `plan_profile:${string}` {
  return `plan_profile:${stableHash(
    planProfileVersionIdentityPayload(profile)
  ).slice("sha256:".length)}`;
}

type PlannedPhaseSetIdentityFields = Pick<PlannedPhaseSet,
  | "schema_version"
  | "phase_set_version"
  | "profile_classification_hash"
  | "planned_phases"
  | "omitted_phases"
  | "capability_snapshot_hash"
  | "source_reason_codes"
  | "blocking_interactions"
  | "outcome"
  | "reason_code"
  | "supersedes"
>;

export function plannedPhaseSetIdentityPayload(
  phaseSet: PlannedPhaseSetIdentityFields
): PlannedPhaseSetIdentityFields {
  return {
    schema_version: phaseSet.schema_version,
    phase_set_version: phaseSet.phase_set_version,
    profile_classification_hash: phaseSet.profile_classification_hash,
    planned_phases: phaseSet.planned_phases,
    omitted_phases: phaseSet.omitted_phases,
    capability_snapshot_hash: phaseSet.capability_snapshot_hash,
    source_reason_codes: phaseSet.source_reason_codes,
    blocking_interactions: phaseSet.blocking_interactions,
    outcome: phaseSet.outcome,
    reason_code: phaseSet.reason_code,
    supersedes: phaseSet.supersedes
  };
}

export function plannedPhaseSetId(
  phaseSet: PlannedPhaseSetIdentityFields
): `planned_phase_set:${string}` {
  return `planned_phase_set:${stableHash(
    plannedPhaseSetIdentityPayload(phaseSet)
  ).slice("sha256:".length)}`;
}

export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodepoint);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
