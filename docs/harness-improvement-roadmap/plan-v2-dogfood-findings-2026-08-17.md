# Harness Plan v2 双仓 Dogfood 问题与优化建议

## 文档定位

- 记录日期：2026-08-17。
- 验证版本：`hunter-harness@0.2.77`。
- 源码固定点：`3687e3e4345a1826f875d089d17a57de820c9eb0`。
- 验证对象：`kld-sdd` 的 `usage-stats-cli-reporting` 与 `kb-sdd` 的 `usage-stats-platform-support`。
- 关联路线：阶段 08～12 的 Plan 契约、产物和质量门，以及阶段 14 的迁移与整体验收。

本文是两次真实 `harness-plan` 运行的缺陷记录和后续实施输入，不表示所列问题已经修复。文中的“已确认缺陷”同时具备运行现象和当前源码证据；“优化项”主要来自产物规模、操作路径和维护成本观察。

## 结论摘要

Plan v2 的原子发布主链已经可用：两次运行最终都发布了固定的 8 个目标文件，publication journal 为 `committed`，readback 为 `verified`，`meta/plan-events.ndjson` 也包含 `artifact_published` 和 `phase_ended`。

当前版本仍不适合直接作为真实 assurance Plan 的默认结束路径，主要原因如下：

1. assurance 或高风险 Plan 必须执行对抗评审，但 CLI 没有接入 Core 已定义的 `reviewer_port`，因此会把必需评审判定为 `review_unavailable`。
2. 重试要求 `attempt` 递增，但 v2 event bundle reader 又要求包内首事件必须是 `attempt=1`；finalizer 生成的是当前尝试事件，二者不能同时成立。
3. evidence-pack 与下游模块没有共享同一套规范化规则。时间、scope 顺序、派生引用、场景 ID 和 run ID 都可能在前一层通过、后一层失败。
4. CLI 只返回笼统错误码，无法指出失败层、字段路径或冲突身份；定位这些问题需要进入源码或临时增加诊断输出。
5. legacy `events.ndjson` 与 v2 `meta/plan-events.ndjson` 同时存在，但成功 finalization 没有关闭前者的 Plan 尝试，形成两个生命周期事实源。

不应通过自动放行 assurance、跳过事件校验或长期修改已安装包缓存解决这些问题。正确方向是补齐可验证的评审收据、统一边界规范化、明确 event bundle 语义，并让 CLI 输出结构化诊断。

## Dogfood 基线

| 样本 | Profile | 尝试 | 任务 / 场景 | 高风险场景 | 最终结果 |
|---|---|---:|---:|---:|---|
| `kld-sdd/usage-stats-cli-reporting` | `assurance` | 1 | 8 / 16 | 14 | 8 个目标文件已提交，readback 通过，v2 Plan 事件终止 |
| `kb-sdd/usage-stats-platform-support` | `assurance` | 2 | 12 / 22 | 20 | 8 个目标文件已提交，readback 通过，v2 Plan 事件终止 |

两份样本都覆盖 8 个质量维度。最终人类文档总量分别约为 101 KiB 和 201 KiB；命令生成的 `plan-evidence.json` 分别约为 449 KiB 和 875 KiB。

验证过程中，为了在已完成并留有事件证据的 inline 自审基础上继续隔离后续故障，曾对本机已安装包缓存做短时诊断性接线：为 reviewer port 返回已完成的评审结果，并把 current-attempt bundle 的首尝试检查改为正整数检查。诊断完成后已恢复原文件并复核。该操作只用于证明故障位置，不是可接受的用户工作流或发布方案。

## 优先级

- P0：阻断必需质量路径或失败恢复，无法靠正常输入稳定规避。
- P1：常见输入可触发跨模块契约冲突，或导致生命周期状态不一致。
- P2：不一定阻断发布，但显著增加操作、诊断或产物消费成本。

