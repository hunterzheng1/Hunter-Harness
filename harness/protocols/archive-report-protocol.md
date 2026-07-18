---
description: harness-archive 的数据化归档和 final-summary 渲染协议。用于减少模型长篇 HTML 生成、提升数据准确性和页面一致性。
---

# Archive Report Protocol

## 原则

archive 不应让模型临场生成 500+ 行 HTML。事实收集与校验由 `harness_archive.py finalize` 单命令完成（cleanup → **freeze（事件 cutoff）** → collect → source consistency → render → renderer consistency → validate → archive-meta 内嵌）；模型仅通过 events 写入维护结论。`meta/archive-meta.md` 由 finalize 生成，禁止手写。历史 archive 回放用 `harness_archive.py replay`（只读，不写 archive-meta / 不跑 cleanup）。

`knownRisks` 仅收录 severity∈{warning,error,critical} 的 issue 事件；无 severity 的 issue 进入 `maintenanceNotes`。`finalStatusReasons` 解释 CONDITIONAL_OK/WARN/FAIL 原因。finalize 在 before-manifest 前 cleanup：删除 lock/pid/launcher/credential，截断超大日志。

详见 `report-pipeline-protocol.md`。本协议保留 archive final report 的维度要求，report pipeline 负责把这些维度程序化生成和校验。

## 必备产物

归档目录必须包含：

```text
archive-meta.md
archive-manifest-before.json
archive-manifest-after.json
summary-data.json
final-summary.html
events.ndjson（新流程推荐；历史 archive 可缺失）
```

## summary-data.json

结构来源为 `harness-archive/templates/summary-data-template.json`（schemaVersion 2.3）。默认由 `harness_archive.py finalize` 生成；历史回放用 `harness_archive.py replay`。

```json
{
  "schemaVersion": "2.3",
  "changeName": "...",
  "businessGoal": "本次变更为了做什么",
  "finalCommit": "...",
  "finalCommitBranch": "origin/...",
  "baseCommit": "...",
  "diffStat": {"filesChanged": 0, "insertions": 0, "deletions": 0, "range": "<base>..<head>"},
  "stageStatus": {
    "plan": "OK/FAIL",
    "run": "WARN/OK/FAIL",
    "test": "OK/PARTIAL/BLOCKED/FAIL",
    "review": "ADVISORY",
    "submit": "OK/WARN/FAIL",
    "archive": "OK/FAIL"
  },
  "durations": {
    "totalLabel": "约 N 分",
    "totalMinutes": 0,
    "stages": [{"stage":"plan","skill":"harness-plan","startedAt":"...","endedAt":"...","minutes":0,"result":"OK"}]
  },
  "skillCalls": [{"skill":"harness-plan","count":1,"result":"OK"}],
  "verification": {
    "unitTests": {"run": 0, "failures": 0, "errors": 0, "skipped": 0, "passRate": "183/185"},
    "apiTests": {"total": 0, "passed": 0, "failed": 0, "blocked": 0, "passRate": "34/35"},
    "coverageDisplay": "29/29"
  },
  "timeline": [],
  "changedFiles": [{"path":"...","summary":"...","insertions":0,"deletions":0}],
  "artifacts": [],
  "reviewSummary": {"status":"ADVISORY","red":0,"yellow":0,"redFixed":0,"redConfirmed":0,"yellowFixed":0,"yellowDeferred":0,"summary":""},
  "archiveManifest": {},
  "uncommittedTestEvidence": [],
  "maintenanceNotes": [],
  "knownRisks": [],
  "manualActions": [],
  "reportPipeline": {
    "schema_version": 1,
    "generated_at": "...",
    "event_count": 0,
    "sources": [],
    "phases": {},
    "commands": [],
    "verificationChecks": [],
    "artifacts": [],
    "validationIssues": [],
    "sourceConsistency": {"ok": true, "issues": []}
  }
}
```

`final-summary.html` 的数字必须全部来自 events、`summary-data.json`、ledger 或 manifest，不得手写另一套统计。

### 数据采集来源（禁止手写统计）

