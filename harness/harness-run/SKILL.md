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

- 设计文档（`plans/*-design.md` 优先，回退 `spec/*-design.md`）与 `plans/*-plan.md`（含 frontmatter）存在且已审批
- 读 `meta/worktree.json`：`requested=true` 时 worktree 须存在或 run 负责创建

<!-- @include shared/worktree-gate.md -->
> 片段：[[shared/worktree-gate.md|worktree-gate]] · 创建命令 → `reference.md`

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]] · run 必读文件优先级 → `reference.md` Step 0

## 执行模式

默认 **Inline Execution**；仅 `--subagent` 切换 Subagent-Driven。

## Workflow 概要

0. 加载上下文：普通 Run 先 `harness_context.py prepare --project . --change <id> --phase run --executor <tool> --json`（`--project` 必填，漏了直接 argparse 报错），再 **`harness_context.py begin --project . --change <id> --phase run --executor <tool> --json`** 校验交接，最后运行 **`harness_gate.py begin --phase run --change <id>`**。<br>**交接凭证不必手工补**：v2 计划的 `plan finalize` 不写 context 事务，`prepare` 会在检测到 committed 的 `meta/publication-journals/*.json` 时自动补录 `plan → run` 凭证（凭证带 `bootstrapSource=plan_publication_journal` 留痕）。仍报 `HANDOFF_REQUIRED`/`LEGACY_BOOTSTRAP_REQUIRED` 说明**没有**这份发布证据——回到 plan 阶段确认发布是否真的完成，**不得**自己拼 `classify + configure-plan + close` 造凭证。`harness_gate.py` 会从当前已安装适配器自动识别 skills root；只有执行复制到别处的脚本时才显式传 `--skills-root`。`--fixback` 不得拼装这些底层步骤，必须只调用一次 `harness_fixback.py launch-review --project . --change <id> --change-dir <change-dir> --executor <tool> --skills-root <skills-root> --product-identity <当前产品身份> --json`：该命令会先筛选结构化评审项，再原子选择 Fixback 分支、确认上下文、取得 Run 门禁并创建已填充批次。返回 `FIXBACK_NOTHING_TO_APPLY` 时直接报告“本轮评审没有需要执行的代码修复”并停止；返回阻塞码时按 `recoveryAction` 停止，不搜索实现、不试探其他参数、不创建空批次。禁止手写 `events.ndjson` / `phase.end`。已连接平台时 begin 会 best-effort 补传事件，失败只告警。
0.5. **测试基础设施探测**（先写 `CHECKING`，四项证据齐备后再结论）→ `reference.md` Step 0.5；测试基线已由上一步 gate begin 内部建立，不得再次执行 guard begin
1. **变更簇 TDD** — `protocols.md` `run-tdd-protocol`；批量 RED/GREEN；按需 `change-cluster-review-protocol`（高风险 + reviewer 预检可用）
2. 构建验证 + **仅**通过 `harness_ledger.py record` 写 ledger（禁止 Write/Edit `verification-ledger.json`）；若本阶段创建/删除了清单、锁文件、源码根或改变技术栈，最后一次产品编辑后、写账本与关门前必须执行 `harness_preflight.py detect --project . --json` 刷新 build profile。`record --project . --profile-input <key>` 会对缺失/陈旧 profile 自动检测并从同一 target 推导 scope、coverage、规范命令和输入闭包；不得再手填另一套身份。detect 在嵌套/多组件仓库返回 `DETECTION_AMBIGUOUS` 时，响应里的 `profileTemplate` 就是可填骨架（已含 defaultsFingerprint、excludedRoots 默认集与 commands 条目形状），按 `hint` 填好写入 `.harness/config/build-profile.json` 即可，**不要去反读 `harness_profile.py` 源码凑结构**。`diff-hash --change-dir` 纳入 ignored tests → `reference.md` Step 2c
3. **场景覆盖检查**（场景表映射，禁止用用例数冒充场景数）
4. **关门检查**（10 项）→ 只执行一次 `harness_gate.py close`；`--to-phase` 必须取返回的 `nextPhases` 或 `plannedPhases` 中 run 的真实后继，禁止写死 test。该命令内部关闭 test guard、写 `phase.end`、释放租约、写 handoff 并补传事件；不得再单独调用 test-guard/context close。失败时按结构化 `recoveryAction` 原样重试，已完成步骤幂等复用。

