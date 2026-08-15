import { buildPlanProfile } from "./classification.js";
import { PlanSchemaError } from "./schemas.js";
import {
  deepFreeze,
  derivePlannedPhaseSetOutcome,
  plannedPhaseSetId,
  sortedUnique,
  stableHash
} from "./stable.js";
import {
  PLAN_PHASES,
  type NormalizedLegacyPlanState,
  type PlanMode,
  type OmittedPlanPhase,
  type PlanPhase,
  type PlanPhaseSetReasonCode,
  type PlanRiskSignal,
  type PlannedPhaseSet
} from "./types.js";

const LEGACY_KEYS = new Set([
  "schemaVersion",
  "changeId",
  "tier",
  "source",
  "signals",
  "defaultPhases",
  "plannedPhases",
  "skippedPhases",
  "requiredValidations",
  "classifiedAt"
]);

const LEGACY_SIGNAL_MAP: Readonly<Record<string, PlanRiskSignal>> = {
  "api-change": "api_change",
  "artifact-protocol": "artifact_protocol",
  auth: "auth",
  "breaking-api": "breaking_contract",
  "breaking-contract": "breaking_contract",
  concurrency: "concurrency",
  delete: "delete",
  "docs-only": "docs_only",
  migration: "migration",
  "no-code-diff": "narrow_fix",
  "production-code": "production_code",
  security: "security",
  "shared-state": "shared_state"
};

const LEGACY_MODE_MAP: Readonly<Record<string, PlanMode>> = {
  fast: "quick",
  standard: "standard",
  full: "assurance"
};

const LEGACY_VALIDATIONS = new Set([
  "apiTest", "compile", "unitTest", "unitTestFull"
]);

function legacyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy plan state must be an object");
  }
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !LEGACY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new PlanSchemaError(
      "PLAN_SCHEMA_UNKNOWN_FIELD",
      `legacy.${unknown.sort().join(",")}`
    );
  }
  return result;
}

function legacyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", `legacy.${label}`);
  }
  return value;
}

function legacyPhases(value: unknown, label: string): PlanPhase[] {
  if (!Array.isArray(value)) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", `legacy.${label}`);
  }
  const phases = value.map((item) => {
    const phase = legacyText(item, label);
    if (!(PLAN_PHASES as readonly string[]).includes(phase)) {
      throw new PlanSchemaError("PLAN_SCHEMA_INVALID", `legacy.${label}.${phase}`);
    }
    return phase as PlanPhase;
  });
  if (new Set(phases).size !== phases.length) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", `legacy.${label}.duplicate`);
  }
  return phases;
}

function legacyDate(value: unknown): string {
  const result = legacyText(value, "classifiedAt");
  if (Number.isNaN(Date.parse(result))) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.classifiedAt");
  }
  return result;
}

function skippedPhaseNames(value: unknown): PlanPhase[] {
  if (!Array.isArray(value)) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.skippedPhases");
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new PlanSchemaError(
        "PLAN_SCHEMA_INVALID",
        `legacy.skippedPhases[${index}]`
      );
    }
    const record = item as Record<string, unknown>;
    const allowed = new Set(["phase", "reason", "operator", "decidedAt"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new PlanSchemaError(
        "PLAN_SCHEMA_UNKNOWN_FIELD",
        `legacy.skippedPhases[${index}]`
      );
    }
    return legacyPhases([record.phase], `skippedPhases[${index}].phase`)[0] as PlanPhase;
  });
}

