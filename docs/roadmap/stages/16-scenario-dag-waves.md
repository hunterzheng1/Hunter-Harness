# 阶段 16：Execute 场景 DAG 波次

## 依赖与并行边界

依赖阶段 11 已冻结的 plan 产物模型（两件套 6 target、`scenario_manifest` 投影）与阶段 15 的执行环增强（`bootstrap-execute` 信封接缝）；消费阶段 01 的字段命名契约（持久化一律 `snake_case`，语言内部命名由 Adapter 显式投影）。

跨层接缝涉及 TS core（`packages/core/src/plan-artifacts/**`）、TS CLI（`packages/cli/src/commands/plan-*.ts`）与 Python（`harness/scripts/harness_plan_finalize.py`、`harness/scripts/harness_context.py`）三处同语义副本，按多语言多层接缝规则同步点查（渲染层/契约层/端口层/脚本层）。

## 背景与来源

来源：[Harness 流程全面调研与中立评估报告](../research/2026-09-17-harness-flow-review.md) F2（Execute 严格串行，无依赖图/波次）与 §4.2 建议「场景级依赖图 + 波次执行」，阶段 15「后续登记」中期项。收益预期受 §2.3-B 修正约束：个人场景下 full 档单 change 内波次并行周期收益有限（评审带宽即瓶颈），主收益场景为 standard 批量任务吞吐——故实际并行调度（16-M2）首试点 standard 档，本阶段先把契约与派生层冻结。

场景级 `depends_on` 与 task 级 `depends_on` 正交：task 管实现顺序（`orderedTasks` 拓扑排序发布产物），场景管验证顺序（execute 侧波次派发输入）。

## 工作包：16-M1 场景依赖契约与拓扑波次派生（advisory）

- Module / Adapter：core `plan-artifacts`（契约与校验）、CLI `plan-evidence-pack`（边界校验与模板）、`plan-publish`（信封透传）、Python finalize（v2 解包与渲染解析）与 context（bootstrap-execute advisory 注入）。
- 输入 Interface 及版本：`TestScenarioInput.depends_on?: readonly string[]`（可选；引用其他 `scenario_id`）；`meta/scenario-manifest.json` v2 `dependsOn` 投影。
- 输出 Interface 及版本：`compute_scenario_waves(scenarios)` 纯函数 → `{available, waveCount, waves, parallelizable, declared}`；`bootstrap-execute` 信封新增 `scenarioWaves` advisory 块。
- 允许修改的路径：`packages/core/src/plan-artifacts/{types,module}.ts`、`packages/core/src/plan-artifacts/publication/module.ts`、`packages/core/test/plan-artifacts-module.test.ts`、`packages/cli/src/commands/plan-evidence-pack.ts`、`packages/cli/src/commands/plan-publish.ts`、`packages/cli/test/plan-publish.e2e.test.ts`、`harness/scripts/harness_plan_finalize.py`、`harness/scripts/harness_context.py` 及对应聚焦测试。
- 禁止修改的共享区域：task 级依赖语义与 `orderedTasks`；ledger/findings/fixback 持久化 schema；波次不实际派发执行。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否（波次纯派生不持久化，同 15-M3 哲学）。
- 兼容与回滚方式：canonical absence——空数组归一为缺省，旧输入重派生逐字节不变；manifest 缺失/畸形/成环时 `scenarioWaves` 只降级 `available=False + reason`，绝不阻断 bootstrap。
- 聚焦测试：core 归一化透传 + 三类拒绝；CLI e2e 透传 manifest/渲染 + 未知引用/自引用/成环拦截（带字段定位）；Python finalize 依赖列解析与波次派生；context 信封注入与降级。
- 依赖的 fixture：既有 plan 发布夹具 + 合成 scenario-manifest。
- 汇合门禁：core 单测、CLI e2e、Python finalize/context 聚焦测试全绿。
- 状态：已实施（2026-09-18）：
  - core：`TestScenarioInput.depends_on` 可选契约；归一化（空数组归一缺省 + 排序去重）；`scenario_manifest` 投影透传；引用校验链拦未知引用/自引用（`PLAN_ARTIFACT_REFERENCE_INVALID`，镜像 task 级既有校验）；DFS 环检测与 task 级同等 fail-closed；渲染文档条件输出「依赖场景」行；`validScenario` 可选键白名单纳入 `depends_on`。
  - CLI：`SCENARIO_OPTIONAL_KEYS` 纳入 `depends_on`；模板 UT-003 示例；`collectInputProblems` 逐条校验（数组型/非空字符串/自引用，逐字段定位）+ 闭包校验（`引用了未声明的场景 X`、`场景依赖成环: A -> B -> A`，确定性 DFS）；归一化排序。`plan-publish` 包装信封把 evidence-pack 失败的 `problems` 提升到顶层（对齐 `recovery_action`/`guidance` 惯例，包装层不吞字段定位）。
  - Python：`_V2_SCENARIO_OPTIONAL_LIST_FIELD_MAP = (("depends_on", "dependsOn"),)` 透传列表字段；`parse_test_scenarios` 支持依赖列（占位符 `-`/`:`/`—`/`·` 过滤）；`compute_scenario_waves` Kahn 分层派生（波次内按 `scenario_id` 排序保确定性，未知引用/成环/空 manifest 降级）；`harness_context._bootstrap_scenario_waves` 注入 `scenarioWaves` advisory（降级透传 unpack 错误码）。

## 后续登记（已立项建议、不在本阶段当前工作包内）

| 建议 | 报告依据 | 定位 |
|---|---|---|
| 16-M2 波次调度器（实际并行派发） | F2、§4.2、§2.3-B | 新组件；worktree-per-wave 或复用轻任务 WI-3.3 write-scope 冲突检测；首试点 standard 档；fast 档可随行 |

## 验收条件

- 16-M1 聚焦测试全绿，且 TS core/CLI 与 Python 既有测试无回归。
- canonical absence 保证旧输入零字节漂移；波次纯派生不持久化。
- advisory 降级路径永不阻断 `bootstrap-execute`。

## 非目标

- 不实现实际并行调度（16-M2 范围）。
- 不改变 task 级依赖与发布拓扑排序语义。
- 不扩展 ledger、findings、fixback 持久化 schema。
- 不让 `scenarioWaves` 成为门禁输入（advisory only）。
