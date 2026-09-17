# 阶段 11：收敛 Plan 产物与文档

## 依赖与并行边界

必须先完成阶段 10 的精简设计审批。只有审批输入稳定后，才能调整产物生成顺序和真相源。

阶段 10～12 必须串行。本阶段拥有 Plan 人类真相源、机器派生物和兼容渲染器；不修改决策前沿、质量策略或 Platform 展示。Platform 可以使用旧 fixture 并行制作页面骨架，但必须在本阶段字段冻结后完成最终接入。

## 目标

减少规划产物之间的重复内容，并缩短 Agent 每次运行需要读取的指导文档。保持现有 finalizer 兼容，分阶段迁移到更清晰的人类真相源和机器派生产物。

## 当前问题

- `SKILL.md`、`protocols.md`、`checklist.md` 和 `reference.md` 重复描述同一规则。
- design、plan、implementation-detail 和 test-scenarios 容易复制背景、风险和实现说明。
- 设计审批前展示完整覆盖表，审批后又生成正式场景。
- 模型执行叙述式自检，finalizer 随后再次进行确定性校验。
- 简单任务也必须人工生成完整 `implementation-detail.md`。

## 目标产物模型

### 人类真相源

| 产物 | 唯一职责 |
|---|---|
| `design.md` | 目标、行为契约、约束、不变量、方案取舍和兼容边界 |
| `plan.md` | 任务、依赖、受影响文件、执行顺序和阶段归属 |
| `test-scenarios.md` | 验收场景、执行层级、证据要求和不适用原因 |

### 机器产物

| 产物 | 来源 |
|---|---|
| `gate-policy.json` | `PlanProfile`、项目能力和设计能力 |
| `worktree.json` | 项目执行策略 |
| `implementation-checkpoints.json` | `plan.md` 派生 |
| `scenario-manifest.json` | `test-scenarios.md` 派生 |
| finalization receipt | 标准输入、哈希和生命周期派生 |

所有机器产物必须包含 `schema_version`、`source_hashes` 和生成器版本。派生物不得被人工编辑；检测到内容与来源哈希不一致时重新生成，而不是把派生物当作第四个人类真相源。

### `implementation-detail.md` 的过渡策略

当前 finalizer 要求 `implementation-detail.md` 存在。短期不直接删除：

- 所有模式都把 `implementation-detail.md` 作为兼容派生视图，来源只能是已批准的 `design.md`、`plan.md` 和 `test-scenarios.md`。
- `quick`：生成简短执行视图，只包含关键修改点、命令和容易误判的边界。
- `standard`：派生接口、数据约束、模块顺序和测试策略。
- `assurance`：在派生视图中增加迁移顺序、失败恢复、并发、权限和回滚说明。
- 该文件不得人工编辑；来源哈希变化时重新生成，内容漂移时以三份人类真相源为准。

长期是否把该文件改为可选项，应在完成兼容迁移和消费者盘点后单独决定。

## 内容分工

### `design.md`

保留：

- 为什么修改。
- 用户可见行为。
- 明确不做什么。
- 接口和关键不变量。
- 失败行为。
- 方案比较与最终决策。
- 适用时的兼容、迁移、回滚和可观测性要求。

移除：

- 完整任务清单。
- 重复的测试执行命令。
- 与 `plan.md` 相同的文件列表说明。

### `plan.md`

保留：

- 任务 ID 和任务目标。
- 受影响路径。
- 任务依赖。
- owner phase。
- 对应设计决策和场景 ID。

移除：

- 重复背景。
- 大段设计解释。
- 逐行代码草稿。
- 固定 2～5 分钟机械微步骤。

### `test-scenarios.md`

完整场景在设计审批后生成。8 个覆盖维度不是强制制造场景的清单，而是适用性检查：

- 适用时必须有场景。
- 不适用时必须说明原因。
- 高风险维度不得无理由标记为不适用。

## Agent 指导文档收敛

目标层次：

1. `SKILL.md`：只保留顺序、路由、完成条件和必要硬门。
2. 规划策略文档：只保留问题预算、模式和质量镜头。
3. 产物 schema：集中定义字段、模板和兼容规则。
4. finalizer：实现所有可确定验证。

应删除以下重复：

