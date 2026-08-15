import type { PlanPhase, PlanProfile } from "../plan-classification/index.js";
import type { PlanEvent as ContractPlanEvent, PlanEventBundle as ContractPlanEventBundle,
  PlanEventBundleReadResult as ContractPlanEventBundleReadResult,
  PlanEventType as ContractPlanEventType } from "@hunter-harness/contracts";
export { PLAN_EVENT_TYPES } from "@hunter-harness/contracts";
import type { HumanArtifactBuildInput, HumanArtifactSet, ImplementationDetailArtifact,
  MachineArtifactDerivationInput, MachineArtifactSet } from "../plan-artifacts/index.js";

export type QualityStatus = "passed" | "failed" | "blocked" | "skipped";
export type QualityLens = "user_behavior" | "interface_contract" | "data_consistency" | "failure_modes" |
  "dependency_seam" | "migration_rollback" | "concurrency_retry" | "observability" | "security_audit";
export type PlanEventType = ContractPlanEventType;

export interface TrustedArtifactSetInput {
  readonly human_input: HumanArtifactBuildInput;
  readonly human: HumanArtifactSet;
  readonly machine_input: Omit<MachineArtifactDerivationInput, "human" | "human_input">;
  readonly machine: MachineArtifactSet;
  readonly detail: ImplementationDetailArtifact;
}

export interface StagedPublicationEvidence {
  readonly schema_version: 1;
  readonly stage_id: string;
  readonly publication_intent_id: string;
  readonly files: readonly { readonly path: string; readonly serialized_content: string;
    readonly serialized_hash: string; readonly format: "markdown" | "json" }[];
  readonly ownership_paths: readonly string[];
  readonly approval_receipt_ref: string;
  readonly artifact_derivation_receipt_refs: readonly string[];
}

export interface StageVerificationEvidence {
  readonly schema_version: 1;
  readonly stage_id: string;
  readonly input_hash: string;
  readonly files_hash: string;
  readonly content_hashes: Readonly<Record<string, string>>;
  readonly approval_receipt_ref: string;
  readonly artifact_derivation_receipt_refs: readonly string[];
  readonly atomic_publish_receipt: string;
  readonly readback_hash: string;
  readonly verified_at: string;
  readonly evidence_hash: string;
}

export interface PlanStageVerifierPort {
  verify(input: { readonly stage_id: string; readonly publication_intent_id: string;
    readonly input_hash: string; readonly files_hash: string; readonly files: StagedPublicationEvidence["files"];
    readonly expected_content_hashes: Readonly<Record<string, string>>; readonly approval_receipt_ref: string;
    readonly artifact_derivation_receipt_refs: readonly string[] }): StageVerificationEvidence;
}

export interface QualityFinding {
  readonly finding_id: string;
  readonly category: string;
  readonly severity: "advisory" | "blocking";
  readonly source_refs: readonly string[];
  readonly message_zh: string;
  readonly suggested_location: string;
}

export interface Layer1Receipt {
  readonly schema_version: 1;
  readonly layer: "deterministic";
  readonly status: "passed" | "failed";
  readonly artifact_set_hash: string;
  readonly publication_evidence_hash: string;
  readonly publication_intent_id: string;
  readonly stage_verification: StageVerificationEvidence;
  readonly findings: readonly QualityFinding[];
  readonly completed_at: string;
  readonly receipt_hash: string;
  readonly receipt_id: string;
}

export interface SemanticEvaluationPort {
  evaluate(input: { readonly profile: PlanProfile; readonly trusted: TrustedArtifactSetInput;
    readonly approved_decisions: readonly string[]; readonly rejected_alternatives: readonly string[];
    readonly builtin_findings: readonly QualityFinding[]; readonly input_hash: string }): readonly QualityFinding[];
}

export interface Layer2Receipt {
  readonly schema_version: 1;
  readonly layer: "semantic";
  readonly status: QualityStatus;
  readonly input_hash: string;
  readonly evaluator_invoked: boolean;
  readonly findings: readonly QualityFinding[];
  readonly completed_at: string;
  readonly receipt_hash: string;
  readonly receipt_id: string;
}

export interface TrustedSemanticProjection {
  readonly input_hash: string;
  readonly evaluator_invoked: boolean;
  readonly findings: readonly QualityFinding[];
  readonly status: QualityStatus;
  readonly completed_at: string;
}

export interface LensAssessment {
  readonly lens: QualityLens;
  readonly applicability: "applicable" | "not_applicable";
  readonly finding_refs: readonly string[];
  readonly not_applicable_reason?: string;
}

