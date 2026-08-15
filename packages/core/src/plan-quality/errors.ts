export class PlanQualityError extends Error {
  readonly code: "PLAN_QUALITY_INPUT_INVALID" | "PLAN_QUALITY_TRUST_INVALID";
  constructor(code: PlanQualityError["code"]) { super(code); this.name = "PlanQualityError"; this.code = code; }
}