- 同一问题预算在多个文件重复。
- 同一审批包字段在多个文件重复。
- 同一场景覆盖表在协议和 checklist 重复。
- finalizer 已能判断的文件和哈希条件仍要求模型逐条复述。
- 环境可以直接查询的命令、路径和默认值被多处缓存。

## 实施步骤

1. 建立规则重复矩阵，确定每条规则的唯一权威位置。
2. 先调整产物字段和渲染器，不立即删除旧兼容字段。
3. 将审批前的覆盖表替换为验收示例。
4. 将正式覆盖检查移入 `test-scenarios.md` 生成过程。
5. 为 `quick` 模式实现 `implementation-detail.md` 派生器。
6. 让 finalizer 继续校验六项标准输入，直到完成版本迁移。
7. 缩短 `SKILL.md`，使用明确指针按分支加载策略和 schema。
8. 删除 checklist 中已由 finalizer 确定执行的项目。
9. 更新测试，证明同一事实只在一个人类产物中维护。

## 验收条件

- design、plan 和 scenarios 的职责不重叠。
- `quick` 模式不再人工重复编写 implementation detail。
- 设计审批前不生成完整 8 维覆盖表。
- finalizer 的六项输入兼容性保持不变，除非有单独迁移版本。
- Agent 运行 Plan 时不需要无条件读取四份完整指导文档。
- 删除重复规则后，所有分支仍能通过指针加载必要约束。
- 旧变更目录仍能被读取和验证。

## 聚焦测试

- 同一简单需求的三份人类真相源不存在重复背景段落，兼容派生视图不引入新事实。
- `quick` 的 detail 由 plan 稳定派生且幂等。
- 修改 plan 后，派生 checkpoints 和 detail 同步更新。
- 场景适用与不适用原因都能被解析。
- 旧格式 frontmatter 和六项标准输入仍能验证。
- 指针触发测试：高风险分支加载高风险策略，简单分支不加载。

## 非目标

- 不在本阶段改变决策前沿或重新进行设计审批。
- 不把 `implementation-detail.md` 保留为第四份人类真相源。
- 不删除下游仍需兼容读取的旧文件或字段。
- 不在文档中重复 finalizer 已能确定执行的结构检查。

## 实施记录

### 11-M1：Plan 产物模型与兼容派生纯 Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `design / plan / test_scenarios` 是唯一三份人类真相源。Module 从阶段 08～10 的 trusted profile、phase set、PlanningContext、Intent、EvidenceMap、DecisionGraph、ApprovalPackage/Receipt 和结构化输入重建 canonical HumanArtifactSet。
- design 只包含目标、行为、约束、不变量、方案取舍和兼容边界；plan 只包含 task、依赖、路径、owner phase、decision/scenario refs；scenarios 只包含验收层级、证据、适用性和不适用原因。三者不引入相互重复的新事实。
- plan task 依赖必须存在且无环，owner phase 必须属于当前 `planned_phases`。quick 阶段集不能把任务伪归属到未计划的 test/review 等阶段。
- 八个覆盖维度逐项表达 applicable 或带理由的 not-applicable；高风险维度不能无理由跳过。
- gate policy、worktree、implementation checkpoints 和 scenario manifest 全部由 trusted HumanArtifactSet、Profile 和能力输入派生，包含 schema、source hashes、冻结 generator version、content hash 与稳定 ID，不能人工成为第四真相源。
- `implementation-detail` 是模式有界的兼容派生视图。quick 只保留关键修改、命令和易误判边界；standard/assurance 逐级增加接口、迁移、失败恢复、并发、权限和 rollback，但不增加人类来源中不存在的事实。
- machine/detail/verify 均携带完整 `human_input`，通过唯一 `canonicalHumanArtifacts` 从 trusted 输入重建 expected HumanArtifactSet，再与候选 exact 比较。修改 plan 会同步改变 checkpoints 和 detail；人工修改 objective 后自重哈希仍拒绝。
- `MODULE_GENERATOR_VERSION` 是唯一冻结常量；验证不能从待验产物读取 expected generator。source/content/set hash、ID、深冻结和 descriptor-only runtime 边界均严格校验。
- legacy 只接受已知 `approved` frontmatter 和精确 canonical 六文件集合，保持只读；未知状态、重排、缺失或 traversal 路径 fail closed。现有 finalizer 未被修改。