- `diffStat` / `changedFiles[].insertions`/`deletions`：来自 `git diff --numstat <base>..<head>` 与 `git diff --stat <base>..<head>`，不得手写。
- `durations`：从 `logs/execution-log.md` 各 `[N] harness-<skill>` 小节的 `开始`/`结束`/`耗时` 解析；`totalMinutes` 为各 stage `minutes` 之和。含用户确认等待的阶段须在该 stage 的 `result` 或 `maintenanceNotes` 注明，不得把等待时间伪装成纯执行时间。
- `skillCalls`：从 execution-log 统计每个 `harness-<skill>` 小节出现次数（含重入）及结果。
- `verification` 各项及 `passRate`：来自 `evidence/verification-ledger.json`，不得手写通过率。
- `reviewSummary.redFixed`/`redConfirmed`/`yellowFixed`/`yellowDeferred`：从 review 报告清单 + 后续修复提交 diff 比对得出，不得手写。
- `artifacts[]`：本次变更构建出的可分发 package 产物（如 `.jar`/`.war`/`.zip`/`.tar`/`.gz`/`.dll`/`.exe`/`.whl`/`.nupkg` 等）。来自项目构建输出目录扫描（按构建工具识别产物路径，如 Maven `target/*.jar`、Gradle `build/libs/*`、npm `dist/*`、.NET `bin/Release/*`），每项记录 `name`（basename）、`path`（相对仓库根）、`size`、`sha256`（`Get-FileHash -Algorithm SHA256` 计算），不得手写。无构建产物时留空数组（renderer 不渲染该卡）。注意：归档 manifest（`archive-manifest-after.json`）记录的是 `.harness/archive/` 目录文件，不包含项目构建产物，两者不可混用。
- `reportPipeline.commands[]` / `verificationChecks[]` / `validationIssues[]`：来自 `events.ndjson`、ledger、validate 结果。旧 archive 无 events 时可从 ledger/log/manifest 回放，不得编造。

## manifest/checksum

archive 前后生成文件清单，包含 path、size、sha256。before/after 统计不一致时，不得删除原目录。

