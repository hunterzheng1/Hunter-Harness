export type PlanArtifactErrorCode = "PLAN_ARTIFACT_INPUT_INVALID" | "PLAN_ARTIFACT_APPROVAL_INVALID" |
  "PLAN_ARTIFACT_REFERENCE_INVALID" | "PLAN_ARTIFACT_COVERAGE_INVALID";

export class PlanArtifactError extends Error {
  readonly code: PlanArtifactErrorCode;
  constructor(code: PlanArtifactErrorCode) {
    super(code);
    this.name = "PlanArtifactError";
    this.code = code;
  }
}