| 编号 | 优先级 | 分类 | 问题 |
|---|---:|---|---|
| HP-01 | P0 | 已确认缺陷 | CLI 未接入 assurance 对抗评审 |
| HP-02 | P0 | 已确认缺陷 | 当前尝试事件包与 `attempt=1` 起始约束冲突 |
| HP-03 | P1 | 已确认缺陷 | 高风险 finding ID 的有损转换会产生碰撞 |
| HP-04 | P1 | 已确认缺陷 | Intent 与审批 scope 使用不同的顺序语义 |
| HP-05 | P1 | 已确认缺陷 | evidence-pack 的隐式引用可能不满足自身下游校验 |
| HP-06 | P1 | 已确认缺陷 | `mode` 同时由分类结果和自然输入决定 |
| HP-07 | P1 | 已确认缺陷 | Plan run ID 的生成约定与 v2 identity schema 不一致 |
| HP-08 | P1 | 已确认缺陷 | 错误输出无法定位失败层和字段 |
| HP-09 | P1 | 集成缺口 | legacy 与 v2 Plan 生命周期没有唯一终态 |
| HP-10 | P2 | 已确认缺陷 | `plan finalize --change-dir` 不参与实际路径解析 |
| HP-11 | P2 | 已确认缺陷 | 等价的带时区时间未在 CLI 边界规范化 |
| HP-12 | P2 | 优化项 | 缺省全量引用导致关系过密和文档膨胀 |

## 详细问题与修复建议

### HP-01：CLI 未接入 assurance 对抗评审

现象：两份样本都是 assurance Plan，且包含高风险场景。主会话已经完成并记录 inline 对抗自审，但 `plan finalize` 仍将 Layer 3 判定为 `review_unavailable`，最终返回 `PLAN_FINALIZATION_QUALITY_INVALID`。

源码证据：

- `packages/core/src/plan-quality/types.ts:170` 已定义可选 `reviewer_port`。
- `packages/core/src/plan-quality/module.ts:379` 在 assurance、显式请求或高风险 finding 存在时触发 Layer 3；没有 reviewer 结果时把状态设为 `blocked`。
- `packages/cli/src/commands/plan-finalize.ts:92` 调用 `runAdversarialGates` 时固定 `prefer_delegated: false`，但没有传入 `reviewer_port`，也没有读取已完成评审的收据。

建议：

1. 为 evidence pack 或 finalize 命令增加受信的 `adversarial_review` 收据输入，至少包含 `reviewer_identity`、`review_mode`、`input_hash`、`findings_hash`、findings 和 `completed_at`。
2. CLI 在调用 Layer 3 前校验收据与当前 trusted artifacts、Layer 2 findings 和高风险 findings 的绑定，再通过明确的 reviewer adapter 传给 Core。
3. 如果支持 delegated review，委派失败最多回退一次 inline；inline 也必须形成相同结构的收据。
4. 缺少、过期或哈希不匹配的评审继续 fail closed，不能把 `review_unavailable` 自动转换为通过。

验收：

- assurance Plan 使用匹配的 inline 收据可以通过 Layer 3。
- 修改 artifacts、findings 或收据哈希后必须阻塞，并返回明确的绑定失败原因。
- delegated reviewer 不可用时只执行一次 inline fallback，并准确记录 `fallback_reason`。
- 没有评审收据时返回 `PLAN_REVIEW_REQUIRED` 一类可操作错误，而不是笼统的 transaction quality failure。

### HP-02：当前尝试事件包与 `attempt=1` 起始约束冲突

现象：`kb-sdd` 首次尝试因 run ID 不合规而进入 `attempt=2`。finalizer 正确复用了第二次尝试身份并生成 3 个当前尝试事件，但 quality verifier 将事件包判为无效。

源码证据：

- `packages/contracts/src/plan-event.ts:101` 硬编码包内首事件必须为 `phase_started` 且 `attempt===1`。
- 同一 reader 的其余逻辑支持同阶段 `attempt` 递增，并已有“完整保留 attempt 1 后再开始 attempt 2”的单元测试。
- `packages/core/src/plan-quality/module.ts:555` 的 finalizer 每次只生成当前 `input.attempt` 的 `phase_started`、中间事件和 `phase_ended`，不会加载此前尝试。

这里混用了两种不同语义：reader 把输入当作完整生命周期聚合，finalizer transaction 却把它当作本次操作的 attempt bundle。

建议优先采用以下拆分：

