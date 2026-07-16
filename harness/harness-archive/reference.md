---
description: harness-archive 的归档流程、manifest、summary-data、final-summary 渲染、目录结构与最终状态规则。
---

# harness-archive 参考

## 归档流程（对齐 SKILL.md Workflow）

- **Phase 0 读取上下文**：读 SKILL.md / 本文件 / 共用协议（`../protocols/archive-report-protocol.md`、`../protocols/report-pipeline-protocol.md`、`../protocols/state-layout-protocol.md`、`../protocols/powershell-protocol.md`、`../protocols/sensitive-info-protocol.md`、`../protocols/evidence-based-reporting-protocol.md`）/ 解析 `$ARGUMENTS`。
- **Phase 1 确认归档对象**：Glob `.harness/changes/*/plans/*-plan.md`（排除 archive），展示概要；多变更让用户选择或终止。
- **Phase 2 确认归档（强制阻断）**：AskUserQuestion 确认，拒绝即终止。
- **Phase 3 执行归档**：
  1. 运行 `python <skills-root>/scripts/harness_archive.py status --change-dir ... --json` 做前置检查。
  2. `meta/archive-meta.md` 由 finalize 生成（与 summary `finalStatus` 同源）；禁止手写。维护者结论写入 events 即可。finalize 在 before-manifest 前执行 cleanup（删除 lock/pid/launcher/credential，截断超大日志）。
  3. 运行 `python <skills-root>/scripts/harness_archive.py finalize --change-dir ... --archive-root ".harness/archive" --json`；读 JSON 结果。finalize 内部负责且仅负责一次 `phase.start` / `phase.end`，调用者不得重复追加。**finalize 报错或 validate 失败时不删除原 changes 目录**。
- **Phase 4 验证与提示**：见 `checklist.md` 归档后验证项。

## manifest 生成

manifest 每项包含：

```json
{"path":"...","size":123,"sha256":"...","lastModified":"..."}
```

建议使用固定脚本，禁止内联复杂 PowerShell（包含 `$`、`$_`、`@{}`、script block、管道 JSON 输出）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "harness-skills/harness-archive/scripts/gen-manifest.ps1" -RootPath ".harness/changes/<change>" -OutputPath ".harness/changes/<change>/evidence/archive-manifest-before.json"
```

移动到 archive 目录后，再生成 after manifest：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "harness-skills/harness-archive/scripts/gen-manifest.ps1" -RootPath ".harness/archive/<date-change>" -OutputPath ".harness/archive/<date-change>/evidence/archive-manifest-after.json"
```

**校验 before/after 时排除 execution-log**（通用）：`logs/execution-log.md` 在归档过程会追加结束记录（Phase 4），before（移动前含开始记录）与 after（含开始+结束记录）sha256 必然不同——这是预期追加，非文件损坏。校验脚本需跳过 `logs/execution-log.md`，其他 moved 文件 sha256 必须一致；若其他文件 missing/mismatch，才表示移动损坏，不得删除原目录。

## summary-data.json 与 harness_archive.py

`reports/final/summary-data.json` 只能由 `harness_archive.py finalize`（归档时）或 `replay`（回放时）生成/校验；**禁止 agent 临场手写或拼装等价数据**，也不存在独立的 `report collect`/`report validate` CLI（参见 `../protocols/report-pipeline-protocol.md` 与 `templates/summary-data-template.json` schemaVersion 2.2）。必须保留原 final report 维度。必须包含：

- `businessGoal`：本次变更为了做什么；
- `stageStatus`：plan/run/test/review/submit/archive；
- `diffStat`：filesChanged/insertions/deletions/range —— 来自 `git diff --numstat` + `git diff --stat <base>..<head>`，不得手写；
- `durations`：totalMinutes + stages[{stage,skill,startedAt,endedAt,minutes,result}] —— 从 `logs/execution-log.md` 各 `[N] harness-<skill>` 小节的 `开始`/`结束`/`耗时` 解析；
- `skillCalls`：每个 skill 的调用次数（含重入）+ 结果 —— 从 execution-log 统计；
- `verification`：单元/API/覆盖展示，含 passRate —— 来自 `evidence/verification-ledger.json`；
- `changedFiles`：path/summary/insertions/deletions —— 来自 `git diff --numstat <base>..<head>`；
- `reviewSummary`：red/yellow + redFixed/redConfirmed/yellowFixed/yellowDeferred 修复进度；
- `maintenanceNotes`：给后续维护者看的结论；
- `knownRisks`：剩余风险或人工确认项。

报告必须突出业务目标和维护者结论。所有统计数字只能来自 events、summary-data、ledger 或 manifest，不得手写另一套。历史 archive 没有 `events.ndjson` 时，允许从 ledger/log/manifest 回放，并在 `reportPipeline.sources` 中记录来源。

## final-summary 渲染

默认使用 Node.js 渲染器：

```powershell
powershell.exe -NoProfile -Command "& '<node-path>' 'harness-skills/harness-archive/templates/render-summary.mjs' --summary '.harness/archive/<date-change>/reports/final/summary-data.json' --out '.harness/archive/<date-change>/reports/final/final-summary.html'"
```

如模板脚本位于 skill 目录，则先复制到 archive 目录或直接引用 skill 路径。

禁止模型临场手写大段 HTML。确需临时修 HTML，只能修模板，不得让统计数字脱离 `summary-data.json`。

`validate` 是 `harness_archive.py finalize` 的内嵌同进程步骤（不再作为独立 `report validate` CLI 调用）。finalize 在 validate error 存在时恢复原 `.harness/changes/<change>` 目录并 exit 非 0，绝不归档未通过校验的变更。

## archive-meta.md 模板

由 `harness_archive.py finalize` 生成（手写视为数据丢失）。frontmatter 与 summary-data 同源：

```markdown
---
archive-id: YYYY-MM-DD-<change-name>
change-name: <change-name>
archived-at: YYYY-MM-DD HH:mm
final-commit: <hash>
base-commit: <hash>
final-status: <OK|WARN|CONDITIONAL_OK|FAIL>   # 与 summary-data.finalStatus 同源
source: harness-archive
---
# 归档元数据 — <change-name>
## 阶段状态
## 变更文件
## 已知风险
```

cleanup 步骤（before-manifest 前）：删除 `events.ndjson.lock`、`runtime/*.pid`、launcher、credential/token/secret 文件名；截断 `logs/**/*.log` 超过 64KB 的尾部保留。

## 目录结构与最终状态规则

- 默认渲染器：`templates/render-summary.mjs`，输入 `reports/final/summary-data.json`，输出 `reports/final/final-summary.html`。
- `render-summary.mjs` 是默认 UTF-8 渲染器；finalize 内嵌调用，不得由模型临场写 HTML。
- 新路径优先：`meta/`、`logs/`、`evidence/`、`reports/final/`、`scripts/`、`backups/uncommitted-tests/`。旧路径只做读取兼容，不再写大量根目录文件。
- 当 `summary-data.json.verification.apiTests.status=USER_SKIPPED` 或 `verification.dbCompatibility.status=BLOCKED_BY_DBA`，最终状态必须是 `CONDITIONAL_OK`。
- 复杂 PowerShell 命令写入 `scripts/*.ps1` 后 `-File` 执行，禁止内联 `$` / `$_`。

## 执行日志记录

归档只向 `events.ndjson` 追加事件（schema_version 3，兼容读取 v1/v2）；`logs/execution-log.md` 由 `harness_events.py append` 自动渲染，禁止手工 Edit。事件类型与脚本用法见 SKILL.md `## 执行日志` 与 `../protocols/report-pipeline-protocol.md`。
