---
description: harness-execute 的原生执行协议。内化 TDD 与变更簇审查能力，但不运行时依赖 Superpowers。
---

# harness-execute 原生执行协议

本文件定义 `/harness-execute` 的内置执行协议。它吸收 test-driven-development 与 subagent-driven-development 的有效做法，但正式流程不调用 Superpowers，也不把外部 skill 是否存在作为执行条件。

## 协议一：run-tdd-protocol

用于每个变更簇。目标是保留 RED→GREEN→REFACTOR 的行为约束，同时允许 harness 按证据分级处理缺失测试基础设施的现实情况。

### RED 三态

| RED 类型 | 何时使用 | 证据要求 |
|----------|----------|----------|
| 真实 RED | 测试基础设施可用，能写测试并运行失败 | 测试编译通过，失败断言指向目标行为 |
| 静态 RED | 测试基础设施不可用或目标层无法真实验证 | 记录降级原因、静态验证场景、待 harness-execute 验证场景 |
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
- `events.ndjson`：关键 command / verification / issue / artifact 事件；RED 类型、GREEN 结果、REFACTOR 结果和验证证据放入事件 `note`。

执行日志是上述事件在阶段边界生成的只读投影，不作为变更簇的直接输出目标。

禁止把静态验证写成“测试通过”。静态 RED/GREEN 的最终状态至少是 🟡WARN，除非后续真实验证已完成。

上述分级只评估 `ownerPhase=run` 的任务和场景。`ownerPhase=test` 的验证按计划留给测试阶段时，记录为“待测试阶段执行”，不得将编码阶段降级为 WARN；后续阶段未开始不是当前阶段的风险。

## 协议二：change-cluster-review-protocol

用于高风险变更簇后的轻量审查。它内化 subagent-driven-development 的“新上下文审查”价值，但不把每个变更簇的 subagent 审查设为默认流程。

### 触发条件

满足**全部**条件时启用：

- 变更簇命中高风险（数据迁移、权限、安全、并发、幂等、核心契约变更、缺真实测试证据等，见原触发列表任一）
- 当前宿主已显式提供隔离 reviewer 能力；需要固定 reviewer 时，单次 `check-agents` 返回 `executionMode=delegated`

未满足时记录“跳过变更簇隔离审查：低风险 / 正常 inline / 后续 harness-review 覆盖”，不得视为降级或显示不可用告警。

### 审查方式

`executionMode=delegated` 时委派只读 `harness-reviewer` 审查当前变更簇 diff。**不 retry**；spawn 失败或无效返回 → 主会话 checklist 自审，记一次 `issue` 事件。

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

## fixback 证据契约

> `launch-review` 的返回体里带 `evidenceContract` 字段，内容与本节一致。这里写一份是因为
> 光靠运行时返回，调用方往往已经动手改代码了才看到。

### 命令链

```text
run-start（修复前，采 RED）→ 改代码 → run-start（修复后，采 GREEN）
  → evidence-template ×2 → register-evidence ×2 → resolve-issue
  → run-start（受影响链）→ evidence-template --kind verification
  → evidence-template --kind review → close
```

### 别手写证据 JSON

证据文件的 `provenance` 需要 `sessionId` / `commandHash` / `resultDigest` / `runReceiptPath`
四个字段，全部能从 `session.json` 直接读出来。用模板生成，不要手抄：

```text
python <skills-root>/scripts/harness_fixback.py evidence-template \
  --change-dir <change-dir> --kind red|green|verification|review \
  --session <sessionId> --out <证据 JSON 路径> --json
```

输出即可直接喂给 `register-evidence`。撞 `FIXBACK_RUN_PROVENANCE_INVALID` 时，错误体会点名
**哪个字段、期望什么、实际什么**——按它改，不要去读实现反推。

### `--product-identity`

产品身份指纹，把 RED/GREEN 绑定到同一产品状态。规范取值是**当前 git HEAD**。省略即自动推导，
`launch-review` 会在返回体的 `resolvedProductIdentity` 里回显；`close --final-product-identity`
**原样引用那个值**，不要另行推导——推导方式不同就会撞 `FIXBACK_GREEN_IDENTITY_MISMATCH`。

### RED 必须在修复之前

RED 证明问题真实存在，GREEN 证明修复真的生效。先改完再把改动回退来凑 RED，证明的只是回退后的
状态，不是原始缺陷，中途还会留下脏工作树。

### close 的两张收据与 review-findings.json

`close` 要 `--affected-receipt`（`kind=verification`，受影响链的托管会话）和 `--review-receipt`
（`kind=review`，指向 `reports/review/review-findings.json`）。

review 收据的放行规则按 **disposition**，不按 severity：

| disposition | 是否阻塞 | 说明 |
|---|---|---|
| `OPEN` / 未登记 | ❌ 阻塞 | 还没人处置，必须先给结论 |
| `FIXED` / `NOT_APPLICABLE` | ✅ 放行 | 已闭环 |
| `ACCEPTED_RISK` / `DEFERRED` | ✅ 放行 | 记入收据 `residualRisks` 留痕 |

> ⚠️ **不要为了让 close 通过而清空或删改 `review-findings.json`。** 它是发现的真相源，写空等于
> 抹掉整轮审查的审计轨迹。处置结论属于另一个 sidecar：
>
> ```text
> python <skills-root>/scripts/harness_review.py write-dispositions \
>   --change-dir <change-dir> --input <dispositions.json>
> ```
