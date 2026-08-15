import {
  deepFreeze,
  derivePlannedPhaseSetOutcome,
  plannedPhaseSetId,
  sortedUnique,
  stableHash
} from "./stable.js";
import { validatePlanProfileIntegrity } from "./classification.js";
import {
  PLAN_PHASES,
  type OmittedPlanPhase,
  type PlanCapabilities,
  type PlanMode,
  type PlanPhase,
  type PlanPhaseSetReasonCode,
  type PlanProfile,
  type PlannedPhaseSet
} from "./types.js";
import { planCapabilitiesSchema, planProfileSchema } from "./schemas.js";

export class PlanConfigurationError extends Error {
  readonly code: "PLAN_OPTIONAL_PHASE_INVALID";

  constructor() {
    super("PLAN_OPTIONAL_PHASE_INVALID");
    this.name = "PlanConfigurationError";
    this.code = "PLAN_OPTIONAL_PHASE_INVALID";
  }
}

const PHASE_ORDER = new Map(PLAN_PHASES.map((phase, index) => [phase, index]));

function orderPhases(phases: Iterable<PlanPhase>): PlanPhase[] {
  return [...new Set(phases)].sort(
    (left, right) => (PHASE_ORDER.get(left) ?? 0) - (PHASE_ORDER.get(right) ?? 0)
  );
}

function defaultOptionalPhases(mode: PlanMode): readonly PlanPhase[] {
  return mode === "quick" ? [] : ["submit"];
}

function omissionForOptional(
  phase: PlanPhase,
  capabilities: PlanCapabilities,
  selected: ReadonlySet<PlanPhase>,
  requestedOmissions: ReadonlySet<PlanPhase>,
  available: ReadonlySet<PlanPhase>
): OmittedPlanPhase {
  if (phase === "submit" && !capabilities.is_git) {
    return {
      phase,
      disposition: "not_applicable",
      reason_code: "submit_not_applicable_no_git"
    };
  }
  if (phase === "submit" && !capabilities.has_remote) {
    return {
      phase,
      disposition: "not_applicable",
      reason_code: "submit_not_applicable_no_remote"
    };
  }
  if (requestedOmissions.has(phase)) {
    return {
      phase,
      disposition: "omitted_optional",
      reason_code: "optional_phase_omitted"
    };
  }
  if (selected.has(phase) && !available.has(phase)) {
    return {
      phase,
      disposition: "optional_unavailable",
      reason_code: "optional_phase_unavailable"
    };
  }
  return {
    phase,
    disposition: "optional_not_selected",
    reason_code: "optional_phase_not_selected"
  };
}

export function configurePlannedPhases(
  profileInput: PlanProfile,
  capabilitiesInput: PlanCapabilities
): PlannedPhaseSet {
  const profile = validatePlanProfileIntegrity(planProfileSchema.parse(profileInput));
  const capabilities = planCapabilitiesSchema.parse(capabilitiesInput);
  if (capabilities.requested_optional_phases.some(
    (phase) => !profile.optional_phases.includes(phase)
  )) {
    throw new PlanConfigurationError();
  }
  const available = new Set(capabilities.available_phases);
  const requestedOmissions = new Set(capabilities.requested_omissions);
  const required = new Set(profile.required_phases);
  if (capabilities.uses_worktree) required.add("merge");
  const selectedOptional = new Set<PlanPhase>([
    ...defaultOptionalPhases(profile.mode),
    ...capabilities.requested_optional_phases
  ]);
  const planned = new Set<PlanPhase>();
  const omitted: OmittedPlanPhase[] = [];

  for (const phase of orderPhases(required)) {
    if (requestedOmissions.has(phase)) {
      omitted.push({
        phase,
        disposition: "required_but_omitted",
        reason_code: "required_phase_omission_rejected"
      });
    } else if (!available.has(phase)) {
      omitted.push({
        phase,
        disposition: "required_but_unavailable",
        reason_code: "required_phase_capability_missing"
      });
    } else {
      planned.add(phase);
    }
  }

  for (const phase of orderPhases(profile.optional_phases)) {
    if (required.has(phase)) continue;
    const submitApplicable = phase !== "submit"
      || (capabilities.is_git && capabilities.has_remote);
    if (
      selectedOptional.has(phase)
      && !requestedOmissions.has(phase)
      && available.has(phase)
      && submitApplicable
    ) {
      planned.add(phase);
      continue;
    }
    omitted.push(omissionForOptional(
      phase,
      capabilities,
      selectedOptional,
      requestedOmissions,
      available
    ));
  }

  const orderedPlanned = orderPhases(planned);
  const orderedOmitted = omitted.sort(
    (left, right) =>
      (PHASE_ORDER.get(left.phase) ?? 0) - (PHASE_ORDER.get(right.phase) ?? 0)
  );
  const semantics = derivePlannedPhaseSetOutcome(orderedOmitted);
  const sourceReasons: PlanPhaseSetReasonCode[] = [
    "profile_required_phases",
    ...orderedOmitted.map(({ reason_code }) => reason_code)
  ];
  if (capabilities.uses_worktree) sourceReasons.push("merge_required_for_worktree");
  const capabilitySnapshotHash = stableHash({
    schema_version: 1,
    is_git: capabilities.is_git,
    has_remote: capabilities.has_remote,
    uses_worktree: capabilities.uses_worktree,
    available_phases: orderPhases(capabilities.available_phases),
    requested_optional_phases: orderPhases(capabilities.requested_optional_phases),
    requested_omissions: orderPhases(capabilities.requested_omissions)
  });
  const phaseSetVersion = (capabilities.previous_phase_set?.phase_set_version ?? 0) + 1;
  const identityFields = {
    schema_version: 1,
    phase_set_version: phaseSetVersion,
    profile_classification_hash: profile.classification_hash,
    planned_phases: orderedPlanned,
    omitted_phases: orderedOmitted,
    capability_snapshot_hash: capabilitySnapshotHash,
    source_reason_codes: sortedUnique(sourceReasons),
    blocking_interactions: semantics.blocking_interactions,
    outcome: semantics.outcome,
    reason_code: semantics.reason_code,
    supersedes: capabilities.previous_phase_set?.phase_set_id
  } as const;

  return deepFreeze({
    schema_version: 1,
    phase_set_id: plannedPhaseSetId(identityFields),
    phase_set_version: phaseSetVersion,
    profile_classification_hash: profile.classification_hash,
    planned_phases: orderedPlanned,
    omitted_phases: orderedOmitted,
    capability_snapshot_hash: capabilitySnapshotHash,
    source_reason_codes: sortedUnique(sourceReasons),
    blocking_interactions: semantics.blocking_interactions,
    outcome: semantics.outcome,
    reason_code: semantics.reason_code,
    created_at: capabilities.configured_at,
    ...(capabilities.previous_phase_set === undefined
      ? {}
      : { supersedes: capabilities.previous_phase_set.phase_set_id })
  });
}