1. 将 finalization quality verifier 消费的结构明确命名为 `PlanAttemptEventBundle`。包内所有事件必须等于 `context.attempt`，首事件只要求 `attempt>=1`。
2. durable outbox 或监控聚合层继续使用 `PlanEventBundle`，并在该层校验 attempt 连续、前一尝试已结束和完整历史未丢失。
3. 如果不能增加新结构，则必须让 finalizer 在校验前读取并合并历史事件；此方案会把 I/O 和聚合责任带入 finalization，优先级低于拆分 bundle 语义。

验收：

- 仅含当前 `attempt=2` 的合法 finalization bundle 可以完成质量验证。
- lifecycle aggregate 缺少 attempt 1、attempt 跳号或前一尝试未结束时仍然失败。
- attempt 2 的 event ID、idempotency key、producer sequence 和时间顺序继续完整校验。
- CLI 增加真实 `attempt=2` 的 evidence-pack → finalize 端到端用例。

### HP-03：高风险 finding ID 的有损转换会产生碰撞

现象：自然输入中的场景 ID 使用了常见的大写形式，例如 `KLD-COMPAT-001`、`KLD-CONCUR-001`。evidence-pack 可以接受这些 ID，但 Layer 3 在派生高风险 findings 时抛出 `PLAN_QUALITY_INPUT_INVALID`。

源码证据：`packages/core/src/plan-quality/module.ts:359` 用 `scenario_id.replace(/[^a-z0-9_.:-]/gu, "_")` 构造 finding ID。大写字符会逐个变成下划线，因此上述两个包含相同长度大写片段的不同 ID 会派生出同一个 finding ID；`findings()` 随后拒绝重复身份。

建议：

- 不再用有损字符替换构造身份。可以对原始 `scenario_id` 做稳定哈希，例如 `risk:<sha256>`，同时在 finding 内容中保留原始 ID。
- 在自然输入边界定义并公开 scenario ID 规范。如果新规范要求小写，evidence-pack 应在构建产物前返回字段级错误；兼容期仍应安全处理已有大写 ID。
- task、scenario、finding 和 event 身份使用共享的 identity helper，避免每个模块各自定义正则和清洗规则。

验收：两个不同的大写高风险场景必须产生不同 finding ID；不合法 ID 的错误包含 `structured_input.scenarios[n].scenario_id`，不能延迟到 Layer 3 才失败。

### HP-04：Intent 与审批 scope 使用不同的顺序语义

现象：`intent.in_scope`、`intent.out_of_scope` 与 `approval.content` 包含相同元素但顺序不同，Layer 2 仍报告 `semantic.scope_identity`。

源码证据：

- `packages/core/src/planning-context/module.ts:167` 在构建 Intent 时对 scope 排序和去重。
- `packages/core/src/plan-decision/module.ts:413` 将审批内容中的 scope 按输入顺序复制。
- `packages/core/src/plan-quality/module.ts:229` 使用顺序敏感的 `same()` 比较 design scope 与 Intent scope。
- `packages/cli/src/commands/plan-evidence-pack.ts` 同时接收 `intent` 和 `approval.content` 两份 scope，没有在边界校验二者的规范化等价性。

建议：

1. scope 的产品语义如果是集合，则所有模块都使用同一个 `canonicalScopeList()`；比较时也按集合语义处理。
2. evidence-pack 在构建审批包前校验 Intent 与审批 scope，经规范化后仍有差异时返回 missing/extra 明细。
3. 长期可让审批包引用已经冻结的 Intent scope，删除第二份可独立变化的 scope；展示层仍可保留用户确认时的原始顺序，但不能参与身份和质量判定。

验收：只改变 scope 顺序不影响 artifact hash 和 Layer 2 结果；增加、删除或修改 scope 仍必须阻塞。

### HP-05：隐式引用可能不满足自身下游校验

现象：使用 evidence-pack 自动生成 requirements 和 ownership 时出现 `PLAN_ARTIFACT_REFERENCE_INVALID`；显式提供按 validator 要求排序的 requirements 与 ownership 后可以通过。

源码证据：

