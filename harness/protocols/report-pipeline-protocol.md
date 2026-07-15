---
description: 结构化事件、summary-data 生成、final-summary 校验和外部可观测性边界协议（finalize/replay）。
---

# Report Pipeline Protocol

## 核心原则

最终报告分三层：

1. **Event Layer**：`events.ndjson` 记录结构化执行事实。
2. **Report Data Layer**：`summary-data.json` 由程序或确定性规则生成。
3. **Renderer / Final Report Layer**：`final-summary.html` 只渲染和解释 summary-data，不重新推理统计。

模型可以写维护者结论、风险解释和人工判断，但不得凭印象手写统计数字、通过率、耗时、命令结果或 artifact hash。

## 标准命令

Skill-bundled 脚本（推荐）：

```powershell
python <skills-root>/scripts/harness_archive.py finalize --change-dir ".harness/changes/<change-name>" --archive-root ".harness/archive" --json
python <skills-root>/scripts/harness_archive.py replay --archive-dir ".harness/archive/YYYY-MM-DD-<change-name>" --json
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase "<phase>" --type <type> [--note "..."]
```

归档报告流水线只有两个入口，均由 `harness_archive.py` 提供：`collect`/`render`/`validate` 是 `finalize` 的内嵌同进程步骤，**不再作为独立 CLI 暴露**（不存在 `report collect`/`report validate` 子命令）。`summary-data.json` 只能由 `finalize`（归档时）或 `replay`（回放时）生成；**禁止 agent 临场手写或拼装等价的 `summary-data.json`**。`harness_archive.py` 不可用时归档失败退出，不得退回手写汇总。

## events.ndjson

**唯一实时日志源**。Harness skill 只向 `events.ndjson` 追加结构化事件；`logs/execution-log.md` 由 `harness_events.py` 渲染，**禁止手工 Edit**。

事件文件位置：

- 当前变更：`.harness/changes/<change-name>/events.ndjson`
- 历史归档：`.harness/archive/<archive-name>/events.ndjson`

写入方式：

```powershell
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase "<phase>" --type <type> [--note "..."] ...
```

`append` 写入契约（Task 4 §6.1）：普通 append = 加锁 -> 追加一行 -> fsync -> 解锁，**不 load 历史、不渲染**（O(1)，跨进程锁 `events.ndjson.lock`，UUID 用完整 `uuid4().hex`）；仅 `--type phase.end` append 成功后渲染一次 `logs/execution-log.md`；显式 `harness_events.py render` 随时从完整 events 重建；`harness_archive.py finalize` 在 collect 前强制 render 一次。人类可读摘要（触发指令、降级原因、阶段结论）写入事件的 `note` 字段；阶段开始/结束、命令、验证、artifact、问题、决策各写对应 `type` 事件。旧 archive 缺少 events 可回放兼容；新变更不得以 execution-log 已存在为理由跳过 events。

基础事件结构（schema_version 3；兼容读取 v1/v2）：

```json
{
  "schema_version": 3,
  "id": "evt-...",
  "timestamp": "2026-07-02T00:00:00.000Z",
  "phase": "run",
  "type": "command",
  "command": "npm test",
  "exit_code": 0,
  "duration_ms": 42100,
  "run_id": "run-...",
  "attempt": 1,
  "executor_tool": "codex",
  "executor_agent": "main",
  "executor_model": "gpt-5",
  "handoff_from_tool": "claude-code",
  "handoff_reason": "continue implementation",
  "note": "可选：触发指令、降级原因、阶段摘要"
}
```

最低事件类型：

| type | 必填/常用字段 | 用途 |
|---|---|---|
| `phase.start` | phase, timestamp | 阶段开始 |
| `phase.end` | phase, timestamp, status | 阶段结束并记录 `OK/WARN/FAIL/BLOCKED`；计算当前 attempt 耗时 |
| `command` | command, exit_code, duration_ms | 命令事实 |
| `verification` | name, status, command | 验证事实 |
| `artifact` | path, kind | 报告、包、manifest 等产物 |
| `issue` | code, severity, message | 问题和校验发现 |
| `decision` | decision, reason | 人工确认、跳过、复用等决策 |

## summary-data.json

summary-data 必须保留原 archive final report 维度，并增加事件层摘要：

```json
{
  "schemaVersion": "2.2",
  "reportPipeline": {
    "schema_version": 1,
    "generated_at": "2026-07-02T00:00:00.000Z",
    "event_count": 0,
    "sources": ["events.ndjson", "evidence/verification-ledger.json"],
    "phases": {},
    "commands": [],
    "verificationChecks": [],
    "artifacts": [],
    "validationIssues": []
  }
}
```

保留字段：

- `businessGoal`
- `finalStatus`
- `diffStat`
- `stageStatus`
- `durations`
- `skillCalls`
- `verification`
- `timeline`
- `changedFiles`
- `artifacts`
- `reviewSummary`
- `archiveManifest`
- `uncommittedTestEvidence`
- `maintenanceNotes`
- `knownRisks`
- `manualActions`

新增 `reportPipeline` 不替代这些字段；它负责为这些字段提供可追溯的数据来源和一致性校验结果。

## finalize 责任边界（`harness_archive.py finalize`）

| 阶段 | 责任 | 写入 |
|---|---|---|
| `collect` | 从 events/ledger/log/manifest/report/git evidence 收集事实 | `summary-data.json` |
| `render` | 由 `render-summary.mjs` 渲染 final-summary | `final-summary.html` |
| `validate` | 检查 final-summary 是否覆盖 summary-data 关键事实 | issues；不得静默忽略 error |

> **已废弃**：独立 `enrich` 步骤与 `harness-report` skill；全部并入 `finalize` 单命令。回放见 `harness_archive.py replay`。

`validate` error 存在时，`harness-archive` 不得删除原 changes 目录。

## 历史 archive 回放

历史 archive 可能没有 `events.ndjson`。此时：

- 不把缺少 events 当失败；
- 从 `verification-ledger.json`、`execution-log.md`、`archive-manifest-*.json`、旧 `summary-data.json` 回放；
- 在 `reportPipeline.sources` 中标明实际来源；
- 对无法恢复的字段写 `unknown` / `not_available`，不得编造。

## 外部平台边界

当前本地流水线不接入 Langfuse、LangSmith、Temporal。

- 可保留 `reportPipeline.externalTraceRefs[]` 等扩展字段。
- 不得要求外部服务可用才允许 archive 成功。
- 未来接入也必须以 `events.ndjson` 和 `summary-data.json` 为稳定合同，不改变 final-summary 质量维度。
