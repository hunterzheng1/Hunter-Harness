import {
  deepFreeze,
  derivePlanProfilePolicy,
  derivePlannedPhaseSetOutcome,
  planProfileClassificationHash,
  planProfileId,
  plannedPhaseSetId,
  sortedUnique
} from "./stable.js";
import {
  PLAN_BLOCKING_INTERACTIONS,
  PLAN_MODES,
  PLAN_PHASES,
  PLAN_PHASE_SET_REASON_CODES,
  PLAN_PROFILE_REASON_CODES,
  PLAN_RISK_SIGNALS,
  PLAN_VALIDATIONS,
  type PlanCapabilities,
  type PlanClassificationInput,
  type PlanProfile,
  type PlanReclassificationSignals,
  type PlannedPhaseSet
} from "./types.js";

export class PlanSchemaError extends Error {
  readonly code:
    | "PLAN_CAPABILITIES_CONTRADICTION"
    | "PLAN_PHASE_SET_INTEGRITY_INVALID"
    | "PLAN_PHASE_SET_CONTRADICTION"
    | "PLAN_PHASE_SET_LINEAGE_INVALID"
    | "PLAN_PROFILE_INTEGRITY_INVALID"
    | "PLAN_PROFILE_LINEAGE_INVALID"
    | "PLAN_SCHEMA_INVALID"
    | "PLAN_SCHEMA_UNKNOWN_FIELD";

  constructor(
    code: PlanSchemaError["code"],
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "PlanSchemaError";
    this.code = code;
  }
}

export interface RuntimeSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: PlanSchemaError };
}

function schema<T>(parser: (value: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(value) {
      try {
        return { success: true, data: parser(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof PlanSchemaError
            ? error
            : new PlanSchemaError("PLAN_SCHEMA_INVALID", String(error))
        };
      }
    }
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strict(
  value: unknown,
  label: string,
  allowed: readonly string[]
): Record<string, unknown> {
  const result = record(value, label);
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PlanSchemaError(
      "PLAN_SCHEMA_UNKNOWN_FIELD",
      `${label}.${unknown.sort().join(",")}`
    );
  }
  return result;
}

function literalOne(value: unknown, label: string): 1 {
  if (value !== 1) invalid(label);
  return 1;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(label);
  return value as string;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(label);
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label);
  return value as boolean;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(label);
  return value as T[number];
}

function arrayOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number][] {
  if (!Array.isArray(value)) invalid(label);
  const result = value.map((item, index) => oneOf(item, allowed, `${label}[${index}]`));
  if (new Set(result).size !== result.length) invalid(`${label} duplicate`);
  return result;
}

function isoDate(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result)
    || Number.isNaN(Date.parse(result))
  ) invalid(label);
  return result;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) invalid(label);
  return result;
}

function id(value: unknown, prefix: string, label: string): string {
  const result = text(value, label);
  if (!new RegExp(`^${prefix}:[a-f0-9]{64}$`, "u").test(result)) invalid(label);
  return result;
}

