export const PLAN_MODES = ["quick", "standard", "assurance"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const PLAN_RISK_SIGNALS = [
  "api_change",
  "artifact_protocol",
  "auth",
  "breaking_contract",
  "concurrency",
  "cross_file",
  "delete",
  "docs_only",
  "irreversible_operation",
  "migration",
  "narrow_fix",
  "payment",
  "permission",
  "production_code",
  "security",
  "shared_state",
  "user_visible_behavior"
] as const;
export type PlanRiskSignal = (typeof PLAN_RISK_SIGNALS)[number];

export const PLAN_PHASES = [
  "plan",
  "execute",
  "review",
  "package",
  "apidoc",
  "submit",
  "merge",
  "archive"
] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

export const PLAN_VALIDATIONS = [
  "deterministic_check",
  "semantic_consistency",
  "adversarial_review"
] as const;
export type PlanValidation = (typeof PLAN_VALIDATIONS)[number];

export const PLAN_BLOCKING_INTERACTIONS = [
  "product_or_risk_decision",
  "concise_design_approval"
] as const;
export type PlanBlockingInteraction =
  (typeof PLAN_BLOCKING_INTERACTIONS)[number];

export const PLAN_PROFILE_REASON_CODES = [
  "low_risk_scope",
  "ordinary_change",
  "high_risk_change",
  "legacy_complexity_mapped",
  "risk_signals_changed"
] as const;
export type PlanProfileReasonCode =
  (typeof PLAN_PROFILE_REASON_CODES)[number];

export const PLAN_PHASE_SET_REASON_CODES = [
  "legacy_optional_phase_omitted",
  "legacy_phase_plan_mapped",
  "merge_required_for_worktree",
  "optional_phase_not_selected",
  "optional_phase_omitted",
  "optional_phase_selected",
  "optional_phase_unavailable",
  "profile_required_phases",
  "required_phase_capability_missing",
  "required_phase_omission_rejected",
  "submit_not_applicable_no_git",
  "submit_not_applicable_no_remote"
] as const;
export type PlanPhaseSetReasonCode =
  (typeof PLAN_PHASE_SET_REASON_CODES)[number];

export interface PlanClassificationInput {
  readonly schema_version: 1;
  readonly change_id: string;
  readonly display_title?: string | undefined;
  readonly risk_signals: readonly PlanRiskSignal[];
  readonly created_at: string;
}

export interface PlanReclassificationSignals {
  readonly schema_version: 1;
  readonly added_risk_signals: readonly PlanRiskSignal[];
  readonly removed_risk_signals: readonly PlanRiskSignal[];
  readonly changed_at: string;
}

export interface PlanInteractionBudget {
  readonly max_clarification_rounds: number;
  readonly allowed_blocking_interactions: readonly PlanBlockingInteraction[];
}

export interface PlanProfile {
  readonly schema_version: 1;
  readonly profile_id: string;
  readonly profile_version: number;
  readonly change_id: string;
  readonly mode: PlanMode;
  readonly risk_signals: readonly PlanRiskSignal[];
  readonly required_phases: readonly PlanPhase[];
  readonly optional_phases: readonly PlanPhase[];
  readonly required_validations: readonly PlanValidation[];
  readonly interaction_budget: PlanInteractionBudget;
  readonly classification_hash: string;
  readonly reason_codes: readonly PlanProfileReasonCode[];
  readonly created_at: string;
  readonly supersedes?: string | undefined;
}

export interface PreviousPhaseSetIdentity {
  readonly phase_set_id: string;
  readonly phase_set_version: number;
}

export interface PlanCapabilities {
  readonly schema_version: 1;
  readonly is_git: boolean;
  readonly has_remote: boolean;
  readonly uses_worktree: boolean;
  readonly available_phases: readonly PlanPhase[];
  readonly requested_optional_phases: readonly PlanPhase[];
  readonly requested_omissions: readonly PlanPhase[];
  readonly configured_at: string;
  readonly previous_phase_set?: PreviousPhaseSetIdentity | undefined;
}

export type OmittedPhaseDisposition =
  | "not_applicable"
  | "omitted_optional"
  | "optional_not_selected"
  | "optional_unavailable"
  | "required_but_omitted"
  | "required_but_unavailable";

export interface OmittedPlanPhase {
  readonly phase: PlanPhase;
  readonly disposition: OmittedPhaseDisposition;
  readonly reason_code: PlanPhaseSetReasonCode;
}

export type PlannedPhaseSetOutcome = "configured" | "not_publishable";
export type PlannedPhaseSetOutcomeReason =
  | "phase_set_configured"
  | "required_phase_capability_missing"
  | "required_phase_omission_rejected";

export interface PlannedPhaseSet {
  readonly schema_version: 1;
  readonly phase_set_id: string;
  readonly phase_set_version: number;
  readonly profile_classification_hash: string;
  readonly planned_phases: readonly PlanPhase[];
  readonly omitted_phases: readonly OmittedPlanPhase[];
  readonly capability_snapshot_hash: string;
  readonly source_reason_codes: readonly PlanPhaseSetReasonCode[];
  readonly blocking_interactions: readonly PlanBlockingInteraction[];
  readonly outcome: PlannedPhaseSetOutcome;
  readonly reason_code: PlannedPhaseSetOutcomeReason;
  readonly created_at: string;
  readonly supersedes?: string | undefined;
}

export interface NormalizedLegacyPlanState {
  readonly source_format: "legacy_gate_policy_v0";
  readonly profile: PlanProfile;
  readonly phase_set: PlannedPhaseSet;
}
