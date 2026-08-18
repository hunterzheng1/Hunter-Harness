---
name: harness-plan
description: "将需求转化为设计文档+实施计划+完整测试场景表，必须在编码前完成。仅当用户显式调用 /harness-plan 或明确要求进入 Harness 规划阶段时使用；不得因用户描述需求就自动触发。"
disable-model-invocation: true
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

需求 → 设计文档 → 任务拆分 → 测试场景表（编码/测试唯一真相源）。项目已绑定远端平台时，阶段 1 只执行下表中的远端查询命令；远端不可用则记录 issue 并继续，不做本地回退。

## When to Use

仅当用户显式调用 `/harness-plan`（或明确说"用 harness 规划这个需求"）时执行。用户只是描述需求、提问或讨论方案时，**不得**自动进入本 skill。

**单阶段原则**：本 skill 只负责 plan 阶段。plan finalize + verify 完成后必须停止并交还用户，仅提示 `plannedPhases` 中的真实下一阶段；禁止自动调用其他阶段 skill。

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
| 0 | git status；脏工作区 → baseline 隔离 + `decision`，不询问。环境体检并入 0.5 的引导命令，不再单独跑 doctor |
| 0.5 | 先定英文 `change-name`（kebab-case，`^[a-z0-9]+(-[a-z0-9]+)*$`）与一次性中文展示标题（建议 6～24 个可见字符，保留必要产品名），然后**一条命令完成引导**：<br>`python <skills-root>/scripts/harness_context.py bootstrap-plan --project . --change <cn> --executor <tool> --title "<中文标题>" --json`<br>它按序做完 doctor → 建 change 骨架 → prepare → state capture（首次把当时 HEAD 固定为不可变 `changeBase`）→ classify（落 `meta/gate-policy.json`）→ 生成合规 `plan_<uuid>` run-id 并追加 `phase.start`，返回紧凑摘要：`runId`/`attempt`/`tier`/`defaultPhases`/`conditionalPhases`/`requiredValidations`/`changeBase`/`head`/`executionRoot`。**重跑复用同一 run-id、不重复写 `phase.start`**（换 run-id 会让 finalize 按生命周期身份 fail-closed）。finalizer 必须复用该 `runId`/`attempt` |
| 0.5b | 仅在引导失败需要单步排查时用等价分解——**每条的参数都是必填，少一个就是白跑一轮**：<br>`harness_runtime.py doctor --project . --change-dir ".harness/changes/<cn>" --agent <claude-code\|codebuddy\|codex\|cursor> --json`<br>`harness_context.py prepare --project . --change <cn> --phase plan --executor <tool> --title "<中文标题>" --json`<br>`harness_state.py capture --project . --change-dir ".harness/changes/<cn>" --json`<br>`harness_gate.py classify --change <cn> --stage plan --json`<br>`harness_events.py append --change-dir ".harness/changes/<cn>" --phase plan --type phase.start --run-id plan_<uuid> --attempt 1`<br>⚠️ `--change-dir` 一律是 `.harness/changes/<cn>`（状态目录），**不是** prepare 返回的 `executionRoot`（代码执行根，无 worktree 时等于项目根）——填错会把 gate-policy/events 写到项目根 |
| 0.6 | 用引导返回的 `tier`/`defaultPhases`/`requiredValidations` 生成 `plannedPhases`，向用户用中文说明可选阶段；确认后运行 `harness_context.py configure-plan --project . --change <cn> --phases "plan,run,...,archive" --operator <tool> --reason "<中文原因>" --json`。无 Git 或不需要提交时不得加入 `submit`；快速迭代默认 `plan,run,archive`。省略项由脚本写入 `skippedPhases`，不得伪造阶段事件 |
| 1 | 直接执行一次 `npx hunter-harness knowledge query "<用户需求原文>" --limit 10 --json`。这是唯一执行入口，不扫描技能目录、不查找其他脚本；失败记 `issue` 并继续，不建立本地索引或离线回退 |
| 2 | 歧义优先检查 + 复杂度分级；先确认会改变实现方向的语义歧义 |
| 3 | 按复杂度执行有预算的代码探索；简单修复不得扩散到无关模块 |
| 4 | **设计审批包** blocking user confirmation；确认事件早于 approved 设计文档和 `meta/worktree.json` |
| 5–6 | **v2（默认）**：任务与场景只沉淀进 `meta/plan-evidence-input.json`（自然输入，字段定稿时点见 `reference.md` 阶段 8 v2 表）；`plans/*.md` 四份由 finalize 派生，**不得手写**——手写的会被派生渲染覆盖，只是白写。**legacy**：才手写 plan + implementation-detail + test-scenarios → `plans/` |
| 7.5 | 仅 `--adversarial` 对抗评审 |
| 8 | **v2 路径（新 change 优先）**：`npx hunter-harness plan evidence-pack --input <meta/plan-evidence-input.json> --output <meta/plan-evidence.json>`，再 `npx hunter-harness plan finalize --input <meta/plan-evidence.json>`；exit 0 且 `code:"PLAN_FINALIZED"` 即发布完成（契约见 `reference.md` 阶段 8 v2 路径）。**legacy 路径**：自然输入不完整（如缺真实审批记录）时才在临时产物集上运行 `harness_plan_finalize.py finalize`，随后立即运行 `verify`；成功后把 finalizer 返回的绝对 `receiptPath` 原样传给 `harness_context.py close`，`--to-phase` 必须取 `plannedPhases` 中 plan 的真实后继，不得写死。写 append-only handoff receipt；不得手写占位路径；原子发布、派生清单计数对账、完整生命周期、render → `checklist.md` |

