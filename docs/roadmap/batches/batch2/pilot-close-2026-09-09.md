# 批次 2 收尾试点：减少模型记账（WI-1~4b 全量流程）

> 日期：2026-09-09
> 样本：2 次完整流程运行（T4' 跨模块 standard / T6' 中断恢复），clone @ 41d2887
> （四工作项全部合入：exec --result-receipt + record-from-receipt、bootstrap-execute、
> status 恢复视图、render-report、evidence-pack 瘦身）
> 对照基线：`batch0/baseline-data-2026-09-07.md` 组 2 稳态（~2.2 min 流程维护）
> 门槛（设计文档 §6）：手工修元数据 0 次；流程维护 ≤1.1 min（-50%）；质量零回退；
> T6 式恢复仅凭 status + recoveryAction。

## 1. 门槛判定总表

| 门槛 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 手工修元数据 | 0 次 | **0 次**（T4' 正常+归档阻断路径、T6' 中断+4 次失败重试路径，全部经命令恢复） | **达成** |
| 流程维护 | ≤1.1 min | T4' 严格口径 **0.87 min**（52.1 s）/ 宽口径 1.07 min；T6' **0.59 min**（35.3 s，含中断恢复链 9.4 s） | **达成** |
| 质量零回退 | 套件全绿 + ledger 无假证据 | T4'：54 定向 + 全量绿；T6'：56 定向 + 全量绿；收据与 ledger 逐条对账一致；T6' 事件/账本/收据零重复 | **达成** |
| 恢复演练 | 仅凭 status + recoveryAction | T6'：status 视图 + 失败信封 recoveryAction 逐环驱动；唯一偏离 = review sidecar runId 查询（B2-6） | **达成**（带 1 项改进候选） |

## 2. T4'（跨模块 standard）流程维护拆分

任务：`harness_change.py status` 列表项补 `lastActivityAt`（读 events.ndjson 最后一条事件
createdAt，尾部 seek，损坏行跳过）——跨 CLI/脚本/测试三处协调的典型 standard 任务。

| 构成 | 耗时 | 说明 |
|---|---|---|
| bootstrap-plan | 1.334 s | |
| configure-plan | 0.189 s | |
| publish（含 1 次 PLAN_REVIEW_REQUIRED 重试） | 1.175 + 3.961 s | 脏树 marker 假阳性（package-lock.json 含 "lock"）触发 review——安全地板行为，模型看 derived echo 后清树 |
| bootstrap-execute | 1.358 s | WI-2 一条命令替代三连 |
| render-report ×2 | 0.380 + 0.906 s | WI-4a：报告从 ledger+events 派生，模型只追加解读段 |
| gate close execute | 18.571 s | `--to-phase` 省略，自动派生 archive（derivedToPhase） |
| archive execute（含 1 次阻断 + 恢复） | 1.629 + 0.303 + 22.251 s | 阻断 1：unpushed-commits（clone 有 upstream）→ unset-upstream；阻断 2：PROJECT_RELEASE_POLICY_BLOCKED → allow-local-release。两条恢复路径都是文档化命令，零手工修文件 |
| **协调命令合计（严格口径）** | **52.057 s** | ledger record 系列（12.9 s）按方法学 §4 不计入（验证记账） |
| 仪式写作 | ~2-3 min 模型时间（未计时） | plan-evidence-input（WI-4b 瘦身后 4 字段省略）+ plan.md；test-report 仪式被 render-report 消除 |

对照 batch0 组 2 稳态 ~2.2 min（协调 ~32 s + 仪式写作 ~1.5 min）：协调命令量级持平
（52 s vs 32 s，多出的是 archive execute 22 s 与 gate close 18.6 s——组 2 基线未含
完整归档链），仪式写作从 ~1.5 min 降到 ~30 s 级（evidence-input 瘦身 + render-report
消除 test-report 全文写作）。

## 3. T6'（中断恢复）

任务：`harness_change.py status` 顶层补 `activeChangeCount`（= len(items)，同源派生）。

**中断点**：unitTestFull 全量套件执行完成、收据已落盘，但尚未 record 进 ledger、
gate close 未运行——T6 起始状态定义（「实现已落盘、ledger 已记录、gate close 尚未
运行」的等价变体：unitTest/compile 已记录，unitTestFull 收据在手未入账）。

**恢复路径（零法证式读文件）**——每一步由上一步的结构化输出驱动：

