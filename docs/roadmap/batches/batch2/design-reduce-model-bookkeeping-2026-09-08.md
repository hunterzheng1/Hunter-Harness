# 批次 2 设计：减少模型记账（完整流程侧）

> 日期：2026-09-08
>
> 状态：**已实施并收尾（2026-09-09）**。本文是提案 §10 批次 2 行的展开与裁决记录。
> 四门槛达成，试点关闭记录见 `pilot-close-2026-09-09.md`；
> 新发现 B2-1~6 已转批次 3 快车道处理（见
> `../batch3/design-evidence-driven-delivery-2026-09-09.md` §1.3/§2）。
>
> 输入：`product-optimization-proposal-2026-09.md` §6/§10/§10.1、
> `batch0/pilot-g3-2026-09-07.md` §7-8（批次 0-1 学习结果）。
> 代码观察基线：`a336d44`（2026-09-08 推送后 main）。

## 0. 裁决记录（2026-09-08，用户授权按讨论稿建议定稿）

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| 1 | WI-1 形态：`exec --record` 一步 vs 收据+消费分层 | **收据+消费分层** | 收据可独立审计（对账「记录的命令确实执行过」）、runner 不依赖 ledger 模块、故障路径可重放。现有 `_write_exec_runtime_receipt`（harness_test_runner.py:1089）是进程管理收据（argvHash/returncode/timedOut），不含 duration/evidence/files——新增 exec 结果收据，不复用不合并 |
| 2 | bootstrap-execute 落点 | **`harness_context.py`** | 与 bootstrap-plan 同家族、同模块；放 harness_task.py 会模糊轻/重入口边界，违背 §10.1 迁移精神 |
| 3 | 测试报告派生（不对称 E） | **进批次 2** | 数据源同为 ledger+events，属「证据直接采集」的自然延伸；推到批次 4 会二次改同一消费端 |
| 4 | plan-evidence-input 瘦身 | **只做「字段可省略+自动推导」** | 不动 v2 契约结构（schemaVersion、八 target、哈希绑定不变）；可省略字段由命令推导并回显，降低仪式成本而不引入契约回归面 |
| 5 | 流程维护门槛 | **完整流程 standard 任务 ≤1.1 min（-50%）** | 沿用方法学 §4 口径作最低门槛；批次 1 轻任务 -93% 不构成完整流程的合理预期（含审批交互与真实编码），门槛是下限不是目标值，实测值照报 |

## 1. 背景与设计输入（批次 0-1 学习 → 批次 2 约束）

| 学习（pilot-g3 §7-8） | 对本设计的约束 |
|---|---|
| 轻任务架构验证通过：流程维护 -93%+、契约学习清零、质量零回退 | 不发明新机制——推广已验证模式：脚本持有记账、错误信封带 field_path+recoveryAction、幂等重跑复用 runId |
| P1/P5/P6 变更感知验证选择已在 `harness_task.py finish` 落地 | 验证计划推导逻辑可复用（profile-input 展开、docs-only→doc contract、同 argv 去重），不重写 |
| P9：重入时验证副作用文件被误判 foreign | 新引导/采集命令必须处理 ownership 重建，不重蹈通道误判 |
| P12/P13 已修（CONTRACT_SCHEMA_PATHS、--tier floor、tier 措辞） | 档位裁决无需模型补记；status 视图需暴露档位来源（声明 floor vs classify 裁决） |
| P14 决策-不接入 can-reuse | 统一操作不加复用检查；`decide_can_reuse`（harness_ledger.py:2037）保持封存 |
| T6：中断面集中在验证执行中（分钟级） | 恢复视图必须能表达「验证执行中被中断」——ledger 收据 + status 是对应工具 |

## 2. 记账不对称盘点（现状，基线 a336d44）

轻任务入口（/harness-task）已消除：仪式写作（--goal/--acceptance 参数化）、
ledger 手工 record（finish 内部执行+记账一体）、gate 编排（begin/finish 收口）、
手工测试报告（finish summary 生成）。

完整流程（/harness-plan → /harness-execute → /harness-archive）残留：

| # | 手工记账点 | 位置 | 频率/成本 | 轻任务对应物 |
|---|---|---|---|---|
| A | 每次构建/测试后手写 `harness_ledger.py record`（8 字段：command/exit-code/duration-ms/evidence/coverage/files/profile-input…） | execute 步骤 2；testing-reference.md:748-749 | 最高频；字段错→关门检查失败一轮 | finish 自动记 |
| B | 手写 `plan-evidence-input.json`（模板+推断已减负，任务/场景/ownership 仍模型手填） | plan 阶段 5-6 | 单次成本最高 | --goal/--acceptance 参数化 |
| C | execute 入口三连命令（context prepare → context begin → gate begin），参数各自必填 | execute 步骤 0 | 每阶段 1 次；漏参=白跑一轮（F 系列教训） | begin 一条命令 |
| D | 知识查询结果手工落事件（`events.py append --type command --note count=<n>`） | plan 阶段 1 | 低成本纯记账 | 无对应（轻任务不查知识） |
| E | 手写测试报告 `test-report-YYYYMMDD-HHmm.md` | execute Output Format | 中；数据全部可从 ledger 派生 | finish summary 自动生成 |
| F | 无统一恢复视图：故障后法证式读 gate-policy/events/ledger/state-snapshot 双层目录 | 全流程故障路径 | 成本集中在故障路径——正是完成证据指向处 | `harness_task.py status` |