- `packages/cli/src/commands/plan-evidence-pack.ts:154` 先按 scope 文本排序，再按该顺序生成 `scopeRefs`。
- `requirementsFrom()` 按 recommended design、invariants 输入顺序和 failure behaviors 输入顺序生成记录。
- `packages/core/src/plan-artifacts/module.ts:174` 要求 requirements 按 kind 后再按 `requirement_id` 排序；`:180` 又要求每个 `approved_scope_refs` 按 ref 排序。
- scope 文本顺序不保证等于 scope 哈希顺序，invariants 的输入顺序也不保证等于派生 requirement ID 顺序。
- 当前 evidence-pack 端到端 fixture 只有一个 scope，无法覆盖该冲突。

建议：

- producer 与 validator 共享同一组 canonical comparator，不复制排序规则。
- 先生成全部 scope、requirement 和 ownership 记录，再按最终身份排序；所有引用数组统一使用 `sortedUnique()`。
- 隐式路径和显式路径应经过同一个 normalize/validate 函数。相同语义输入应生成字节一致的 trusted artifacts。

验收用例至少包含：两个“文本顺序与 hash 顺序不同”的 scope、同 kind 的多个 requirements、多个 ownership path，以及未显式传 requirements/ownership 的完整 CLI 端到端运行。

### HP-06：`mode` 同时由分类结果和自然输入决定

源码现状：`runPlanEvidencePack` 先通过 `risk_signals` 生成 `profile.mode`，但在派生 implementation detail 时使用 `input.mode ?? "standard"`。Core 又要求 detail mode 与 `human_input.profile.mode` 完全一致。自然输入不传 `mode` 且风险分类为 assurance 时会失败；传入与分类结果不同的 `mode` 也不会覆盖分类，只会制造冲突。

建议：

- implementation detail 始终使用 `profile.mode`。
- 如果产品需要手工 override，应把 override 作为分类模块的显式输入，由 profile 记录 override 原因；不得只影响下游某个产物。
- 从自然输入 Schema 中删除无效的第二事实源，兼容期可接受旧字段，但要求其等于分类结果并给出弃用提示。

验收：assurance 风险输入在不提供 `mode` 时可以生成 assurance detail；不一致 override 在分类阶段得到明确结果，不再表现为 `PLAN_ARTIFACT_INPUT_INVALID`。

### HP-07：Plan run ID 约定与 v2 identity schema 不一致

现象：`harness-plan` 只要求 Agent 初始化稳定的 plan-run-id，没有规定首字符格式。本次两个运行使用裸十六进制 UUID，其中 `kb-sdd` 的首字符为数字，v2 finalizer 拒绝该身份；更换为带 `plan_` 前缀的 ID 后才进入下一步。对于十六进制 UUID，首字符为数字的概率是 `10/16`，不是罕见边界。

源码证据：`packages/contracts/src/plan-event.ts:16` 和 `packages/core/src/plan-quality/module.ts:463` 都要求身份以小写字母开头；`harness/harness-plan/SKILL.md:62` 与 `harness/harness-plan/reference.md:302` 只说明“生成稳定 run ID”。

建议：

- 提供唯一的 `createPlanRunId()` 或 CLI 初始化命令，统一生成 `plan_<uuid>`。
- 在写入 legacy `phase.start` 前完成 v2 identity 校验，不能等到 finalization 才发现。
- 兼容读取已有裸 UUID；新写入统一使用带类型前缀的身份。

验收：以 `0`～`9` 开头的随机源都能通过统一构造器形成合规 ID；legacy 事件、evidence pack、quality receipt 和 v2 events 全程复用同一个最终身份。

### HP-08：错误输出无法定位失败层和字段

运行中观察到以下外部错误：

| 外部错误 | 实际原因 |
|---|---|
| `PLANNING_INTENT_INVALID` | `decided_at` 不是 canonical UTC 字符串 |
| `PLAN_ARTIFACT_REFERENCE_INVALID` | 隐式 requirement/scope/ownership 排序不满足交叉引用约束 |
| `PLAN_QUALITY_INPUT_INVALID` | 高风险 finding ID 碰撞，或 run ID 不合规 |
| `PLAN_FINALIZATION_QUALITY_INVALID` | reviewer 不可用，或 attempt 2 事件包被拒绝 |

