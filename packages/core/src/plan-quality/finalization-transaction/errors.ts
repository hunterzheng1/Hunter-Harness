export type PlanFinalizationTransactionErrorCode =
  | "PLAN_FINALIZATION_INPUT_INVALID"
  | "PLAN_FINALIZATION_IDENTITY_INVALID"
  | "PLAN_FINALIZATION_LEGACY_READ_ONLY"
  | "PLAN_FINALIZATION_QUALITY_INVALID"
  | "PLAN_FINALIZATION_RENDER_INVALID"
  | "PLAN_FINALIZATION_PORT_INVALID"
  | "PLAN_FINALIZATION_FILESYSTEM_INVALID"
  | "PLAN_FINALIZATION_RECORD_INVALID"
  | "PLAN_FINALIZATION_PUBLICATION_INVALID"
  | "PLAN_FINALIZATION_OUTBOX_INVALID";

export class PlanFinalizationTransactionError extends Error {
  readonly code: PlanFinalizationTransactionErrorCode;

  constructor(code: PlanFinalizationTransactionErrorCode) {
    super(code);
    this.name = "PlanFinalizationTransactionError";
    this.code = code;
  }
}
