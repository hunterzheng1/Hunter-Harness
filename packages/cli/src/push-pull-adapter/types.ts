import type {
  ArchiveOutboxClaim,
  ArchiveRemoteAdapter,
  ArchiveRemotePublishResult,
  ArchiveRetentionPolicy,
  PushPullDecisionInput,
  PushPullDecisionResult,
  PushPullDirection,
  PushPullExecutionReceipt,
  PushPullInteractionInput,
  PushPullOrchestration,
  PushPullPreview,
  SourceRef
} from "@hunter-harness/core";

export type PushPullCliRequest =
  | Readonly<{
    schema_version: 1;
    operation: "preview";
    direction: PushPullDirection;
    interaction: PushPullInteractionInput;
  }>
  | Readonly<{
    schema_version: 1;
    operation: "confirm";
    direction: PushPullDirection;
    preview_hash: string;
    decision: PushPullDecisionInput;
  }>
  | Readonly<{
    schema_version: 1;
    operation: "execute";
    direction: PushPullDirection;
    confirmation_id: string;
  }>
  | Readonly<{
    schema_version: 1;
    operation: "archive_publish";
    claim: ArchiveOutboxClaim;
    source_ref: SourceRef;
    retention_policy: ArchiveRetentionPolicy;
  }>;

export interface PushPullCliRetryMetadata {
  readonly retryable: boolean;
  readonly reason_code: string | null;
}

export type PushPullCliResult =
  | Readonly<{
    schema_version: 1;
    operation: "preview";
    direction: PushPullDirection;
    retry: PushPullCliRetryMetadata;
    result: PushPullPreview;
  }>
  | Readonly<{
    schema_version: 1;
    operation: "confirm";
    direction: PushPullDirection;
    retry: PushPullCliRetryMetadata;
    result: PushPullDecisionResult;
  }>
  | Readonly<{
    schema_version: 1;
    operation: "execute";
    direction: PushPullDirection;
    verification: Readonly<{ status: "verified"; preview_hash: string }>;
    retry: PushPullCliRetryMetadata;
    result: PushPullExecutionReceipt;
  }>
  | Readonly<{
    schema_version: 1;
    operation: "archive_publish";
    retry: PushPullCliRetryMetadata;
    result: ArchiveRemotePublishResult;
  }>;

/** CLI command Adapter seam. Every operation settles asynchronously. */
export interface PushPullCliPort {
  dispatch(request: PushPullCliRequest | unknown): Promise<PushPullCliResult>;
}

export interface PushPullCliDependencies {
  readonly orchestration?: PushPullOrchestration | undefined;
  /** Explicit Archive Push is a separate capability and never enters ordinary preview/execute. */
  readonly archive?: ArchiveRemoteAdapter | undefined;
}
