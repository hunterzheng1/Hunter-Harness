# 阶段 08：统一 Plan 规划契约与模式

## 背景与关键结论

当前 `harness-plan` 已具备显式启动、固定 `changeBase`、远端知识唯一入口、内联优先探索、staging、原子 `finalize` 和 `verify` 等必要安全门。本轮不重写生命周期，重点是减少简单需求中的重复分类、无效确认、重复探索和重复文档，同时保持高风险需求的质量门槛。

外部方案只吸收适合 Hunter 的部分：

- Matt Pocock `grilling` 的决策依赖树、事实与决策分离、同一前沿批量提问。
- GitHub Spec Kit 的风险分层和按需质量门。
- OpenSpec 的产物依赖与协同更新。
- GSD 的薄编排器、聚焦上下文和按风险启用研究。

不采用无限盘问、简单任务默认多 Agent、Plan 直接修改项目级规则或架构，以及为所有需求生成完整重型规划体系。

本阶段的 `PlanClassificationModule` 只暴露分类和阶段计划动作。意图提取、证据构建、设计审批和最终发布分别由阶段 09、10 和 12 拥有：

```text
classifyPlan(input) -> PlanProfile
configurePlannedPhases(profile, capabilities) -> PlannedPhaseSet
reclassifyPlan(previousProfile, changedSignals) -> PlanProfile
```

阶段 09～12 可以组成概念上的 Plan 流水线，但不得在本阶段建立第二个覆盖全流程的 Interface。

## 目标

建立唯一的规划分类结果，消除重复分级、阶段配置确认冲突和执行路径漂移。该阶段只调整规划契约与状态流，不同时改造知识查询、审批包或产物格式。

## 依赖与并行边界

- 已完成阶段 01 的共享状态、项目级候选和兼容字段契约。
- 已按阶段 14 的 Plan 专项基线记录当前可获得的耗时、交互、查询、产物和首次结束成功率；缺失项明确标为「待采集」。
- 工作树中没有与 `harness-plan` 相互覆盖的未完成修改；如有，先完成或隔离这些修改。

本阶段只拥有 `PlanProfile`、阶段计划和交互白名单，可与阶段 02、05 和 06A 并行。它不修改知识查询、Codebase Map、规则文件或最终产物格式。

阶段关闭时必须发布 `PlanProfile` 的 schema、旧复杂度字段映射和 fixture。阶段 09～12 只消费该 Interface，不再各自解释 `classify` 原始输出。

## 当前问题

1. 早期 `classify` 已返回风险等级、默认阶段和验证要求，现有 Plan 流程的第 2 阶段又进行复杂度分级。
2. 现有 Plan 流程的 0.6 步要求用户确认旧字段 `plannedPhases`，但交互白名单未允许该独立确认。
3. 执行模式、风险等级和阶段计划分散在自然语言规则中，Agent 可能生成不一致结果。
4. change-name 在状态初始化时已经成为目录标识，设计审批时再次允许常规修改会扩大重命名范围。

## 设计方案

### 使用唯一的 `PlanProfile`

`classify` 是唯一风险和复杂度分类入口。分类结果映射为以下规划模式：

| 模式 | 适用范围 | 澄清 | 探索 | 质量检查 |
|---|---|---|---|---|
| `quick` | 小范围、低风险、行为明确的修复 | 0～1 个问题 | 一次合并探索，必要时一次补查 | 确定性检查 |
| `standard` | 常规功能或跨文件修改 | 一轮或少量分轮 | 结构化影响面探索 | 确定性检查 + 语义一致性检查 |
| `assurance` | 认证、支付、迁移、并发、安全、不可逆操作 | 多轮决策前沿 | 完整影响面和失败路径探索 | 确定性检查 + 语义检查 + 对抗评审 |

不要再创建第二套模型自定义复杂度等级。后续步骤只消费 `classify` 的机器结果和 `PlanProfile`。

`PlanProfile` 至少包含：

```text
PlanProfile = {
  schema_version,
  profile_id,
  mode: quick | standard | assurance,
  risk_signals[],
  required_phases[],
  optional_phases[],
  required_validations[],
  interaction_budget,
  classification_hash,
  reason_codes[],
  created_at,
  supersedes?
}
```

结合项目能力和用户允许的范围后，阶段计划单独持久化为：

```text
PlannedPhaseSet = {
  schema_version,
  phase_set_id,
  profile_classification_hash,
  planned_phases[],
  omitted_phases[],
  capability_snapshot_hash,
  source_reason_codes[],
  created_at,
  supersedes?
}
```

`PlanProfile.required_phases` 表示风险分类要求；`PlannedPhaseSet.planned_phases` 表示已经结合项目能力后冻结的实际阶段。调用方不得把二者当作同一字段，也不得再使用未声明映射的 `plannedPhases` 机器字段。

