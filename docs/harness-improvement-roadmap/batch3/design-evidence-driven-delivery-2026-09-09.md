# 批次 3 设计：证据驱动交付 + 批次 2 遗留补测

> 日期：2026-09-09
>
> 状态：**已裁决（2026-09-09）**。§0 四项建议经用户确认全部采纳，
> 快车道（B2-1/2/3/4/6 + B2-5 止血告警 + apiTest 探针）启动实施；
> WI-1/2/3 按本文顺序推进。
>
> 输入：`product-optimization-proposal-2026-09.md` §4.6/§4.7/§10、
> `batch2/pilot-close-2026-09-09.md` §4-6（B2-1~6 + T5 缺口）。
> 代码观察基线：`c3ad44c`（2026-09-09 推送后 main）。

## 0. 待裁决项（实施前需用户定稿）

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | B2-5（tier/mode 双轨）修复深度：仅加告警 vs 信号表对齐+单一权威 | **分两步：先告警（批次 3 内），对齐列为独立工作项** | 告警是零风险止血（半天级）；信号表对齐动 Python classify 与 CLI classifyPlan 两处 + 契约测试，需要独立设计（见 WI-1） |
| 2 | T5 补测时机：B2-5 对齐前 vs 后 | **对齐后，apiTest 探针前置到快车道** | 对齐前补测的门槛判定与审计轨迹走双轨（tier=full/mode=assurance 并存），大概率需对齐后重跑确认——双倍试点成本；且 full 档阶段集推导经过 requiredRetained 静默覆盖路径（T6' 实证的 B2-5 bug 行为），测的不是最终形态。对齐后唯一实质代价是 apiTest 缺口发现晚，该代价用快车道探针（见 §2 快车道末项）以 ~1/10 成本捕获。周期串行是用代表性换的 |
| 3 | 批次 3 原定范围（风险要求、局部失效、任务依赖与增量评审）是否全量进 | **按提案原范围推进，B2 系列修复作为前置快车道** | B2-1~6 是批次 2 试点直接产出的小修复，混入批次 3 主体会模糊交付物边界；快车道先行合入 |
| 4 | B2-2（publish 丢 review）修复方向：publish 内透传 vs 文档明确直连 | **publish 内透传** | `--renew-review` 已有续签机制，缺的只是「input 无 adversarial_review 但磁盘 pack 有」的检测分支；文档直连是放弃编排收口，与 HP-18 目标相悖 |

**裁决记录**：2026-09-09 用户确认四项建议值（①B2-5 分两步：止血告警进快车道，对齐为 WI-1；②T5 在 WI-1 后补测，apiTest 探针前置到快车道；③批次 3 按提案原范围推进，B2 系列修复作为前置快车道；④B2-2 走 publish 内透传）。快车道自本记录起实施。

## 1. 背景与输入

### 1.1 批次 2 收尾试点结论（已关闭）

四门槛达成（手工修元数据 0 次、流程维护 0.59-0.87 min、质量零回退、
恢复演练通过）；B2-1~6 为新发现改进候选（无阻断）；T5（full 档完整流程）
未覆盖。

### 1.2 批次 3 原定交付物（提案 §10）

「证据驱动交付：风险要求、局部失效、任务依赖与增量评审——
无错误证据复用、并行组合验收通过」。

对应提案 §4.6（验证三层 + 证据复用五要素 + 受影响测试选择）与
§4.7（评审与返工：按风险安排检查、返工只失效受影响项）。

### 1.3 B2 系列遗留（批次 2 试点产出）

| # | 发现 | 严重度 | 修复量估计 |
|---|---|---|---|
| B2-1 | record-from-receipt 不支持 --scenario-ids | 中（场景绑定被迫二次 record） | 小：参数透传，cmd_record 已支持 |
| B2-2 | plan publish 重建 pack 丢 adversarial_review | 中（assurance 计划编排收口失效） | 小：publish 加检测分支 + 续签 |
| B2-3 | exec 300s 默认超时不足 + 嵌套 runner 锁冲突 | 低（文档补充即可） | 极小：testing-reference.md |
| B2-4 | 归档 unpushed-commits 缺 unset-upstream 提示 | 低 | 极小：recoveryAction 文案 |
| B2-5 | tier/mode 双轨不一致（configure 被静默覆盖） | **高**（结构性） | 大：见 WI-1 |
| B2-6 | review sidecar runId 校验滞后 + recoveryAction 不带 currentRunId | 中（恢复路径被迫读原文） | 小：write-findings 自动取当前 run |

## 2. 工作项

### 快车道：B2 小修复（B2-1/2/3/4/6，预计一个提交簇）

**B2-1**：`record-from-receipt` 加 `--scenario-ids`/`--scenario-receipt-file`
参数透传到内部 `cmd_record` 调用（harness_ledger.py:3297 的
`scenario_ids=None` 改为 `getattr(args, ...)`）。单测：收据路径 +
场景绑定一次完成；schemaVersion 2 manifest 时 receipt 强制校验不变。

