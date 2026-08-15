import type { SyncApplyFailureEvidence } from "./types.js";

export type SyncMaintenanceErrorCode =
  | "SYNC_CONTEXT_INVALID"
  | "SYNC_PLAN_INVALID"
  | "SYNC_PLAN_NOT_FOUND"
  | "SYNC_PLAN_EXPIRED"
  | "SYNC_PLAN_STALE"
  | "SYNC_ACTION_SELECTION_INVALID"
  | "SYNC_CONFIRMATION_REQUIRED"
  | "SYNC_PROVIDER_RECEIPT_INVALID"
  | "SYNC_VERIFICATION_FAILED"
  | "SYNC_APPLY_FAILED"
  | "SYNC_ROLLBACK_FAILED";

export class SyncMaintenanceError extends Error {
  readonly code: SyncMaintenanceErrorCode;
  readonly retryable: boolean;
  readonly failure_evidence?: SyncApplyFailureEvidence | undefined;

  constructor(
    code: SyncMaintenanceErrorCode,
    retryable = false,
    failure_evidence?: SyncApplyFailureEvidence
  ) {
    super(code);
    this.name = "SyncMaintenanceError";
    this.code = code;
    this.retryable = retryable;
    this.failure_evidence = failure_evidence;
  }
}
