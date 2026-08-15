export const RULE_TOPICS = [
  "core",
  "architecture",
  "coding",
  "testing",
  "workflow",
  "security"
] as const;

export const RULE_STATUSES = [
  "active",
  "proposed",
  "deprecated",
  "superseded",
  "conflicted"
] as const;

export const RULE_ACTIVATIONS = [
  "always",
  "path",
  "relevance",
  "manual"
] as const;

export const INSTRUCTION_TARGET_AGENTS = [
  "codex",
  "claude_code",
  "cursor",
  "codebuddy"
] as const;

export type RuleTopic = typeof RULE_TOPICS[number];
export type RuleStatus = typeof RULE_STATUSES[number];
export type RuleActivation = typeof RULE_ACTIVATIONS[number];
export type InstructionTargetAgent = typeof INSTRUCTION_TARGET_AGENTS[number];

export interface RulesGeneratorIdentity {
  name: string;
  version: string;
  prompt_version?: string | undefined;
}

export interface RulesManifestFile {
  path: string;
  topic: RuleTopic;
  status: RuleStatus;
  content_hash: string;
  activation: RuleActivation;
  globs: readonly string[];
  module_refs: readonly string[];
  target_agents: readonly InstructionTargetAgent[];
  context_budget: number;
  evidence_refs: readonly string[];
}

export interface RulesManifest {
  schema_version: 1;
  ruleset_version: string;
  generator: RulesGeneratorIdentity;
  project_identity: string;
  canonical_root: ".harness/rules";
  files: readonly RulesManifestFile[];
  map_manifest_hash?: string | undefined;
  archive_evidence_cursor?: string | undefined;
  proposal_id?: string | undefined;
  reviewed_at?: string | undefined;
  supersedes?: string | undefined;
}

export type CompatibleRulesManifestFile = Partial<
  Omit<RulesManifestFile, "path" | "content_hash" | "target_agents">
> & Pick<RulesManifestFile, "path" | "content_hash" | "target_agents">;

export interface CompatibleRulesManifest {
  schema_version: 1;
  ruleset_version?: string | undefined;
  generator?: RulesGeneratorIdentity | undefined;
  project_identity?: string | undefined;
  canonical_root: ".harness/rules";
  files: readonly CompatibleRulesManifestFile[];
  map_manifest_hash?: string | undefined;
  archive_evidence_cursor?: string | undefined;
  proposal_id?: string | undefined;
  reviewed_at?: string | undefined;
  supersedes?: string | undefined;
}

export type RulesManifestReadReasonCode =
  | "RULES_MANIFEST_INVALID"
  | "RULES_MANIFEST_VERSION_UNSUPPORTED";

export type RulesManifestDegradationReason =
  | "RULES_MANIFEST_LEGACY_FILE_METADATA_UNAVAILABLE"
  | "RULES_MANIFEST_LEGACY_GENERATOR_UNAVAILABLE"
  | "RULES_MANIFEST_LEGACY_PROJECT_IDENTITY_UNAVAILABLE";

export type RulesManifestReadResult =
  | {
    ok: true;
    source_schema_version: 0 | 1;
    manifest: CompatibleRulesManifest;
    degradation_reasons: readonly RulesManifestDegradationReason[];
  }
  | {
    ok: false;
    reason_code: RulesManifestReadReasonCode;
  };

export interface InstructionCanonicalFileSnapshot {
  path: string;
  content_hash: string;
  references: readonly string[];
}

export interface InstructionEntrypointSnapshot {
  agent: InstructionTargetAgent;
  path: string;
  content_hash: string;
  references: readonly string[];
}

export interface InstructionProjectionSnapshot {
  agent: InstructionTargetAgent;
  path: string;
  content_hash: string;
  expected_content_hash: string | null;
  canonical_refs: readonly string[];
}

export interface InstructionInspectionInput {
  schema_version: 1;
  project_identity: string;
  enabled_agents: readonly InstructionTargetAgent[];
  manifest: RulesManifest;
  canonical_files: readonly InstructionCanonicalFileSnapshot[];
  entrypoints: readonly InstructionEntrypointSnapshot[];
  projection_files: readonly InstructionProjectionSnapshot[];
  map_evidence_refs: readonly string[];
  archive_evidence_cursor?: string | undefined;
  configuration_hashes: Readonly<Record<string, string>>;
  prompt_version: string;
  agent_context_usage: Readonly<Partial<Record<InstructionTargetAgent, number>>>;
  agent_context_budgets: Readonly<Partial<Record<InstructionTargetAgent, number>>>;
  previous_input_fingerprint?: string | undefined;
  last_proposal_ref?: string | undefined;
  last_apply_receipt_ref?: string | undefined;
}

