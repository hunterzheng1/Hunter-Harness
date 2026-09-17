# 阶段 17：决策级度量面板

## 依赖与并行边界

依赖阶段 11.4-M5 已落地的 `harness_efficiency.py` 单 change 摘要（run-session 计时、包装层验证计数、失效流转）与其数据源（run_sessions、环境回执、失效回执、评审 findings sidecar）。只读消费，不改任何生产侧脚本。

## 背景与来源

来源：[Harness 流程全面调研与中立评估报告](../research/2026-09-17-harness-flow-review.md) F6（无决策级效率度量）与 §4.2 建议「跨 change 效率度量聚合」，阶段 15「后续登记」中期项。定位是回答「Harness 让我变快了还是变慢了」这类决策问题；不做质量门禁、不分配责任（沿用 11.4-M5「reports facts and does not assign responsibility」基调）。

## 工作包：17-M1 跨 change 度量面板

- Module / Adapter：`harness/scripts/harness_efficiency.py` 新增 `collect_efficiency_panel(changes_root, *, now_iso)` 与 CLI `--changes-root` 面板模式（与 `--change-dir` 互斥）。
- 输入 Interface 及版本：changes 根目录（如 `.harness/changes`）；每 change 经 `resolve_state_dir_for_contract` 容错解析 state 根（split-v1 与 legacy 同口径）。
- 输出 Interface 及版本：面板 JSON `schemaVersion: 1`，四指标块 + 覆盖统计：
  - `cycleTime`：每 change 的 run_sessions 最早开始 → 最晚结束跨度，跨 change 的 `medianMs/minMs/maxMs`；
  - `gateFirstPass`：按 `(change, stage)` 取时间序首条会话，`status=OK` 记首过，输出 `stages/firstPass/rate`；
  - `reviewFindings`：`reports/review/review-findings.json` sidecar（跨轮合并视图）的 `total/perReviewedChange/bySeverity`；
  - `automation`：`managedByHarness=True` 会话占比（`managedRatio`），对照手工包装数。
- 允许修改的路径：`harness/scripts/harness_efficiency.py`、`harness/scripts/tests/test_harness_efficiency.py`。
- 禁止修改的共享区域：run_sessions / findings / ledger 的生产侧写入路径与 schema；单 change 摘要（`build_efficiency_summary`）既有口径与 CLI 行为。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否（纯只读聚合）。
- 兼容与回滚方式：新增可选参数与函数；`--change-dir` 单 change 模式行为零变化。每项指标数据缺失只降级 `available=False + reason`，绝不阻断整体面板；隐藏/工具目录（`.`/`_` 前缀）与畸形 JSON 跳过。
- 聚焦测试：`test_harness_efficiency.py` 的 `EfficiencyPanelTests`（四指标聚合、空根降级、隐藏目录与畸形 findings 跳过、CLI 面板模式与参数互斥）。
- 依赖的 fixture：合成 changes 根（内存临时目录 + 合成 session/findings JSON）。
- 汇合门禁：`python harness/scripts/tests/test_harness_efficiency.py` 全绿。
- 状态：已实施（2026-09-18）。

## 验收条件

- 面板四指标可从真实 changes 根聚合出数；缺数据项降级不阻断。
- 单 change 摘要 CLI 行为与既有测试零回归。

## 非目标

- 不做趋势存储与历史对比（面板是即时只读视图）。
- 不把任何指标接入门禁。
- 不采集新数据源（只用已持久化的 run_sessions、findings sidecar、回执）。