已自动化（无需重做）：bootstrap-plan 复用 runId、plan publish 自动记
baseline/attempt、gate close 自动派生 to-phase + 租约自动重取、
archive execute 一条命令收口。

## 3. 工作项（四项 ↔ 提案交付物）

### WI-1 证据直接采集（交付物 4）——消不对称 A

**现状**：模型经 `harness_test_runner.py exec` 跑命令，再手工拼
`harness_ledger.py record` 8 字段。字段是执行结果的转录——纯记账。

**设计**：
1. `harness_test_runner.py exec` 新增 `--result-receipt <path>`：执行结束后
   原子写结果收据（schemaVersion 1）：command argv、exit code、timedOut、
   duration_ms、stdout/stdtail 摘要（截断上限，如 4 KiB）、进程树隔离标记、
   执行时间戳。与既有 runtime receipt（进程管理用途）并存，用途不同不合并。
2. `harness_ledger.py record-from-receipt --receipt <path> --change-dir <dir>
   --verification <kind> [--profile-input <key>] [--project .]`：读收据推导
   ledger 条目——status 由 exit code/timedOut 推导、duration/evidence 摘要
   直接收录、files/scope/coverage 经 `expand_profile_input_files`
   （harness_ledger.py:945）与 `ensure_profile_input_target`（:1003）从
   build-profile 推导，与 `harness_task.py finish` 同一推导路径。
3. 模型操作从「跑测试 + 手拼 8 字段」变为「跑测试（带 --result-receipt）+
   record-from-receipt（2 参数）」。

**边界**：
- 收据只增不改 ledger 语义；record-from-receipt 校验失败（收据损坏/缺
  verification 语义）时回退手工 record——旧路保留为故障出口，不删。
- 收据文件落 change 目录 `evidence/receipts/`（随归档 manifest 覆盖），
  不落项目根。
- 口述通过仍被拒绝：无收据的 record-from-receipt 不存在，手工 record
  仍是受控例外（SKILL 明示）。

### WI-2 统一任务操作（交付物 1）——消不对称 C + D

**设计**：
1. `harness_context.py bootstrap-execute --project . --change <cn>
   --executor <tool> --json`：与 bootstrap-plan 同家族，一条命令完成
   prepare → context begin（交接校验）→ gate begin（含测试基线 guard）。
   幂等：重跑复用同一 runId、不重复 phase.start（与 bootstrap-plan 同
   语义）；返回紧凑摘要（runId/attempt/tier/租约 TTL/测试基线状态）。
   execute SKILL 步骤 0 的三连命令与 0.5b 分解链保留为排障出口。
2. 知识查询事件（不对称 D）：`npx hunter-harness knowledge query` 成功返回
  `events.py append` 的模型步骤——改为 CLI 查询命令自身在项目绑定平台时
   自动落事件（count/exit_code/duration 由命令实测，不信模型转述）。
   CLI 侧属边界建议，单列跟进，不阻塞本批 Python 侧交付。

**边界**：bootstrap-execute 只服务新引导的 execute 阶段；review/submit 等
其他阶段的入口编排本批不动（观察 bootstrap-execute 试点效果后再定）。

### WI-3 可读恢复（交付物 3）——消不对称 F

**设计**：`harness_change.py status [--change <cn>] --json`——统一只读恢复
视图，覆盖轻任务与完整流程两条路径（同一 resolver：`resolve_change`）：

- 当前阶段与 runId/attempt（区分 task 阶段与 plan/execute/…阶段）
- 档位及来源（声明 floor vs classify 裁决，读 gate-policy.json）
- plannedPhases 进度（已完成/当前/待办，读 events）
- ledger 验证状态（各 verification kind 的最新记录与 status）
- 脏树与 foreign paths（读 state-snapshot 对比）
- 租约状态
- **下一步动作**：按状态机推导（如「验证失败→修复后重跑 finish」
  「execute 已关门→下一阶段 review」「归档阻断→reasonCode+recoveryAction」），
  复用各命令已有的 recoveryAction 文案，不新造话术。

**边界**：只读、派生自现有权威状态（gate-policy/events/ledger/
state-snapshot/task.json），**不新建任何可写状态**（提案边界：不保留两套
可写权威状态）。`harness_task.py status` 保持可用，内部可改为委托
（实现细节，不构成契约）。

### WI-4 自动身份（交付物 2）——消不对称 E + B 残余