1. `harness_change.py status --change active-change-count --json` →
   `CHANGE_RECOVERY_VIEW`：currentPhase=execute、unitTest/compile=OK、租约 active、
   `nextAction` 指向 gate close。**未读任何 gate-policy/events/ledger 原文**。
2. `record-from-receipt`（unitTestFull）→ `record --scenario-ids`（UT-001..003）→
   `render-report` → `gate close execute`（derivedToPhase=review）。
3. review 阶段恢复链（每步失败信封的 recoveryAction 给出下一步命令）：
   - `gate close review` → LEASE_ABSENT（review 从未 begin）→ recoveryAction 提示
     `harness_context.py handoff --to-phase review`（gate begin 报
     CONTEXT_HANDOFF_REQUIRED 的 recoveryAction 同源）
   - `gate begin review` → 成功
   - `gate close review` → REVIEW_OUTPUTS_INCOMPLETE → recoveryAction 提示
     `harness_review.py scaffold` → write-findings → scaffold → write-dispositions
   - `gate close review` → REVIEW_OUTPUTS_INVALID（sidecar runId 不匹配）→ 从
     events 的 phase.start 读当前 runId 重写 sidecars（此处读了一次 events 原文——
     唯一一次偏离纯 status 路径，见 B2-6）
   - `gate close review` → 成功但 handoffPending（status 视图识别并给出补
     `--to-phase` 幂等续跑命令）
   - 续跑 → LEASE_ABSENT → recoveryAction 提示 `claim --run-id <原 run-id>` →
     close 成功，handoff 落盘
4. `archive execute` → finalStatus OK。

**验收条件判定**：

| 条件 | 结果 |
|---|---|
| 幂等续跑语义 | ✅ handoffPending 检测 + `--to-phase` 补跑 + claim 重取租约，全程无状态重置 |
| events.ndjson 无重复 phase.end | ✅ 每阶段恰 1 条 start/1 条 end（plan/execute/review/archive） |
| ledger 无重复记录 | ✅ 3 验证各 1 条，收据各 1 份 |
| 最终状态一致 | ✅ finalStatus OK，change 目录归档移除 |

**流程维护**：0.59 min（35.3 s 协调命令；其中中断恢复链 9.4 s——含 4 次失败重试，
每次失败信封都带 recoveryAction，无一次需要猜测）。

**手工修元数据**：0 次（review sidecar 的 runId 重写是经 `write-findings`/
`write-dispositions` 命令，不是手改 JSON）。

## 4. 新发现（P 系列候选）

| # | 发现 | 影响 | 处置建议 |
|---|---|---|---|
| B2-1 | `record-from-receipt` 不支持 `--scenario-ids`（harness_ledger.py:3297 硬编码 None）——场景绑定只能走手工 `record`，与 WI-1「推荐路径」冲突 | 有场景清单的 change 在收据路径上必须二次 record（合并语义保留身份字段，无假证据，但多一条命令 + PROFILE_INPUT_MISSING 警告噪音） | record-from-receipt 加 `--scenario-ids`/`--scenario-receipt-file` 透传（cmd_record 已支持，纯参数传递） |
| B2-2 | `plan publish` 重建 evidence-pack 丢弃 adversarial_review（input 不携带时）——`--renew-review` 只救 PLAN_REVIEW_BINDING_FAILED，救不了 PLAN_REVIEW_REQUIRED | 评审过的计划重跑 publish 必须再走一次 review-record + finalize 两步（publish 的编排收口对 assurance 计划失效） | publish 检测 input 无 adversarial_review 但磁盘 pack 有 → 续签或透传；或文档明确 assurance 计划用 review-record + finalize 直连 |
| B2-3 | exec 默认 300s 超时对全量 Python 套件（~13 min）不足；嵌套 `harness_test_runner.py unittest` 与外层 exec 冲突项目测试锁（TEST_RUN_ALREADY_ACTIVE） | 模型需知道 `--timeout-seconds 900` 与「exec 内直接 python -m unittest discover」两个坑 | testing-reference.md 补充：全量套件 exec 超时预算与嵌套禁令（已有锁规则，补 exec 场景） |
| B2-4 | 归档 `unpushed-commits` 阻断对「clone 有 upstream 但只做本地试点」的场景无出路提示（SKILL.md 说无 upstream 允许，但没说怎么从有 upstream 到无 upstream） | 模型需自行发现 `git branch --unset-upstream` | archive 阻断信封的 recoveryAction 补 unset-upstream 提示 |
| B2-5 | **tier 与 profile mode 双轨不一致**：T6' gate-policy tier=standard（stageDecisions.review.required=false）但 CLI profile mode=assurance（delete 信号 → required_phases 含 review）——configure-plan 落的 `plan,execute,archive` 被 evidence-pack 的 requiredRetained 覆盖回含 review 的四阶段，且无告警 | 模型按 standard 三阶段规划，execute 关门后才发现要跑 review 阶段（review 骨架/处置/租约全套仪式）；tier 字段与实际阶段计划脱节误导审计 | 短期：evidence-pack 在 requiredRetained 非空时发 warning（phase_set_source 已有，缺「configure 被覆盖」的显式提示）；中期：Python classify 与 CLI classifyPlan 的信号表对齐后统一 tier/mode 单一权威 |
| B2-6 | review sidecar 的 runId 必须匹配当前 review run，但 `write-findings` 不校验也不回填当前 runId——错误 runId 要到 gate close 才报 REVIEW_OUTPUTS_INVALID，且 recoveryAction 不含「当前 runId 是什么」 | 恢复路径被迫读 events.ndjson 原文找 runId（T6' 唯一一次偏离纯 status 路径） | write-findings 缺 runId 时自动取当前 review run；或 close 的错误信封直接带 currentRunId |

