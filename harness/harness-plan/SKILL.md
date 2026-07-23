---
name: harness-plan
description: "将需求转化为设计文档+实施计划+完整测试场景表，必须在编码前完成。使用场景：需求分析、feature plan、技术方案设计、实现方案规划"
argument-hint: "需求描述 | --adversarial"
effort: medium
allowed-tools: [Read, Glob, Grep, Edit, Write, Agent, Bash(powershell.exe:*)]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(cp *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
---

# harness-plan — 需求规划

## Purpose

确定 change 后必须运行 `python <skills-root>/scripts/harness_gate.py classify --change <id> --stage plan --json`，并把脚本返回的 risk tier、默认阶段、条件阶段和必需验证写入计划；不得凭模型印象另建风险分级。

需求 → 设计文档 → 任务拆分 → 测试场景表（编码/测试唯一真相源）。存在 `.harness/archive/` 或 `.harness/knowledge/` 时须先 `harness-knowledge-query`。

## When to Use

`/harness-plan`、新功能设计、技术方案、测试场景表规划。

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]] · plan 额外写 `meta/worktree.json`、`meta/change-context.json`

<!-- @include shared/worktree-gate.md -->
> 片段：[[shared/worktree-gate.md|worktree-gate]] · plan 在**设计审批包**写入 `worktree.json`（模板 → `reference.md`）

## 原生规划协议

内化为 `protocols.md`：`clarification-protocol`、`decision-grilling-protocol`、`implementation-planning-protocol`。不运行时调用 Superpowers/grill-me。

<!-- @section-id plan.delegate -->
## 执行路由（inline 优先）

- **阶段 3 探索默认 inline**：主会话直接使用 CodeGraph/Read，简单修复和常规跨文件变更不得为“隔离上下文”额外启动 agent。
- **仅高复杂度探索考虑委派**：涉及多个独立模块、陌生大型代码库或可并行的独立调查时，才执行一次 `python <skills-root>/scripts/harness_preflight.py check-agents --skills-root <skills-root> --agent harness-explorer --json`。只有 `executionMode=delegated` 才委派；`executionMode=inline` 是正常路径，静默继续；`unavailable` 只记录安装问题后 inline。
- **阶段 7.5 evaluator**：仅 `--adversarial` 或 auth/支付/迁移/并发等高风险规划启用；需要固定 agent 时才预检。无论预检 inline、spawn 失败、空返回或只有元数据，都立即由主会话完成同一对抗检查，`fallbackPolicy=inline-no-retry`。
- 日志记录 `executionMode=inline|delegated`；只有真实定义损坏或 spawn 失败才记 issue。正常 inline 不得显示“subagent 不可用”告警。

## Workflow 概要

| 阶段 | 动作 |
|------|------|
| 0 | 用当前解释器运行 `harness_runtime.py doctor`，后续消费绝对 argv；git status；脏工作区 → baseline 隔离 + `decision`，不询问 |
| 0.5 | 先初始化 change-name + `phase.start`，从第一条知识查询起保留事件证据 |
| 1 | `harness-knowledge-query` 单次 query（内部 ensure-current；失败记 `issue`） |
| 2 | 歧义优先检查 + 复杂度分级；先确认会改变实现方向的语义歧义 |
| 3 | 按复杂度执行有预算的代码探索；简单修复不得扩散到无关模块 |
| 4 | **设计审批包** blocking user confirmation；确认事件早于 approved 设计文档和 `meta/worktree.json` |
| 5–6 | plan + implementation-detail + test-scenarios → `plans/` |
| 7.5 | 仅 `--adversarial` 对抗评审 |
| 8 | 在临时产物集上运行 `harness_plan_finalize.py finalize`；原子发布、唯一 `phase.end`、render → `checklist.md` |

change-name 范围变更 → 提示重命名或记 🟡WARN（→ `reference.md`）

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则

| 规则 | 要点 |
|------|------|
| 产物路径 | 只写 `.harness/changes/<cn>/`；禁止 superpowers 输入 |
| 设计审批包 | 一次 blocking user confirmation 含 worktree（读 `harness.json` `defaultWorktree`） |
| 阶段 8 | spec/plan/detail/scenarios/worktree.json 先进入 staging；仅 finalizer 校验成功后发布并写唯一 `phase.end`/log，失败不得手工补终态 |
| Plan 结束 | **禁止**询问执行模式；只提示 `/harness-run` |
| 知识查询 | 0.5 失败不得假装已读历史 |
| 歧义优先检查 | 否定、对比、动作对象或范围存在多种合理解释时，最小取证后先给推荐理解并一次一问；确认前不深挖错误方向 |
| 简单修复探索预算 | 预计不超过 2 个代码文件、且不涉及认证/安全/迁移/并发/API 契约重设时，最多 1 次合并 CodeGraph 查询 + 1 次定向补查、1 个用户澄清问题；无关发现只记非阻断说明 |
| 精简产物 | 简单修复只保留实现所需的设计、任务、边界和测试；禁止在 spec/plan/detail/scenarios 中重复同一背景和结论 |
| 测试执行成本 | 场景表必须设计快速反馈层级、预计时长、资源预算、超时和可复用证据；默认先跑受影响测试，再跑模块门禁，候选验证只复用身份一致的全量证据 |
| state snapshot | 读取 `state-snapshot.json`（`harness_state.py` / state-layout-protocol §state-snapshot.json）了解 project/worktree root、HEAD/base、profile/rules/map/knowledge 指纹；失效由脚本刷新，**不得仅凭缓存跳过代码探索或验证门禁**（design §3.6） |
| 协议 | sensitive-info / evidence-based-reporting / state-layout |

产出物表、frontmatter、legacy 兼容、结束输出模板 → `reference.md`

## 渐进披露

- **Read `checklist.md`** — 阶段检查与覆盖表
- **Read `protocols.md`** — 阶段 4/6 原生协议
- **Read `reference.md`** — 模板与 worktree JSON

## 交互白名单

1. **设计审批包**（阶段 4）：设计 + 场景表 + worktree + change-name
2. **decision-grilling**（阶段 2/3 澄清）：语义歧义或高风险业务裁决（一次一问）

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`plan`