export interface ReviewExecutionReceipt {
  readonly schema_version: 1;
  readonly review_mode: "inline" | "delegated";
  readonly delegation_attempted: boolean;
  readonly delegation_outcome: "not_requested" | "succeeded" | "unavailable" | "failed";
  readonly fallback_reason?: "delegation_unavailable" | "delegation_failed" | "delegation_empty";
  readonly reviewer_identity: string;
  readonly input_hash: string;
  readonly findings_hash: string;
  readonly completed_at: string;
}

export interface AdversarialReviewerPort {
  review(input: { readonly mode: "inline" | "delegated"; readonly input_hash: string;
    readonly trusted: TrustedArtifactSetInput; readonly semantic_findings: readonly QualityFinding[];
    readonly high_risk_findings: readonly QualityFinding[]; readonly lenses: readonly LensAssessment[] }): {
      readonly reviewer_identity: string;
      readonly findings: readonly QualityFinding[] } | undefined;
}

export interface Layer3Receipt {
  readonly schema_version: 1;
  readonly layer: "adversarial";
  readonly status: QualityStatus;
  readonly input_hash: string;
  readonly high_risk_findings_hash: string;
  readonly lenses: readonly LensAssessment[];
  readonly findings: readonly QualityFinding[];
  readonly review_execution: ReviewExecutionReceipt;
  readonly completed_at: string;
  readonly receipt_hash: string;
  readonly receipt_id: string;
}

export type PlanEvent = ContractPlanEvent;
export type PlanEventBundle = ContractPlanEventBundle;
export type PlanEventBundleReadResult = ContractPlanEventBundleReadResult;

export interface PlanFinalizationReceipt {
  readonly schema_version: 1;
  readonly status: "succeeded" | "blocked";
  readonly run_id: string;
  readonly change_key: string;
  readonly profile_ref: string;
  readonly artifact_set_hash: string;
  readonly layer_receipt_hashes: readonly string[];
  readonly publication_intent_id: string;
  readonly finalizer_action: "publish" | "none";
  readonly completed_at: string;
  readonly receipt_hash: string;
  readonly receipt_id: string;
}

export interface PlanQualityModule {
  readEventBundle(input: unknown): Promise<PlanEventBundleReadResult>;
  runDeterministicGates(input: { readonly trusted: TrustedArtifactSetInput;
    readonly publication: StagedPublicationEvidence; readonly stage_verifier_port: PlanStageVerifierPort;
    readonly completed_at: string }): Layer1Receipt;
  runSemanticGates(input: { readonly trusted: TrustedArtifactSetInput; readonly evaluator_port?: SemanticEvaluationPort;
    readonly completed_at: string }): Layer2Receipt;
  runAdversarialGates(input: { readonly trusted: TrustedArtifactSetInput; readonly semantic: Layer2Receipt;
    readonly explicit_adversarial: boolean; readonly reviewer_port?: AdversarialReviewerPort;
    readonly prefer_delegated: boolean; readonly completed_at: string }): Layer3Receipt;
  finalizeQuality(input: { readonly trusted: TrustedArtifactSetInput; readonly layer1: Layer1Receipt;
    readonly layer2: Layer2Receipt; readonly layer3: Layer3Receipt;
    readonly trusted_stage_verification: StageVerificationEvidence;
    readonly trusted_semantic_projection: TrustedSemanticProjection;
    readonly trusted_review_execution: ReviewExecutionReceipt;
    readonly publication: StagedPublicationEvidence; readonly run_id: string; readonly attempt: number;
    readonly phase: PlanPhase; readonly completed_at: string }): {
      readonly receipt: PlanFinalizationReceipt; readonly events: readonly PlanEvent[] };
  verifyFinalization(input: { readonly trusted: TrustedArtifactSetInput; readonly layer1: Layer1Receipt;
    readonly layer2: Layer2Receipt; readonly layer3: Layer3Receipt; readonly publication: StagedPublicationEvidence;
    readonly trusted_stage_verification: StageVerificationEvidence;
    readonly trusted_semantic_projection: TrustedSemanticProjection;
    readonly trusted_review_execution: ReviewExecutionReceipt;
    readonly execution_identity: { readonly run_id: string; readonly change_key: string; readonly phase: PlanPhase;
      readonly attempt: number; readonly completed_at: string; readonly publication_intent_id: string };
    readonly receipt: PlanFinalizationReceipt; readonly events: readonly PlanEvent[] }): { readonly valid: boolean;
      readonly reason_code: "PLAN_QUALITY_VALID" | "PLAN_QUALITY_INVALID" };
  normalizeLegacy(input: unknown): unknown;
}
