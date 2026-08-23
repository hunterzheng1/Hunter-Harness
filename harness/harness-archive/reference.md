---
description: harness-archive 的归档流程、manifest、summary-data 校验、目录结构与最终状态规则。
---

# harness-archive 参考

## 归档流程（对齐 SKILL.md Workflow）

- **Phase 0 读取上下文**：读 SKILL.md，解析 `$ARGUMENTS`，刷新一次状态快照。常规路径不预读全部参考资料。
- **Phase 1 确认归档对象**：使用 `harness_change.py resolve` 解析 contract/state 双层目录；多变更让用户选择或终止。
- **Phase 2 确定归档结局**：已有明确指令时直接使用；只有结局不明确或需要认领既有提交范围时才询问。
- **Phase 3 执行归档**：
  1. 运行一次 `python <skills-root>/scripts/harness_archive.py execute --change-dir ... --archive-root ".harness/archive" --intent <...> --closure <...> --json`。不要预先运行 `auto-gate` 或 `status`，也不要随后直接运行 `finalize`。候选收据缺失时，`execute` 会先尝试复用完整且身份一致的 `unitTestFull` ledger；产品内容未变化而 HEAD 因提交前移时，只重绑定候选身份，不重跑测试。
  2. `execute` 在同一进程中复用预检结果，并负责且仅负责一次正式 `phase.start` / `phase.end`。准备耗时单独记录。`meta/archive-meta.md` 与 summary 均由 finalize 内部生成；禁止手写。
  3. finalize 在 before-manifest 前执行 cleanup（删除 lock/pid/launcher/credential，截断超大日志）。它采用冻结优先：collect 前 fsync 事件并写 `evidence/evidence-cutoff.json`；cutoff 后不再追加事件。source consistency 或 summary consistency 失败时，脚本保留原 changes 目录并非零退出。
- **Phase 4 验证与提示**：优先使用 `execute` 返回的 manifest、ZIP 和上传回执；仅在结果缺失或不一致时读取 `checklist.md`。

数据库兼容性由项目能力配置决定。门禁策略既未声明 `database` 能力，也未把 `dbCompatibility` 列为必需验证时，汇总结果为 `NOT_APPLICABLE`，并以 `capability-profile` 作为类型化来源；只有明确具备数据库能力或明确要求该验证时才检查数据库证据。

## 基线折叠的恢复方式

`ARCHIVE_BASE_EQUALS_FEATURE_TIP` 表示正常完成的归档范围为空。不要修改 ledger、state snapshot 或制造空提交。按实际情况选择：

1. 本次变更确实对应仓库中一段已有提交：展示 base、tip 和产品文件清单，获得用户明确确认后运行：

   ```powershell
   python <skills-root>/scripts/harness_archive.py adopt-existing-range --change-dir ".harness/changes/<change>" --base <base> --tip <tip> --reason "<中文原因>" --confirm-existing-range --json
   ```

   命令生成不可覆盖的 `meta/archive-range-adoption.json`，并绑定仓库身份、ownership、diffHash 和文件清单。随后只重跑一次 `execute`。
2. 需求未完成：使用 `--intent record-only --closure abandoned|superseded --closure-reason "<中文原因>"`。零产品增量作为 warning 保存，不阻止封存，且 `releaseEligible=false`。
3. 无法证明范围或用户拒绝确认：取消归档，保留原目录。

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

`reports/final/summary-data.json` 只能由 `harness_archive.py finalize`（归档时）或 `replay`（回放时）生成/校验；**禁止 agent 临场手写或拼装等价数据**，也不存在独立的 `report collect`/`report validate` CLI（参见 `../protocols/report-pipeline-protocol.md` 与 `templates/summary-data-template.json` schemaVersion 2.3）。必须保留原 final report 维度。必须包含：

