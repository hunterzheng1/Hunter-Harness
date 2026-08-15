import {
  deepFreeze,
  derivePlanProfilePolicy,
  planProfileClassificationHash,
  planProfileId,
  planPolicyForMode,
  sortedUnique
} from "./stable.js";
import {
  PLAN_BLOCKING_INTERACTIONS,
  type PlanClassificationInput,
  type PlanMode,
  type PlanProfile,
  type PlanProfileReasonCode
} from "./types.js";
import { planClassificationInputSchema } from "./schemas.js";

interface ProfileIdentityInput {
  readonly classification_input: PlanClassificationInput;
  readonly profile_version: number;
  readonly supersedes?: string | undefined;
  readonly mode_override?: PlanMode | undefined;
  readonly extra_reason_codes?: readonly PlanProfileReasonCode[] | undefined;
}

export function buildPlanProfile(input: ProfileIdentityInput): PlanProfile {
  const signals = sortedUnique(input.classification_input.risk_signals);
  const policy = input.mode_override === undefined
    ? derivePlanProfilePolicy(signals)
    : planPolicyForMode(input.mode_override);
  const mode = policy.mode;
  const reasonCodes = sortedUnique([
    policy.reason_code,
    ...(input.extra_reason_codes ?? [])
  ]);
  const classificationFields = {
    schema_version: 1,
    change_id: input.classification_input.change_id,
    mode,
    risk_signals: signals,
    required_phases: policy.required_phases,
    optional_phases: policy.optional_phases,
    required_validations: policy.required_validations,
    interaction_budget: {
      max_clarification_rounds: policy.max_clarification_rounds,
      allowed_blocking_interactions: PLAN_BLOCKING_INTERACTIONS
    },
    reason_codes: reasonCodes
  } as const;
  const classificationHash = planProfileClassificationHash(classificationFields);
  const profileId = planProfileId({
    change_id: input.classification_input.change_id,
    classification_hash: classificationHash,
    profile_version: input.profile_version,
    supersedes: input.supersedes
  });

  return deepFreeze({
    schema_version: 1,
    profile_id: profileId,
    profile_version: input.profile_version,
    change_id: input.classification_input.change_id,
    mode,
    risk_signals: signals,
    required_phases: [...policy.required_phases],
    optional_phases: [...policy.optional_phases],
    required_validations: [...policy.required_validations],
    interaction_budget: {
      max_clarification_rounds: policy.max_clarification_rounds,
      allowed_blocking_interactions: [...PLAN_BLOCKING_INTERACTIONS]
    },
    classification_hash: classificationHash,
    reason_codes: reasonCodes,
    created_at: input.classification_input.created_at,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes })
  });
}

export function classifyPlan(input: PlanClassificationInput): PlanProfile {
  return buildPlanProfile({
    classification_input: planClassificationInputSchema.parse(input),
    profile_version: 1
  });
}

export class PlanProfileIntegrityError extends Error {
  readonly code: "PLAN_PROFILE_INTEGRITY_INVALID";

  constructor() {
    super("PLAN_PROFILE_INTEGRITY_INVALID");
    this.name = "PlanProfileIntegrityError";
    this.code = "PLAN_PROFILE_INTEGRITY_INVALID";
  }
}

export function validatePlanProfileIntegrity(profile: PlanProfile): PlanProfile {
  const rebuilt = buildPlanProfile({
    classification_input: {
      schema_version: 1,
      change_id: profile.change_id,
      risk_signals: profile.risk_signals,
      created_at: profile.created_at
    },
    profile_version: profile.profile_version,
    supersedes: profile.supersedes,
    extra_reason_codes: profile.reason_codes
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(profile)) {
    throw new PlanProfileIntegrityError();
  }
  return profile;
}
