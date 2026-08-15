export type CodebaseMapSyncProviderErrorCode =
  | "MAP_CONTEXT_IDENTITY_MISMATCH"
  | "MAP_PUBLICATION_PLAN_INVALID"
  | "MAP_ACTION_STALE"
  | "MAP_EXECUTION_RECEIPT_INVALID"
  | "MAP_EXECUTION_COMPENSATION_FAILED"
  | "MAP_EXECUTION_RECEIPT_NOT_FOUND";

export interface MapExecutionCompensationEvidence {
  readonly operation_id: string;
  readonly expected_manifest_hash: string;
  readonly compensation_error_name?: string | undefined;
  readonly rollback_result?: {
    readonly rolled_back: boolean;
    readonly resulting_manifest_hash?: string | undefined;
  } | undefined;
}

export class CodebaseMapSyncProviderError extends Error {
  readonly code: CodebaseMapSyncProviderErrorCode;
  readonly evidence?: MapExecutionCompensationEvidence | undefined;

  constructor(
    code: CodebaseMapSyncProviderErrorCode,
    evidence?: MapExecutionCompensationEvidence
  ) {
    super(code);
    this.name = "CodebaseMapSyncProviderError";
    this.code = code;
    if (evidence !== undefined) this.evidence = evidence;
  }
}