**阶段归属规则**：只用 `ownerPhase=run` 的任务和场景判定编码阶段结果。`ownerPhase=test` 的任务或场景按计划留给测试阶段属于正常移交，必须记录为“待测试阶段执行”，不得将编码阶段降级为 WARN；只有 run 自身负责的工作未完成、验证降级或证据异常时才使用 WARN。

> 关门脚本与本规则一致：`harness_gate.py close --phase run` 的 C9 场景覆盖只要求 `ownerPhase` 为 `plan`/`run` 的必需场景有通过 receipt，`ownerPhase=test` 的场景出现在返回值的 `deferred` 里，不阻断 run。若 run 关门报 `REQUIRED_SCENARIO_NOT_EXECUTED` 且缺的是接口/端到端场景，那是 `meta/scenario-manifest.json` 里 `ownerPhase` 标错了（或老清单没声明），应当修清单——**不要**为了过门在 run 阶段起服务补跑本属 test 的验证。

**Fixback**：入口只用 `launch-review`，后续问题处理通过 `resolve-issue/close` 驱动，不得把修复说明当成新的普通 Run。只读取返回的受影响问题和文件；验证仅失效与 `changedFiles` 相交的目标，其他 Test/Review 证据继续复用。RED 优先；`manual`、`workflow` 或未选用的建议不进入代码批次，使用中文记录处理结论。

**构建/测试执行入口**：所有构建与测试命令（mvn / gradle / npm test / pytest 等）必须经 `harness_test_runner.py exec` 发起，**禁止**用 `powershell.exe -Command` 直接裸跑：

```text
python <skills-root>/scripts/harness_test_runner.py exec --project . --timeout-seconds <预估上限> -- <构建命令及参数>
```

该入口持有项目级互斥锁并托管进程树。裸跑构建在宿主工具超时后会被推入后台，多个后台构建同时写同一个 `target/`、`build/` 或 `node_modules/.cache`，表现为编译产物被清空、日志文件被占用、"增量编译抖动"——这些都不是代码缺陷，是并发自相残杀，排查成本极高。`--timeout-seconds` 按最慢的一次全量构建估（默认 300 秒偏短），宁可给足也不要让命令被中途掐断。

返回 `TEST_RUN_ALREADY_ACTIVE`（退出码 3）说明**已有构建在跑**：等它结束或用 `lock-status` 查明持有者，**不得**改用裸跑绕开锁，也不得另起一个并行构建。确认持有进程已消失时才用 `lock-reap` 回收。

**长阶段租约续期**：`gate begin` 的租约默认 TTL 3600 秒，而 run 阶段常常跑得更久。租约过期不会中断执行，只会让最后的 `gate close` 报 `LEASE_ABSENT`。凡预计超过 1 小时的阶段，每完成一个变更簇就用本阶段**原 run-id** 续租一次（同 run-id 重复 claim 即刷新，不会新开 attempt）：

```text
python <skills-root>/scripts/harness_change.py claim --change <id> --phase run --run-id <本阶段 run-id> --ttl-seconds 3600 --json
```

已经报了 `LEASE_ABSENT` 也按同一条命令恢复——错误响应的 `resumeRunId` 就是要用的 run-id；**不要**重跑 `gate begin`，那会新开 attempt 并丢失本轮 capsule。

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
| **关门/状态** | 10 项关门检查；持久化 run-task-status；仅 run-owned P0 静态-only 导致 WARN；test-owned 待办正常移交 |
| **Worktree** | `requested=true` 时代码只写 worktree |
| **构建/测试** | 一律经 `harness_test_runner.py exec`；禁止裸跑 mvn/gradle/npm test；`TEST_RUN_ALREADY_ACTIVE` 表示已有构建在跑，等待而非另起 |
| **租约** | 阶段超 1 小时按变更簇用原 run-id 续租；`LEASE_ABSENT` 用 `harness_change.py claim` 恢复，不重跑 begin |
| **PowerShell** | 所有 git 经 `powershell.exe -NoProfile -Command` |

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
