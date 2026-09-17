# 阶段 10：优化 Plan 决策澄清与审批

## 依赖与并行边界

必须先完成：

1. 阶段 08 的统一规划契约与模式。
2. 阶段 09 的意图与证据上下文。

阶段 10、11 和 12 共享 Plan 状态机、文档和 finalizer，必须严格串行。本阶段拥有决策节点、问题前沿和设计审批包，不修改产物字段、finalizer 或 Platform 页面。

## 目标

只询问真正需要用户裁决的事项，并根据决策依赖关系分轮提问。设计审批只展示产品行为、重要取舍、风险和验收示例，不混入常规执行配置。

## 当前问题

- 固定一次一问导致普通需求等待多轮。
- 问题预算只限制总数，没有描述问题之间的依赖关系。
- 设计审批包含 worktree、change-name 和完整覆盖表，用户需要同时理解不同层级的信息。
- 场景覆盖在正式测试场景生成前重复展示。
- 事实调查、工程默认值和业务裁决的边界仍主要依赖自然语言判断。

## 设计方案

### 构建设计决策树

每个未决节点标记为以下类型之一：

| 类型 | 处理方式 |
|---|---|
| `fact` | Agent 通过代码、配置、历史知识或文档调查，不询问用户 |
| `engineering-default` | Agent 给出推荐并自动采用，记录理由 |
| `product-decision` | 用户确认范围、行为或兼容性 |
| `risk-decision` | 用户确认权限、安全、迁移、删除或不可逆风险 |

每个节点记录前置节点。只有前置节点已经解决的 `product-decision` 和 `risk-decision` 才能进入当前问题前沿。

```text
DecisionNode = {
  schema_version,
  decision_id,
  type,
  depends_on[],
  status,                    // pending | resolved | blocked | superseded
  question?,
  recommendation?,
  tradeoffs[],
  affected_behaviors[],
  evidence_refs[],
  resolution?,
  resolved_by?,
  resolved_at?
}
```

决策前沿只由 `depends_on` 和机器状态计算；展示顺序或中文标题变化不能改变依赖关系。

### 按前沿分轮提问

提问预算保持有界：

| 模式 | 每轮策略 | 总预算 |
|---|---|---:|
| `quick` | 只问一个阻塞问题 | 0～1 |
| `standard` | 同轮展示最多 3 个互不依赖的问题 | 1～3 |
| `assurance` | 每轮最多 3 个问题，按依赖继续下一轮 | 5～7 |

每个问题必须包含：

- 需要决定什么。
- 推荐答案。
- 推荐理由。
- 主要取舍。
- 不同答案会改变哪些行为或范围。

如果超过预算仍不能收敛，输出未决决策清单并暂停，不继续制造更多问题。

### 精简设计审批包

审批包只展示：

1. 目标和用户可见结果。
2. 明确包含和不包含的范围。
3. 推荐设计和关键替代方案。
4. 关键不变量、失败行为和兼容边界。
5. 主要风险及缓解方式。
6. 3～7 个验收示例。
7. 仍未解决的决策；正常情况下应为空。

审批收据记录审批包哈希、`IntentContract`、`PlanningContext`、所有决策节点版本、审批结果和审批者身份。任一输入变化后旧审批失效，不能只更新 Markdown 而继续复用原收据。

以下内容不再作为审批问题：

- worktree：使用项目策略，进入 Run 时创建。
- `PlannedPhaseSet.planned_phases`：由阶段 08 自动持久化。
- Agent 选择：由执行路由决定。
- 常规 change-name：只展示稳定标识和中文标题。
- 完整 8 维测试覆盖表：在审批后生成正式场景时处理。

### 项目级内容只生成候选

如果 Plan 发现新的领域术语、长期架构决策或项目规则需求，记录为候选：

```yaml
candidate_id: 稳定 ID
candidate_type: glossary | architecture-decision | rule
source_change_key: 来源 Change
rationale: 为什么值得项目级保存
evidence_refs: 来源引用
proposed_content: 建议内容
content_hash: 内容指纹
status: pending
```

Plan 不直接覆盖规则、架构或领域文档。规则候选和可执行架构约束由阶段 07 审阅；架构事实通过阶段 05 重新采集；完整 ADR 与术语候选留在变更记录中。Sync 只提供入口，Push 只负责上传已确认内容。

候选使用阶段 01 的 `ProjectContentCandidate` Schema。Plan 只写入 Change 的机器产物并随归档上传。阶段 07 只消费 `rule` 和可转换为长期约束的 `architecture-decision`；`glossary` 与完整 ADR 仅展示待审状态，不自动应用。不得在 Plan 结束时直接调用 Push 上传项目资料。

只有满足以下条件，才生成 ADR 候选：

- 决策难以撤销。
- 缺少背景时未来维护者会困惑。
- 确实比较过多个可行方案。

## 实施步骤

1. 定义决策节点类型和依赖字段。
2. 将现有问题预算改为决策前沿算法。
3. 实现独立问题同轮、依赖问题分轮的渲染方式。
4. 让 `fact` 节点调用阶段 09 的 `PlanningContext`，不再询问用户。
5. 重写设计审批包，只保留产品和风险层信息。
6. 将 worktree、阶段计划和 Agent 选择从审批包移出。
7. 将完整场景覆盖检查移到产物生成阶段。
8. 增加项目级内容候选格式，但不实现自动发布。
9. 精简事件：记录用户答案、自动采用的重要默认值和阻塞问题，不记录机械自检文案。

## 验收条件

- 普通需求中的独立问题可以在同一轮回答。
- 后续问题不会在前置决策未解决时提前出现。
- Agent 能查到的事实不会转交用户。
- 每个用户问题都有推荐、理由、取舍和影响说明。
- 设计审批不再要求确认 worktree、阶段计划或 Agent。
- 审批发生在 `status: approved` 文档写入之前。
- 项目级规则和架构只形成候选，不被 Plan 直接写入或上传。

