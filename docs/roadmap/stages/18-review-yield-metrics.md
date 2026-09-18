# 阶段 18：评审收益度量


## 依赖与并行边界

依赖阶段 17-M1 的 `collect_efficiency_panel` 面板骨架与其 findings sidecar 读取路径；消费 `harness_review.py` 的 `fixback-dispositions.json`（schemaVersion 1，per-change 最新轮）。只读扩展面板 JSON，不改任何生产侧脚本与 schema。

## 背景与来源

来源：[Harness 流程全面调研与中立评估报告](../research/2026-09-17-harness-flow-review.md) §4.3 建议「[P2] 评审收益度量（各 persona/evaluator 独立发现数、确认率、阻断率），为裁剪冗余角色提供数据。依据：roadmap 10」。

数据现实（设计输入，已核实）：findings schema（`harness_review.py` `validate_findings`）只有 dimension/severity/path/line/title/fixbackAction + 追溯字段，**无 persona/evaluator 归因字段**；`write_findings` 对额外字段透传（`entry = dict(finding)`），归因只需评审产出侧携带 `source` 等字段即自动入统，无需改 schema。因此本阶段按现有数据做 dimension 级聚合，persona/evaluator 级在缺数据时降级输出缺口说明，不虚构。

## 工作包：18-M1 评审收益度量块（reviewYield）

- Module / Adapter：`harness/scripts/harness_efficiency.py` 面板新增第五块 `reviewYield`（`_load_latest_dispositions` / `_review_yield_record` / `_aggregate_review_yield`）。
- 输入 Interface 及版本：同 17-M1 changes 根；每 change 读 `review-findings.json`（schemaVersion 3 跨轮合并视图）+ `fixback-dispositions.json`（schemaVersion 1 最新轮）。
- 输出 Interface 及版本：面板 JSON `schemaVersion: 1`（additive 新增键，既有四块零变化），`reviewYield` 结构：
  - `byDimension`：每维度 `total/blockingCandidates/confirmed/rejected/unresolved/confirmationRate/independent`；
  - `dispositions`：按 findingId join 最新轮处置，`confirmed=FIXED|ACCEPTED_RISK|DEFERRED`、`rejected=NOT_APPLICABLE`、其余计 `unresolved`；`confirmationRate = confirmed/(confirmed+rejected)`（分母只含已裁决，未裁决不罚；分母为 0 输出 null）；`scope: "latest-round"` 标注口径；`unmatchedDispositions` 记处置表指向已不存在 finding 的孤儿条目；
  - `blockingCandidates`：severity ∈ {RED, YELLOW} 的发现数与占比（修复回流协议的待处置口径）；
  - `recurrence`：`firstSeenRunId != lastSeenRunId` 的跨轮复报数（§2.3-D 固化判据的数据基础）与 `carriedOver` 计数；
  - `independentFindings`：同 change 内 `(path, 归一化 title)` 组只被单一维度覆盖的发现数（跨维度同组视为共享发现，启发式去重）；
  - `personaAttribution`：扫描 `source/persona/evaluator/reviewer` 字段；有数据时输出 `attributed/attributedShare/bySource`，无数据时 `available=False + reason`（如实标注 schema 缺口）。
- 允许修改的路径：`harness/scripts/harness_efficiency.py`、`harness/scripts/tests/test_harness_efficiency.py`。
- 禁止修改的共享区域：findings / dispositions / run_sessions 的生产侧写入路径与 schema；既有四指标块口径。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否（纯只读聚合）。
- 兼容与回滚方式：additive 键新增，读取既有键的消费方不受影响；无 findings sidecar 时降级 `available=False + reason`；缺 dispositions 文件时全量计 `unresolved`、`confirmationRate=null`，不视为失败。
- 聚焦测试：`test_harness_efficiency.py` 的 `ReviewYieldTests`（逐维度确认率与阻断候选、跨轮重现与携带、独立/共享发现、persona 归因缺口降级与聚合、缺处置降级、孤儿处置计数）+ 空根降级断言补 `reviewYield`。
- 依赖的 fixture：合成 changes 根（内存临时目录 + 合成 findings/dispositions JSON）。
- 汇合门禁：`python harness/scripts/tests/test_harness_efficiency.py` 全绿。
- 状态：已实施（2026-09-18）。

## 验收条件

- `reviewYield` 块从真实 changes 根聚合出数；缺数据项降级不阻断。
- 既有 17-M1 四块与单 change 摘要 CLI 零回归（EfficiencyPanelTests 原断言未动）。

## 非目标

- 不改评审产出侧 schema（persona/evaluator 归因字段引入是独立后续项；本块已就绪消费）。
- 不做跨轮处置历史追溯（dispositions sidecar 只留最新轮，属数据源限制）。
- 不把任何收益指标接入门禁。
