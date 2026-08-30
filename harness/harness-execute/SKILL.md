---
name: harness-execute
description: "执行阶段：按变更簇执行 TDD 编码循环（RED→GREEN→REFACTOR→编译验证），随后完成单元/接口/数据兼容验证并输出测试报告。仅当用户显式调用 /harness-execute 时使用；不得因用户提到编码/实现/测试就自动触发，也不得被其他阶段 skill 自动接续。"
disable-model-invocation: true
argument-hint: "变更名 | --subagent | --inline | --fixback | 留空自动检测"
effort: medium
allowed-tools: [Read, Edit, Write, Glob, Grep, Agent, Bash(powershell.exe:*)]
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
  - Bash(node *)
  - Bash(codegraph *)
---

# harness-execute — 执行（编码 + 验证）

> 2026-08 阶段合并：原 `run`（编码）与 `test`（验证）合并为单一 `execute` 阶段。
> `/harness-run` 与 `/harness-test` 保留为别名入口，语义与本 skill 相同。

## Purpose

基于 plan + test-scenarios，按**变更簇**执行 TDD（RED→GREEN→REFACTOR→构建验证），随后在同一阶段内完成单元测试、接口测试与数据兼容验证，写入 verification-ledger 并输出测试报告。负责 worktree 创建/切换。

## When to Use

仅当用户显式调用 `/harness-execute`（或别名 `/harness-run`、`/harness-test`）时执行；plan 完成后**不自动**进入本阶段。参数：`--subagent` 强制 Subagent-Driven；`--inline` 等同默认；`--fixback` 读最新 review fixback。**默认 Inline，不询问执行模式**。

**单阶段原则**：execute 关门后必须停止并交还用户，仅提示 `plannedPhases` 中的真实下一阶段；禁止自动开始其他阶段。

## 前置条件

- 设计文档（`plans/*-design.md` 优先，回退 `spec/*-design.md`）与 `plans/*-plan.md`（含 frontmatter）存在且已审批
- `plans/*-test-scenarios.md` 存在（测试真相源）
- 读 `meta/worktree.json`：`requested=true` 时 worktree 须存在或 execute 负责创建；worktree 已创建则在 worktree 中执行测试，不得静默回到主目录

<!-- @include shared/worktree-gate.md -->
> 片段：[[shared/worktree-gate.md|worktree-gate]] · 创建命令 → `harness-run/reference.md`

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow 概要

0. 加载上下文：先 `harness_context.py prepare --project . --change <id> --phase execute --executor <tool> --json`（`--project` 必填），再 `harness_context.py begin --project . --change <id> --phase execute --executor <tool> --json` 校验交接，最后运行 **`harness_gate.py begin --phase execute --change <id>`**。旧名 `--phase run` / `--phase test` 仍被接受并归一为 execute。<br>**交接凭证不必手工补**：v2 计划的 `plan finalize` 不写 context 事务，`prepare` 会在检测到 committed 的 `meta/publication-journals/*.json` 时自动补录 `plan → execute` 凭证（凭证带 `bootstrapSource=plan_publication_journal` 留痕）。仍报 `HANDOFF_REQUIRED`/`LEGACY_BOOTSTRAP_REQUIRED` 说明**没有**这份发布证据——回到 plan 阶段确认发布是否真的完成，**不得**自己拼 `classify + configure-plan + close` 造凭证。<br>**Fixback** 不得拼装底层步骤，必须只调用一次 `harness_fixback.py launch-review --project . --change <id> --change-dir <change-dir> --executor <tool> --skills-root <skills-root> --product-identity <当前产品身份> --json`；返回 `FIXBACK_NOTHING_TO_APPLY` 时直接报告并停止。禁止手写 `events.ndjson` / `phase.end`。
0.5. **测试基础设施探测**与**命令执行模式 preflight** → `harness-test/reference.md`「命令执行模式 preflight」；测试基线已由 gate begin 内部建立，不得再次执行 guard begin
1. **变更簇 TDD** — `harness-run/protocols.md` `run-tdd-protocol`；批量 RED/GREEN；按需 `change-cluster-review-protocol`
2. 构建验证 + **仅**通过 `harness_ledger.py record` 写 ledger（禁止 Write/Edit `verification-ledger.json`）；profile 缺失或陈旧时先 `harness_preflight.py detect --project . --json`；`record --project . --profile-input <key>` 从同一 target 推导 scope、coverage、规范命令与输入闭包
3. **验证执行**：单元测试可复用则跳过（`harness_ledger.py can-reuse`）；接口测试**强制批量执行器**一次跑完全部场景；数据兼容验证按场景表执行 → `harness-test/reference.md`
4. **场景覆盖检查**（场景表映射，禁止用用例数冒充场景数）
5. **关门检查**（10 项）→ 只执行一次 `harness_gate.py close`；`--to-phase` 可省略——计划后继唯一（排除 fixback 自环）时自动派生并交接（输出含 `derivedToPhase`）。仅 fixback 回环时显式传 `--to-phase execute`。该命令内部关闭 test guard、写 `phase.end`、释放租约、写 handoff 并补传事件；不得再单独调用 test-guard/context close。失败时按结构化 `recoveryAction` 原样重试，已完成步骤幂等复用。

