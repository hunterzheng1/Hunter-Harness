import type { PlanPhase, PlanProfile, PlannedPhaseSet } from "../plan-classification/index.js";
import type { EvidenceMap, IntentContract, PlanningContext } from "../planning-context/index.js";
import type {
  ApprovalPackage,
  ApprovalPackageDraftInput,
  ApprovalReceipt,
  DecisionGraph
} from "../plan-decision/index.js";

export type CoverageDimension = "normal_path" | "parameter_validation" | "business_rules" |
  "permission_boundaries" | "data_compatibility" | "error_codes" | "integration_impact" |
  "concurrency_idempotency";

export interface RequirementRecord {
  readonly requirement_id: string;
  readonly kind: "behavior" | "invariant" | "failure_behavior";
  readonly text: string;
  readonly evidence_refs: readonly string[];
  readonly approved_scope_refs: readonly string[];
}

export interface ApprovedScopeRecord {
  readonly scope_ref: string;
  readonly text: string;
}

export interface OwnershipRecord {
  readonly ownership_ref: string;
  readonly path: string;
  readonly approved_scope_refs: readonly string[];
  readonly evidence_refs: readonly string[];
}

export interface PlanTaskInput {
  readonly task_id: string;
  readonly objective: string;
  readonly affected_paths: readonly string[];
  readonly depends_on: readonly string[];
  readonly owner_phase: PlanPhase;
  readonly decision_refs: readonly string[];
  readonly scenario_refs: readonly string[];
  readonly requirement_refs: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly ownership_refs: readonly string[];
}

export type ScenarioPriority = "P0" | "P1" | "P2";

export interface TestScenarioInput {
  readonly scenario_id: string;
  readonly title: string;
  readonly acceptance: string;
  readonly coverage_dimension: CoverageDimension;
  readonly execution_level: "unit" | "api" | "data_compatibility" | "integration" | "system";
  readonly evidence_requirements: readonly string[];
  readonly verification_command?: string | undefined;
  readonly risk_level: "low" | "medium" | "high";
  // priority 与 owner_phase 是门禁判定 "哪些场景必须带 ledger 证据、在哪个阶段到期"
  // 的依据，risk_level 与 task_refs 都替代不了：risk 是影响面，priority 是取证要求；
  // 一条场景可以引用跨阶段的多个 task，反查没有仲裁规则。
  readonly priority: ScenarioPriority;
  readonly owner_phase: PlanPhase;
  // 可执行测试身份三元。ledger 场景（P0/P1）必须齐全，否则派生的 manifest
  // 只能声明 schemaVersion 1，run/test 关门时无法绑定结构化执行收据。
  readonly executable_test_id?: string | undefined;
  readonly test_file?: string | undefined;
  readonly test_title?: string | undefined;
  readonly task_refs: readonly string[];
  readonly requirement_refs: readonly string[];
}

export interface CoverageApplicabilityInput {
  readonly coverage_dimension: CoverageDimension;
  readonly applicability: "applicable" | "not_applicable";
  readonly scenario_refs: readonly string[];
  readonly not_applicable_reason?: string | undefined;
}

export interface HumanArtifactStructuredInput {
  readonly change_key: string;
  readonly requirements: readonly RequirementRecord[];
  readonly approved_scopes: readonly ApprovedScopeRecord[];
  readonly ownership: readonly OwnershipRecord[];
  readonly tasks: readonly PlanTaskInput[];
  readonly scenarios: readonly TestScenarioInput[];
  readonly coverage: readonly CoverageApplicabilityInput[];
}

export interface HumanArtifactBuildInput {
  readonly schema_version: 2;
  readonly profile: PlanProfile;
  readonly phase_set: PlannedPhaseSet;
  readonly context: PlanningContext;
  readonly intent: IntentContract;
  readonly evidence: EvidenceMap;
  readonly graph: DecisionGraph;
  readonly approval_package: ApprovalPackage;
  readonly approval_package_input: ApprovalPackageDraftInput;
  readonly approval_receipt: ApprovalReceipt;
  readonly structured_input: HumanArtifactStructuredInput;
}

export interface ArtifactIdentity {
  readonly schema_version: 2;
  readonly artifact_id: string;
  readonly artifact_type: string;
  readonly source_hashes: Readonly<Record<string, string>>;
  readonly generator_version: string;
  readonly content_hash: string;
}

export interface DesignArtifact extends ArtifactIdentity {
  readonly artifact_type: "design";
  readonly content: {
    readonly goal: string;
    readonly user_visible_outcome: string;
    readonly in_scope: readonly string[];
    readonly out_of_scope: readonly string[];
    readonly behavior_contract: string;
    readonly constraints: readonly string[];
    readonly invariants: readonly string[];
    readonly failure_behaviors: readonly string[];
    readonly tradeoffs: readonly string[];
    readonly compatibility_boundaries: readonly string[];
    readonly risks: readonly { readonly risk: string; readonly mitigation: string }[];
    readonly requirements: readonly RequirementRecord[];
    readonly approved_scopes: readonly ApprovedScopeRecord[];
    readonly ownership: readonly OwnershipRecord[];
  };
}

export interface PlanArtifact extends ArtifactIdentity {
  readonly artifact_type: "plan";
  readonly content: { readonly change_key: string; readonly tasks: readonly PlanTaskInput[] };
}

export interface TestScenariosArtifact extends ArtifactIdentity {
  readonly artifact_type: "test_scenarios";
  readonly content: {
    readonly scenarios: readonly TestScenarioInput[];
    readonly coverage: readonly CoverageApplicabilityInput[];
  };
}

