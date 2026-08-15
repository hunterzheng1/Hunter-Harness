import type { PlanArtifactPublicationPlan } from "../../plan-artifacts/publication/types.js";
import type {
  PlanDurablePublicationBaseline,
  PlanDurablePublicationReceipt,
  PlanDurablePublicationRollbackInput,
  PlanDurablePublicationSha256
} from "../durable-publication/types.js";

export const PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION = 1 as const;
export const PLAN_DURABLE_PUBLICATION_FILESYSTEM_RECORD_KIND =
  "plan_durable_publication_filesystem" as const;
export const PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_KIND =
  "plan_durable_publication_filesystem_authority" as const;
export const PLAN_DURABLE_PUBLICATION_FILESYSTEM_PAYLOAD_COUNT = 8 as const;

export type PlanDurablePublicationFilesystemSha256 = PlanDurablePublicationSha256;

export type PlanDurablePublicationFilesystemJournalState =
  | "prepared"
  | "applying"
  | "committed"
  | "rolled_back"
  | "recovery_required"
  | "unknown";

export type PlanDurablePublicationFilesystemCommitAmbiguity =
  | "not_ambiguous"
  | "unknown"
  | "resolved_committed"
  | "resolved_rolled_back";

export type PlanDurablePublicationFilesystemReadbackState = "pending" | "verified" | "failed";
export type PlanDurablePublicationFilesystemCleanupState =
  | "not_required"
  | "pending"
  | "completed"
  | "best_effort_failed";
export type PlanDurablePublicationFilesystemStagingState =
  | "private"
  | "fsynced"
  | "verified"
  | "orphaned"
  | "cleaned";

export interface PlanDurablePublicationFilesystemBounds {
  readonly max_project_identity_length: 160;
  readonly max_project_id_length: 160;
  readonly max_change_key_length: 160;
  readonly max_operation_id_length: 160;
  readonly max_idempotency_key_length: 160;
  readonly max_root_identity_length: 512;
  readonly max_staging_id_length: 192;
  readonly max_recovery_id_length: 192;
  readonly max_recovery_token_length: 80;
  readonly max_timestamp_length: 64;
  readonly max_payload_bytes: 2_000_000;
  readonly max_total_payload_bytes: 8_000_000;
  readonly max_journal_bytes: 65_536;
  readonly exact_target_count: 8;
}

export const PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS: PlanDurablePublicationFilesystemBounds = Object.freeze({
  max_project_identity_length: 160,
  max_project_id_length: 160,
  max_change_key_length: 160,
  max_operation_id_length: 160,
  max_idempotency_key_length: 160,
  max_root_identity_length: 512,
  max_staging_id_length: 192,
  max_recovery_id_length: 192,
  max_recovery_token_length: 80,
  max_timestamp_length: 64,
  max_payload_bytes: 2_000_000,
  max_total_payload_bytes: 8_000_000,
  max_journal_bytes: 65_536,
  exact_target_count: 8
});

export interface PlanDurablePublicationFilesystemRootIdentity {
  readonly schema_version: 1;
  /** Stable non-path identity of the trusted project root. */
  readonly project_identity: string;
  /** Hash issued by the host for the trusted project root; never an absolute path. */
  readonly project_root_hash: PlanDurablePublicationFilesystemSha256;
}

export interface PlanDurablePublicationFilesystemTargetRootIdentity {
  readonly schema_version: 1;
  readonly change_key: string;
  /** Host-selected relative target-root identity; the contract does not choose its value. */
  readonly target_root: string;
  readonly target_set_hash: PlanDurablePublicationFilesystemSha256;
  readonly ownership_paths: readonly string[];
}

export interface PlanDurablePublicationFilesystemJournalRootIdentity {
  readonly schema_version: 1;
  /** Host-selected relative journal-root identity; the contract does not choose its value. */
  readonly journal_root: string;
  readonly journal_root_hash: PlanDurablePublicationFilesystemSha256;
}

/** Descriptor-only authority supplied by the host; no runtime absolute path is durable. */
export interface PlanDurablePublicationFilesystemHostAuthority {
  readonly schema_version: 1;
  readonly record_kind: typeof PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_KIND;
  readonly root_identity: PlanDurablePublicationFilesystemRootIdentity;
  readonly target_identity: PlanDurablePublicationFilesystemTargetRootIdentity;
  readonly journal_identity: PlanDurablePublicationFilesystemJournalRootIdentity;
}

export type PlanDurablePublicationFilesystemSafetyPolicy = {
  readonly same_volume: "same_volume_required";
  readonly atomic_replace: "atomic_replace_set_required";
  readonly fsync: "file_and_parent_directory_required";
  readonly symlink_policy: "reject_symlink_and_reparse_point";
  readonly target_allowlist: "exact_eight_plan_targets";
};

export const PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY: PlanDurablePublicationFilesystemSafetyPolicy = Object.freeze({
  same_volume: "same_volume_required",
  atomic_replace: "atomic_replace_set_required",
  fsync: "file_and_parent_directory_required",
  symlink_policy: "reject_symlink_and_reparse_point",
  target_allowlist: "exact_eight_plan_targets"
});

export interface PlanDurablePublicationFilesystemStagingIdentity {
  readonly schema_version: 1;
  readonly staging_id: `plan_stage:${string}`;
  readonly staging_root_hash: PlanDurablePublicationFilesystemSha256;
  readonly target_set_hash: PlanDurablePublicationFilesystemSha256;
  readonly state: PlanDurablePublicationFilesystemStagingState;
}

export interface PlanDurablePublicationFilesystemRecoveryIdentity {
  readonly schema_version: 1;
  readonly recovery_id: `plan_recovery_id:${string}`;
  readonly recovery_token: `plan_recovery:${string}`;
}

