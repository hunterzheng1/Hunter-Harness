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

需求 → 设计文档 → 任务拆分 → 测试场景表（编码/测试唯一真相源）。存在 `.harness/archive/` 或 `.harness/knowledge/` 时须先 `harness-knowledge-query`。

## When to Use

`/harness-plan`、新功能设计、技术方案、测试场景表规划。

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]] · plan 额外写 `meta/worktree.json`、`meta/change-context.json`

<!-- @include shared/worktree-gate.md -->
> 片段：[[shared/worktree-gate.md|worktree-gate]] · plan 在**设计审批包**写入 `worktree.json`（模板 → `reference.md`）

## 原生规划协议

内化为 `protocols.md`：`clarification-protocol`、`decision-grilling-protocol`、`implementation-planning-protocol`。不运行时调用 Superpowers/grill-me。

## Subagent 委派

- **阶段 3 探索**：先运行 `python <skills-root>/scripts/harness_preflight.py check-agents --skills-root <skills-root> --agent harness-explorer --json`；可用则委派，否则主会话探索；无效返回不 retry
- **阶段 7.5**：仅 `--adversarial`；先运行 `python <skills-root>/scripts/harness_preflight.py check-agents --skills-root <skills-root> --agent harness-evaluator --json`；可用才委派到 `reports/plan-review/`

## Workflow 概要

| 阶段 | 动作 |
|------|------|
| 0 | git status；脏工作区 → baseline 隔离 + `decision`，不询问 |
| 0.5 | 先初始化 change-name + `phase.start`，从第一条知识查询起保留事件证据 |
| 1 | `harness-knowledge-query` 单次 query（内部 ensure-current；失败记 `issue`） |
| 2 | 歧义优先检查 + 复杂度分级；先确认会改变实现方向的语义歧义 |
| 3 | 按复杂度执行有预算的代码探索；简单修复不得扩散到无关模块 |
| 4 | **设计审批包** AskUserQuestion；确认事件早于 approved 设计文档和 `meta/worktree.json` |
| 5–6 | plan + implementation-detail + test-scenarios → `plans/` |
| 7.5 | 仅 `--adversarial` 对抗评审 |
| 8 | 产物完整性必检 → `checklist.md` |

change-name 范围变更 → 提示重命名或记 🟡WARN（→ `reference.md`）

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则

| 规则 | 要点 |
|------|------|
| 产物路径 | 只写 `.harness/changes/<cn>/`；禁止 superpowers 输入 |
| 设计审批包 | 一次 AskUserQuestion 含 worktree（读 `harness.json` `defaultWorktree`） |
| 阶段 8 | spec/plan/detail/scenarios/worktree.json/logs/events 缺一不可 → ❌FAIL |
| Plan 结束 | **禁止**询问执行模式；只提示 `/harness-run` |
| 知识查询 | 0.5 失败不得假装已读历史 |
| 歧义优先检查 | 否定、对比、动作对象或范围存在多种合理解释时，最小取证后先给推荐理解并一次一问；确认前不深挖错误方向 |
| 简单修复探索预算 | 预计不超过 2 个代码文件、且不涉及认证/安全/迁移/并发/API 契约重设时，最多 1 次合并 CodeGraph 查询 + 1 次定向补查、1 个用户澄清问题；无关发现只记非阻断说明 |
| 精简产物 | 简单修复只保留实现所需的设计、任务、边界和测试；禁止在 spec/plan/detail/scenarios 中重复同一背景和结论 |
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