**阶段归属规则**：只用 `ownerPhase=execute` 的任务和场景判定本阶段结果。`ownerPhase=review`/`submit` 的场景按计划留给后续阶段属于正常移交，出现在关门返回值的 `deferred` 里，不阻断 execute。合并前 `ownerPhase=run`/`test` 的旧清单经别名表归一为 execute，在 execute 关门时一并到期。

> 关门脚本与本规则一致：`harness_gate.py close --phase execute` 的 C9 场景覆盖要求全部 `ownerPhase=execute` 的必需场景有通过 receipt——包括本属原 run 半段的编码验证与原 test 半段的接口/兼容验证，这正是两阶段合并的语义。

**构建/测试执行入口**：所有构建与测试命令（mvn / gradle / npm test / pytest 等）必须经 `harness_test_runner.py exec` 发起，**禁止**用 `powershell.exe -Command` 直接裸跑：

```text
python <skills-root>/scripts/harness_test_runner.py exec --project . --timeout-seconds <预估上限> -- <构建命令及参数>
```

资源档位是硬合同（`safe` 默认；`system`/`full` 需用户明确授权或 `--confirm-resource-intensive`）；Python `unittest` 必须逐模块隔离模式（`harness_test_runner.py unittest --profile safe --tests-dir <目录>`）。返回 `TEST_RUN_ALREADY_ACTIVE` 说明已有构建在跑：等待或查明持有者，不得绕开锁另起并行构建。完整约束 → `harness-test/checklist.md`「0.0-A 资源安全档位」。

**长阶段租约**：`gate begin` 的租约默认 TTL 3600 秒，execute 阶段常常跑得更久。租约过期不会中断执行，**也不再阻断收尾**：`gate close` 发现租约过期而 run-id 仍是本阶段的，会自动用原 run-id 重取并照常关门，只在返回体的 `leaseLapsed` 里记录。不需要定期续租；报 `LEASE_ABSENT`/`LEASE_INVALID` 时先确认 begin 真的跑过，**不要**重跑 `gate begin`。

**关门重试是幂等续跑**（0.4.5 workflow 起）：租约释放是 close 的最后一个可失败步骤，handoff/monitor/清草稿任一失败时租约仍持有，原样重跑同一命令即可（已完成步骤由 closeTransaction journal 幂等跳过）。万一处于「phase.end 已写 + 租约已放 + 交接未完成」的历史中间态，重跑 close 会自动识别并补跑剩余步骤（`PHASE_CLOSE_RESUMED`）：未带 `--to-phase` 时从 plannedPhases 派生唯一后继，后继不唯一才报 `PHASE_HANDOFF_PENDING` 并列出候选。**都不需要手工 `harness_change.py claim`**——LEASE_ABSENT 只在 begin 从未跑过时才该出现。

**接口测试执行器优先级**：接口测试执行器（默认首选）> PowerShell batch `.ps1` > Playwright MCP `browser_evaluate`（仅前两者不可用或用户明确选择）> curl + UTF-8 JSON body file（兜底）。执行器在 PowerShell 可用时**禁止**用 Playwright MCP 逐条执行。→ `harness-test/reference.md`「接口测试工具优先级」