export interface HumanArtifactSet {
  readonly schema_version: 2;
  readonly artifact_set_id: string;
  readonly artifact_set_hash: string;
  readonly design: DesignArtifact;
  readonly plan: PlanArtifact;
  readonly test_scenarios: TestScenariosArtifact;
}

export type ProjectCapability = "api" | "database" | "filesystem" | "migration" | "network" |
  "permissions" | "security" | "ui" | "concurrency";

export interface MachineArtifactDerivationInput {
  readonly schema_version: 2;
  readonly profile: PlanProfile;
  readonly phase_set: PlannedPhaseSet;
  readonly capabilities: readonly ProjectCapability[];
  readonly worktree_policy: "project_default" | "required" | "forbidden";
  readonly human_input: HumanArtifactBuildInput;
  readonly human: HumanArtifactSet;
  /**
   * Python 门禁策略快照（可选）：classify 在阶段 0.5 写入 meta/gate-policy.json 的
   * requiredGateDag / requiredValidationsByPhase / tier / source 等门禁字段。
   * evidence-pack 读出后以白名单键并入 gate_policy content 并哈希绑定——v2 产物
   * 由此成为门禁权威（gate 优先读 plan-profile.json），不再依赖工作副本漂移风险。
   */
  readonly gate_policy_overlay?: Readonly<Record<string, unknown>>;
}

export interface MachineArtifact extends ArtifactIdentity {
  readonly artifact_type: "gate_policy" | "worktree" | "implementation_checkpoints" | "scenario_manifest";
  readonly content: Readonly<Record<string, unknown>>;
}

export interface MachineArtifactSet {
  readonly schema_version: 2;
  readonly artifact_set_id: string;
  readonly artifact_set_hash: string;
  readonly gate_policy: MachineArtifact;
  readonly worktree: MachineArtifact;
  readonly implementation_checkpoints: MachineArtifact;
  readonly scenario_manifest: MachineArtifact;
}

export interface ImplementationDetailArtifact extends ArtifactIdentity {
  readonly artifact_type: "implementation_detail";
  readonly mode: PlanProfile["mode"];
  readonly content: Readonly<Record<string, unknown>>;
}

export interface ArtifactSetVerification {
  readonly valid: boolean;
  readonly reason_code: "PLAN_ARTIFACT_SET_VALID" | "PLAN_ARTIFACT_SET_INVALID" |
    "PLAN_ARTIFACT_SOURCE_DRIFT";
}

export interface LegacyV1PlanTask {
  readonly task_id: string;
  readonly objective: string;
  readonly affected_paths: readonly string[];
  readonly depends_on: readonly string[];
  readonly owner_phase: PlanPhase;
  readonly decision_refs: readonly string[];
  readonly scenario_refs: readonly string[];
}

export interface LegacyV1TestScenario {
  readonly scenario_id: string;
  readonly title: string;
  readonly acceptance: string;
  readonly coverage_dimension: CoverageDimension;
  readonly execution_level: "unit" | "api" | "data_compatibility" | "integration" | "system";
  readonly evidence_requirements: readonly string[];
  readonly verification_command?: string | undefined;
  readonly risk_level: "low" | "medium" | "high";
}

export interface LegacyV1ArtifactIdentity {
  readonly schema_version: 1;
  readonly artifact_id: string;
  readonly artifact_type: "design" | "plan" | "test_scenarios";
  readonly source_hashes: Readonly<Record<string, string>>;
  readonly generator_version: "hunter-harness-plan-artifacts/1";
  readonly content_hash: string;
  readonly content: unknown;
}

export interface LegacyV1HumanArtifactSet {
  readonly schema_version: 1;
  readonly artifact_set_id: string;
  readonly artifact_set_hash: string;
  readonly design: LegacyV1ArtifactIdentity;
  readonly plan: LegacyV1ArtifactIdentity;
  readonly test_scenarios: LegacyV1ArtifactIdentity;
}

export type PlanArtifactReadResult =
  | { readonly ok: true; readonly source_schema_version: 2; readonly readiness: "current";
    readonly artifacts: HumanArtifactSet }
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "legacy_read_only";
    readonly legacy: LegacyV1HumanArtifactSet }
  | { readonly ok: true; readonly source_schema_version: 0; readonly readiness: "legacy_read_only";
    readonly legacy: { readonly change_name: string; readonly frontmatter_status: "approved";
      readonly standard_inputs: readonly string[] } }
  | { readonly ok: false; readonly reason_code: "PLAN_ARTIFACT_RECORD_INVALID" |
    "PLAN_ARTIFACT_VERSION_UNSUPPORTED" };

export interface PlanArtifactModel {
  buildHumanArtifacts(input: HumanArtifactBuildInput): HumanArtifactSet;
  deriveMachineArtifacts(input: MachineArtifactDerivationInput): MachineArtifactSet;
  deriveImplementationDetail(input: {
    readonly mode: PlanProfile["mode"];
    readonly human_input: HumanArtifactBuildInput;
    readonly human: HumanArtifactSet;
  }): ImplementationDetailArtifact;
  verifyArtifactSet(input: {
    readonly human_input: HumanArtifactBuildInput;
    readonly human: HumanArtifactSet;
    readonly machine_input: Omit<MachineArtifactDerivationInput, "human" | "human_input">;
    readonly machine: MachineArtifactSet;
    readonly detail: ImplementationDetailArtifact;
  }): ArtifactSetVerification;
  normalizeLegacy(input: unknown, trusted?: HumanArtifactBuildInput): PlanArtifactReadResult;
}