**B2-2**：`plan publish` 在 evidence-pack 步骤后检测「input 无
adversarial_review 但重建前磁盘 pack 有」→ 自动走 review-record --renew
续签（findings 未变时）或报 PLAN_REVIEW_BINDING_FAILED 带明确
recoveryAction。单测：重建保留收据路径 + findings 变化时的失败路径。

**B2-3**：testing-reference.md 补两条：全量套件 exec 需
`--timeout-seconds 900`（默认 300s 不够）；exec 内直接
`python -m unittest discover`，禁止嵌套 harness_test_runner.py
unittest（项目测试锁冲突）。

**B2-4**：archive unpushed-commits 阻断的 recoveryAction 补
`git branch --unset-upstream`（本地试点/无推送意图场景的文档化出路）。

**B2-6**：`harness_review.py write-findings` 缺 runId 时自动取当前
review run（从 events 或 gate 状态读）；`REVIEW_OUTPUTS_INVALID` 错误
信封带 currentRunId。单测：缺 runId 自动回填 + 错误信封字段。

**apiTest NOT_APPLICABLE 探针**（T5 前置，裁决 2 的配套项）：在任意
scratch change 上验证 `harness_ledger.py record --verification apiTest
--applicability NOT_APPLICABLE --applicability-reason "<scope 原因>"`
路径存在且 gate close 接受该记账（不要求真实 API 执行）。这是 T5 补测
要回答的问题中最独立于档位权威的一个——5 分钟探针替代整轮试点才能
拿到的早发现价值。若路径缺失，记录为 B3-1 进待办池，不现场发明机制。

**探针结果（2026-09-10，B3-1 已立项）**：路径半存在。
① record 侧完整：`--applicability NOT_APPLICABLE` 被接受，落盘条目
带嵌套 `applicability: {applicability, reason}` 且 v2 必填字段齐全
（inputsHash/coverage/algorithmVersion 等）。
② gate close 侧不认：`validate_ledger_entry_v2`
（harness_gate.py:688）对 NOT_RUN 条目只认 evidence 以 `DEGRADED:`
开头的降级路径，**完全不读 applicability 字段**——NOT_APPLICABLE
记账在 phase_status=OK 下被 `VALIDATION_NOT_OK` 挡住（scratch 探针
实证：missing 含 "status=NOT_RUN requires evidence starting with
'DEGRADED: <reason>'"）。
**B3-1（待办池）**：gate close 的 ledger 校验把 `applicability:
NOT_APPLICABLE`（带 reason）纳入合法的关门形态——语义上 NOT_APPLICABLE
比 DEGRADED 更强（声明验证不适用 vs 承认没跑），不应被迫伪装成降级。
设计时需与 WI-1 的档位权威联动（apiTest 是否 required 由 tier 决定）。
T5 补测时 apiTest 记账走 `DEGRADED: <reason>` 或真实执行，不依赖 B3-1。

### WI-1：tier/mode 单一权威（B2-5 结构性修复）

> **状态：已完成（2026-09-10）**。独立设计文档
> `design-wi1-tier-mode-single-authority-2026-09-10.md`（含四项裁决记录），
> 六步实施全部合入 main：①risk-signals.json 共享契约（a193123）②Python
> 加载器 + fail-closed 回退（bbdf1d0）③sync 生成 TS 常量（a34a7fa）④
> evidence-pack mode→tier 派生写回 + 工作副本同步（6eff029）⑤tier-mode-parity
> 跨语言契约测试（c07eebd）⑥文档更新（本提交）。已知语义差异冻结在契约
> 测试：docs-only Python 不降档 / contract-schema 仅 Python 侧。stopgap
> 告警保留（移除条件：WI-2 验证 full 档完整流程后）。

**现状**：Python `harness_gate.py classify`（tier: fast/standard/full，
marker 表 full_markers）与 CLI `classifyPlan`（mode: quick/standard/assurance，
ASSURANCE_SIGNALS）是两套独立裁决，信号表已对齐（risk-signal-inference.ts
注释明说移植自 harness_gate.py:1468-1476），但**裁决结果不互通**：
- gate-policy.json 记 tier（standard），stageDecisions.review.required=false
- plan-profile.json 记 mode（assurance），required_phases 含 review
- evidence-pack 的 requiredRetained 静默覆盖 configure-plan 的阶段省略

**设计方向**（需独立设计文档，本节只定边界）：
1. 单一裁决点：evidence-pack 构建时由 CLI profile mode 推导 tier 并写回
   gate-policy（或反向——Python classify 读 plan-profile）；两处 marker 表
   合并为共享数据文件（JSON 契约，双端加载），消除移植漂移面。
2. requiredRetained 非空时 evidence-pack 输出显式 warning
   （「configure-plan 省略的 review 因 assurance 信号被保留」）——
   这是止血项，快车道可先行。
3. 契约测试：同一 affected_paths + git status 输入下，Python classify 与
   CLI classifyPlan 的信号集、档位、required_phases 三元组一致。

**边界**：不改变信号语义（delete 仍是 assurance 信号——marker 表内容
冻结）；只消除双轨。历史 change 的 gate-policy 不回写（读时兼容）。

