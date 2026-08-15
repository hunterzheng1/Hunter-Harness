import type { ProjectContentCandidate } from "@hunter-harness/contracts";
import type { PlanProfile, PlannedPhaseSet } from "../plan-classification/index.js";
import type { EvidenceMap, IntentContract, PlanningContext } from "../planning-context/index.js";

export type DecisionNodeType = "fact" | "engineering_default" | "product_decision" | "risk_decision";
export type DecisionNodeStatus = "pending" | "resolved" | "blocked" | "superseded";

export interface DecisionNodeInput {
  readonly schema_version: 1;
  readonly decision_id: string;
  readonly decision_version: number;
  readonly type: DecisionNodeType;
  readonly depends_on: readonly string[];
  readonly status: DecisionNodeStatus;
  readonly question?: string | undefined;
  readonly recommendation?: string | undefined;
  readonly recommendation_reason?: string | undefined;
  readonly tradeoffs: readonly string[];
  readonly affected_behaviors: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly resolution?: string | undefined;
  readonly resolved_by?: "evidence" | "engineering_default" | "user" | undefined;
  readonly resolved_at?: string | undefined;
}

export type DecisionNode = DecisionNodeInput;

export interface DecisionQuestion {
  readonly decision_id: string;
  readonly decision_version: number;
  readonly question: string;
  readonly recommendation: string;
  readonly recommendation_reason: string;
  readonly tradeoffs: readonly string[];
  readonly affected_behaviors: readonly string[];
}

export interface DecisionGraph {
  readonly schema_version: 1;
  readonly graph_id: string;
  readonly input_hash: string;
  readonly planning_context_ref: string;
  readonly plan_profile_ref: string;
  readonly planned_phase_set_ref: string;
  readonly nodes: readonly DecisionNode[];
  readonly frontier_round: number;
  readonly current_frontier: readonly DecisionQuestion[];
  readonly unresolved_decision_ids: readonly string[];
  readonly blocked_decision_ids: readonly string[];
  readonly question_budget: {
    readonly minimum: number;
    readonly maximum: number;
    readonly used: number;
    readonly remaining: number;
  };
  readonly status: "ready_for_approval" | "questions_required" | "paused" | "not_publishable";
  readonly reason_codes: readonly string[];
  readonly evaluated_at: string;
}

export interface DecisionGraphInput {
  readonly schema_version: 1;
  readonly profile: PlanProfile;
  readonly phase_set: PlannedPhaseSet;
  readonly context: PlanningContext;
  readonly intent: IntentContract;
  readonly evidence: EvidenceMap;
  readonly nodes: readonly DecisionNodeInput[];
  readonly evaluated_at: string;
}

export interface ApprovalContentInput {
  readonly goal: string;
  readonly user_visible_outcome: string;
  readonly in_scope: readonly string[];
  readonly out_of_scope: readonly string[];
  readonly recommended_design: string;
  readonly key_alternatives: readonly string[];
  readonly invariants: readonly string[];
  readonly failure_behaviors: readonly string[];
  readonly compatibility_boundaries: readonly string[];
  readonly risks: readonly { readonly risk: string; readonly mitigation: string }[];
  readonly acceptance_examples: readonly string[];
}

export interface ApprovalPackage {
  readonly schema_version: 1;
  readonly approval_package_id: string;
  readonly approval_package_hash: string;
  readonly approval_input_hash: string;
  readonly intent_contract_ref: string;
  readonly planning_context_ref: string;
  readonly plan_profile_ref: string;
  readonly planned_phase_set_ref: string;
  readonly decision_graph_ref: string;
  readonly status: "ready" | "not_publishable";
  readonly sections: {
    readonly goal_and_outcome: { readonly goal: string; readonly user_visible_outcome: string };
    readonly scope: { readonly in_scope: readonly string[]; readonly out_of_scope: readonly string[] };
    readonly design: { readonly recommended_design: string; readonly key_alternatives: readonly string[] };
    readonly boundaries: {
      readonly invariants: readonly string[];
      readonly failure_behaviors: readonly string[];
      readonly compatibility_boundaries: readonly string[];
    };
    readonly risks: readonly { readonly risk: string; readonly mitigation: string }[];
    readonly acceptance_examples: readonly string[];
    readonly unresolved_decisions: readonly string[];
  };
  readonly created_at: string;
}

export interface ApprovalPackageInput {
  readonly schema_version: 1;
  readonly profile: PlanProfile;
  readonly phase_set: PlannedPhaseSet;
  readonly context: PlanningContext;
  readonly intent: IntentContract;
  readonly evidence: EvidenceMap;
  readonly graph: DecisionGraph;
  readonly content: ApprovalContentInput;
  readonly created_at: string;
}

