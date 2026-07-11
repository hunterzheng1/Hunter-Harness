---
description: harness-review 的原生修复反馈协议。内化 receiving-code-review 能力，但不运行时依赖外部 skill。
---

# harness-review 原生修复反馈协议

本文件定义 `/harness-review` 的 `review-fixback-protocol`。它把 RED/YELLOW 审查建议转成结构化修复反馈，不调用 Superpowers `receiving-code-review`。

## review-fixback-protocol

用于 review 报告生成之后。目标是让 RED/YELLOW 问题可以被后续 run 或人工修复直接消费，同时保持 harness-review 的 advisory 定位。

### 输入

- `reports/review/review-report-YYYYMMDD-HHmm.md`
- 当前 diff 的 RED/YELLOW 问题清单
- `plans/<change-name>-test-scenarios.md`
- `evidence/verification-ledger.json` 与 `evidence/run-task-status.md`（如存在）

### 输出规则

如果存在 RED/YELLOW 问题，必须单独生成结构化 fixback 并写入：

```text
.harness/changes/<change-name>/reports/review/fixback-YYYYMMDD-HHmm.md
```

每条 fixback 必须包含：

| 字段 | 要求 |
|------|------|
| 等级 | RED / YELLOW |
| 影响位置 | 文件路径 + 行号或最小可定位区域 |
| 风险说明 | 说明为什么值得处理 |
| 推荐修复 | 可执行的修复方向，不写空泛建议 |
| 验证方式 | 构建、测试、场景编号或人工确认方式 |
| submit 影响 | 默认 advisory；仅 strict-review-gate=true 时标记阻塞 |

如果没有 RED/YELLOW，必须明确写：

```markdown
无需 fixback：本次 review 未发现 RED/YELLOW 问题。
```

### 定位边界

- harness-review 默认仅供参考，不阻塞 submit/archive。
- `review-fixback-protocol` 只生成修复反馈，不自动修改代码。
- 不得把 YELLOW 写成必须阻塞 submit。
- 只有配置 `strict-review-gate: true` 时，RED 才可标记为阻塞 submit。

### 模板

```markdown
# Review Fixback — <change-name>

## 摘要

- RED: N
- YELLOW: M
- strict-review-gate: true/false

## 修复反馈

| # | 等级 | 影响位置 | 风险说明 | 推荐修复 | 验证方式 | submit 影响 |
|:--:|:----:|----------|----------|----------|----------|-------------|
| 1 | RED | `path/to/file:123` | ... | ... | `test-scenarios.md` API-001 + 构建命令 | advisory / blocking |
```
