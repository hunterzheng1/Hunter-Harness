---
name: harness-task
description: "轻任务闭环：一条命令完成任务记录→验证→归档（begin/finish/status），适用于文档/配置改动与普通功能/局部缺陷修复。仅当用户显式调用 /harness-task 时使用；需求涉及权限、安全、迁移、并发、契约破坏或契约/Schema 邻接文件（harness_change/fixback/efficiency/events/ledger/state/archive/gate 等被跨模块消费 schema 的脚本）时不得使用，转 /harness-plan 完整流程。"
---

# harness-task — 轻任务闭环

## Purpose

批次 1 试点（提案 §3/§10/§12）：模型不再编排阶段 Skill、不再手写
plan-evidence-input.json——`harness_task.py` 一条命令完成任务记录 →
验证 → 归档。验证不接受模型口述通过：命令从 build-profile 解析、由
脚本执行、结果写 verification-ledger。

## When to Use

仅当用户显式调用 `/harness-task`（或明确说"用轻任务做这个改动"）时执行。

**前置拒绝**（转 `/harness-plan` 完整流程，不 begin）：

- 需求提及权限/认证（auth、token、credential、permission）
- 安全（secret、crypto）、数据迁移（migration、SQL）
- 并发（lock、lease、transaction）、破坏制品协议（artifact、manifest、baseline）
- 共享状态（shared、state/、workflow-policy）、删除类改动（delete、purge）
- 契约/Schema 邻接文件变更：`harness/scripts/` 下的 harness_change/
  harness_fixback/harness_efficiency/harness_events/harness_ledger/
  harness_state/harness_archive/harness_gate .py——它们的输出 schema 被
  跨语言/跨模块消费（TS CLI、其他 harness 脚本），变更即 contract-schema
  信号 → full（权威清单：harness_gate.py `CONTRACT_SCHEMA_PATHS`）
- 需要多阶段设计审批、worktree 隔离、或 API 契约重设

适用：文档/配置改动（fast 档）+ 普通功能开发 + 局部缺陷修复（standard 档）。

## Workflow

| 步骤 | 动作 |
|------|------|
| ① 理解目标 | 从需求提炼一句话目标（成为 businessGoal）与至少一条可验证验收条件。缺陷任务先写失败测试作为回归证据 |
| ② begin | `python <skills-root>/scripts/harness_task.py begin --project . --change <kebab-case-id> --executor <tool> --goal "<目标一句话>" --acceptance "<可验证条件>" [--tier fast\|standard] [--write-scope <路径>] [--depends-on <cn>] --json`（`--acceptance`/`--write-scope`/`--depends-on` 可重复）。`--tier` 声明档位下限：声明比裁决高时抬升裁决，反之不压低（classify 信号升级仍生效）；`--tier full` 直接拒绝（rc 3，不建 change 目录），转 `/harness-plan`。并行协调：`--write-scope` 声明写入范围（相对路径），与其他 open 任务声明相交 → TASK_SCOPE_CONFLICT 拒绝；`--depends-on` 声明依赖，目标未 completed → TASK_DEPENDENCY_UNMET/MISSING/CYCLE 拒绝。重跑幂等：复用同一 runId，不重复 phase.start；改口声明档位/范围/依赖 → 拒绝。调试档位裁决加 `--dry-run`：只输出信号命中明细、阈值对照与裁决 tier（含 wouldReject），零文件副作用（不落 task.json、不建 change 目录） |
| ③ 自由探索/编辑/测试 | 正常编码。不写 plan-evidence-input.json、不调阶段 Skill、不手写 ledger/events JSON——全部由 finish 生成 |
| ④ finish | `python <skills-root>/scripts/harness_task.py finish --project . --change <cn> --json`。一条命令完成：classify → 档位裁决 → 跑档位验证 → 写 ledger → 生成 plan.md → 成果摘要落盘 → commit（不 push）→ 归档（record-only）。放弃任务用 `--closure abandoned --closure-reason "<中文原因>"`；不想自动提交用 `--no-commit`。**成果摘要（WI-E1）**：用 `--outcome-summary "<实际完成的行为>"` 如实填写（事实与 begin 的 goal 分字段，goal 绝不自动当成果；completed 缺省给 OUTCOME_SUMMARY_MISSING 警告），按需补 `--outcome-motivation`（取舍原因，无法证实的标 [推测]）、`--outcome-risk`/`--outcome-next`/`--outcome-unverified`（可重复；残余风险/下一步/未验证项，空白不凑数）。摘要权威是 `meta/outcome.json`（随归档保留），stdout summary 只是其派生展示 |
| ⑤ 报告 | 把 finish 返回的 summary（完成内容/验证结果/残余风险/代码位置）原样报告给用户，附 archiveDir |

## 关键规则

| 规则 | 要点 |
|------|------|
| begin 前工作区 | begin 会记录脏树基线；begin 之前就存在且任务未触碰的脏文件会被 finish 拒绝（FOREIGN_PATHS_PRESENT）——先提交或 stash 无关改动 |
| 档位 | fast（docs/config）→ unitTest；standard（代码）→ compile+unitTest+unitTestFull。full 信号（含 contract-schema）→ finish 拒绝（TASK_TIER_UPGRADE_REQUIRED），change 目录保留，转 `/harness-plan` 续用。begin `--tier` 声明是下限（floor）：声明 standard + docs-only diff → 仍按 standard 记账，不降级 |
| 验证 | 命令从 build-profile `verificationGraph.targets` 解析；缺 target 按回退链（unitTest→unitTestFull；compile→unitTest→unitTestFull）落到真实存在的目标，ledger 记录真实执行名。缺 build-profile → `harness_preflight.py detect` 重新探测 |
| 失败重跑 | 验证失败修复后直接重跑 finish（幂等：phase.end 不重复、ledger 覆盖）。归档失败同样重跑 finish 补归档 |
| 状态恢复 | 任何时刻 `harness_task.py status --project . --change <cn> --json` 查看档位/已记验证/未提交 diff/下一步；跨代际统一视图 `harness_change.py status --change <cn> --json`（轻任务与完整流程同构，批次 2 WI-3） |
| 并行协调（WI-3.3） | `--write-scope`/`--depends-on` 是 begin 时的协调事实，task.json 固化、运行中不可改（改 = abandon 后以新声明重开）。冲突方 finish 后重试即串行（begin 拒绝零副作用）。声明 scope 的任务 finish 实际 diff 越界 → TASK_SCOPE_VIOLATION 停止（不提交，改动留工作区）；未声明 scope 的任务不参与冲突检测，begin 响应 `unscopedOpenChanges` 提示存量未声明 open 任务 |
| 产物 | 只写 `.harness/changes/<cn>/`；plan.md、execution-log、ledger、events 全部由脚本生成，禁止手写 |
| 资产出站（WI-E3） | finish 落盘 outcome.json 后会把成果资产**同进程原子入队** `.harness/state/local/asset-outbox/`（幂等键去重，重跑 finish 不重复）；入队失败 → finish 报错、任务保持 open（修复后重跑 finish）。远端交付走 `harness_asset_outbox.py drain`（租约/退避/死信）；未配置远端时队列保持 pending 并显式标注待验证，begin 输出 `assetOutbox` 摘要（含 reap 回收） |

错误码表、档位映射、Windows 路径陷阱 → `reference.md`
