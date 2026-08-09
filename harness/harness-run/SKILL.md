---
name: harness-run
description: "按变更簇执行 TDD 编码循环（RED→GREEN→REFACTOR→编译验证），逐变更簇实现计划中的任务。仅当用户显式调用 /harness-run 时使用；不得因用户提到编码/实现就自动触发，也不得被其他阶段 skill 自动接续。"
disable-model-invocation: true
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

仅当用户显式调用 `/harness-run` 时执行；plan 完成后**不自动**进入本阶段。参数：`--subagent` 强制 Subagent-Driven；`--inline` 等同默认；`--fixback` 读最新 review fixback。**默认 Inline，不询问执行模式**。

**单阶段原则**：run 关门后必须停止并交还用户，仅提示 `plannedPhases` 中的真实下一阶段；禁止自动开始其他阶段。

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

0. 加载上下文：普通 Run 先 `harness_context.py prepare --phase run --executor <tool> [--change <id>] --json`，再 **`harness_context.py begin --phase run --change <id> --executor <tool> --json`** 校验交接，最后运行 **`harness_gate.py begin --phase run --change <id>`**。`--fixback` 不得拼装这些底层步骤，必须只调用一次 `harness_fixback.py launch-review --project . --change <id> --change-dir <change-dir> --executor <tool> --skills-root <skills-root> --product-identity <当前产品身份> --json`：该命令会先筛选结构化评审项，再原子选择 Fixback 分支、确认上下文、取得 Run 门禁并创建已填充批次。返回 `FIXBACK_NOTHING_TO_APPLY` 时直接报告“本轮评审没有需要执行的代码修复”并停止；返回阻塞码时按 `recoveryAction` 停止，不搜索实现、不试探其他参数、不创建空批次。禁止手写 `events.ndjson` / `phase.end`。已连接平台时 begin 会 best-effort 补传事件，失败只告警。
0.5. **测试基础设施探测**（先写 `CHECKING`，四项证据齐备后再结论）→ `reference.md` Step 0.5；测试基线已由上一步 gate begin 内部建立，不得再次执行 guard begin
1. **变更簇 TDD** — `protocols.md` `run-tdd-protocol`；批量 RED/GREEN；按需 `change-cluster-review-protocol`（高风险 + reviewer 预检可用）
2. 构建验证 + **仅**通过 `harness_ledger.py record` 写 ledger（禁止 Write/Edit `verification-ledger.json`）；若本阶段创建/删除了清单、锁文件、源码根或改变技术栈，最后一次产品编辑后、写账本与关门前必须执行 `harness_preflight.py detect --project . --json` 刷新 build profile。`record --project . --profile-input <key>` 会对缺失/陈旧 profile 自动检测并从同一 target 推导 scope、coverage、规范命令和输入闭包；不得再手填另一套身份。`diff-hash --change-dir` 纳入 ignored tests → `reference.md` Step 2c
3. **场景覆盖检查**（场景表映射，禁止用用例数冒充场景数）
4. **关门检查**（10 项）→ 只执行一次 `harness_gate.py close`；`--to-phase` 必须取返回的 `nextPhases` 或 `plannedPhases` 中 run 的真实后继，禁止写死 test。该命令内部关闭 test guard、写 `phase.end`、释放租约、写 handoff 并补传事件；不得再单独调用 test-guard/context close。失败时按结构化 `recoveryAction` 原样重试，已完成步骤幂等复用。

**Fixback**：入口只用 `launch-review`，后续问题处理通过 `resolve-issue/close` 驱动，不得把修复说明当成新的普通 Run。只读取返回的受影响问题和文件；验证仅失效与 `changedFiles` 相交的目标，其他 Test/Review 证据继续复用。RED 优先；`manual`、`workflow` 或未选用的建议不进入代码批次，使用中文记录处理结论。

**执行器边界**：优先使用项目 build profile 和已有测试入口。禁止为了绕过 ESM、路径或参数问题临时生成 `.js`、`require` 脚本；需要文件式 runner 时使用项目已有入口，确需新增时遵循项目模块类型（例如 ESM 使用 `.mjs`）。runner 包装说明写入 `runnerCommand` 元数据，不得拼进账本的规范 `command`。

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
| **Gate/Guard** | 跨 Agent/阶段先用 `harness_context.py prepare/begin`；阶段门禁与上下文交接统一用 `harness_gate.py begin/close`；gate 内部负责 guard begin/close，模型只在需要记录测试来源或修复时调用 guard 的 `record/stage/mark` |
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
