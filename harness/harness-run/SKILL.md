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

0. 加载上下文：先 `harness_change.py resolve [--change] --json`（多 active 缺参 → `CHANGE_SELECTION_REQUIRED`，禁止按 mtime 猜测）；读 spec/plan/detail/scenarios/ledger/run-task-status/worktree；`--fixback` 读 fixback → **`harness_gate.py begin --phase run --change <id>`**（内部 claim + phase.start + identity；禁止手工 Write `events.ndjson` / 手工 `phase.end`）
0.5. **测试基础设施探测**（先写 `CHECKING`，四项证据齐备后再结论）→ `reference.md` Step 0.5；进入 TDD 前执行 `harness_test_guard.py begin --project . --change-dir ".harness/changes/<cn>" --json`
1. **变更簇 TDD** — `protocols.md` `run-tdd-protocol`；批量 RED/GREEN；按需 `change-cluster-review-protocol`（高风险 + reviewer 预检可用）
2. 构建验证 + **仅**通过 `harness_ledger.py record` 写 ledger（禁止 Write/Edit `verification-ledger.json`）；`diff-hash --change-dir` 纳入 ignored tests → `reference.md` Step 2c
3. **场景覆盖检查**（场景表映射，禁止用用例数冒充场景数）
4. **关门检查**（10 项）→ `harness_test_guard.py close` → **`harness_gate.py close --phase run --change <id> --status <OK|WARN|FAIL>`**（内部 phase.end + 释放租约；close 失败不得用自然语言宣称成功）

**Fixback**：`--fixback` 或用户要求时读 `reports/review/fixback-*.md`；RED 优先；未选用则记 `fixback: advisory-not-applied`。

**Foundation Gate**：若 `meta/implementation-checkpoints.json` 中 `foundation-gate` 为 pending，不得开始 plan 中任务 6+；由 `harness_gate.py` 硬阻断。

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
| **探测/ledger** | 基础设施先探测；每次构建/测试经 `harness_ledger.py record`；禁止手写 ledger JSON；用 canonical `diff-hash --change-dir` |
| **Gate/Guard** | 阶段边界只用 `harness_gate.py begin/close`；测试跟踪用 `harness_test_guard.py begin/close/record/stage` |
| **预存变更** | 保留 → baseline 隔离；存在则最终 ≥ 🟡WARN |
| **关门/状态** | 10 项关门检查；持久化 run-task-status；P0 静态-only 不得建议 submit |
| **Worktree** | `requested=true` 时代码只写 worktree |
| **PowerShell** | 所有 git/构建经 `powershell.exe -NoProfile -Command` |

### 陈旧测试安全修复与精确跟踪

测试编译或 RED/GREEN 失败时，先区分当前实现缺陷、测试基础设施故障与陈旧测试。只有同时满足以下条件才允许自动修复陈旧测试：当前生产代码、已批准计划或可验证的历史变更能唯一确定新契约；修改范围仅限测试文件；修复后会立即重跑该测试及本变更目标测试。符合时以 `stale-test-repair` 记录：

```text
python <skills-root>/scripts/harness_test_guard.py record --project . --change-dir ".harness/changes/<change-name>" --files "<精确测试文件路径，逗号分隔>" --reason stale-test-repair --json
```

新建或正常更新测试分别使用 `tdd-created` / `test-updated`。若预期行为存在业务歧义，停止测试修复并记录 `BLOCKED_PREEXISTING`，不得猜测新断言。

**禁止临时排除测试**：不得将测试改名为 `.bak`、移出测试目录、删除、添加 `@Disabled`/`@Ignore`、修改 Surefire/Gradle exclude 或跳过测试来制造绿色结果；也不得仅为满足陈旧测试而修改生产代码。`.gitignore` 中的测试只能通过 manifest 的精确路径闭环处理，禁止全局放宽 ignore。

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