export function normalizeLegacyPlanState(value: unknown): NormalizedLegacyPlanState {
  const legacy = legacyObject(value);
  if (legacy.schemaVersion !== 1) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.schemaVersion");
  }
  const tier = legacyText(legacy.tier, "tier");
  const mode = LEGACY_MODE_MAP[tier];
  if (mode === undefined) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.tier");
  }
  const changeId = legacyText(legacy.changeId, "changeId");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(changeId)) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.changeId");
  }
  if (!Array.isArray(legacy.signals)) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.signals");
  }
  const signals = sortedUnique(legacy.signals.map((value) => {
    const legacySignal = legacyText(value, "signals");
    const mapped = LEGACY_SIGNAL_MAP[legacySignal];
    if (mapped === undefined) {
      throw new PlanSchemaError(
        "PLAN_SCHEMA_INVALID",
        `legacy.signals.${legacySignal}`
      );
    }
    return mapped;
  }));
  const defaultPhases = legacyPhases(legacy.defaultPhases, "defaultPhases");
  const plannedPhases = legacyPhases(legacy.plannedPhases, "plannedPhases");
  if (defaultPhases[0] !== "plan" || defaultPhases.at(-1) !== "archive") {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.defaultPhases.sequence");
  }
  if (plannedPhases[0] !== "plan" || plannedPhases.at(-1) !== "archive") {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.plannedPhases.sequence");
  }
  const skipped = skippedPhaseNames(legacy.skippedPhases);
  if (!Array.isArray(legacy.requiredValidations)
    || legacy.requiredValidations.some(
      (item) => typeof item !== "string" || !LEGACY_VALIDATIONS.has(item)
    )) {
    throw new PlanSchemaError("PLAN_SCHEMA_INVALID", "legacy.requiredValidations");
  }
  const classifiedAt = legacyDate(legacy.classifiedAt);
  const profile = buildPlanProfile({
    classification_input: {
      schema_version: 1,
      change_id: changeId,
      risk_signals: signals,
      created_at: classifiedAt
    },
    profile_version: 1,
    mode_override: mode,
    extra_reason_codes: ["legacy_complexity_mapped"]
  });
  const plannedSet = new Set(plannedPhases);
  const skippedSet = new Set(skipped);
  if (skipped.some((phase) => plannedSet.has(phase))) {
    throw new PlanSchemaError(
      "PLAN_SCHEMA_INVALID",
      "legacy plannedPhases and skippedPhases overlap"
    );
  }
  const omittedPhases: OmittedPlanPhase[] = PLAN_PHASES
    .filter((phase) => !plannedSet.has(phase))
    .map((phase) => {
      if (profile.required_phases.includes(phase)) {
        return {
          phase,
          disposition: "required_but_omitted" as const,
          reason_code: "required_phase_omission_rejected" as const
        };
      }
      if (skippedSet.has(phase)) {
        return {
          phase,
          disposition: "omitted_optional" as const,
          reason_code: "legacy_optional_phase_omitted" as const
        };
      }
      return {
        phase,
        disposition: "optional_not_selected" as const,
        reason_code: "optional_phase_not_selected" as const
      };
    });
  const sourceReasonCodes: PlanPhaseSetReasonCode[] = sortedUnique([
    "legacy_phase_plan_mapped",
    ...omittedPhases.map(({ reason_code }) => reason_code)
  ]);
  const capabilitySnapshotHash = stableHash({
    source_format: "legacy_gate_policy_v0",
    planned_phases: plannedPhases,
    skipped_phases: sortedUnique(skipped)
  });
  const semantics = derivePlannedPhaseSetOutcome(omittedPhases);
  const phaseSetIdentity = {
    schema_version: 1,
    phase_set_version: 1,
    profile_classification_hash: profile.classification_hash,
    planned_phases: plannedPhases,
    omitted_phases: omittedPhases,
    capability_snapshot_hash: capabilitySnapshotHash,
    source_reason_codes: sourceReasonCodes,
    blocking_interactions: semantics.blocking_interactions,
    outcome: semantics.outcome,
    reason_code: semantics.reason_code
  } as const;
  const phaseSet: PlannedPhaseSet = deepFreeze({
    schema_version: 1,
    phase_set_id: plannedPhaseSetId(phaseSetIdentity),
    phase_set_version: 1,
    profile_classification_hash: profile.classification_hash,
    planned_phases: [...plannedPhases],
    omitted_phases: omittedPhases,
    capability_snapshot_hash: capabilitySnapshotHash,
    source_reason_codes: sourceReasonCodes,
    blocking_interactions: semantics.blocking_interactions,
    outcome: semantics.outcome,
    reason_code: semantics.reason_code,
    created_at: classifiedAt
  });

  return deepFreeze({
    source_format: "legacy_gate_policy_v0",
    profile,
    phase_set: phaseSet
  });
}
