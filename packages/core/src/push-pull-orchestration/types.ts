import type { FindingOverride } from "../security/scanner.js";
import type {
  ConflictResolution,
  RemoteSyncModule,
  SourceRef,
  SyncConflict,
  SyncOperation,
  SyncPreview,
  SyncReceipt,
  SyncScope
} from "../remote-sync/index.js";

export type PushPullDirection = "push" | "pull";
export type PushPullSourceMode = "current" | "explicit";
export type UserSyncScope = SyncScope | "all";

export interface PushPullInteractionInput {
  schema_version: 1;
  source_ref: SourceRef;
  source_mode: PushPullSourceMode;
  scopes?: readonly UserSyncScope[] | undefined;
}

export interface NormalizedPushPullRequest extends PushPullInteractionInput {
  direction: PushPullDirection;
  scopes: readonly UserSyncScope[];
}

export interface PushPullDisplay {
  heading: string;
  summary: string;
  detail_lines: readonly string[];
}

export type PushPullPreviewOutcome =
  | "ready"
  | "no_changes"
  | "needs_resolution"
  | "sensitive_confirmation_required";

export interface PushPullPreview {
  schema_version: 1;
  direction: PushPullDirection;
  preview_hash: string;
  source_ref: SourceRef;
  scopes: readonly Exclude<SyncScope, "archive">[];
  outcome: PushPullPreviewOutcome;
  base_version: string | null;
  remote_version: SyncPreview["remote_version"];
  operations: readonly SyncOperation[];
  conflicts: readonly SyncConflict[];
  security_scan: SyncPreview["security_scan"];
  display_zh: PushPullDisplay;
}

export interface PushPullConflictChoice {
  path: string;
  resolution: Exclude<ConflictResolution, "cancel">;
  source_artifact_id?: string | undefined;
  source_project_version?: string | undefined;
}

export interface PushPullDecisionInput {
  action: "continue" | "review" | "stop";
  idempotency_key: string;
  conflict_decisions: readonly PushPullConflictChoice[];
  scan_overrides?: readonly FindingOverride[] | undefined;
}

export type PushPullDecisionResult =
  | {
    schema_version: 1;
    status: "confirmed";
    direction: PushPullDirection;
    preview_hash: string;
    confirmation_id: string;
    display_zh: PushPullDisplay;
  }
  | {
    schema_version: 1;
    status: "no_changes" | "review_required" | "cancelled";
    direction: PushPullDirection;
    preview_hash: string;
    display_zh: PushPullDisplay;
  };

export interface PushPullExecutionReceipt {
  schema_version: 1;
  direction: PushPullDirection;
  preview_hash: string;
  status: "completed" | "no_changes" | "cancelled" | "retryable";
  sync_receipt: SyncReceipt;
  display_zh: PushPullDisplay;
}

export type NormalizePushPullResult =
  | {
    ok: true;
    source_schema_version: 0 | 1;
    request: NormalizedPushPullRequest;
  }
  | {
    ok: false;
    reason_code: "PUSH_PULL_COMPAT_INVALID";
  };

export interface PushPullOrchestration {
  buildPushPreview(input: PushPullInteractionInput): Promise<PushPullPreview>;
  confirmPush(preview_hash: string, decision: PushPullDecisionInput): PushPullDecisionResult;
  executePush(confirmation_id: string): Promise<PushPullExecutionReceipt>;
  buildPullPreview(input: PushPullInteractionInput): Promise<PushPullPreview>;
  resolvePull(preview_hash: string, decision: PushPullDecisionInput): PushPullDecisionResult;
  executePull(confirmation_id: string): Promise<PushPullExecutionReceipt>;
}

export type RemoteSyncDependency = Pick<
  RemoteSyncModule,
  "previewPush" | "push" | "previewPull" | "pull"
>;