manifest 必须使用固定脚本生成，禁止内联包含 `$`、`$_`、`@{}`、script block、管道 JSON 输出的 PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "harness-skills/harness-archive/scripts/gen-manifest.ps1" -RootPath ".harness/changes/<change>" -OutputPath ".harness/changes/<change>/evidence/archive-manifest-before.json"
```

最终报告必须区分：

- movedFiles：实际移动的文件数；
- generatedFiles：archive 过程中生成的文件数；
- totalArchiveFiles：归档目录最终文件总数。

## 页面内容

final-summary 必须突出：

1. 本次变更业务目标；
2. 代码变更统计（diffStat：文件数 / insertions / deletions）；
3. 各阶段耗时与 Skill 调用统计（durations / skillCalls）；
4. 验证结果与复用/重测来源（含通过率）；
5. review advisory 摘要（含修复进度：已修复 / 已确认 / 留后续）；
6. 给后续维护者的结论；
7. 已知风险或人工确认项。

禁止出现顶部 `N/A`、正文 `100%` 这类互相矛盾的数据。


## final-summary 信息密度要求

`summary-data.json` 至少包含 `verification`、`artifacts`、`reviewSummary`、`archiveManifest`、`maintenanceNotes`、`knownRisks`、`manualActions`。renderer 只根据 JSON 渲染，不在 HTML 中重新推理数据。

`artifacts` 与 `uncommittedTestEvidence` 为空数组时，renderer 不渲染对应卡片（"📦 产物清单"/"🧪 未提交测试证据"），避免空态噪音；非空才渲染。字段在 JSON 中始终保留，仅控制是否展示。

## 渲染器

默认渲染器为 Node.js：

```powershell
powershell.exe -NoProfile -Command "& '<node-path>' 'harness-skills/harness-archive/templates/render-summary.mjs' --summary '.harness/changes/<change>/reports/final/summary-data.json' --out '.harness/changes/<change>/reports/final/final-summary.html'"
```

PowerShell HTML renderer 仅作 legacy fallback。该脚本以 UTF-8 with BOM 保存，确保 Windows PowerShell 5.1 正确识别编码（无 BOM 会被 5.1 按 ANSI/GBK 误读导致中文 label 乱码）；默认渲染器仍为 Node.js `render-summary.mjs`。

**Python fallback（`harness_archive.py` 内置）**：Node 不可用/超时/exit 非 0/未产出文件时，`harness_archive.py render_final_summary` 自动降级为内置 Python fallback（`render_fallback_html`），渲染含 changeName、finalStatus、`reportPipeline.commands`（command/exitCode）、`verification`（unitTests/apiTests/dbCompatibility）、changedFiles、archiveManifest、knownRisks、manualActions、maintenanceNotes 的确定性 HTML；USER_SKIPPED/BLOCKED_BY_DBA/失败状态可见，所有动态值 HTML 转义。返回结构统一为 `{ok, renderer: node|python-fallback|none, fallbackReason, out_path}`。Node 与 Python fallback **都失败**（`renderer=none, ok=false`）时，finalize 立即恢复原 change 目录并 exit 非 0，**绝不归档无 final-summary.html 的变更**。

`validate` 是 `harness_archive.py finalize` 的内嵌同进程步骤（不存在独立 `report validate` CLI）；validate error 存在时，finalize 恢复原 changes 目录并 exit 非 0，绝不删除原 changes 目录。**缺 final-summary.html 恒为 validate error**（不再有"没有 HTML 但只 warning"的分支）。

## 冻结优先 finalize 与两层一致性（schemaVersion 2.3 起）

finalize 在 collect 之前**冻结事件事实**：所有 archive-fact 事件落盘并 fsync 后，写入唯一的 `phase.end` 与 `evidence/evidence-cutoff.json`（`eventCount` + `sha256` + `frozenAt`）。cutoff 之后**禁止再向归档 events.ndjson 追加任何事件**；后续报告生成事实（render/validate 结果、manifest 比对）只写入 finalize JSON payload 与 maintenance outbox，不回写事件流。collect 是纯函数：stage/timeline/durations 全部由冻结事件推导，**不存在选择性 patch 步骤**。

两层 validator 顺序执行，任何一层失败都恢复原 change 目录并非零退出：

1. **source consistency**（`validate_source_consistency`，render 前）：summary 事实对照冻结来源——`event_count` 对 cutoff、verification 对 ledger typed metrics projection、review 计数对 sidecars。结果写入 `reportPipeline.sourceConsistency = {ok, issues}`；`ok=false` 时 issue code 含 `event-count-mismatch` / `verification-mismatch`。
2. **renderer consistency**（`validate_summary`，render 后）：HTML 对照 summary-data，数字不得漂移。

## versioned repair（不改写原归档）

`replay` 保持只读。归档后发现不一致时，用显式修复：

```powershell
python harness/scripts/harness_archive.py repair --archive-dir ".harness/archive/<archive-id>" --json
```

repair 先在 archive 外生成候选 derived version，两层 validator 均通过后，才以不可变新版本写入 `derived/v<N>/{summary-data.json, final-summary.html, repair-record.json}`，并把 `derived/authoritative.json` pointer 指向该版本；**原 summary-data.json、final-summary.html 与 manifest 永不覆盖**。知识层只从 authoritative pointer 指向且 hash 校验通过的版本提取条目。

## 归档与知识维护解耦（§8）

archive close 的破坏性事务只执行确定性 close：

```text
status -> manifest -> move -> collect -> render -> validate -> compare
-> 写 maintenance outbox(pending) -> stop AI service -> return
```

close **不再同步顺序启动四次** `harness_knowledge.py`（ingest/dedupe/auto-supersede/reverify-stale）。它写一个 `pending` outbox 项即返回，`knowledgeMaintenance=QUEUED`；写 outbox 失败时 `NOT_QUEUED`（warning，不回滚 archive，`finalStatus` 仍由验证事实决定，本次总状态 CONDITIONAL）。

outbox 布局见 `state-layout-protocol.md`「knowledge maintenance-outbox」。`harness_knowledge.py maintain --project . --archive-id <id>` 单进程推进：claim pending/failed -> running -> 增量 ingest（含 in-memory near-dedupe，不再二次磁盘 dedupe）-> auto-supersede -> reverify-stale -> 导出残余 judge checklist -> completed（或 `completed_rules_pending_judge` 若 `pendingJudgements>0`）。失败 -> failed（attempts+1，可重试）；completed 项幂等。`harness-sync` 启动时扫描 pending/failed outbox 并执行 maintain。

**机械 maintain 不得假装完成语义裁决**：存在待裁决项（conflict / promote-candidate）时状态为 `completed_rules_pending_judge`、`pendingJudgements>0`、写 `pending-judgements-<archive-id>.json`，由模型层后续 `judge --apply` 处理；`manualReview=true` 时保留人工确认。

## 最终状态

当 `apiTests.status=USER_SKIPPED` 或 `dbCompatibility=BLOCKED_BY_DBA` 时，最终状态不得写纯 `OK`，必须写：

```text
CONDITIONAL_OK
```

并在 `knownRisks` / `manualActions` 中说明风险接受和后续人工动作。

## 未提交测试证据

run/test 本轮新增、更新或安全修复且被 `.gitignore` 忽略的测试，必须先由 `test-tracking.json` + `harness_test_guard.py stage` 精确提交；这类测试不得继续作为“未提交证据”收尾，也不得计入可复用 P0 验证后随 worktree 删除。

`uncommittedTestEvidence` 只兼容历史归档或明确只读的外部证据：归档到 `backups/uncommitted-tests/`，记录文件名、验证范围与未提交原因，并在 final-summary 展示风险。若它是本轮可修改的回归测试，则 archive 必须阻断并要求先走精确跟踪流程。
