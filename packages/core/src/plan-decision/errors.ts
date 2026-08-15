export type PlanDecisionErrorCode =
  | "PLAN_DECISION_INPUT_INVALID"
  | "PLAN_DECISION_DEPENDENCY_INVALID"
  | "PLAN_DECISION_APPROVAL_INVALID"
  | "PLAN_DECISION_CANDIDATE_INVALID";

export class PlanDecisionError extends Error {
  readonly code: PlanDecisionErrorCode;
  constructor(code: PlanDecisionErrorCode) {
    super(code);
    this.name = "PlanDecisionError";
    this.code = code;
  }
}
