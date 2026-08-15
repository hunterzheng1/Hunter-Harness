export const CODEBASE_MAP_V2_DOCUMENTS = [
  "STACK.md",
  "INTEGRATIONS.md",
  "ARCHITECTURE.md",
  "STRUCTURE.md",
  "CONVENTIONS.md",
  "TESTING.md",
  "CONCERNS.md"
] as const;

export type MapDocumentName = typeof CODEBASE_MAP_V2_DOCUMENTS[number];
export type MapPublicationTargetPath =
  | `.harness/codebase/map/${MapDocumentName}`
  | ".harness/codebase/map-summary.md"
  | ".harness/codebase/map-manifest.json";

export const CODEBASE_MAP_PUBLICATION_TARGETS = Object.freeze([
  ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `.harness/codebase/map/${name}` as const),
  ".harness/codebase/map-summary.md",
  ".harness/codebase/map-manifest.json"
] satisfies readonly MapPublicationTargetPath[]);
export type MapMode = "quick" | "incremental" | "full";
export type MapDocumentStatus =
  | "current"
  | "refreshed"
  | "unchanged"
  | "conflicted"
  | "failed";
export type MapStatus = "ready" | "partial" | "conflicted" | "failed";

export interface MapGeneratorIdentity {
  name: string;
  version: string;
  prompt_version?: string | undefined;
}

export interface MapManifestDocumentV2 {
  path: string;
  topics: readonly string[];
  evidence_sources: readonly string[];
  input_fingerprint: string;
  content_hash: string;
  estimated_tokens: number;
  status: MapDocumentStatus;
}

export type CompatibleMapManifestDocumentV2 =
  Omit<MapManifestDocumentV2,
    "input_fingerprint" | "content_hash" | "estimated_tokens" | "status"> & {
    input_fingerprint?: string | undefined;
    content_hash?: string | undefined;
    estimated_tokens?: number | undefined;
    status?: MapDocumentStatus | undefined;
  };

/** The durable v2 write model. Compatibility readers use CompatibleMapManifestV2. */
export interface MapManifestV2 {
  schema_version: 2;
  generator: MapGeneratorIdentity;
  project_identity: string;
  repository_identity: string;
  branch_name?: string | undefined;
  source_commit?: string | undefined;
  worktree_identity?: string | undefined;
  mode: MapMode;
  scope: string;
  path_filters: readonly string[];
  input_fingerprint: string;
  input_group_fingerprints?: Readonly<Record<string, string>> | undefined;
  documents: readonly MapManifestDocumentV2[];
  summary_hash: string;
  warnings: readonly string[];
  degradation_reasons: readonly string[];
  status: MapStatus;
  published_at: string;
}

/**
 * A v2-shaped read model. Fields unavailable in a legacy manifest stay absent;
 * their absence is also recorded in degradation_reasons.
 */
export interface CompatibleMapManifestV2 {
  schema_version: 2;
  generator?: MapGeneratorIdentity | undefined;
  project_identity?: string | undefined;
  repository_identity?: string | undefined;
  branch_name?: string | undefined;
  source_commit?: string | undefined;
  worktree_identity?: string | undefined;
  mode?: MapMode | undefined;
  scope?: string | undefined;
  path_filters: readonly string[];
  input_fingerprint?: string | undefined;
  input_group_fingerprints?: Readonly<Record<string, string>> | undefined;
  documents: readonly CompatibleMapManifestDocumentV2[];
  summary_hash?: string | undefined;
  warnings: readonly string[];
  degradation_reasons: readonly string[];
  status?: MapStatus | undefined;
  published_at?: string | undefined;
}

export type MapManifestReadResult =
  | {
    ok: true;
    source_schema_version: 1 | 2;
    manifest: CompatibleMapManifestV2;
  }
  | { ok: false; reason_code: "MAP_MANIFEST_INVALID" | "MAP_MANIFEST_VERSION_UNSUPPORTED" };