export interface ApprovalPackageDraftInput {
  readonly content: ApprovalContentInput;
  readonly created_at: string;
}

export interface ApprovalReceipt {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly approval_package_ref: string;
  readonly approval_package_hash: string;
  readonly approval_input_hash: string;
  readonly intent_contract_ref: string;
  readonly planning_context_ref: string;
  readonly plan_profile_ref: string;
  readonly planned_phase_set_ref: string;
  readonly decision_graph_ref: string;
  readonly decision_versions: readonly { readonly decision_id: string; readonly decision_version: number }[];
  readonly outcome: "approved" | "cancelled" | "rejected";
  readonly approver_id: string;
  readonly decided_at: string;
}

export interface ApprovalDecisionResult {
  readonly receipt: ApprovalReceipt;
  readonly approved_design_document: ApprovalPackage | null;
}

export interface ApprovalVerification {
  readonly valid: boolean;
  readonly reason_code: "APPROVAL_RECEIPT_VALID" | "APPROVAL_RECEIPT_INVALID" | "APPROVAL_INPUT_CHANGED";
  readonly approved_design_document: ApprovalPackage | null;
}

export interface ArchitectureDecisionCandidateInput {
  readonly schema_version: 1;
  readonly source_change_key: string;
  readonly rationale: string;
  readonly evidence_refs: readonly string[];
  readonly proposed_content: string;
  readonly confidence: number;
  readonly producer: string;
  readonly producer_version: string;
  readonly created_at: string;
  readonly irreversible: boolean;
  readonly future_maintainer_confusion: boolean;
  readonly multiple_viable_alternatives: boolean;
}

export type ProjectCandidateResult =
  | { readonly created: false; readonly reason_code: "ADR_CRITERIA_NOT_MET" }
  | { readonly created: true; readonly candidate: ProjectContentCandidate; readonly delivery: "pending_only" };

export type PlanDecisionReadResult =
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "current"; readonly graph: DecisionGraph }
  | { readonly ok: true; readonly source_schema_version: 0; readonly readiness: "legacy_read_only"; readonly legacy_ref: string }
  | { readonly ok: false; readonly reason_code: "PLAN_DECISION_RECORD_INVALID" | "PLAN_DECISION_VERSION_UNSUPPORTED" };

export type ApprovalPackageReadResult =
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "current";
      readonly package: ApprovalPackage }
  | { readonly ok: true; readonly source_schema_version: 0; readonly readiness: "legacy_read_only";
      readonly legacy_ref: string }
  | { readonly ok: false; readonly reason_code:
      | "APPROVAL_PACKAGE_RECORD_INVALID"
      | "APPROVAL_PACKAGE_VERSION_UNSUPPORTED" };

export interface PlanDecisionModule {
  evaluateDecisionGraph(input: DecisionGraphInput): DecisionGraph;
  buildApprovalPackage(input: ApprovalPackageInput): ApprovalPackage;
  recordApproval(input: {
    readonly package: ApprovalPackage;
    readonly graph: DecisionGraph;
    readonly profile: PlanProfile;
    readonly phase_set: PlannedPhaseSet;
    readonly context: PlanningContext;
    readonly intent: IntentContract;
    readonly evidence: EvidenceMap;
    readonly package_input: ApprovalPackageDraftInput;
    readonly outcome: "approved" | "cancelled" | "rejected";
    readonly approver_id: string;
    readonly decided_at: string;
  }): ApprovalDecisionResult;
  verifyApprovalReceipt(input: {
    readonly receipt: ApprovalReceipt;
    readonly package: ApprovalPackage;
    readonly profile: PlanProfile;
    readonly phase_set: PlannedPhaseSet;
    readonly context: PlanningContext;
    readonly intent: IntentContract;
    readonly evidence: EvidenceMap;
    readonly graph: DecisionGraph;
    readonly package_input: ApprovalPackageDraftInput;
  }): ApprovalVerification;
  createArchitectureDecisionCandidate(input: ArchitectureDecisionCandidateInput): ProjectCandidateResult;
  normalizeRecord(input: unknown, trusted?: {
    readonly profile: PlanProfile;
    readonly phase_set: PlannedPhaseSet;
    readonly context: PlanningContext;
    readonly intent: IntentContract;
    readonly evidence: EvidenceMap;
  }): PlanDecisionReadResult;
  normalizeApprovalPackage(input: unknown, trusted: ApprovalPackageInput): ApprovalPackageReadResult;
}
