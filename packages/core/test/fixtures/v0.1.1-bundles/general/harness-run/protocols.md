---
description: harness-run 的原生执行协议。内化 TDD 与变更簇审查能力，但不运行时依赖 Superpowers。
---

# harness-run 原生执行协议

本文件定义 `/harness-run` 的内置执行协议。它吸收 test-driven-development 与 subagent-driven-development 的有效做法，但正式流程不调用 Superpowers，也不把外部 skill 是否存在作为执行条件。

## 协议一：run-tdd-protocol

用于每个变更簇。目标是保留 RED→GREEN→REFACTOR 的行为约束，同时允许 harness 按证据分级处理缺失测试基础设施的现实情况。

### RED 三态

| RED 类型 | 何时使用 | 证据要求 |
|----------|----------|----------|
| 真实 RED | 测试基础设施可用，能写测试并运行失败 | 测试编译通过，失败断言指向目标行为 |
| 静态 RED | 测试基础设施不可用或目标层无法真实验证 | 记录降级原因、静态验证场景、待 harness-test 验证场景 |
| 复用 RED | 计划和测试场景已明确失败场景，且本轮只执行同一场景的实现 | 引用 test-scenarios 编号与前序证据，仍需在 run 日志登记 |

RED 失败原因必须与目标 bug 或需求直接相关。无效 RED（测试搭建错误、private 访问限制、mock/stubbing 错误、依赖注入失败、NPE 来自测试夹具）不得进入 GREEN。

### GREEN

GREEN 只做让当前变更簇通过的最小实现。不得顺手处理无关重构、顺手扩范围、或把未确认业务决策写入代码。

### REFACTOR

REFACTOR 只允许不改变行为的整理。若重构改变行为，必须回到 RED/GREEN。重构后重新运行当前变更簇对应验证；若无法运行真实测试，必须更新静态验证说明。

### 证据写入

每个变更簇结束必须写入或更新：

- `evidence/verification-ledger.json`：构建/测试命令、证据、diffHash、复用状态。
- `evidence/run-task-status.md`：任务状态、对应场景、未验证项。
- `logs/execution-log.md`：RED 类型、GREEN 结果、REFACTOR 结果、验证证据。
- `events.ndjson`：关键 command / verification / issue / artifact 事件。

禁止把静态验证写成“测试通过”。静态 RED/GREEN 的最终状态至少是 🟡WARN，除非后续真实验证已完成。

## 协议二：change-cluster-review-protocol

用于高风险变更簇后的轻量审查。它内化 subagent-driven-development 的“新上下文审查”价值，但不把每个变更簇的 subagent 审查设为默认流程。

### 触发条件

满足**全部**条件时启用：

- 变更簇命中高风险（数据迁移、权限、安全、并发、幂等、核心契约变更、缺真实测试证据等，见原触发列表任一）
- `python <skills-root>/scripts/harness_preflight.py check-agents --skills-root <skills-root> --agent harness-reviewer --json` 返回 `usable=true`

未满足时记录“跳过变更簇审查：低风险 / reviewer 不可用 / 后续 harness-review 覆盖”，不得视为降级。

### 审查方式

`usable=true` 时委派只读 `harness-reviewer` 审查当前变更簇 diff。**不 retry**；无效返回 → 主会话 checklist 自审，记 `decision` 事件。

审查范围只限当前变更簇：

- 是否偏离 plan / implementation-detail。
- 是否遗漏 test-scenarios 中的 P0/P1 场景。
- 是否破坏 API、数据、权限、安全或兼容契约。
- 是否引入非计划文件、临时 debug、敏感信息或过程性注释。

### 输出

审查结论写入当前 run 日志：

```markdown
### 变更簇审查 — <cluster>
- 触发原因: <risk trigger>
- 方式: reviewer / 主会话自审 / 跳过
- 结论: OK / YELLOW / RED
- 问题: <文件:行 + 建议>
```

RED 问题必须在当前 run 中处理或明确记录为未处理风险；YELLOW 问题可交给后续 `/harness-review`。
