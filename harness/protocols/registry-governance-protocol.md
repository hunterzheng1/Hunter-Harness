# 容器仓库容量与生命周期治理协议

适用于 TCR、GHCR 及其他按标签或版本计数的容器仓库。平台适配器负责读取真实库存和执行受控删除；通用内核只做容量判断、保护集合闭包与 dry-run 计划。

## 构建前容量预检

每次候选构建前必须提供当前版本数、计划新增数、配额和告警比例。若计划后超过配额，返回 `REGISTRY_VERSION_QUOTA_FULL` 并在构建前阻断；达到告警水位返回 `REGISTRY_VERSION_QUOTA_WARNING`。

禁止先构建镜像、再依赖推送失败发现容量不足。

## 保护集合

保护标签至少包含：

- 当前生产与上一生产；
- 冻结候选、回滚窗口内候选；
- release/evidence/TAT/smoke 收据引用的标签或 digest；
- 运维显式 pin。

保护标签解析出的 digest 必须加入保护 digest。共享 digest 被任一保护标签引用时，所有指向该 digest 的标签都进入保护集合，不能仅凭另一个标签较旧就删除。

## 清理计划与执行

1. 先调用 `planRegistryCleanup` 生成 `dryRun=true` 的结构化计划；
2. 候选按创建时间与标签稳定排序，仅删除达到目标水位所需的最小数量；
3. 若保护版本数量已超过目标水位，返回 `PROTECTED_VERSIONS_EXCEED_TARGET`，不扩大删除范围；
4. 平台适配器执行前重新读取库存并核对计划 identity；
5. 执行后重新查询版本数、受保护 digest 和剩余容量，写入最终收据；
6. 通用内核不直接持有平台凭据，也不执行删除 API。

通用容量与计划内核由 `@hunter-harness/core` 的 `assessRegistryCapacity` 和 `planRegistryCleanup` 提供。