**陈旧测试安全修复**：只有当前生产代码、已批准计划或可验证历史能唯一确定新契约时，才允许仅修改测试并立即重跑，然后记录：

```text
python <skills-root>/scripts/harness_test_guard.py record --project . --change-dir ".harness/changes/<change-name>" --files "<精确测试文件路径，逗号分隔>" --reason stale-test-repair --json
```

新建或正常更新测试分别使用 `tdd-created` / `test-updated`；存在业务歧义时记录 `BLOCKED_PREEXISTING` 并停止。**禁止临时排除测试**（`.bak`/改名/移出目录/禁用注解/exclude/`skipTests` 充当通过证据）。

**Foundation Gate**：若 `meta/implementation-checkpoints.json` 中 `foundation-gate` 为 pending，不得开始 plan 中任务 6+；由 `harness_gate.py` 硬阻断。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 编码侧细则 → `harness-run/reference.md`、`harness-run/protocols.md`；验证侧细则 → `harness-test/reference.md`、`harness-test/checklist.md`、`harness-test/pitfalls.md`

| 域 | 要点 |
|----|------|
| **文档输入** | 只读 `.harness/changes/<cn>/`；禁止 `docs/superpowers/` |
| **变更簇 TDD** | 一簇一次 RED/GREEN；低价值项豁免；新分支必须 RED |
| **RED/GREEN** | RED 须有效；静态验证 ≠ 测试通过 |
| **探测/ledger** | 基础设施先探测；每次构建/测试经 `harness_ledger.py record`；禁止手写 ledger JSON |
| **Gate/Guard** | 跨 Agent/阶段先用 `harness_context.py prepare/begin`；阶段门禁统一用 `harness_gate.py begin/close`；gate 内部负责 guard begin/close（`harness_test_guard.py begin` / `harness_test_guard.py close` 仅由 gate 调用，不构成模型执行步骤），模型只在需要记录测试来源或修复时调用 guard 的 `record/stage/mark` |
| **关门/状态** | 10 项关门检查；仅 execute-owned P0 静态-only 导致 WARN；review/submit-owned 待办正常移交 |
| **Worktree** | `requested=true` 时代码只写 worktree |
| **构建/测试** | 一律经 `harness_test_runner.py exec`；禁止裸跑；`TEST_RUN_ALREADY_ACTIVE` 表示已有构建在跑，等待而非另起 |
| **租约** | 阶段超 TTL 由 close 自动用原 run-id 重取，无需续租；`LEASE_ABSENT`/`LEASE_INVALID` 才需人工 `harness_change.py claim`，一律不重跑 begin |
| **报告** | 区分"产品测试"与"工具维护"；API 维度 `OK`/`PARTIAL`/`BLOCKED`/`NOT_RUN`/`FAIL` 五态 |

## Output Format

变更文件表 + 构建/测试证据 + 场景覆盖摘要 + 最终状态（✅OK / 🟡WARN / ❌FAIL）。测试报告保存到 `.harness/changes/<change-name>/reports/test/test-report-YYYYMMDD-HHmm.md`。

## 渐进披露

- **Read `harness-run/protocols.md`** — run-tdd + change-cluster-review
- **Read `harness-run/reference.md`** — Step 0–5 细节、TDD/RED/ledger/迁移/安全矩阵
- **Read `harness-test/checklist.md`** — 验证前各项强制检查、preflight、服务生命周期清单
- **Read `harness-test/reference.md`** — API 测试执行方法、执行器模板、运行时配置叠加
- **Read `harness-test/pitfalls.md`** — 测试踩坑规则

## 交互白名单

1. **预存变更**：保留 / 暂存 / 终止
2. **数据库迁移**：展示审查清单并确认（**永不自动执行**）
3. **worktree 创建失败**：是否改主目录
4. **Service Gate**：仅当 `harness_service.py ensure` 返回 `needs-user-decision` 时询问处理方式
5. **资源密集型测试确认**：仅当发布/验收确实需要 `system` 或 `full` 档位，且用户尚未明确授权时询问；获得授权后传入 `--confirm-resource-intensive`

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`execute`