export interface PlanDurablePublicationFilesystemBinding {
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly plan_hash: PlanDurablePublicationFilesystemSha256;
  readonly expected_baseline: PlanDurablePublicationBaseline;
  readonly new_manifest_hash: PlanDurablePublicationFilesystemSha256;
  readonly ownership_paths: readonly string[];
  readonly expected_payload_hashes: Readonly<Record<string, PlanDurablePublicationFilesystemSha256>>;
  readonly expected_readback_hash: PlanDurablePublicationFilesystemSha256;
}

export interface PlanDurablePublicationFilesystemJournal {
  readonly schema_version: typeof PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION;
  readonly record_kind: typeof PLAN_DURABLE_PUBLICATION_FILESYSTEM_RECORD_KIND;
  readonly authority: PlanDurablePublicationFilesystemHostAuthority;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly binding: PlanDurablePublicationFilesystemBinding;
  readonly staging: PlanDurablePublicationFilesystemStagingIdentity;
  readonly recovery: PlanDurablePublicationFilesystemRecoveryIdentity;
  readonly safety_policy: PlanDurablePublicationFilesystemSafetyPolicy;
  readonly state: PlanDurablePublicationFilesystemJournalState;
  readonly commit_ambiguity: PlanDurablePublicationFilesystemCommitAmbiguity;
  readonly readback: PlanDurablePublicationFilesystemReadbackState;
  readonly cleanup: PlanDurablePublicationFilesystemCleanupState;
  readonly created_at: string;
  readonly updated_at: string;
}

export type PlanDurablePublicationFilesystemRecord = PlanDurablePublicationFilesystemJournal;

export type PlanDurablePublicationFilesystemJournalReadResult =
  | { readonly ok: true; readonly mode: "current"; readonly value: PlanDurablePublicationFilesystemJournal }
  | { readonly ok: true; readonly mode: "legacy_read_only"; readonly source_schema_version: 0 }
  | {
    readonly ok: false;
    readonly reason_code:
      | "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID"
      | "PLAN_DURABLE_PUBLICATION_FILESYSTEM_VERSION_UNSUPPORTED";
  };

export interface PlanDurablePublicationFilesystemPrepareRequest {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly expected_baseline: PlanDurablePublicationBaseline;
  readonly plan: PlanArtifactPublicationPlan;
  readonly authority: PlanDurablePublicationFilesystemHostAuthority;
  readonly recovery_token: `plan_recovery:${string}`;
}

export interface PlanDurablePublicationFilesystemInspectRequest {
  readonly operation_id: string;
  readonly idempotency_key?: string;
}

export interface PlanDurablePublicationFilesystemApplyRequest {
  readonly operation_id: string;
  readonly recovery_token: `plan_recovery:${string}`;
}

export interface PlanDurablePublicationFilesystemRollbackRequest extends PlanDurablePublicationRollbackInput {
  readonly authority: PlanDurablePublicationFilesystemHostAuthority;
  readonly recovery_token: `plan_recovery:${string}`;
  /** Must equal expected_baseline.manifest_hash; protects against a foreign live set. */
  readonly expected_published_manifest_hash: PlanDurablePublicationFilesystemSha256;
}

export interface PlanDurablePublicationFilesystemReadback {
  readonly operation_id: string;
  readonly live_manifest_hash: PlanDurablePublicationFilesystemSha256 | null;
  readonly payload_hashes: Readonly<Partial<Record<string, PlanDurablePublicationFilesystemSha256>>>;
  readonly readback_hash: PlanDurablePublicationFilesystemSha256 | null;
  readonly journal_committed: boolean;
}

export interface PlanDurablePublicationFilesystemTransactionInspection {
  readonly operation_id: string;
  readonly state: PlanDurablePublicationFilesystemJournalState;
  readonly receipt: PlanDurablePublicationReceipt | null;
  readonly recovery_token: `plan_recovery:${string}` | null;
  readonly binding: PlanDurablePublicationFilesystemBinding | null;
}

export interface PlanDurablePublicationFilesystemIdempotencyConflict {
  readonly operation_id: string;
  readonly state: "idempotency_conflict";
  readonly receipt: null;
  readonly recovery_token: null;
  readonly binding: null;
}

export type PlanDurablePublicationFilesystemPortInspection =
  | PlanDurablePublicationFilesystemTransactionInspection
  | PlanDurablePublicationFilesystemIdempotencyConflict;

/** Pure effect seam. A later Adapter supplies the host authority and performs the filesystem effects. */
export interface PlanDurablePublicationFilesystemTransactionPort {
  inspect(input: PlanDurablePublicationFilesystemInspectRequest):
    PlanDurablePublicationFilesystemPortInspection | Promise<PlanDurablePublicationFilesystemPortInspection>;
  prepare(input: PlanDurablePublicationFilesystemPrepareRequest):
    PlanDurablePublicationFilesystemPortInspection | Promise<PlanDurablePublicationFilesystemPortInspection>;
  apply(input: PlanDurablePublicationFilesystemApplyRequest):
    PlanDurablePublicationFilesystemTransactionInspection | Promise<PlanDurablePublicationFilesystemTransactionInspection>;
  recover(input: PlanDurablePublicationFilesystemApplyRequest):
    PlanDurablePublicationFilesystemTransactionInspection | Promise<PlanDurablePublicationFilesystemTransactionInspection>;
  rollback(input: PlanDurablePublicationFilesystemRollbackRequest):
    PlanDurablePublicationFilesystemTransactionInspection | Promise<PlanDurablePublicationFilesystemTransactionInspection>;
  readback(operation_id: string): PlanDurablePublicationFilesystemReadback |
    Promise<PlanDurablePublicationFilesystemReadback>;
}
