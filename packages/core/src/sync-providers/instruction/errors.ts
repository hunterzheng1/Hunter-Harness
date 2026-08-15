export type InstructionSyncProviderErrorCode =
  | "INSTRUCTION_CONTEXT_IDENTITY_MISMATCH"
  | "INSTRUCTION_SNAPSHOT_INVALID"
  | "INSTRUCTION_APPLY_PLAN_INVALID"
  | "INSTRUCTION_ACTION_STALE"
  | "INSTRUCTION_EXECUTION_RECEIPT_INVALID"
  | "INSTRUCTION_EXECUTION_COMPENSATION_FAILED"
  | "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND";

export interface InstructionExecutionCompensationEvidence {
  readonly transaction_hash: string;
  readonly expected_canonical_hash: string;
  readonly execute_error_name?: string | undefined;
  readonly rollback_error_name?: string | undefined;
  readonly compensation_error_name?: string | undefined;
  readonly rollback_result?: {
    readonly rolled_back: boolean;
    readonly resulting_canonical_hash: string;
  } | undefined;
}

export class InstructionSyncProviderError extends Error {
  readonly code: InstructionSyncProviderErrorCode;
  readonly evidence?: InstructionExecutionCompensationEvidence | undefined;

  constructor(
    code: InstructionSyncProviderErrorCode,
    evidence?: InstructionExecutionCompensationEvidence
  ) {
    super(code);
    this.name = "InstructionSyncProviderError";
    this.code = code;
    if (evidence !== undefined) this.evidence = evidence;
  }
}