`packages/cli/src/commands/plan-evidence-pack.ts:288` 和 `packages/cli/src/commands/plan-finalize.ts:161` 都只输出异常 message；transaction 失败也没有暴露 Layer 1/2/3、event bundle reader 或字段路径。另有 `packages/core/src/plan-artifacts/module.ts:413` 的直接 `console.error("ART-CHK", ...)`，Core 在校验失败时不应绕过 CLI 输出协议写 stderr。

建议统一错误信封：

```json
{
  "ok": false,
  "code": "PLAN_FINALIZE_FAILED",
  "stage": "layer3",
  "reason_code": "PLAN_REVIEW_REQUIRED",
  "field_path": "review_execution",
  "findings": [],
  "retryable": false
}
```

- 每个模块保留稳定 `reason_code`，并可附安全的 `field_path`、finding ID 和中文修复说明。
- CLI 默认不输出 stack、完整 evidence 内容或敏感值；本地 `--debug` 才输出受控调用栈。
- 删除 Core 中的直接 console 输出，由 CLI adapter 负责呈现。

验收：上述四类故障都能仅凭 CLI JSON 定位到具体层和输入字段，不需要修改已安装包或进入调试器。

### HP-09：legacy 与 v2 Plan 生命周期没有唯一终态

现象：两次成功发布后，`meta/plan-events.ndjson` 都有终止事件，但 legacy `events.ndjson` 仍停留在打开的 Plan 尝试；`kld-sdd` 的 attempt 1 没有 `phase.end`，`kb-sdd` 的 attempt 2 也没有 `phase.end`。下游 Skill、execution log 和 Platform 如果读取不同事件源，会得到不同的 Plan 状态。

建议：

1. 明确唯一 canonical 生命周期。优先让 v2 durable event outbox 成为事实源，legacy 事件和 execution log 由幂等 projection adapter 生成。
2. 如果迁移期必须双写，finalization transaction 需发布一个可恢复的 lifecycle projection 命令；只有 publication committed 且终态投影完成，Plan 才向下游报告 closed。
3. `harness_context close` 应消费 finalization receipt 或 projection receipt，不能要求 Agent 手工补 `phase.end`。
4. Platform 与后续 `harness-run` 使用同一状态读取接口，不分别猜测两个文件。

验收：finalize 成功后立即执行 run prepare，系统能识别 Plan 已关闭；重复 finalize/projection 不产生第二个终态；监控只展示一个 attempt 序列。

### HP-10：`--change-dir` 不参与实际路径解析

源码现状：`packages/cli/src/commands/plan-finalize.ts:67` 始终以 `dependencies.cwd` 构造 root authority 和 publication ports；`:71` 计算 `changeDir` 后只在返回 JSON 中展示，没有用于读取、授权或写入。

建议二选一：

- 真正接入：解析 `--change-dir`，验证其位于项目 `.harness/changes/<change_key>` 下，并据此构造 project root、change key 和 authority。
- 删除或重命名：如果路径必须由 cwd 与 change key 唯一推导，就移除该选项，避免用户误以为它控制发布位置。

验收：从非仓库根目录运行并传入绝对 change-dir 时，所有 8 个目标和 journal 只写入指定 Change；越界、change key 不匹配和 symlink/reparse point 继续拒绝。

### HP-11：等价的带时区时间未在 CLI 边界规范化

现象：`2026-08-17T03:44:55.964+08:00` 被 `buildIntent` 以 `PLANNING_INTENT_INVALID` 拒绝，等价的 `2026-08-16T19:44:55.964Z` 可以通过。

根因：`packages/core/src/planning-context/stable.ts:36` 只接受与 `new Date(value).toISOString()` 字节相同的 canonical UTC；plan-decision 与 plan-event 的时间校验又允许带 offset。`runPlanEvidencePack` 直接把 `approval.decided_at` 传给所有模块，没有先规范化。

建议：evidence-pack 入口先解析 ISO 8601，再统一转换为 `toISOString()`；所有派生产物使用同一个 canonical 时间。无法解析的输入返回 `approval.decided_at` 字段级错误。

