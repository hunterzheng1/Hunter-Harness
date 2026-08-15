export type SyncSha256 = `sha256:${string}`;
export type ProviderApplicabilityState = "applicable" | "not_applicable" | "unavailable";
export type SyncHealthStatus = "OK" | "ADVISORY" | "WARN" | "FAIL" | "BLOCKED" | "UNKNOWN";
export type SyncUrgency = "none" | "optional" | "recommended" | "required";
export type SyncActionRisk = "low" | "medium" | "high";
export type SyncRollbackStrategy = "none" | "automatic" | "manual";

export interface ProjectChangeSet {
  readonly schema_version: 1;
  readonly baseline_available: boolean;
  readonly head_commit?: string | undefined;
  readonly dirty_paths: readonly string[];
  readonly untracked_paths: readonly string[];
}

export interface SyncContextInput {
  readonly schema_version: 1;
  readonly project_identity: string;
  readonly repository_identity?: string | undefined;
  readonly worktree_identity?: string | undefined;
  readonly current_commit?: string | undefined;
  readonly upstream_ref?: string | undefined;
  readonly project_change_set: ProjectChangeSet;
  readonly enabled_agents: readonly string[];
  readonly agent_profiles: Readonly<Record<string, string>>;
  readonly platform_binding?: { readonly project_id: string } | undefined;
  readonly feature_flags: Readonly<Record<string, boolean>>;
}

export interface SyncContext extends SyncContextInput {
  readonly context_hash: SyncSha256;
}

export interface ProviderApplicability {
  readonly applicability: ProviderApplicabilityState;
  readonly reason_code: string;
}

export interface SyncEvidence {
  readonly source: string;
  readonly input_hash: SyncSha256;
  readonly observed_hash?: SyncSha256 | undefined;
}

export interface SyncFinding {
  readonly schema_version: 1;
  readonly finding_id: string;
  readonly provider_id: string;
  readonly status: SyncHealthStatus;
  readonly urgency: SyncUrgency;
  readonly reason_code: string;
  readonly display_title_zh: string;
  readonly display_message_zh: string;
  readonly evidence: SyncEvidence;
}

export interface SyncActionPlan {
  readonly schema_version: 1;
  readonly action_id: string;
  readonly provider_id: string;
  readonly finding_ids: readonly string[];
  readonly depends_on: readonly string[];
  readonly conflicts_with: readonly string[];
  readonly invalidates_providers: readonly string[];
  readonly expected_writes: readonly string[];
  readonly network_access: boolean;
  readonly model_access: boolean;
  readonly risk: SyncActionRisk;
  readonly rollback_strategy: SyncRollbackStrategy;
  readonly invalidation_hash: SyncSha256;
  readonly estimated_duration_ms: number;
}

export interface SyncProviderResult {
  readonly provider_id: string;
  readonly applicability: ProviderApplicabilityState;
  readonly status: SyncHealthStatus;
  readonly urgency: SyncUrgency;
  readonly reason_code: string;
  readonly findings: readonly SyncFinding[];
  readonly duration_ms: number;
  readonly timeout_type?: "provider_budget" | undefined;
  readonly degradation_reason?: string | undefined;
}

export interface SyncPlanSummary {
  readonly schema_version: 1;
  readonly provider_count: number;
  readonly not_applicable_count: number;
  readonly unavailable_count: number;
  readonly status_counts: Readonly<Partial<Record<SyncHealthStatus, number>>>;
  readonly urgency_counts: Readonly<Partial<Record<SyncUrgency, number>>>;
}

export interface SyncPlan {
  readonly schema_version: 1;
  readonly plan_id: `sync_plan:${string}`;
  readonly context_hash: SyncSha256;
  readonly input_hash: SyncSha256;
  readonly provider_results: readonly SyncProviderResult[];
  readonly findings: readonly SyncFinding[];
  readonly actions: readonly SyncActionPlan[];
  readonly expected_writes: readonly string[];
  readonly preview_hash: SyncSha256;
  readonly created_at: string;
  readonly expires_at: string;
  readonly summary: SyncPlanSummary;
}

export interface SyncApplyConfirmation {
  readonly schema_version: 1;
  readonly plan_id: `sync_plan:${string}`;
  readonly preview_hash: SyncSha256;
  readonly approved_action_ids: readonly string[];
  readonly allow_writes: boolean;
  readonly allow_network: boolean;
  readonly allow_model: boolean;
  readonly confirmed_at: string;
}

export interface SyncRollbackPlan {
  readonly strategy: SyncRollbackStrategy;
  readonly available: boolean;
  readonly rollback_token?: string | undefined;
}

