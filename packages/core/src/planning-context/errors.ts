export type PlanningContextErrorCode =
  | "PLANNING_INTENT_INVALID"
  | "PLANNING_KNOWLEDGE_QUERY_INVALID"
  | "PLANNING_KNOWLEDGE_RECEIPT_INVALID"
  | "PLANNING_KNOWLEDGE_ALREADY_COMPRESSED"
  | "PLANNING_EVIDENCE_INVALID"
  | "PLANNING_CONTEXT_INVALID";

export class PlanningContextError extends Error {
  readonly code: PlanningContextErrorCode;
  constructor(code: PlanningContextErrorCode) {
    super(code);
    this.name = "PlanningContextError";
    this.code = code;
  }
}