- `businessGoal`：本次变更为了做什么；
- `stageStatus`：plan/run/test/review/submit/archive；
- `diffStat`：filesChanged/insertions/deletions/range —— 来自 `git diff --numstat` + `git diff --stat <base>..<head>`，不得手写；
- `durations`：totalMinutes + stages[{stage,skill,startedAt,endedAt,minutes,result}] —— 从 `logs/execution-log.md` 各 `[N] harness-<skill>` 小节的 `开始`/`结束`/`耗时` 解析；
- `skillCalls`：每个 skill 的调用次数（含重入）+ 结果 —— 从 execution-log 统计；
- `verification`：单元/API/覆盖展示，含 passRate —— 来自 `evidence/verification-ledger.json`；
- `efficiency`：墙钟/活动/资源等待、验证尝试、失败分类、环境 prepare/reuse/reset/cleanup、重复命令与 wrapper 数 —— 由 `harness_efficiency.py` 从运行回执自动汇总；
- `changedFiles`：path/summary/insertions/deletions —— 来自 `git diff --numstat <base>..<head>`；
- `reviewSummary`：red/yellow + redFixed/redConfirmed/yellowFixed/yellowDeferred 修复进度；
- `maintenanceNotes`：给后续维护者看的结论；
- `knownRisks`：剩余风险或人工确认项；
- `decisions`：已采纳的设计决策/需求/API 契约 —— 来自 `evidence/decisions.json`（见下节），生成器只做校验与透传，不从 markdown 提取。

报告必须突出业务目标和维护者结论。所有统计数字只能来自 events、summary-data、ledger 或 manifest，不得手写另一套。历史 archive 没有 `events.ndjson` 时，允许从 ledger/log/manifest 回放，并在 `reportPipeline.sources` 中记录来源。

## evidence/decisions.json（可选，知识沉淀入口）

重要设计决策、长期约束、API 契约要进入平台知识库的唯一通道：在 plan/execute/review 阶段由人或 agent 把**已采纳**的结论写入 `.harness/changes/<change>/evidence/decisions.json`（schema_version 1）：

```json
{
  "schema_version": 1,
  "decisions": [
    {
      "id": "D-001",
      "title": "一句话结论（必填，≤500 字）",
      "rationale": "为什么（可选，≤4000 字）",
      "entry_type": "decision | requirement | api-contract",
      "status": "adopted | proposed | rejected | superseded",
      "path": "docs/design/x.md（可选，相对路径，溯源用）",
      "line": 42,
      "keywords": ["可选，≤32 个"],
      "source": "plan | review | manual | archive"
    }
  ]
}
```

- 只有 `status: "adopted"` 的记录会成为知识候选（`entry_type` 原样落到知识条目上）；其余状态保留在 summary 里做记录。
- 与 reviewFindings 的裁决门槛同源：**筛选必须在上游发生**——不要把讨论过程原文倒进来，归档时不做任何 LLM 提取。
- 不合 schema 的记录会被丢弃并在 `maintenanceNotes` 留一条计数说明；丢弃不无声。
- 未裁决（OPEN/UNKNOWN）的 RED/YELLOW findings 若导致候选为 0，finalize 会显式告警提示先裁决再 republish。

## 平台展示与数据校验

平台监控直接读取 `reports/final/summary-data.json`，归档阶段不再生成本地 HTML 报告，也不得由模型临场维护第二份展示数据。

`validate` 是 `harness_archive.py finalize` 的内嵌同进程步骤（不再作为独立 `report validate` CLI 调用）。finalize 在 validate error 存在时恢复原 `.harness/changes/<change>` 目录并 exit 非 0，绝不归档未通过校验的变更。

## repair（归档后修复，不改写原版）

归档后发现来源事实与 summary-data 不一致时，使用显式修复（`replay` 仍为只读）：

```powershell
python <skills-root>/scripts/harness_archive.py repair --archive-dir ".harness/archive/<archive-id>" --json
```

repair 在 archive 外生成候选版本。来源校验与数据校验通过后，写入不可变 `derived/v<N>/`（summary-data.json + repair-record.json），并更新 `derived/authoritative.json` pointer；原 summary 与 manifest 不覆盖。知识层仅从 authoritative pointer 且 hash 校验通过的版本提取。

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

- 平台直接读取 `reports/final/summary-data.json`；本地不生成重复展示文件。
- 新路径优先：`meta/`、`logs/`、`evidence/`、`reports/final/`、`scripts/`、`backups/uncommitted-tests/`。旧路径只做读取兼容，不再写大量根目录文件。
- 当 `summary-data.json.verification.apiTests.status=USER_SKIPPED` 或 `verification.dbCompatibility.status=BLOCKED_BY_DBA`，最终状态必须是 `CONDITIONAL_OK`。
- 复杂 PowerShell 命令写入 `scripts/*.ps1` 后 `-File` 执行，禁止内联 `$` / `$_`。

## 执行日志记录

归档只向 `events.ndjson` 追加事件（schema_version 3，兼容读取 v1/v2）；`logs/execution-log.md` 由 `harness_events.py append` 自动渲染，禁止手工 Edit。事件类型与脚本用法见 SKILL.md `## 执行日志` 与 `../protocols/report-pipeline-protocol.md`。