export interface SyncActionReceipt {
  readonly schema_version: 1;
  readonly action_id: string;
  readonly provider_id: string;
  readonly input_hash: SyncSha256;
  readonly output_hash: SyncSha256;
  readonly evidence_sources: readonly string[];
  readonly wrote: boolean;
  readonly modified_paths: readonly string[];
  readonly rollback: SyncRollbackPlan;
  readonly auto_fixed: boolean;
  readonly duration_ms: number;
  readonly completed_at: string;
}

export interface SyncVerification {
  readonly schema_version: 1;
  readonly action_id: string;
  readonly provider_id: string;
  readonly status: "verified" | "failed";
  readonly reason_code: string;
  readonly evidence_hash: SyncSha256;
  readonly verified_at: string;
}

export interface SyncRollbackReceipt {
  readonly schema_version: 1;
  readonly action_id: string;
  readonly provider_id: string;
  readonly status: "rolled_back" | "failed" | "not_available";
  readonly reason_code: string;
  readonly evidence_hash: SyncSha256;
  readonly completed_at: string;
}

export interface SyncApplyFailureEvidence {
  readonly schema_version: 1;
  readonly plan_id: `sync_plan:${string}`;
  readonly preview_hash: SyncSha256;
  readonly failed_action_id: string;
  readonly reason_code:
    | "PROVIDER_APPLY_FAILED"
    | "PROVIDER_RECEIPT_INVALID"
    | "PROVIDER_VERIFICATION_FAILED";
  readonly receipts: readonly SyncActionReceipt[];
  readonly rollback_receipts: readonly SyncRollbackReceipt[];
  readonly failed_at: string;
}

export interface RemoteSyncRequestIntent {
  readonly schema_version: 1;
  readonly request_id: `sync_remote_intent:${string}`;
  readonly context_hash: SyncSha256;
  readonly changed_paths: readonly string[];
  readonly reason_code: "local_sync_changes_available";
}

export interface SyncApplyResult {
  readonly schema_version: 1;
  readonly plan_id: `sync_plan:${string}`;
  readonly preview_hash: SyncSha256;
  readonly applied_action_ids: readonly string[];
  readonly receipts: readonly SyncActionReceipt[];
  readonly verifications: readonly SyncVerification[];
  readonly rechecked_providers: readonly SyncProviderResult[];
  readonly changed_paths: readonly string[];
  readonly no_changes: boolean;
  readonly remote_sync_request_intent?: RemoteSyncRequestIntent | undefined;
  readonly completed_at: string;
}

export interface SyncActionProvider {
  readonly provider_id: string;
  applicable(context: SyncContext): Promise<ProviderApplicability>;
  inspect(context: SyncContext): Promise<readonly SyncFinding[]>;
  plan(context: SyncContext, finding_ids: readonly string[]): Promise<readonly SyncActionPlan[]>;
  apply(action_plan: SyncActionPlan, confirmation: SyncApplyConfirmation): Promise<SyncActionReceipt>;
  verify(receipt: SyncActionReceipt): Promise<SyncVerification>;
  rollback(action_plan: SyncActionPlan, receipt: SyncActionReceipt): Promise<SyncRollbackReceipt>;
}

export interface SyncProviderRegistry {
  readonly provider_ids: readonly string[];
  get(provider_id: string): SyncActionProvider | undefined;
}

export interface SyncMaintenanceModule {
  inspect(context: SyncContext, provider_ids?: readonly string[]): Promise<SyncPlan>;
  apply(
    plan_id: `sync_plan:${string}`,
    preview_hash: SyncSha256,
    action_ids: readonly string[],
    confirmation: SyncApplyConfirmation
  ): Promise<SyncApplyResult>;
  verify(receipts: readonly SyncActionReceipt[]): Promise<readonly SyncVerification[]>;
}

export type SyncMaintenanceReadResult =
  | { readonly ok: true; readonly source_schema_version: 1; readonly plan: SyncPlan }
  | {
    readonly ok: true;
    readonly source_schema_version: 0;
    readonly readiness: "legacy_read_only";
    readonly legacy: {
      readonly status: SyncHealthStatus;
      readonly input_hash: SyncSha256 | null;
      readonly report_path: null;
      readonly report_sha256: null;
    };
    readonly reason_codes: readonly string[];
  }
  | { readonly ok: false; readonly reason_code: "SYNC_RECORD_INVALID" | "SYNC_RECORD_VERSION_UNSUPPORTED" };