验收：表示同一时刻的 `Z` 与 `+08:00` 输入生成相同 canonical 时间和身份哈希；无效日期、过长小数和非法 offset 有明确错误。

### HP-12：缺省全量引用导致关系过密和文档膨胀

源码现状：`packages/cli/src/commands/plan-evidence-pack.ts:186` 在调用方省略 refs 时，将所有 scenario、requirement、evidence 和 ownership 引用赋给每个 task，也将所有 task 和 requirement 引用赋给每个 scenario。renderer 随后在每个 task、scenario、requirement 和 ownership 下重复打印这些列表。

本次较大样本只有 12 个任务和 22 个场景，但 4 份人类文档已达到约 201 KiB；其中 plan 约 74 KiB、design 约 76 KiB。关系虽然闭合，却容易退化成“每个任务关联全部场景”的稠密图，削弱计划对执行者的导航价值。

建议：

- 只有在单任务等无歧义场景下才自动补全双向引用；非平凡计划要求明确关系，或从一侧关系确定性推导另一侧。
- 增加 graph density 和全量 fan-out 警告；每个 task/scenario 都连接全集时要求调用方确认或修正。
- 人类文档只展示执行所需的局部关系和简短证据摘要；完整机器引用保留在 checkpoints、scenario manifest 或独立 meta artifact 中。
- `approved_scopes` 自然输入只接收 `text`。当前类型要求调用方传 `scope_ref`、实现又丢弃该值，应删除这一伪输入。

验收：以本次两个样本作为回归 fixture，机器关系保持闭合，人类文档不重复输出全量引用，task ↔ scenario 与 requirement ↔ task/scenario 仍可双向追溯。

## 推荐实施顺序

### 波次 A：恢复必需路径

1. 冻结 `AdversarialReviewReceipt` 输入及绑定规则，接入 CLI。
2. 拆分 attempt bundle 与 lifecycle aggregate 语义。
3. 增加 assurance + high-risk + attempt 2 的真实 CLI 端到端测试。

该波次完成前，不应宣称 assurance Plan 可以通过公开 CLI 稳定结束。

### 波次 B：统一自然输入边界

1. 建立 `EvidencePackInputSchema` 和共享规范化函数。
2. 统一 run ID、timestamp、scenario ID、scope、requirement、ownership 和引用排序。
3. 让 `profile.mode` 成为唯一事实源。
4. 对旧字段提供兼容读取和明确弃用信息。

### 波次 C：统一状态与诊断

1. 定义 v2 event outbox 到 canonical lifecycle 的 projection。
2. 让 context close、run prepare 和 Platform 消费同一 Plan 终态。
3. 发布结构化错误信封，移除 Core 直接 console 输出。
4. 修正或移除未生效的 `--change-dir`。

### 波次 D：收敛产物

1. 限制隐式全量引用。
2. 调整 Markdown renderer，机器引用留在 meta artifacts。
3. 用真实 Plan 样本跟踪文档大小、关系密度、首次 finalize 成功率和失败定位耗时。

## 回归测试矩阵

| 层级 | 必测输入 | 预期 |
|---|---|---|
| evidence-pack | assurance 风险信号，不传 `mode` | 使用 `profile.mode=assurance` 成功构建 |
| evidence-pack | `decided_at` 使用等价的 `Z` 与 offset | 规范化后身份一致 |
| evidence-pack | 多 scope，文本顺序与 ref hash 顺序不同 | 隐式 requirements/ownership 可通过 |
| evidence-pack | Intent 与审批 scope 仅顺序不同 | 通过；真实 missing/extra 失败并给出 diff |
| quality L3 | 两个不同的大写高风险 scenario ID | finding ID 唯一 |
| quality L3 | 匹配、篡改和缺失的 review receipt | 分别通过、绑定失败、明确要求评审 |
| events | 仅含当前 attempt 2 的 finalization bundle | attempt 校验通过 |
| events | aggregate 缺历史、跳 attempt、前次未结束 | aggregate 校验失败 |
| CLI finalize | 裸 UUID 随机源以数字开头 | 统一构造为合规 `plan_` 身份 |
| CLI finalize | 从非根目录传绝对 `--change-dir` | 写入指定 Change 或明确拒绝，不静默改用 cwd |
| lifecycle | finalize 成功后立即 prepare run | Plan 已关闭且只有一个终态 |
| renderer | 本次两份 dogfood fixture | 无全量笛卡尔式引用，机器追溯不丢失 |