export interface MapFeatureFlags {
  map_enabled: boolean;
  auto_check_enabled: boolean;
  explicit_request: boolean;
  codegraph_enabled: boolean;
  codegraph_available: boolean;
}

export interface MapInspectionInput {
  schema_version: 2;
  project_identity: string;
  repository_identity: string;
  worktree_identity?: string | undefined;
  is_git: boolean;
  branch_name?: string | undefined;
  current_commit?: string | undefined;
  last_mapped_commit?: string | undefined;
  dirty_paths: readonly string[];
  untracked_paths: readonly string[];
  affected_paths: readonly string[];
  input_group_fingerprints: Readonly<Record<string, string>>;
  feature_flags: MapFeatureFlags;
  manifest?: unknown;
  /** Durable byte hash supplied by the filesystem Adapter when available. */
  manifest_hash?: string | undefined;
}

export type MapHealthReasonCode =
  | "MAP_NOT_ADOPTED"
  | "MAP_MANIFEST_MISSING"
  | "MAP_MANIFEST_INVALID"
  | "MAP_MANIFEST_INCOMPLETE"
  | "MAP_MANIFEST_CONFLICTED"
  | "MAP_MANIFEST_FAILED"
  | "MAP_MANIFEST_PARTIAL"
  | "MAP_LEGACY_IDENTITY_UNKNOWN"
  | "MAP_MANIFEST_IDENTITY_INCOMPLETE"
  | "MAP_LOCAL_MODIFICATION_CONFLICT"
  | "MAP_PROJECT_IDENTITY_MISMATCH"
  | "MAP_REPOSITORY_IDENTITY_MISMATCH"
  | "MAP_BRANCH_MISMATCH"
  | "MAP_WORKTREE_MISMATCH"
  | "MAP_SOURCE_COMMIT_CHANGED"
  | "MAP_WORKSPACE_DIRTY"
  | "MAP_STRUCTURE_DRIFT"
  | "MAP_CONTENT_DRIFT"
  | "MAP_INPUT_FINGERPRINT_CHANGED"
  | "MAP_CODEGRAPH_UNAVAILABLE"
  | "MAP_CURRENT";

export type MapConflict =
  | {
    reason_code:
      | "MAP_PROJECT_IDENTITY_MISMATCH"
      | "MAP_REPOSITORY_IDENTITY_MISMATCH"
      | "MAP_BRANCH_MISMATCH"
      | "MAP_WORKTREE_MISMATCH";
    expected: string;
    actual: string;
  }
  | {
    reason_code: "MAP_LOCAL_MODIFICATION_CONFLICT";
    paths: readonly string[];
  };

export interface MapHealth {
  schema_version: 2;
  applicability: "applicable" | "not_applicable";
  status: "not_applicable" | "missing" | "current" | "refresh_required" | "conflicted";
  input_fingerprint: string;
  manifest_version?: 1 | 2 | undefined;
  manifest_hash?: string | undefined;
  source_commit?: string | undefined;
  affected_documents: readonly MapDocumentName[];
  conflicts: readonly MapConflict[];
  suggested_actions: readonly (
    | "offer_generate_map"
    | "run_quick_refresh"
    | "run_incremental_refresh"
    | "run_full_refresh"
    | "resolve_identity_conflict"
    | "keep_local"
    | "use_new_result"
    | "view_diff"
  )[];
  reason_codes: readonly MapHealthReasonCode[];
}

export type MapEvidenceTopic =
  | "stack"
  | "integrations"
  | "architecture"
  | "structure"
  | "conventions"
  | "testing"
  | "concerns";

export interface MapEvidenceCandidate {
  topic: MapEvidenceTopic;
  source_path: string;
  content: string;
  confidence: "verified" | "inferred" | "unverified";
  evidence_source: "codegraph" | "filesystem" | "manifest";
}

export interface MapEvidenceSelectionInput {
  schema_version: 2;
  manifest_hash: string;
  source_commit?: string | undefined;
  topics: readonly MapEvidenceTopic[];
  budget: { max_characters: number; max_tokens: number };
  candidates: readonly MapEvidenceCandidate[];
}