展示用中文理由由 `reason_codes` 渲染，不作为恢复或门禁输入。风险变化时生成新分类版本并记录替代关系，不能原地覆盖旧收据。

### 自动持久化阶段计划

系统根据 `classify`、项目能力和 Git 状态生成 `PlannedPhaseSet.planned_phases`，然后直接持久化。常规流程不增加单独的用户确认。

需要用户裁决的情况只有：

- 用户明确要求缩小生命周期范围。
- 系统发现用户要求与高风险必需阶段冲突。
- 项目缺少执行某个必需阶段的能力，且不能安全降级。

高风险必需阶段不能通过用户确认伪装为已通过。系统只能将变更标记为提前结束或不可发布。

### 固定交互白名单

Plan 只允许以下 blocking 交互：

1. 未解决的产品或风险决策。
2. 精简设计审批。

`PlannedPhaseSet.planned_phases`、worktree、Agent 选择和常规 change-name 不再形成独立问题。系统可以展示这些信息，但不等待确认。

### 稳定标识与展示名称分离

- change ID 或英文 change-name 是稳定机器标识。
- 中文标题是用户可见名称。
- 设计范围轻微变化时，只更新中文标题和设计内容。
- 只有机器标识明显误导或与新范围冲突时，才使用显式重命名操作。

## 实施步骤

1. 盘点 `classify`、`configure-plan` 和现有 Plan 流程第 2 阶段复杂度分级的所有调用点。
2. 定义 `PlanProfile` 的机器字段、允许值和来源。
3. 让 `classify` 或其适配层返回唯一 `PlanProfile`。
4. 删除现有 Plan 流程第 2 阶段的第二次分类，只保留歧义检查和对分类结果的消费。
5. 将实际阶段计划写入 `PlannedPhaseSet.planned_phases`，并默认自动持久化。
6. 对风险变化建立一次可追踪的重新分类操作，禁止静默覆盖。
7. 统一 `SKILL.md`、协议文档和测试中的交互白名单。
8. 更新监控事件，使用户看到采用的模式和原因，但不产生无意义的确认事件。

## 预计影响文件

- `harness/harness-plan/SKILL.md`
- `harness/harness-plan/protocols.md`
- `harness/harness-plan/checklist.md`
- `harness/scripts/harness_gate.py`
- `harness/scripts/harness_context.py`
- 对应的 Python 和 CLI 测试

实际实施前应通过 CodeGraph 和引用搜索确认完整调用面，不以本列表替代代码调查。

## 验收条件

- 每次 Plan 只产生一个风险分类和一个 `PlanProfile`。
- 普通需求不会单独询问 `PlannedPhaseSet.planned_phases`。
- 交互白名单与实际流程一致。
- 无 Git 项目不会错误加入 `submit`。
- 高风险项目不能省略机器判定的必需阶段。
- 范围变化后的重新分类有明确事件和原因。
- change-name 不会在设计审批时被无条件重新生成。

## 聚焦测试

- `quick`、`standard`、`assurance` 三类映射测试。
- 无 Git、无远端、快速迭代和高风险项目的阶段计划测试。
- 用户要求跳过普通可选阶段的测试。
- 用户要求跳过高风险必需阶段的拒绝或提前结束测试。
- 风险在设计后升级时的重新分类测试。
- 交互测试：普通流程只出现允许的 blocking 交互。

## 非目标

- 不定义 `IntentContract`、`PlanningContext`、设计审批包或 finalizer Interface。
- 不查询知识、读取 Codebase Map 或生成 Plan 人类产物。
- 不让 `PlanProfile` 直接写规则、架构或项目资料。
- 不保留两套同时有效的复杂度或阶段计划字段。

## 停止条件和回退

出现以下情况时停止该阶段，不继续修改现有 Plan 流程的第 2 阶段：

- 现有 `classify` 无法稳定表达 Plan 所需信息。
- `PlannedPhaseSet.planned_phases` 的持久化格式需要跨版本迁移，但迁移方案尚未确定。
- Run、Test 或 Archive 仍依赖被删除的旧复杂度字段。

回退时保留旧字段读取兼容，恢复旧写入路径。不要同时保留两套有效分类源。

## 主要参考

- [Matt Pocock `grilling`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)
- [Matt Pocock `domain-modeling`](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md)
- [Matt Pocock `writing-for-agents`](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md)
- [GitHub Spec Kit Quickstart](https://github.com/github/spec-kit/blob/main/docs/quickstart.md)
- [OpenSpec OPSX](https://github.com/Fission-AI/OpenSpec/blob/main/docs/opsx.md)
- [GSD Core](https://github.com/open-gsd/gsd-core)