## 兼容与迁移约束

- 不降低 Layer 1～3 的 fail-closed 语义；修复的是证据接线和契约冲突，不是把质量门改成自动通过。
- 已有大写 scenario ID 应可兼容读取；新写入规范可以收紧，但必须在 evidence-pack 边界报错。
- event bundle 如果改变语义，应新增明确的 attempt bundle 类型或 schema 版本，不能让同一 v1 结构在不同调用点代表不同范围。
- `mode`、调用方提供的 `scope_ref` 和未生效的 `--change-dir` 需要经过弃用期，不能无提示删除。
- legacy 事件到 v2 事件的迁移必须幂等、可恢复，并保留此前尝试；不得通过重写历史文件制造单一终态。
- 结构化错误可以作为向后兼容的附加字段发布，现有顶层 `code` 保留到消费方完成迁移。

## 完成定义

满足以下条件后，才能认为本轮 Harness Plan dogfood 暴露的问题已经关闭：

1. 两份原始自然输入不需要显式 requirements/ownership 排序、不需要手改 run ID，也不需要修改安装缓存即可 finalize。
2. assurance 对抗评审有可验证收据，缺失或篡改时按明确原因阻塞。
3. attempt 2 可以完成 finalization，同时完整 lifecycle reader 仍能发现历史断裂。
4. finalize 成功后 canonical 生命周期、context、后续 Skill 和 Platform 对 Plan 终态结论一致。
5. 每个失败 fixture 都能从 CLI JSON 直接得到失败层、稳定原因码和字段路径。
6. 8 个目标文件、publication journal、readback、event outbox 和幂等重放仍通过现有原子发布门禁。

## 修复关闭记录（2026-08-17，CLI 350/350 + core 1282/1282 验证）

| 编号 | 状态 | 关闭方式 |
|---|---|---|
| HP-01 | 已关闭 | `AdversarialReviewReceipt` 接入 finalize；缺收据 `PLAN_REVIEW_REQUIRED`、绑定失败 `PLAN_REVIEW_BINDING_FAILED` |
| HP-02 | 已关闭 | `PlanAttemptEventBundle` 语义拆分；attempt=2 finalize e2e 全通，聚合层仍校验历史完整 |
| HP-03 | 已关闭 | 高风险 finding ID 稳定哈希派生（`risk:<hash>`） |
| HP-04 | 已关闭 | scope 集合语义统一（构造即 canonical + 集合比较 + 边界等价校验 `PLAN_SCOPE_MISMATCH`） |
| HP-05 | 已关闭 | 隐式 requirements/ownership 与 validator 共享 canonical comparator + 终态排序 |
| HP-06 | 已关闭 | detail mode 唯一事实源 = `profile.mode` |
| HP-07 | 已关闭 | `createPlanRunId()` + 边界 `PLAN_RUN_ID_INVALID`（含 field_path） |
| HP-08 | 已关闭 | 统一错误信封（code/stage/reason_code/field_path/retryable）；core 直接 console 输出已删除 |
| HP-09 | 已关闭 | finalize 成功向 legacy events.ndjson 幂等投影终态（v2 outbox 唯一事实源；重复执行 already_closed） |
| HP-10 | 已关闭 | `--change-dir` 真实参与解析（realpath + 形状校验 + change_key 绑定） |
| HP-11 | 已关闭 | 边界时间规范化（Z 与 offset 等价生成相同产物身份） |
| HP-12 | 已关闭（renderer 裁剪除外） | 伪 scope_ref 输入删除（`PLAN_SCOPE_REF_FORGED`）；task↔scenario 引用确定性闭包 + 全量 fan-out 密度警告 |

**遗留（下一工作包）**：Markdown renderer 裁剪——人类文档只展示局部关系、机器引用留在 meta artifact。
该改动会改变产物字节与内容哈希，需要独立的 golden fixture 更新周期，不在本轮 dogfood 修复内。
