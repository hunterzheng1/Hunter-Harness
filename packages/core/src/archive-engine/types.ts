export type Sha256 = `sha256:${string}`;

export type ClosureDisposition = "completed" | "abandoned" | "superseded";
export type ArchiveIntent = "release_candidate" | "record_only";
export type ArchiveFailureClassification =
  | "auto_fixable"
  | "user_choice"
  | "release_only"
  | "irrecoverable";
export type ArchivePhaseTerminalStatus =
  | "passed"
  | "warning"
  | "failed"
  | "blocked"
  | "not_run";

export interface ArchivePhaseOutcome {
  readonly phase: string;
  readonly status: ArchivePhaseTerminalStatus;
  readonly evidence_hash?: Sha256 | undefined;
}

export interface ReleaseEvidence {
  git_repository: boolean;
  upstream_configured: boolean;
  source_committed: boolean;
  source_pushed: boolean;
  ci_passed: boolean;
  candidate_verified: boolean;
}

export interface AvailableArchiveEvidence {
  phase_terminals: readonly ArchivePhaseOutcome[];
  release?: ReleaseEvidence | undefined;
  termination_reason_zh?: string | undefined;
  superseded_by?: string | undefined;
}

export interface ClosurePolicy {
  schema_version: 1;
  disposition: ClosureDisposition;
  archive_intent: ArchiveIntent;
  planned_phase_set_ref?: PlannedPhaseSet | undefined;
  available_evidence: AvailableArchiveEvidence;
}

export interface ArchiveChangeRef {
  schema_version: 1;
  change_identity: string;
  archive_schema_version: 1;
  archive_path: string;
  max_archive_bytes?: number | undefined;
}

export interface ArchiveSourceFile {
  path: string;
  content: string | Uint8Array;
}

export interface ArchiveInventoryItem {
  path: string;
  content_hash: Sha256;
  size_bytes: number;
}

export interface ArchiveExcludedItem {
  path: string;
  reason_code:
    | "ARCHIVE_CREDENTIAL_PATH_EXCLUDED"
    | "ARCHIVE_ENV_PATH_EXCLUDED"
    | "ARCHIVE_VCS_PATH_EXCLUDED"
    | "ARCHIVE_RUNTIME_PATH_EXCLUDED";
}

export interface ArchiveBlocker {
  readonly reason_code: ArchiveReasonCode;
  readonly classification: ArchiveFailureClassification;
  readonly message_zh: string;
  readonly phase?: string | undefined;
}

export interface ArchiveExpectedOutput {
  readonly path: string;
  readonly kind: "source" | "summary" | "attestation" | "metadata" | "manifest";
}

export interface ArchivePlan {
  readonly schema_version: 1;
  readonly plan_hash: Sha256;
  readonly operation_id: `archive_operation:${string}`;
  readonly change_identity: string;
  readonly closure_disposition: ClosureDisposition;
  readonly archive_intent: ArchiveIntent;
  readonly archive_schema_version: 1;
  readonly archive_path: string;
  readonly closure_policy_hash: Sha256;
  readonly source_snapshot_hash: Sha256;
  readonly planned_phase_set_ref?: PlannedPhaseSet | undefined;
  readonly phase_outcomes: readonly ArchivePhaseOutcome[];
  readonly included_items: readonly ArchiveInventoryItem[];
  readonly excluded_items: readonly ArchiveExcludedItem[];
  readonly blockers: readonly ArchiveBlocker[];
  readonly warnings: readonly string[];
  readonly expected_outputs: readonly ArchiveExpectedOutput[];
}

export interface LocalArchiveReceipt {
  readonly schema_version: 1;
  readonly operation_id: `archive_operation:${string}`;
  readonly change_identity: string;
  readonly closure_disposition: ClosureDisposition;
  readonly archive_intent: ArchiveIntent;
  readonly source_snapshot_hash: Sha256;
  readonly archive_schema_version: 1;
  readonly archive_path: string;
  readonly archive_manifest_hash: Sha256;
  readonly completed_at: string;
}

export type ArchiveReasonCode =
  | "ARCHIVE_INPUT_INVALID"
  | "ARCHIVE_PATH_INVALID"
  | "ARCHIVE_PLAN_INVALID"
  | "ARCHIVE_PLAN_BLOCKED"
  | "ARCHIVE_PLAN_STALE"
  | "PLANNED_PHASE_SET_REQUIRED"
  | "PLANNED_PHASE_TERMINAL_MISSING"
  | "PLANNED_PHASE_NOT_SUCCESSFUL"
  | "UNPLANNED_PHASE_MUST_BE_NOT_RUN"
  | "UNFINISHED_RELEASE_INTENT_FORBIDDEN"
  | "TERMINATION_REASON_REQUIRED"
  | "SUPERSESSION_REFERENCE_REQUIRED"
  | "RELEASE_GIT_REQUIRED"
  | "RELEASE_UPSTREAM_REQUIRED"
  | "RELEASE_COMMIT_REQUIRED"
  | "RELEASE_PUSH_REQUIRED"
  | "RELEASE_CI_REQUIRED"
  | "RELEASE_CANDIDATE_PROOF_REQUIRED"
  | "ARCHIVE_BUDGET_EXCEEDED"
  | "ARCHIVE_OPERATION_NOT_FOUND"
  | "ARCHIVE_STAGE_INVALID"
  | "ARCHIVE_IMMUTABLE_CONFLICT"
  | "ARCHIVE_LOCAL_FAILURE";