function changeId(value: unknown): string {
  const result = text(value, "change_id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)) invalid("change_id");
  return result;
}

function invalid(label: string): never {
  throw new PlanSchemaError("PLAN_SCHEMA_INVALID", label);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export const planClassificationInputSchema = schema<PlanClassificationInput>((value) => {
  const input = strict(value, "PlanClassificationInput", [
    "schema_version", "change_id", "display_title", "risk_signals", "created_at"
  ]);
  const displayTitle = input.display_title === undefined
    ? undefined
    : text(input.display_title, "display_title");
  if (displayTitle !== undefined && displayTitle.length > 80) invalid("display_title");
  if (displayTitle !== undefined && [...displayTitle].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  )) invalid("display_title");
  return deepFreeze({
    schema_version: literalOne(input.schema_version, "schema_version"),
    change_id: changeId(input.change_id),
    ...(displayTitle === undefined ? {} : { display_title: displayTitle }),
    risk_signals: arrayOf(input.risk_signals, PLAN_RISK_SIGNALS, "risk_signals"),
    created_at: isoDate(input.created_at, "created_at")
  });
});

export const planReclassificationSignalsSchema = schema<PlanReclassificationSignals>((value) => {
  const input = strict(value, "PlanReclassificationSignals", [
    "schema_version", "added_risk_signals", "removed_risk_signals", "changed_at"
  ]);
  const added = arrayOf(
    input.added_risk_signals, PLAN_RISK_SIGNALS, "added_risk_signals"
  );
  const removed = arrayOf(
    input.removed_risk_signals, PLAN_RISK_SIGNALS, "removed_risk_signals"
  );
  if (added.some((signal) => removed.includes(signal))) {
    throw new PlanSchemaError(
      "PLAN_SCHEMA_INVALID",
      "PLAN_RECLASSIFICATION_SIGNAL_CONFLICT"
    );
  }
  return deepFreeze({
    schema_version: literalOne(input.schema_version, "schema_version"),
    added_risk_signals: added,
    removed_risk_signals: removed,
    changed_at: isoDate(input.changed_at, "changed_at")
  });
});

export const planCapabilitiesSchema = schema<PlanCapabilities>((value) => {
  const input = strict(value, "PlanCapabilities", [
    "schema_version", "is_git", "has_remote", "uses_worktree",
    "available_phases", "requested_optional_phases", "requested_omissions",
    "configured_at", "previous_phase_set"
  ]);
  let previousPhaseSet: PlanCapabilities["previous_phase_set"];
  if (input.previous_phase_set !== undefined) {
    const previous = strict(input.previous_phase_set, "previous_phase_set", [
      "phase_set_id", "phase_set_version"
    ]);
    previousPhaseSet = {
      phase_set_id: id(previous.phase_set_id, "planned_phase_set", "phase_set_id"),
      phase_set_version: integer(previous.phase_set_version, "phase_set_version", 1)
    };
  }
  const result: PlanCapabilities = {
    schema_version: literalOne(input.schema_version, "schema_version"),
    is_git: booleanValue(input.is_git, "is_git"),
    has_remote: booleanValue(input.has_remote, "has_remote"),
    uses_worktree: booleanValue(input.uses_worktree, "uses_worktree"),
    available_phases: arrayOf(input.available_phases, PLAN_PHASES, "available_phases"),
    requested_optional_phases: arrayOf(
      input.requested_optional_phases, PLAN_PHASES, "requested_optional_phases"
    ),
    requested_omissions: arrayOf(
      input.requested_omissions, PLAN_PHASES, "requested_omissions"
    ),
    configured_at: isoDate(input.configured_at, "configured_at"),
    ...(previousPhaseSet === undefined ? {} : { previous_phase_set: previousPhaseSet })
  };
  if (!result.is_git && (result.has_remote || result.uses_worktree)) {
    throw new PlanSchemaError(
      "PLAN_CAPABILITIES_CONTRADICTION",
      "has_remote and uses_worktree require is_git"
    );
  }
  return deepFreeze(result);
});

export const planProfileSchema = schema<PlanProfile>((value) => {
  const input = strict(value, "PlanProfile", [
    "schema_version", "profile_id", "profile_version", "change_id", "mode",
    "risk_signals", "required_phases", "optional_phases", "required_validations",
    "interaction_budget", "classification_hash", "reason_codes", "created_at",
    "supersedes"
  ]);
  const budget = strict(input.interaction_budget, "interaction_budget", [
    "max_clarification_rounds", "allowed_blocking_interactions"
  ]);
  const requiredPhases = arrayOf(input.required_phases, PLAN_PHASES, "required_phases");
  const optionalPhases = arrayOf(input.optional_phases, PLAN_PHASES, "optional_phases");
  if (requiredPhases.some((phase) => optionalPhases.includes(phase))) {
    invalid("required_phases and optional_phases overlap");
  }
  const supersedes = input.supersedes === undefined
    ? undefined
    : id(input.supersedes, "plan_profile", "supersedes");
  const result: PlanProfile = {
    schema_version: literalOne(input.schema_version, "schema_version"),
    profile_id: id(input.profile_id, "plan_profile", "profile_id"),
    profile_version: integer(input.profile_version, "profile_version", 1),
    change_id: changeId(input.change_id),
    mode: oneOf(input.mode, PLAN_MODES, "mode"),
    risk_signals: arrayOf(input.risk_signals, PLAN_RISK_SIGNALS, "risk_signals"),
    required_phases: requiredPhases,
    optional_phases: optionalPhases,
    required_validations: arrayOf(
      input.required_validations, PLAN_VALIDATIONS, "required_validations"
    ),
    interaction_budget: {
      max_clarification_rounds: integer(
        budget.max_clarification_rounds, "max_clarification_rounds"
      ),
      allowed_blocking_interactions: arrayOf(
        budget.allowed_blocking_interactions,
        PLAN_BLOCKING_INTERACTIONS,
        "allowed_blocking_interactions"
      )
    },
    classification_hash: hash(input.classification_hash, "classification_hash"),
    reason_codes: arrayOf(input.reason_codes, PLAN_PROFILE_REASON_CODES, "reason_codes"),
    created_at: isoDate(input.created_at, "created_at"),
    ...(supersedes === undefined ? {} : { supersedes })
  };
  if (
    (result.profile_version === 1 && result.supersedes !== undefined)
    || (result.profile_version > 1 && result.supersedes === undefined)
    || result.supersedes === result.profile_id
  ) {
    throw new PlanSchemaError(
      "PLAN_PROFILE_LINEAGE_INVALID",
      "profile version and supersedes are inconsistent"
    );
  }
  const policy = derivePlanProfilePolicy(result.risk_signals);
  const baseReasonCodes = new Set([
    "low_risk_scope", "ordinary_change", "high_risk_change"
  ]);
  const supplementalReasonCodes = result.reason_codes.filter(
    (reason) => !baseReasonCodes.has(reason)
  );
  const expectedReasonCodes = sortedUnique([
    policy.reason_code,
    ...supplementalReasonCodes
  ]);
  if (
    !sameStrings(result.risk_signals, sortedUnique(result.risk_signals))
    || result.mode !== policy.mode
    || !sameStrings(result.required_phases, policy.required_phases)
    || !sameStrings(result.optional_phases, policy.optional_phases)
    || !sameStrings(result.required_validations, policy.required_validations)
    || result.interaction_budget.max_clarification_rounds
      !== policy.max_clarification_rounds
    || !sameStrings(
      result.interaction_budget.allowed_blocking_interactions,
      PLAN_BLOCKING_INTERACTIONS
    )
    || !sameStrings(result.reason_codes, expectedReasonCodes)
  ) {
    throw new PlanSchemaError(
      "PLAN_PROFILE_INTEGRITY_INVALID",
      "profile policy does not match risk signals"
    );
  }
  const expectedClassificationHash = planProfileClassificationHash(result);
  const expectedProfileId = planProfileId({
    change_id: result.change_id,
    classification_hash: expectedClassificationHash,
    profile_version: result.profile_version,
    supersedes: result.supersedes
  });
  if (
    result.classification_hash !== expectedClassificationHash
    || result.profile_id !== expectedProfileId
  ) {
    throw new PlanSchemaError(
      "PLAN_PROFILE_INTEGRITY_INVALID",
      "profile identity does not match content"
    );
  }
  return deepFreeze(result);
});

export const plannedPhaseSetSchema = schema<PlannedPhaseSet>((value) => {
  const input = strict(value, "PlannedPhaseSet", [
    "schema_version", "phase_set_id", "phase_set_version",
    "profile_classification_hash", "planned_phases", "omitted_phases",
    "capability_snapshot_hash", "source_reason_codes", "blocking_interactions",
    "outcome", "reason_code", "created_at", "supersedes"
  ]);
  if (!Array.isArray(input.omitted_phases)) invalid("omitted_phases");
  const omittedPhases = input.omitted_phases.map((value, index) => {
    const item = strict(value, `omitted_phases[${index}]`, [
      "phase", "disposition", "reason_code"
    ]);
    return {
      phase: oneOf(item.phase, PLAN_PHASES, `omitted_phases[${index}].phase`),
      disposition: oneOf(item.disposition, [
        "not_applicable", "omitted_optional", "optional_not_selected",
        "optional_unavailable", "required_but_omitted", "required_but_unavailable"
      ] as const, `omitted_phases[${index}].disposition`),
      reason_code: oneOf(
        item.reason_code, PLAN_PHASE_SET_REASON_CODES,
        `omitted_phases[${index}].reason_code`
      )
    };
  });
  const supersedes = input.supersedes === undefined
    ? undefined
    : id(input.supersedes, "planned_phase_set", "supersedes");
  const result: PlannedPhaseSet = {
    schema_version: literalOne(input.schema_version, "schema_version"),
    phase_set_id: id(input.phase_set_id, "planned_phase_set", "phase_set_id"),
    phase_set_version: integer(input.phase_set_version, "phase_set_version", 1),
    profile_classification_hash: hash(
      input.profile_classification_hash, "profile_classification_hash"
    ),
    planned_phases: arrayOf(input.planned_phases, PLAN_PHASES, "planned_phases"),
    omitted_phases: omittedPhases,
    capability_snapshot_hash: hash(
      input.capability_snapshot_hash, "capability_snapshot_hash"
    ),
    source_reason_codes: arrayOf(
      input.source_reason_codes, PLAN_PHASE_SET_REASON_CODES, "source_reason_codes"
    ),
    blocking_interactions: arrayOf(
      input.blocking_interactions, PLAN_BLOCKING_INTERACTIONS, "blocking_interactions"
    ),
    outcome: oneOf(input.outcome, ["configured", "not_publishable"] as const, "outcome"),
    reason_code: oneOf(input.reason_code, [
      "phase_set_configured", "required_phase_capability_missing",
      "required_phase_omission_rejected"
    ] as const, "reason_code"),
    created_at: isoDate(input.created_at, "created_at"),
    ...(supersedes === undefined ? {} : { supersedes })
  };
  if (
    (result.phase_set_version === 1 && result.supersedes !== undefined)
    || (result.phase_set_version > 1 && result.supersedes === undefined)
    || result.supersedes === result.phase_set_id
  ) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_LINEAGE_INVALID",
      "phase-set version and supersedes are inconsistent"
    );
  }
  const omittedNames = result.omitted_phases.map(({ phase }) => phase);
  const partition = new Set([...result.planned_phases, ...omittedNames]);
  if (
    new Set(omittedNames).size !== omittedNames.length
    || result.planned_phases.some((phase) => omittedNames.includes(phase))
    || partition.size !== PLAN_PHASES.length
    || PLAN_PHASES.some((phase) => !partition.has(phase))
  ) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_CONTRADICTION",
      "planned and omitted phases must be disjoint and unique"
    );
  }
  const dispositionReasons = {
    not_applicable: new Set([
      "submit_not_applicable_no_git", "submit_not_applicable_no_remote"
    ]),
    omitted_optional: new Set([
      "legacy_optional_phase_omitted", "optional_phase_omitted"
    ]),
    optional_not_selected: new Set(["optional_phase_not_selected"]),
    optional_unavailable: new Set(["optional_phase_unavailable"]),
    required_but_omitted: new Set(["required_phase_omission_rejected"]),
    required_but_unavailable: new Set(["required_phase_capability_missing"])
  } as const;
  if (result.omitted_phases.some(({ phase, disposition, reason_code }) =>
    !dispositionReasons[disposition].has(reason_code)
    || (disposition === "not_applicable" && phase !== "submit")
  )) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_CONTRADICTION",
      "omitted phase disposition and reason are inconsistent"
    );
  }
  const omissionReasonCodes = new Set([
    "legacy_optional_phase_omitted",
    "optional_phase_not_selected",
    "optional_phase_omitted",
    "optional_phase_unavailable",
    "required_phase_capability_missing",
    "required_phase_omission_rejected",
    "submit_not_applicable_no_git",
    "submit_not_applicable_no_remote"
  ]);
  const expectedOmissionReasons = sortedUnique(
    result.omitted_phases.map(({ reason_code }) => reason_code)
  );
  const actualOmissionReasons = result.source_reason_codes.filter(
    (reason) => omissionReasonCodes.has(reason)
  );
  const provenanceReasons = result.source_reason_codes.filter(
    (reason) => !omissionReasonCodes.has(reason)
  );
  const legacySource = provenanceReasons.includes("legacy_phase_plan_mapped");
  const allowedProvenance = legacySource
    ? ["legacy_phase_plan_mapped"]
    : [
        "merge_required_for_worktree",
        "profile_required_phases"
      ];
  if (
    !sameStrings(actualOmissionReasons, expectedOmissionReasons)
    || provenanceReasons.some((reason) => !allowedProvenance.includes(reason))
    || (legacySource && provenanceReasons.length !== 1)
    || (!legacySource && !provenanceReasons.includes("profile_required_phases"))
    || (provenanceReasons.includes("merge_required_for_worktree")
      && !result.planned_phases.includes("merge"))
  ) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_CONTRADICTION",
      "source reasons do not match phase dispositions"
    );
  }
  const semantics = derivePlannedPhaseSetOutcome(result.omitted_phases);
  if (
    result.outcome !== semantics.outcome
    || result.reason_code !== semantics.reason_code
  ) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_CONTRADICTION",
      "outcome and reason do not match required phase dispositions"
    );
  }
  const expectedPhaseSetId = plannedPhaseSetId(result);
  if (result.phase_set_id !== expectedPhaseSetId) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_INTEGRITY_INVALID",
      "phase-set identity does not match content"
    );
  }
  if (
    !sameStrings(
      result.blocking_interactions,
      semantics.blocking_interactions
    )
  ) {
    throw new PlanSchemaError(
      "PLAN_PHASE_SET_CONTRADICTION",
      "blocking interactions do not match phase-set outcome"
    );
  }
  return deepFreeze(result);
});