完成证据：

- 聚焦测试：`14/14` 通过。
- 阶段 08～11 与契约受影响测试：`338/338` 通过。
- 稳定树 Core 全量测试：`61` 个文件、`934/934` 通过。
- Core/root 类型检查、Core 构建、限定范围 ESLint 和 diff check 通过。
- hostile 矩阵覆盖取消审批、foreign profile、人工 objective 自重哈希、evil generator、task cycle/dangling、未计划 owner phase、覆盖缺理由、source drift、accessor 和 legacy 状态/路径。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/plan-artifacts/**`、聚焦测试和 current/legacy fixture；未修改阶段 10、阶段 12、现有 finalizer、CLI、Skill、指导文档、OpenAPI 或 Platform。

11-M1 关闭后仍未接入的 Adapter：

- Markdown/JSON 渲染、真实文件系统写入、CAS/原子发布、恢复和人工编辑漂移处理。
- 现有 finalizer 六文件输入与 current machine artifacts 的兼容 Adapter；迁移前不删除旧文件或字段。
- `harness-plan` Skill、protocol/checklist/reference 的指针化裁剪，以及 Run/Review/Archive/Platform 消费者迁移。
- 阶段 12 分层质量门与 finalization receipt；只能消费本工作包冻结的 artifact identities。

### 11-M2：v2 语义引用与 ownership 契约扩展

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

冻结的 current v2 增量：

- current `HumanArtifactBuildInput`、ArtifactIdentity、人类/机器产物、detail、builder、derive、verify 和输出全部固定 `schema_version=2` 与 generator `/2`；schema v1 不能继续写 current 产物。
- v1 使用独立 LegacyV1 types 和 exact parser，只允许冻结的 generator `/1` 与旧字段，拒绝 v2 requirements、scope/ownership 和引用字段混入；normalize 只返回 `legacy_read_only`，没有 derive 路径。
- design structured input 使用稳定 requirement records：`behavior | invariant | failure_behavior` 各有唯一 ID、文本、evidence refs 和 approved scope refs。
- approved scope 与 ownership 是稳定 records；plan task 增加 requirement/evidence/ownership refs，affected paths 必须由 ownership 覆盖且满足 canonical path；scenario 增加 task/requirement refs。
- canonical builder 验证全集、唯一、dangling、cycle、evidence/scope/ownership、每个 requirement 至少由 task 与 scenario 覆盖。
- `task.scenario_refs` 与 `scenario.task_refs` 双向精确一致；scenario 的每个 requirement 必须由其 `task_refs` 中至少一个 task 实现，防止交叉错配被固化进 checkpoints/manifest。
- machine artifacts、implementation detail、verify 和 current normalizer 全部从同一 v2 canonical HumanArtifactSet 重建，修改引用后自重哈希仍无效。

完成证据：

- 聚焦测试：`19/19` 通过。
- 阶段 08～11 受影响测试：`80/80` 通过。
- Root/Core 类型检查、Core 构建、限定范围与根 ESLint、diff check 通过。
- hostile 矩阵覆盖 v1 current 写入、v1/v2 混合 wire、双向 task/scenario 错配、局部 requirement 错配、dangling evidence/ownership 和 self-hash mismatch。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改仍限于 `packages/core/src/plan-artifacts/**`、聚焦测试和 v0/v1/v2 fixture；未修改阶段 12 或旧 finalizer。

11-M2 关闭后仍未接入的 Adapter：

- v1 持久目录到 v2 current 的显式迁移写入与回滚；v1 在迁移前保持只读。
- v2 Markdown/JSON renderer、真实存储/发布 Adapter 和旧 finalizer 六文件兼容投影。
- 阶段 12 必须只消费 v2 requirement、scope、ownership、task/scenario refs 做确定语义检查，不得退回文本相似度猜测。

## 停止条件和回退

如果发现 Run、Review、Archive 或 Platform 直接依赖 `implementation-detail.md` 的特定自由文本结构，先记录消费者契约并提供兼容适配。不要在同一提交中删除文件并修改所有下游消费者。

如果文档缩减导致 Agent 漏掉硬门，把硬门迁移到机器校验或 SKILL 主流程。不要仅靠恢复整份长 checklist 解决。
