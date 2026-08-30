/**
 * HP-08：Plan 命令统一结构化错误信封。
 * 兼容约束：顶层 `code` 保留到消费方完成迁移；stage/reason_code/field_path
 * 为附加定位字段。默认不含 stack/敏感值；retryable 显式给出。
 */

export type PlanErrorStage = "boundary" | "intent" | "decision" | "artifacts" | "layer1" | "layer2" | "layer3" | "finalize";

export interface PlanErrorEnvelope {
  readonly ok: false;
  readonly code: string;
  readonly stage: PlanErrorStage;
  readonly reason_code: string;
  readonly field_path?: string;
  readonly findings?: readonly unknown[];
  readonly retryable: boolean;
  readonly message?: string;
  readonly [key: string]: unknown;
}

const STAGE_BY_PREFIX: readonly [RegExp, PlanErrorStage][] = [
  [/^PLAN_(RUN_ID|TIME|SCOPE)_/u, "boundary"],
  [/^PLAN_REVIEW_/u, "layer3"],
  [/^PLANNING_/u, "intent"],
  [/^PLAN_DECISION_/u, "decision"],
  [/^PLAN_ARTIFACT_/u, "artifacts"],
  [/^PLAN_FINALIZE_DETERMINISTIC/u, "layer1"],
  [/^PLAN_FINALIZATION_/u, "finalize"],
  [/^PLAN_QUALITY_/u, "layer3"]
];

/** 按稳定码前缀推导阶段；catch 块里应用 reason_code（core 码）而不是信封码推导。 */
export function planStageForCode(code: string): PlanErrorStage {
  return STAGE_BY_PREFIX.find(([pattern]) => pattern.test(code))?.[1] ?? "finalize";
}

export function planErrorEnvelope(input: {
  readonly code: string;
  readonly reason_code?: string;
  readonly field_path?: string;
  readonly findings?: readonly unknown[];
  readonly retryable?: boolean;
  readonly message?: string;
  readonly stage?: PlanErrorStage;
  readonly extra?: Readonly<Record<string, unknown>>;
}): PlanErrorEnvelope {
  const stage = input.stage ?? planStageForCode(input.code);
  return Object.freeze({
    ok: false as const,
    code: input.code,
    stage,
    reason_code: input.reason_code ?? input.code,
    ...(input.field_path === undefined ? {} : { field_path: input.field_path }),
    ...(input.findings === undefined ? {} : { findings: input.findings }),
    retryable: input.retryable ?? false,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.extra ?? {})
  });
}

export function emitPlanError(
  stdout: (chunk: string) => void,
  envelope: PlanErrorEnvelope
): 1 {
  stdout(`${JSON.stringify(envelope)}\n`);
  return 1;
}
