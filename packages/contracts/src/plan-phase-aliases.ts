/**
 * 旧计划阶段名 → 现阶段名（与 harness/scripts/harness_paths.py 的
 * LEGACY_PHASE_ALIASES 互为镜像，两侧各加单测冻结，禁止漂移）。
 *
 * 2026-08 run+test 合并为 execute（方案 c，review 保留独立阶段）。
 * 映射只用于读取历史 gate-policy.json / plannedPhases 等未哈希数据；
 * 已哈希的 receipt 不得先映射再重算。
 */
export const LEGACY_PLAN_PHASE_ALIASES = {
  run: "execute",
  test: "execute"
} as const;

export type LegacyPlanPhaseName = keyof typeof LEGACY_PLAN_PHASE_ALIASES;
