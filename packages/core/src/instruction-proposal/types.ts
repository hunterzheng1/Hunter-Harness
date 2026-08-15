import type { ProjectContentCandidate } from "@hunter-harness/contracts";

import type {
  MapEvidenceBundle,
  MapEvidenceCandidate,
  MapEvidenceTopic
} from "../codebase/map-v2/types.js";
import type {
  InstructionInspectionRef,
  InstructionProjectionOperation,
  InstructionProjectionPlan,
  RuleTopic
} from "../instruction-governance/types.js";

export type InstructionEvidenceConfidence = "high" | "medium" | "low";
export type InstructionEvidenceEligibility =
  | "proposable"
  | "supporting_only"
  | "review_only"
  | "display_only";

export interface InstructionEvidenceScope {
  map_topics: readonly MapEvidenceTopic[];
  candidate_rule_topics: Readonly<Record<string, RuleTopic>>;
  executable_architecture_candidate_ids: readonly string[];
  max_items: number;
  max_characters: number;
  max_utf8_bytes: number;
}

interface InstructionEvidenceItemBase {
  reference: string;
  source_version: string;
  source_path: string;
  content: string;
  confidence: InstructionEvidenceConfidence;
  eligibility: InstructionEvidenceEligibility;
  target_topic: RuleTopic | null;
}

export type InstructionEvidenceItem =
  | InstructionEvidenceItemBase & {
    source_kind: "candidate";
    candidate_type: "rule" | "architecture-decision" | "glossary";
    source_payload: ProjectContentCandidate;
  }
  | InstructionEvidenceItemBase & {
    source_kind: "map";
    source_payload: {
      schema_version: 2;
      manifest_hash: string;
      source_commit?: string | undefined;
      requested_topics: readonly MapEvidenceTopic[];
      snippet: MapEvidenceCandidate;
    };
  };

export interface InstructionEvidenceBundle {
  schema_version: 1;
  map_manifest_hash: string;
  selection_scope: InstructionEvidenceScope;
  items: readonly InstructionEvidenceItem[];
  used_budget: {
    items: number;
    characters: number;
    utf8_bytes: number;
  };
  limits: {
    max_items: number;
    max_characters: number;
    max_utf8_bytes: number;
  };
  truncation_reasons: readonly ("item_limit" | "character_limit" | "utf8_byte_limit")[];
  evidence_hash: string;
}

export type InstructionProposalOperation = "add" | "modify" | "move" | "deprecate";
export type InstructionReviewMode =
  | "automatic"
  | "confirmation_required"
  | "suggestion_only";

export interface InstructionProposalActionDraft {
  operation: InstructionProposalOperation;
  target_path: string;
  source_path?: string | undefined;
  topic: RuleTopic;
  content: string;
  evidence_refs: readonly string[];
  rationale_zh: string;
  confidence: InstructionEvidenceConfidence;
  review_mode: InstructionReviewMode;
}

export interface InstructionProposalModelRequest {
  schema_version: 1;
  inspection_ref: InstructionInspectionRef;
  evidence: InstructionEvidenceBundle;
  prompt_version: string;
}

export interface InstructionProposalModelPort {
  propose(request: InstructionProposalModelRequest): Promise<{
    actions: readonly InstructionProposalActionDraft[];
  }>;
}

export interface ProposeInstructionChangesInput {
  inspection_ref: InstructionInspectionRef;
  current_inspection_ref: InstructionInspectionRef;
  evidence: InstructionEvidenceBundle;
  expected_baseline_hash: string;
  canonical_file_hashes: Readonly<Record<string, string>>;
  created_at: string;
  expires_at: string;
  prompt_version: string;
  model_identity: string;
}

export interface InstructionProposalAction extends InstructionProposalActionDraft {
  action_id: string;
  before_content_hash: string | null;
  content_hash: string;
}

export interface InstructionProposal {
  schema_version: 1;
  proposal_id: string;
  inspection_ref: InstructionInspectionRef;
  input_fingerprint: string;
  expected_baseline_hash: string;
  evidence_hash: string;
  prompt_version: string;
  model_identity: string;
  actions: readonly InstructionProposalAction[];
  evidence_refs: readonly string[];
  status: "ready";
  created_at: string;
  expires_at: string;
  proposal_hash: string;
}

export interface VerifyCurrentInstructionProposalInput {
  schema_version: 1;
  map_bundle: MapEvidenceBundle;
  candidates: readonly unknown[];
  selection_scope: InstructionEvidenceScope;
  inspection_ref: InstructionInspectionRef;
  current_inspection_ref: InstructionInspectionRef;
  expected_baseline_hash: string;
  canonical_file_hashes: Readonly<Record<string, string>>;
  created_at: string;
  expires_at: string;
  prompt_version: string;
  model_identity: string;
  raw_model_actions: readonly InstructionProposalActionDraft[];
  verified_at: string;
}

