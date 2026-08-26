/**
 * 给 runCli 注入精简 env 时必须透传恢复根，否则 `resolveRecoveryRoot` 回退到
 * 真实存储（%LOCALAPPDATA%/HunterHarness/recovery），durable 条目无人回收。
 * global-temp setup 已把根指进临时目录，这里只负责向下透传；teardown 的泄漏
 * 守卫负责兜底报警。
 */
export const recoveryEnv: Record<string, string> =
  process.env["HUNTER_HARNESS_RECOVERY_ROOT"] === undefined
    ? {}
    : { HUNTER_HARNESS_RECOVERY_ROOT: process.env["HUNTER_HARNESS_RECOVERY_ROOT"] };