export interface ArchiveOperationSummary {
  operation_id: `archive_operation:${string}`;
  status: ArchiveOperationStatus;
  suggested_action: "none" | "resume" | "inspect";
  reason_code?: ArchiveReasonCode | undefined;
}

export interface ArchiveReconcileResult {
  schema_version: 1;
  change_identity: string;
  status: "not_found" | "prepared" | "recoverable" | "locally_archived" | "conflicted";
  operations: readonly ArchiveOperationSummary[];
}

export type ArchiveOperationStatus =
  | "prepared"
  | "staging"
  | "validating"
  | "published"
  | "receipt_written"
  | "locally_archived"
  | "recoverable"
  | "stale"
  | "failed";

export interface ArchiveOperationRecord {
  operation_id: `archive_operation:${string}`;
  change_identity: string;
  source_snapshot_hash: Sha256;
  archive_schema_version: 1;
  plan: ArchivePlan;
  status: ArchiveOperationStatus;
  owner_id: string;
  lease_expires_at: string;
  quiesced: boolean;
  staged_manifest_hash?: Sha256 | undefined;
  published_manifest_hash?: Sha256 | undefined;
  completed_at?: string | undefined;
  receipt_written: boolean;
  terminal_event_written: boolean;
  reason_code?: ArchiveReasonCode | undefined;
}

export interface ArchiveFilePayload extends ArchiveInventoryItem {
  content: Uint8Array;
}

export interface ArchiveSnapshot {
  change_identity: string;
  files: readonly ArchiveSourceFile[];
}

export interface ArchiveStage {
  operation_id: `archive_operation:${string}`;
  change_identity: string;
  source_snapshot_hash: Sha256;
  archive_path: string;
  archive_manifest_hash: Sha256;
  files: ReadonlyMap<string, Uint8Array>;
}

export interface PublishedArchive {
  operation_id: `archive_operation:${string}`;
  change_identity: string;
  archive_path: string;
  archive_manifest_hash: Sha256;
  files: ReadonlyMap<string, Uint8Array>;
}

export interface ArchiveTerminalEvent {
  schema_version: 1;
  event_type: "archive.locally_archived";
  operation_id: `archive_operation:${string}`;
  change_identity: string;
  archive_manifest_hash: Sha256;
  occurred_at: string;
}

export interface ArchiveLocalPort {
  readChangeSnapshot(change_identity: string): Promise<ArchiveSnapshot>;
  loadOperation(operation_id: string): Promise<ArchiveOperationRecord | undefined>;
  saveOperation(record: ArchiveOperationRecord): Promise<void>;
  listOperations(change_identity: string): Promise<readonly ArchiveOperationRecord[]>;
  isOwnerActive(owner_id: string): Promise<boolean>;
  quiesce(change_identity: string, operation_id: string): Promise<void>;
  writeStage(stage: ArchiveStage): Promise<void>;
  inspectStage(operation_id: string): Promise<ArchiveStage | undefined>;
  publishStage(operation_id: string, archive_path: string): Promise<PublishedArchive>;
  inspectArchive(archive_path: string): Promise<PublishedArchive | undefined>;
  loadReceipt(operation_id: string): Promise<LocalArchiveReceipt | undefined>;
  writeReceipt(receipt: LocalArchiveReceipt): Promise<void>;
  appendTerminalEvent(event: ArchiveTerminalEvent): Promise<void>;
}

export interface ArchiveEngine {
  prepareArchive(change: ArchiveChangeRef, policy: ClosurePolicy): Promise<ArchivePlan>;
  finalizeLocalArchive(plan: ArchivePlan): Promise<LocalArchiveReceipt>;
  resumeArchive(operation_id: string): Promise<LocalArchiveReceipt>;
  reconcileArchive(change_identity: string): Promise<ArchiveReconcileResult>;
}

export type ArchiveRecordReadResult =
  | {
    ok: true;
    source_schema_version: 1;
    readiness: "ready";
    receipt: LocalArchiveReceipt;
  }
  | {
    ok: true;
    source_schema_version: 0;
    readiness: "unavailable";
    legacy: {
      change_identity: string;
      archive_path: string;
      completed_at: string;
    };
    reason_codes: readonly [
      "LEGACY_OPERATION_ID_UNKNOWN",
      "LEGACY_SOURCE_SNAPSHOT_UNKNOWN",
      "LEGACY_CLOSURE_POLICY_UNKNOWN",
      "LEGACY_MANIFEST_IDENTITY_UNKNOWN"
    ];
  }
  | { ok: false; reason_code: "ARCHIVE_RECORD_INVALID" | "ARCHIVE_RECORD_VERSION_UNSUPPORTED" };
import type { PlannedPhaseSet } from "../plan-classification/index.js";
