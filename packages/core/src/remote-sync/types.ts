import type {
  BranchSnapshot,
  BranchSnapshotPage,
  ConflictResolution,
  ContentKind,
  RemoteVersionIdentity,
  SnapshotFile,
  SnapshotFilePage,
  SnapshotVersionPage,
  SyncAction,
  SyncDirection,
  SyncScope
} from "@hunter-harness/contracts";

import type {
  FindingOverride,
  SensitiveFinding
} from "../security/scanner.js";

export type {
  BranchSnapshot,
  BranchSnapshotPage,
  ConflictResolution,
  ContentKind,
  RemoteVersionIdentity,
  SnapshotFile,
  SnapshotFilePage,
  SnapshotVersionPage,
  SyncAction,
  SyncDirection,
  SyncScope
};

export interface SourceRef {
  project_id: string;
  branch_name: string;
  commit_sha: string;
  client_id: string;
  change_key?: string;
}

export interface ContentFile {
  path: string;
  content_kind: ContentKind;
  content_hash: string;
  size: number;
  content: Uint8Array | string;
}

export interface SyncOperation {
  /** Target path. For rename this is always the destination. */
  path: string;
  /** Present and required only when action is rename. */
  source_path?: string | undefined;
  content_kind: ContentKind;
  action: SyncAction;
  local_hash?: string | undefined;
  remote_hash?: string | undefined;
  base_hash?: string | undefined;
}

export interface SyncConflict extends SyncOperation {
  reason_code: "SYNC_CONTENT_CONFLICT" | "SYNC_RENAME_TARGET_CONFLICT";
}

export interface SyncPreview {
  preview_hash: string;
  source_ref: SourceRef;
  base_version: string | null;
  remote_version?: RemoteVersionIdentity | undefined;
  operations: SyncOperation[];
  conflicts: SyncConflict[];
  security_scan: {
    scanner_version: string;
    blocked: boolean;
    hard_blocked: boolean;
    review_required: boolean;
    findings: SensitiveFinding[];
  };
}

export interface ConflictDecision {
  path: string;
  resolution: ConflictResolution;
  expected_preview_hash: string;
  source_artifact_id?: string | undefined;
  source_project_version?: string | undefined;
}

export interface SyncConfirmation {
  preview_hash: string;
  idempotency_key: string;
  conflict_decisions: readonly ConflictDecision[];
  scan_confirmation?: {
    expected_preview_hash: string;
    overrides: readonly FindingOverride[];
  } | undefined;
}

export type SyncReasonCode =
  | "SYNC_LOCK_UNAVAILABLE"
  | "REMOTE_UNAVAILABLE"
  | "REMOTE_PUBLISH_FAILED"
  | "PULL_TRANSACTION_FAILED"
  | "SYNC_CANCELLED";

export interface SyncReceipt {
  preview_hash: string;
  project_version?: string | undefined;
  artifact_id?: string | undefined;
  no_changes: boolean;
  applied: SyncOperation[];
  skipped: SyncOperation[];
  retryable: SyncOperation[];
  reason_code?: SyncReasonCode | undefined;
}

export interface ArchivePackageRef {
  request_id: string;
  /** Stable canonical archive identity produced by the verified package receipt. */
  archive_id: string;
  change_key: string;
  archive_schema_version: number;
  package_sha256: string;
  content: Uint8Array;
}

export interface ArchiveSyncReceipt {
  request_id: string;
  idempotency_key: string;
  project_id: string;
  archive_id: string;
  change_key: string;
  package_sha256: string;
  archive_status: "stored" | "failed";
  project_version: string;
  stored_at: string;
  retryable: boolean;
  reason_code?: "REMOTE_UNAVAILABLE" | "ARCHIVE_PUBLISH_FAILED" | undefined;
}

export interface ArchiveCommit {
  package_ref: ArchivePackageRef;
  source_ref: SourceRef;
  /** Per immutable package request: includes package_sha256. */
  idempotency_key: string;
  /** Logical project/change/schema slot: deliberately excludes package_sha256. */
  logical_slot: string;
}

export interface SyncStatus {
  source_ref: SourceRef;
  last_push?: SyncReceipt | undefined;
  last_pull?: SyncReceipt | undefined;
  last_archive?: ArchiveSyncReceipt | undefined;
}

export interface SyncView {
  revision: string;
  base_version: string | null;
  baseline_files: readonly ContentFile[];
  local_files: readonly ContentFile[];
  remote_files: readonly ContentFile[];
  remote_version?: RemoteVersionIdentity | undefined;
}

export interface PushCommit {
  source_ref: SourceRef;
  expected_revision: string;
  preview_hash: string;
  idempotency_key: string;
  payload_hash: string;
  files: readonly ContentFile[];
  operations: readonly SyncOperation[];
  skipped: readonly SyncOperation[];
}

export interface PullCommit {
  source_ref: SourceRef;
  expected_revision: string;
  preview_hash: string;
  idempotency_key: string;
  payload_hash: string;
  files: readonly ContentFile[];
  baseline_files: readonly ContentFile[];
  operations: readonly SyncOperation[];
  skipped: readonly SyncOperation[];
  project_version?: string | undefined;
  artifact_id?: string | undefined;
}

export interface ProjectRef {
  project_id: string;
}

export interface BranchRef extends ProjectRef {
  branch_name: string;
}

export interface SnapshotRef extends ProjectRef {
  artifact_id: string;
}

export interface RemoteSyncPort {
  withProtocolLock<T>(source_ref: SourceRef, work: () => Promise<T>): Promise<T>;
  readSyncView(source_ref: SourceRef): Promise<SyncView>;
  getIdempotentSyncReceipt(
    source_ref: SourceRef,
    direction: SyncDirection,
    idempotency_key: string,
    payload_hash: string
  ): Promise<SyncReceipt | null>;
  storeIdempotentSyncReceipt(
    source_ref: SourceRef,
    direction: SyncDirection,
    idempotency_key: string,
    payload_hash: string,
    receipt: SyncReceipt
  ): Promise<void>;
  getSyncStatus(source_ref: SourceRef): Promise<SyncStatus>;
  commitPush(command: PushCommit): Promise<SyncReceipt>;
  commitPull(command: PullCommit): Promise<SyncReceipt>;
  commitArchive(command: ArchiveCommit): Promise<ArchiveSyncReceipt>;
  listBranchSnapshots(
    project_ref: ProjectRef,
    cursor: string | undefined,
    limit: number
  ): Promise<BranchSnapshotPage>;
  listSnapshotVersions(
    branch_ref: BranchRef,
    cursor: string | undefined,
    limit: number
  ): Promise<SnapshotVersionPage>;
  listSnapshotFiles(
    snapshot_ref: SnapshotRef,
    cursor: string | undefined,
    limit: number
  ): Promise<SnapshotFilePage>;
  getSnapshotFile(
    snapshot_ref: SnapshotRef,
    path: string
  ): Promise<SnapshotFile | null>;
}

export type SyncOperationValidationResult =
  | { ok: true }
  | {
    ok: false;
    reason_code:
      | "SYNC_RENAME_SOURCE_REQUIRED"
      | "SYNC_OPERATION_SOURCE_PATH_FORBIDDEN"
      | "SYNC_PATH_NOT_ELIGIBLE"
      | "SYNC_CONTENT_KIND_MISMATCH";
  };
