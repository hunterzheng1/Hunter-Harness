---
name: harness-run
description: "按变更簇执行 TDD 编码循环（RED→GREEN→REFACTOR→编译验证），逐变更簇实现计划中的任务。使用场景：开始编码、实现功能、写代码、TDD 编码"
argument-hint: "变更名 | --subagent | --inline | --fixback | 留空自动检测"
effort: medium
allowed-tools: [Read, Edit, Write, Glob, Grep, Bash(powershell.exe:*)]
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
  - Bash(codegraph *)
---

# harness-run — 需求编码

## Purpose

基于 plan + test-scenarios，按**变更簇**执行 TDD（RED→GREEN→REFACTOR→构建验证），写入 verification-ledger。负责 worktree 创建/切换（见 [[shared/worktree-gate.md|worktree-gate]]）。

## When to Use

触发语："开始编码""实现功能""写代码""TDD编码"。参数：`--subagent` 强制 Subagent-Driven；`--inline` 等同默认；`--fixback` 读最新 review fixback。**默认 Inline，不询问执行模式**。

## 前置条件

- `spec/*-design.md`、`plans/*-plan.md`（含 frontmatter）存在且已审批
- 读 `meta/worktree.json`：`requested=true` 时 worktree 须存在或 run 负责创建

<!-- @include shared/worktree-gate.md -->
> 片段：[[shared/worktree-gate.md|worktree-gate]] · 创建命令 → `reference.md`

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]] · run 必读文件优先级 → `reference.md` Step 0

## 执行模式

默认 **Inline Execution**；仅 `--subagent` 切换 Subagent-Driven。

## Workflow 概要

0. 加载上下文（change-name、spec/plan/detail/scenarios/ledger/run-task-status/worktree；`--fixback` 读 fixback）→ append `phase.start`
0.5. **测试基础设施探测**（先写 `CHECKING`，四项证据齐备后再结论）→ `reference.md` Step 0.5
1. **变更簇 TDD** — `protocols.md` `run-tdd-protocol`；批量 RED/GREEN；按需 `change-cluster-review-protocol`（高风险 + reviewer 预检可用）
2. 构建验证 + 写 ledger（diffHash 三部分合并，`reference.md` Step 2c）
3. **场景覆盖检查**（场景表映射，禁止用用例数冒充场景数）
4. **关门检查**（10 项）+ 计划状态持久化

**Fixback**：`--fixback` 或用户要求时读 `reports/review/fixback-*.md`；RED 优先；未选用则记 `fixback: advisory-not-applied`。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 全文判定、示例、模板 → `reference.md`；ledger → `../protocols/ledger-protocol.md`

| 域 | 要点 |
|----|------|
| **文档输入** | 只读 `.harness/changes/<cn>/`；禁止 `docs/superpowers/` |
| **变更簇 TDD** | 一簇一次 RED/GREEN；低价值项豁免；新分支必须 RED |
| **RED/GREEN** | RED 须有效；静态验证 ≠ 测试通过；greenfield 大重写豁免见 reference |
| **Mapper/DB** | 纯 Mock 不得宣称 DB 验证通过；迁移脚本**永不自动执行** |
| **探测/ledger** | 基础设施先探测；每次构建/测试写 ledger；三部分 diffHash |
| **预存变更** | 保留 → baseline 隔离；存在则最终 ≥ 🟡WARN |
| **关门/状态** | 10 项关门检查；持久化 run-task-status；P0 静态-only 不得建议 submit |
| **Worktree** | `requested=true` 时代码只写 worktree |
| **PowerShell** | 所有 git/构建经 `powershell.exe -NoProfile -Command` |

## Output Format

变更文件表 + 构建/测试证据 + 场景覆盖摘要 + 最终状态（✅OK / 🟡WARN / ❌FAIL）。→ `reference.md`

## 渐进披露

- **Read `protocols.md`** — run-tdd + change-cluster-review
- **Read `reference.md`** — Step 0–5 细节、TDD/RED/ledger/迁移/安全矩阵
- **Read `checklist.md`** — 逐步勾选

## 交互白名单

1. **预存变更**：保留 / 暂存 / 终止
2. **数据库迁移**：展示审查清单并确认（**永不自动执行**）
3. **worktree 创建失败**：是否改主目录

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`run`