export interface MapEvidenceBundle {
  schema_version: 2;
  manifest_hash: string;
  source_commit?: string | undefined;
  requested_topics: readonly MapEvidenceTopic[];
  snippets: readonly MapEvidenceCandidate[];
  used_budget: { characters: number; tokens: number };
  truncation_reasons: readonly (
    | "SENSITIVE_PATH_EXCLUDED"
    | "SENSITIVE_CONTENT_EXCLUDED"
    | "CHARACTER_BUDGET_EXHAUSTED"
    | "TOKEN_BUDGET_EXHAUSTED"
    | "TOPIC_NOT_AVAILABLE"
  )[];
}

export interface MappingExecutionPolicy {
  mode: MapMode;
  model_tier: "light" | "standard";
  max_parallel_mappers: number;
  max_model_attempts: 2;
  timeout_ms: number;
  token_budget: number;
  escalation_conditions: readonly ["VALIDATION_FAILED", "HIGH_RISK_AMBIGUITY"];
}

/** Created only by the filesystem Adapter after a verified atomic publication. */
export interface MapReceipt {
  schema_version: 2;
  operation_id: string;
  input_fingerprint: string;
  previous_manifest_hash?: string | undefined;
  manifest_hash: string;
  changed_documents: readonly MapDocumentName[];
  preserved_documents: readonly MapDocumentName[];
  execution_policy: MappingExecutionPolicy;
  execution: {
    provider: string;
    model: string;
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
    model_attempts: number;
    escalated: boolean;
    escalation_reasons: readonly string[];
  };
  verification: {
    seven_documents_valid: boolean;
    references_valid: boolean;
    sensitive_scan_passed: boolean;
    atomic_publication_completed: boolean;
  };
  completed_at: string;
}

export type MapManifestDraftV2 = Omit<MapManifestV2, "published_at">;

export interface MapPublicationPlanInput {
  schema_version: 2;
  /** Frozen by the confirmation/preview caller; the Module never reads a clock. */
  published_at: string;
  mode: MapMode;
  affected_documents: readonly MapDocumentName[];
  previous_manifest_hash?: string | undefined;
  previous_documents: Readonly<Record<string, string>>;
  proposed_documents: Readonly<Record<string, string>>;
  manifest_draft: MapManifestDraftV2;
  summary_content: string;
}

export type MapPublicationOperation =
  | { operation: "stage_write"; path: string; content_hash: string }
  | {
    operation: "atomic_replace_set";
    staged_paths: readonly string[];
    target_paths: readonly string[];
    rollback_on_failure: true;
    expected_previous_manifest_hash?: string | undefined;
  };

export type MapPublicationFailureReason =
  | "PUBLICATION_SCOPE_INVALID"
  | "MAP_DOCUMENT_MISSING"
  | "MAP_DOCUMENT_EMPTY"
  | "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"
  | "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"
  | "ARCHITECTURE_EVIDENCE_MISSING"
  | "SENSITIVE_OUTPUT_DETECTED"
  | "MAP_MANIFEST_DRAFT_INVALID"
  | "MAP_PUBLICATION_TIMESTAMP_INVALID";

export type MapPublicationPlan =
  | {
    ok: true;
    plan_hash: string;
    /** Complete byte payload for the exact owned publication target set. */
    payloads: Readonly<Record<MapPublicationTargetPath, string>>;
    documents: Readonly<Record<MapDocumentName, string>>;
    changed_documents: readonly MapDocumentName[];
    preserved_documents: readonly MapDocumentName[];
    /** Complete durable object and its exact canonical bytes for Adapter persistence. */
    manifest: MapManifestV2;
    manifest_payload: string;
    /** Backward-compatible alias; now complete and byte-bound, not an un-timestamped draft. */
    manifest_draft: MapManifestV2;
    operations: readonly MapPublicationOperation[];
  }
  | {
    ok: false;
    reason_codes: readonly MapPublicationFailureReason[];
    retained_manifest_hash?: string | undefined;
    operations: readonly [];
  };