### WI-2：T5 补测（full 档完整流程）

> **状态：已完成（2026-09-10）**。任务定义
> `tasks/T5-workflow-policy-review-cadence.md`（workflow-policy riskTiers
> reviewCadence 字段演进，shared-state marker 双端命中），采集报告
> `collected/t5-full-tier-2026-09-10.md`。五门槛全部达成：流程维护 0.51 min
> （对照 T4' 0.87 min）；apiTest DEGRADED 记账路径可用；WI-1 单一权威在
> full 档真实计划上端到端验证（tier_source=mode-derived:assurance）。
> 新发现 **B3-2（高）**：full 档阶段集权威链断裂（v2 快照缺 gate 字段 →
> 回退 standard 工作副本 → review 被跳过），与 B3-1/B3-3 同属「full 档
> 阶段与验证的权威链」设计主题。B2-5 stopgap 告警建议保留至 B3-2 修复。

**前置**：WI-1 完成（full 档声明有单一权威后补测才对最终形态有效）。

**任务定义**（沿 batch0 T5 模板改写）：
- 任务：真实 schema/契约变更（如 build-profile.json verificationGraph
  或 workflow-policy.json riskTiers 的字段演进），plan 文档显式
  `风险等级: full`（或对齐后的等价声明方式）。
- 完整流程：plan → execute → review → submit → archive 五阶段
  （full 档 defaultPhases）。
- 验证集：compile/unitTest/unitTestFull/apiTest 四项（apiTest 首次在
  完整流程实测——NOT_APPLICABLE 记账路径已由快车道探针先行验证，
  T5 运行验证其在 full 档 gate close 下的实际接受度）。
- 测量点：full 档流程维护（对照 T4' 0.87 min——预期 review+submit
  仪式增加 ~0.5-1 min）；review 阶段全套仪式成本（T6' 已有部分数据）；
  post-run classify 升档路径（CONTRACT_SCHEMA_PATHS 命中时）。

**门槛**：沿用批次 2 四门槛 + full 档特有：apiTest 记账路径明确
（真实执行或 NOT_APPLICABLE 带理由，不允许跳过不记）。

### WI-3：批次 3 主体（证据驱动交付，提案原范围）

按提案 §4.6/§4.7 展开，本设计文档只列框架，实施前各子项独立设计：

1. **局部失效**：返工/fixback 只失效受影响的验证与评审结论
   （现有 invalidation 机制扩展到 review sidecars）。
   > **状态：设计待裁决（2026-09-12）**。独立设计文档
   > `design-wi3-1-partial-invalidation-2026-09-12.md`（含五项待裁决项）。
   > 勘察结论：验证证据侧局部失效已存在（fixback 条目级），本项主体是
   > 评审侧 finding 级携带 + disposition 跨轮继承。
2. **证据复用**：P14 决策维持不接入（can-reuse 封存）；本项只做
   「跨 change 的同类验证证据导入」（宿主 CI 证据导入路径，提案 §4.6）。
3. **任务依赖**：并行写入的文件范围冲突检测（提案 §4.4）。
4. **增量评审**：review 输入从「整个 diff」收敛到「本次变更 + 受影响
   上下文」（提案 §4.7）。

**边界**：不提前删除现有门禁（提案 §10 批次 3 行）；每项先出
设计再实施。

## 3. 实施顺序

```
快车道（B2-1/2/3/4/6 + B2-5 止血告警 + apiTest 探针）──┐
                                                          ├── WI-1（tier/mode 单一权威）
                                                          │        │
                                                          │        └── WI-2（T5 补测）
                                                          └── WI-3（批次 3 主体，独立设计）
```

- 快车道先行合入（小修复 + 止血，不阻塞任何项）。
- WI-1 与 WI-3 可并行（不同模块：CLI/契约 vs 验证/评审运行时）。
- WI-2 严格在 WI-1 后。

## 4. 试点门槛

| 门槛 | 目标 | 口径 |
|---|---|---|
| B2 修复验证 | 每项修复带单测 + 试点 clone 复现原场景通过 | 沿 P9 双验证惯例 |
| T5 补测 | 批次 2 四门槛 + apiTest 记账路径明确 | full 档完整流程 |
| WI-1 | 双端契约测试三元组一致 + 试点 clone 无静默覆盖 | tier/mode/required_phases |
| WI-3 | 各子项独立设计时定 | — |

## 5. 风险与回退

| 风险 | 缓解 |
|---|---|
| WI-1 信号表合并引入双端行为漂移 | 共享 JSON + 契约测试先行；历史 change 读时兼容不回写 |
| T5 补测发现 apiTest 路径缺失 | 早发现已由快车道探针捕获（缺失则记 B3-1）；T5 运行中再发现属探针未覆盖的交互问题，发现即记录为 B3 系列，不现场发明机制 |
| 快车道与 WI-1 止血项重复 | 止血告警代码标注 `// B2-5 stopgap: WI-1 落地后移除` |
| 批次 3 主体范围膨胀 | WI-3 每子项独立设计文档 + 用户裁决后才实施 |