## 聚焦测试

- 三个独立问题在一轮展示。
- 存在依赖的两个问题分两轮展示。
- fact 节点通过 EvidenceMap 解决后不询问用户。
- 超过预算后暂停并输出未决清单。
- `quick` 模式零问题直接进入审批。
- 审批取消时不生成 approved 设计文档。
- worktree 和 `PlannedPhaseSet.planned_phases` 不出现在 blocking 问题中。
- ADR 候选只在三个必要条件都满足时生成。

## 非目标

- 不重新分类 `PlanProfile` 或修改 `PlannedPhaseSet`。
- 不重复执行知识查询、Codebase Map 或代码探索。
- 不定义 Plan 最终产物字段或执行 finalizer。
- 不直接应用或上传项目级候选。

## 实施记录

### 10-M1：决策前沿与设计审批纯 Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- DecisionGraph 绑定阶段 08 Profile/阶段集和阶段 09 PlanningContext、Intent、EvidenceMap 的完整可信输入。所有公开入口先执行递归 descriptor-only snapshot；accessor、symbol、Proxy、自定义 prototype、sparse/extra array 和输入 coercion 均无执行失败。
- `fact` 只能由当前 EvidenceMap、PlanningContext 分区和实际 source/ref 证明并使用 `resolved_by=evidence`；`engineering_default` 只能自动采用工程默认并保留理由；`product_decision` 与 `risk_decision` 只能由用户解决。
- canonical graph derivation 统一验证依赖存在、无环、resolved 角色闭包、eligible frontier、轮次、预算、blocked/unresolved、status、reason 和 identity。builder、current parser 和 approval 共用该派生，不能接受自重哈希循环、未知依赖或提前 frontier。
- quick、standard、assurance 分别执行冻结的每轮与总预算；每轮最多三个互不依赖问题。超过预算固定 paused/not publishable，不继续制造问题。worktree、阶段集、Agent 路由和完整覆盖表不形成 blocking 问题。
- PlanningContext 为 `decisions_required` 但缺少对应决策节点时入口 fail closed，不生成 current parser 无法恢复的图。
- `canonicalApprovalPackage(...)` 是七类审批内容的唯一 projector，由 trusted profile、phase set、context、intent、evidence、graph 和独立 package input 完整重建。build、签署和 verify 均使用同一 projector，不信任包或收据自哈希。
- approved 只允许 graph `ready_for_approval`、package `ready` 且无 unresolved/blocker。questions-required 或 not-publishable 不能签发/验证 approved receipt，也不返回 approved 文档；cancelled/rejected 明确返回 null 文档。
- ADR 候选仅在难以撤销、缺少背景会困惑、已比较多个方案三项都成立时生成阶段 01 current pending candidate；Module 不应用、不写项目文档、不调用 Push。
- v0 只读 fail closed；current graph/approval record 缺少可信输入时不能凭自哈希恢复为 current。

完成证据：

- 聚焦测试：`20/20` 通过。
- 阶段 08、09、10 与契约受影响测试：`324/324` 通过。
- 稳定树 Core 全量测试：`60` 个文件、`912/912` 通过。
- Core 类型检查、构建、限定范围 ESLint 和 diff check 通过。
- hostile 矩阵覆盖 getter/Proxy/symbol/coercion、伪造 resolved_by、依赖环/未知依赖/提前 frontier、foreign fact evidence、不可恢复 context、自重哈希 foreign intent/goal package 和 not-publishable approved receipt。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/plan-decision/**`、聚焦测试和 current/legacy fixture；未修改阶段 08/09、现有 Plan 状态机、CLI、Skill、finalizer、OpenAPI 或 Platform。

### 10-M2：交互呈现与答案收集适配器

状态：已关闭。该工作包只负责从已验证的 current `DecisionGraph`/`ApprovalPackage` 机械生成一轮问题呈现，并收集完整或取消的 request-only 意图；不写 Plan 状态、不记录审批、不生成 approved 产物，也不调用 Push。独立终审 Ready，Standards 与 Spec 均为 `Yes`，阻断 finding 为 `0`。

完成证据：

- 聚焦测试：`9/9` 通过，无跳过。
- CLI/Core 类型检查、CLI 构建与 bundle、限定 ESLint 和 diff check 通过。
- 输入边界覆盖 descriptor-only snapshot、Proxy/getter/自定义对象拒绝、graph/frontier 机械派生校验、问题批次 SHA-256 绑定、最多三个问题、规范文本、重复问题、畸形节点和取消/部分答案的零写入行为。
- 修改范围仅为 `packages/cli/src/plan-interaction-presentation/**`、对应聚焦测试和 Core 窄导出；未修改持久化、审批写入、现有 Plan 状态机、Platform 或 OpenAPI。

10-M2 关闭后仍未接入的 Adapter：

- 真实交互宿主的中文界面、用户身份和事件持久化。
- DecisionGraph、ApprovalPackage 和 ApprovalReceipt 的恢复存储及现有 `harness-plan` / Python 状态机接线。
- 项目内容候选到阶段 07/13 的只读消费与归档上传；本 Module 不直接应用或 Push。
- 阶段 11 产物模型与阶段 12 finalizer。二者必须严格串行消费本工作包冻结的 approved receipt。

## 停止条件和回退

如果宿主交互能力无法在一轮稳定展示多个问题，保留决策前沿模型，但按同一轮中的固定顺序逐个呈现。不要退回没有依赖关系的全局问题列表。

如果项目级候选与既有 Sync/Push 方案的 schema 尚未确定，先写入 Plan 的机器收据并标记待消费，不直接创建项目级文件。