export type CurrentInstructionProposalVerification =
  | {
    readonly valid: true;
    readonly reason_code: "INSTRUCTION_CURRENT_PROPOSAL_VERIFIED";
    readonly proposal: InstructionProposal;
    readonly evidence: InstructionEvidenceBundle;
    readonly verified_at: string;
  }
  | {
    readonly valid: false;
    readonly reason_code:
      | "INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID"
      | "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
      | "INSTRUCTION_CURRENT_PROPOSAL_MISMATCH"
      | "INSTRUCTION_CURRENT_PROPOSAL_EXPIRED"
      | "INSTRUCTION_CURRENT_PROPOSAL_LEGACY_READ_ONLY";
  };

export type InstructionActionDecisionValue = "accept" | "reject" | "retain";

export interface InstructionActionDecision {
  action_id: string;
  decision: InstructionActionDecisionValue;
}

export type InstructionApplyReasonCode =
  | "INSTRUCTION_APPLY_PROPOSAL_INVALID"
  | "INSTRUCTION_APPLY_SELECTION_INVALID"
  | "INSTRUCTION_APPLY_BASELINE_MISMATCH"
  | "INSTRUCTION_APPLY_PROPOSAL_EXPIRED"
  | "INSTRUCTION_APPLY_MANIFEST_INVALID"
  | "INSTRUCTION_APPLY_PROJECTION_INVALID"
  | "INSTRUCTION_APPLY_PROJECTION_UNBOUND";

export interface InstructionCanonicalWriteOperation {
  operation: "write";
  path: string;
  content: string;
  content_hash: string;
  expected_content_hash: string | null;
  action_id: string;
  layer: "canonical";
}

export interface InstructionCanonicalDeleteOperation {
  operation: "delete";
  path: string;
  content_hash: null;
  expected_content_hash: string | null;
  action_id: string;
  layer: "canonical";
}

export interface InstructionManifestWriteInput {
  content: string;
  content_hash: string;
  expected_content_hash: string;
}

export interface InstructionManifestWriteOperation {
  operation: "write";
  path: ".harness/rules/rules-manifest.json";
  content: string;
  content_hash: string;
  expected_content_hash: string;
  action_ids: readonly string[];
  layer: "canonical";
}

export interface InstructionProjectionWriteOperation extends InstructionProjectionOperation {
  layer: "projection";
}

export type InstructionApplyOperation =
  | InstructionCanonicalWriteOperation
  | InstructionCanonicalDeleteOperation
  | InstructionManifestWriteOperation
  | InstructionProjectionWriteOperation;

export interface InstructionRollbackStep {
  operation: "restore_baseline";
  path: string;
  baseline_hash: string;
}

export interface InstructionApplyPlan {
  schema_version: 1;
  proposal_id: string;
  proposal_hash: string;
  inspection_ref: InstructionInspectionRef;
  expected_baseline_hash: string;
  projection_plan_ref: string;
  resulting_canonical_hash: string;
  status: "ready" | "blocked";
  reason_codes: readonly InstructionApplyReasonCode[];
  decisions: readonly InstructionActionDecision[];
  operations: readonly InstructionApplyOperation[];
  rollback_plan: readonly InstructionRollbackStep[];
  planned_at: string;
  transaction_hash: string;
}

export interface InstructionApplyResult {
  completed_at: string;
  resulting_canonical_hash: string;
  projection_receipt_ref: string;
  applied_operations: readonly {
    path: string;
    content_hash: string | null;
  }[];
}

export interface InstructionApplyReceipt {
  schema_version: 1;
  receipt_id: string;
  proposal_id: string;
  proposal_hash: string;
  transaction_hash: string;
  applied_action_ids: readonly string[];
  skipped_action_ids: readonly string[];
  action_outcomes: readonly InstructionActionDecision[];
  changed_paths: readonly string[];
  canonical_hash: string;
  projection_receipt_ref: string;
  verification: { status: "verified"; operation_count: number };
  rollback_ref: string;
  completed_at: string;
  receipt_hash: string;
}

export type InstructionReceiptReasonCode =
  | "INSTRUCTION_RECEIPT_PROPOSAL_MISMATCH"
  | "INSTRUCTION_RECEIPT_PLAN_MISMATCH"
  | "INSTRUCTION_RECEIPT_EXECUTION_MISMATCH"
  | "INSTRUCTION_RECEIPT_HASH_INVALID";

export interface InstructionReceiptVerification {
  valid: boolean;
  reason_codes: readonly InstructionReceiptReasonCode[];
}

export interface LegacyInstructionProposalView {
  schema_version: 1;
  source_schema_version: 0;
  legacy_proposal_id: string;
  status: "legacy_unverified";
  ready: false;
  reason_codes: readonly ["INSTRUCTION_LEGACY_REINSPECTION_REQUIRED"];
}

export type ProjectionPlanInput = InstructionProjectionPlan;