export type InstructionStructureReasonCode =
  | "INSTRUCTION_CANONICAL_FILE_MISSING"
  | "INSTRUCTION_CANONICAL_HASH_MISMATCH"
  | "INSTRUCTION_CANONICAL_REFERENCE_INVALID"
  | "INSTRUCTION_CONTEXT_BUDGET_EXCEEDED"
  | "INSTRUCTION_ENTRYPOINT_MISSING"
  | "INSTRUCTION_PROJECTION_CONFLICT"
  | "INSTRUCTION_REFERENCE_CYCLE";

export interface InstructionStructureFinding {
  finding_id: string;
  reason_code: InstructionStructureReasonCode;
  path?: string | undefined;
  target_agent?: InstructionTargetAgent | undefined;
  related_paths: readonly string[];
}

export type InstructionQualityReasonCode =
  | "INSTRUCTION_TOPIC_ARCHITECTURE_MISSING"
  | "INSTRUCTION_TOPIC_BUILD_MISSING"
  | "INSTRUCTION_TOPIC_TESTING_MISSING";

export interface InstructionQualitySuggestion {
  suggestion_id: string;
  reason_code: InstructionQualityReasonCode;
  topic: "architecture" | "build" | "testing";
}

export interface InstructionInspectionRef {
  schema_version: 1;
  input_fingerprint: string;
  canonical_hash: string;
  result_hash: string;
}

export type InstructionHealthStatus =
  | "current"
  | "review_required"
  | "conflicted"
  | "invalid";

export interface InstructionHealth {
  schema_version: 1;
  inspection_id: string;
  inspection_ref: InstructionInspectionRef;
  input_fingerprint: string;
  canonical_hash: string;
  projection_hashes: Readonly<Partial<Record<InstructionTargetAgent, string>>>;
  status: InstructionHealthStatus;
  structure_findings: readonly InstructionStructureFinding[];
  quality_suggestions: readonly InstructionQualitySuggestion[];
  last_proposal_ref?: string | undefined;
  last_apply_receipt_ref?: string | undefined;
  requires_reinspection: boolean;
}

export type InstructionGovernanceErrorCode = "INSTRUCTION_INSPECTION_INPUT_INVALID";

export class InstructionGovernanceError extends Error {
  readonly code: InstructionGovernanceErrorCode;

  constructor(code: InstructionGovernanceErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "InstructionGovernanceError";
    this.code = code;
  }
}

export interface CanonicalRuleDocument {
  path: string;
  content: string;
}

export interface CanonicalRulesRef {
  schema_version: 1;
  canonical_hash: string;
  manifest: RulesManifest;
  files: readonly CanonicalRuleDocument[];
}

export interface AgentProjectionRequest {
  agent: InstructionTargetAgent;
  max_context_budget: number;
  observed_projection_hashes: Readonly<Record<string, string | null>>;
}

export type ExpectedProjectionHashes = Readonly<Record<string, string | null>>;

export type InstructionProjectionReasonCode =
  | "INSTRUCTION_CANONICAL_REF_INVALID"
  | "INSTRUCTION_PROJECTION_BASELINE_CONFLICT"
  | "INSTRUCTION_PROJECTION_CONTEXT_BUDGET_EXCEEDED"
  | "INSTRUCTION_PROJECTION_EXPECTATION_MISSING"
  | "INSTRUCTION_PROJECTION_EXPECTATION_UNKNOWN"
  | "INSTRUCTION_PROJECTION_PATH_COLLISION"
  | "INSTRUCTION_PROJECTION_RENDER_INVALID";

export interface InstructionProjectionFailure {
  reason_code: InstructionProjectionReasonCode;
  target_agent?: InstructionTargetAgent | undefined;
  path?: string | undefined;
}

export interface InstructionProjectionOperation {
  operation: "write";
  path: string;
  target_agents: readonly InstructionTargetAgent[];
  source_paths: readonly string[];
  expected_content_hash: string | null;
  content_hash: string;
  content: string;
  adapter_version: "instruction_projection_v1";
}

export type InstructionProjectionPlanStatus =
  | "ready"
  | "conflicted"
  | "invalid";

export interface InstructionProjectionPlan {
  schema_version: 1;
  canonical_hash: string;
  adapter_version: "instruction_projection_v1";
  status: InstructionProjectionPlanStatus;
  executable: boolean;
  operations: readonly InstructionProjectionOperation[];
  failures: readonly InstructionProjectionFailure[];
  projection_hashes: Readonly<Partial<Record<InstructionTargetAgent, string>>>;
  plan_hash: string;
}