change-name 范围变更 → 提示重命名或记 🟡WARN（→ `reference.md`）

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则

| 规则 | 要点 |
|------|------|
| 产物路径 | 只写 `.harness/changes/<cn>/`；禁止 superpowers 输入 |
| 设计真相源 | **v2** = `plans/<cn>-design.md`（finalize 派生、哈希绑定、八 target 之一）；**legacy** = `spec/<cn>-design.md`。同一 change 只有一份设计权威，禁止两处并存导致漂移；下游读取顺序见 `shared/read-protocol.md` |
| Change 标题 | 首次 Plan 同时确定英文 `change-name` 与中文展示标题；英文名保持目录和机器标识不变，中文标题由 `prepare --title` 持久化，后续阶段只复用、不重新生成 |
| 阶段计划 | Plan 必须持久化 `plannedPhases`；固定从 plan 开始、以 archive 结束。Test、Review、Submit、Package、API 文档可按项目策略省略；高风险必需项只能转为“提前结束且不可发布”，不得伪装通过 |
| 产品边界 | `ownership.productPaths` 必须覆盖计划会修改的源文件、测试文件和构建入口；只写目录前缀或精确文件，禁止 `**` 通配。finalize 前对照任务表补齐，避免归档阶段才发现边界缺口 |
| 空目录 | 不得为“预留目录”生成 `.gitkeep`；只有产品明确需要跟踪空目录时才能创建，并在计划中说明业务原因 |
| 设计审批包 | 一次 blocking user confirmation 含 worktree（读 `harness.json` `defaultWorktree`）。必须同时展示 **in_scope 与 out_of_scope 两个列表**——只展示"做什么"会让范围误判活到发布之后，代价是整份计划 republish |
| 引用即追问 | 需求引用了外部设计文档章节（贴段落、指 `### Bn`、说"之前设计的时候如…"）时，阶段 2 必须确认该章节是否纳入本次范围，落到 in_scope 或 out_of_scope；引用 ≠ 纳入，也 ≠ 排除 |
| 阶段 8 | 二选一且不得混用：**v2** = `hunter-harness plan finalize`（证据包 → 八 target + journal committed + plan-events.ndjson）；**legacy** = 六项标准产物先进入 staging，仅 finalizer 校验成功后发布并写唯一 `phase.end`/log，随后 `verify` 确认 start/end、收据完整覆盖六项标准产物、哈希、全部任务表和非空场景清单一致。失败均不得手工补终态 |
| 发布后改产物 | 用 `harness_plan_finalize.py republish --run-id <全新> --reason "<why>"` 一次完成（新 attempt + 换收据 + 重新派生 manifest）。重跑 `finalize` 会报 `PLAN_FINALIZATION_HASH_CONFLICT`；**绝不手改 `meta/scenario-manifest.json`**（派生物，手改必致 `ARTIFACT_HASH_DRIFT`）→ `reference.md`「发布后修订计划」 |
| v2 输入骨架 | 不要猜 `plan-evidence-input.json` 结构：`npx hunter-harness plan evidence-pack --print-template` 给出**一个字不改就能通过 evidence-pack** 的骨架（结构合法；`change_key`/`run_id` 仍须换成真实身份才能 finalize），逐项替换即可。结构不符时命令返回 `PLAN_EVIDENCE_INPUT_INVALID`，带 `field_path` 与 `problems[]`（缺失/多余键、枚举取值）——按 problems 改完重跑；**不得**为找契约去反编译 `dist/bin.js` 或翻 npx 缓存。带不了 `<>` 的占位字段与硬约束清单 → `reference.md` 阶段 8 v2 路径 |
| Plan 结束 | **禁止**询问执行模式；只提示 `/harness-run` |
| 知识查询 | 阶段 1 失败不得假装已读历史，也不得改用本地索引或其他执行入口 |
| 读命令输出 | `--json` 输出是完整结构，**不得**接 `\| tail -N` / `\| head -N` 后据此判断——截断的 JSON 解析不了，只会逼出一次补读。输出太长时读命令写下的文件（classify → `meta/gate-policy.json`），或用 `bootstrap-plan` 的紧凑摘要 |
| 歧义优先检查 | 否定、对比、动作对象或范围存在多种合理解释时，最小取证后先给推荐理解并一次一问；确认前不深挖错误方向 |
| 简单修复探索预算 | 预计不超过 2 个代码文件、且不涉及认证/安全/迁移/并发/API 契约重设时，最多 1 次合并 CodeGraph 查询 + 1 次定向补查、1 个用户澄清问题；无关发现只记非阻断说明 |
| 精简产物 | 简单修复只保留实现所需的设计、任务、边界和测试；禁止在 spec/plan/detail/scenarios 中重复同一背景和结论 |
| 测试执行成本 | 场景表必须设计快速反馈层级、预计时长、资源预算、超时和可复用证据；默认先跑受影响测试，再跑模块门禁，候选验证只复用身份一致的全量证据 |
| state snapshot | Plan 首次 capture 固定不可变 `changeBase`；后续刷新只更新 HEAD 和各段指纹，不得把当前 HEAD 写回为基线。读取 `state-snapshot.json` 了解 project/worktree root、HEAD/base、profile/rules/map/knowledge 指纹；失效由脚本刷新，**不得仅凭缓存跳过代码探索或验证门禁**（design §3.6） |
| 协议 | sensitive-info / evidence-based-reporting / state-layout |

产出物表、frontmatter、legacy 兼容、结束输出模板 → `reference.md`

## 渐进披露

- **Read `checklist.md`** — 阶段检查与覆盖表
- **Read `protocols.md`** — 阶段 4/6 原生协议
- **Read `reference.md`** — 模板与 worktree JSON

## 交互白名单

1. **设计审批包**（阶段 4）：设计 + **范围（做什么/不做什么）** + 场景表 + worktree + change-name
2. **decision-grilling**（阶段 2/3 澄清）：语义歧义或高风险业务裁决（一次一问）

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`plan`