1. **测试报告派生**（不对称 E）：execute 的 `test-report-*.md` 改为
   `harness_ledger.py render-report --change-dir <dir> [--out <path>]` 从
   ledger+events 派生（变更文件表/验证证据/场景覆盖摘要/五态状态），模型
   只追加解读段落（残余风险、下一步）。渲染可重建、不作为第二份可写状态
   （提案 §4.9：渲染文档不作为权威）。
2. **plan-evidence-input 瘦身**（不对称 B，裁决 4）：`plan evidence-pack`
   对 standard 档允许省略可推导字段（risk_signals 已按 affected_paths+git
   status 推断取并集——扩展同法：capabilities 已探测、attempt/baseline 已
   自动记账），必填项（任务/场景/ownership/in_scope/out_of_scope）不变。
   省略时命令回显推导值，模型可核对。v2 契约结构不动。

## 4. 非目标

- 不合并轻任务与完整流程为单一入口（/harness-task 与 /harness-plan 保持
  分离；「一个入口跑所有任务」是提案 §11 问题 3 的产品判断，不在本批）。
- 不动批次 3 范围（风险要求、局部失效、任务依赖、增量评审）。
- 不动批次 4 资产闭环（知识候选、异步队列）。
- 不删除或削弱现有阶段门禁（退役属批次 5）。
- 不为 status 视图新建任何可写状态。
- 不接入验证复用（P14 已决策-不接入）。
- 不做「全部 TypeScript 化/Python 化」迁移（提案 §6.2）。

## 5. 迁移与兼容（提案 §10.1 落地）

- 新命令全部写穿既有 state layout API 与程序化函数（与 harness_task.py
  同路径：harness_change/harness_state/harness_gate/harness_events/
  harness_ledger/harness_archive），单一可写权威，不建平行状态。
- **旧任务继续用原解释器完成**：已 begin 的 change 沿用原命令序列
  （三连入口、手工 record、手写报告），不在执行中途静默切换语义。
  bootstrap-execute/record-from-receipt 只服务新引导的执行。
- 结果收据带 schemaVersion；record-from-receipt 校验失败回退手工 record。
- 渲染报告与手写报告不并存于同一 change：render-report 产物带生成标记
  （frontmatter `generated: true`），旧手写报告在归档时按事实收录。
- 回滚：关闭新参数（--result-receipt 不传即无收据；bootstrap-execute
  不调用即原路径），无状态迁移需要。

## 6. 试点门槛与任务集

| 门槛 | 目标 | 口径 |
|---|---|---|
| 手工修元数据 | **0 次** | 正常 + 故障路径（中断/验证失败/归档阻断）中手写或手改 ledger JSON、events.ndjson、gate-policy.json、run-id/attempt 回填的次数；手工 record 仅允许作为收据校验失败的回退并计为例外 |
| 流程维护 | 完整流程 standard 任务 ≤1.1 min（-50%） | 方法学 §4 口径（协调命令+仪式写作+状态修复），不含审批等待与真实编码 |
| 质量零回退 | 套件全绿 + 产物等价 + ledger 无假证据 | 收据与 ledger 条目可逐条对账（命令、exit code、duration） |
| 恢复演练 | T6 式中断 + 归档阻断场景仅凭 status + recoveryAction 恢复 | 零法证式读底层文件（gate-policy/events/ledger 原文） |

试点任务集（必须走完整流程；轻任务路径不重测——批次 1 已覆盖）：
T4 类跨模块 standard、T5 类 schema/full 档、T6 类中断恢复，各 ≥1 次；
对照基线 `batch0/baseline-data-2026-09-07.md` 组 2 稳态。

## 7. 实施顺序与依赖

```
WI-1 收据+record-from-receipt   ──┐
WI-2 bootstrap-execute           ──┼── 互相独立，可并行
WI-3 status（依赖 WI-1/2 的命令存在后视图更完整，但可先做只读部分）
WI-4a render-report（依赖 WI-1：报告数据源含收据增强的 ledger）
WI-4b evidence-pack 瘦身（独立，CLI 侧）
```

建议顺序：WI-1 → WI-2 → WI-3 → WI-4a → WI-4b；每项带单测 + 试点 clone
端到端（沿批次 1 P9 的双验证惯例）。

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| 收据摘要截断丢关键证据 | 摘要只作 evidence 展示，完整输出仍在 runner 日志；ledger 不依赖摘要判定 |
| record-from-receipt 推导错 files/scope | 推导路径与 harness_task.py finish 同源（同函数），单测覆盖；校验失败回退手工 record |
| bootstrap-execute 掩盖交接语义（plan→execute 凭证） | 内部仍走 context begin 校验，不绕过 HANDOFF_REQUIRED；失败信封带 recoveryAction 指回原路径 |
| status 视图与权威状态漂移 | 只读派生 + 派生自单一权威文件；视图字段缺失时报 UNKNOWN 不猜 |
| render-report 与手写报告语义差异 | 五态状态（OK/WARN/FAIL/REUSED/RETESTED）沿用归档 summary-data 语义，不新造 |
| 新旧入口并存期混淆 | SKILL 文档明示新任务用新命令、旧 change 用原序列；status 视图标注任务使用的入口代际 |