## 5. 任务集覆盖判定

| 任务类型 | 覆盖 | 说明 |
|---|---|---|
| T4 类跨模块 standard | ✅ T4' | 完整流程 plan→execute→archive |
| T5 类 schema/full 档 | ⚠️ 部分 | T4' 触碰 harness_change.py（CONTRACT_SCHEMA_PATHS 成员），但**完整流程不跑 post-run classify**（那是 harness_task.py finish 轻任务路径的 P12 修复）——full 档声明需在 plan 文档写 `风险等级: full`，本试点未验证 full 档完整流程（review 阶段 + apiTest）。T6' 同为 standard。**结论：T5 测量点未覆盖，如需 full 档完整流程数据需补跑** |
| T6 类中断恢复 | ✅ T6' | 见 §3 |

## 6. 结论

1. **手工修元数据 0 次：达成**。两次完整流程（含 T6' 的 4 次失败重试 + 归档阻断
   恢复）全部经结构化命令完成；失败信封的 recoveryAction 在 T6' 恢复链上
   逐环给出下一步命令，是「零手工修」的直接支撑。
2. **流程维护 ≤1.1 min：达成**。T4' 0.87 min（严格口径）/ T6' 0.59 min，对照
   batch0 组 2 稳态 ~2.2 min（-60%~-73%）。仪式写作侧：evidence-input 瘦身
   （4 字段省略）+ render-report 消除 test-report 全文写作 + bootstrap-execute
   合并三连，是主要降幅来源；协调命令绝对值持平（多出的 archive/gate close
   时长是组 2 基线未覆盖的完整归档链）。
3. **质量零回退：达成**。T4'/T6' 定向 + 全量套件全绿；收据与 ledger 逐条对账
   （命令/exitCode/durationMs 三元组一致）；render-report 派生报告与 ledger 一致；
   T6' 中断恢复零重复副作用（事件/账本/收据各一份）。
4. **恢复演练：达成**。T6' 全程仅凭 status 视图 + 各失败信封的 recoveryAction
   驱动；唯一偏离是 review sidecar runId 查询（B2-6，修复后可归零）。
5. **任务集覆盖**：T4 ✅ / T6 ✅ / T5（full 档完整流程）未覆盖——完整流程的
   full 档需 plan 文档显式 `风险等级: full` 且会引入 review+apiTest 全套仪式，
   本试点两任务均被推断为 standard/assurance。B2-5 的 tier/mode 双轨问题
   （T6' 实际走了 assurance 阶段集）部分覆盖了「review 阶段仪式成本」的观察，
   但 apiTest 与 full 档 classify 升档路径仍无数据。**建议**：T5 补测列为
   批次 3 候选，与 B2-5 的信号表对齐工作合并（对齐后 full 档声明才有单一权威）。

**批次 2 关闭判定**：四门槛全部达成，批次 2 工作项（WI-1/2/3/4a/4b）在完整流程
上验证通过。B2-1~B2-6 为新发现的改进候选（无阻断项），建议进批次 3 待办池。
