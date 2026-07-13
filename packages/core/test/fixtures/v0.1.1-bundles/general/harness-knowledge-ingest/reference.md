---
description: harness-knowledge-ingest 的命令详细示例、config.json 配置参考与变更日志。仅在执行命令或查阅配置时读取。
---

# harness-knowledge-ingest 参考

本文件为 `harness-knowledge-ingest` 的渐进披露支持文件，承载 Commands 详细示例与变更日志。SKILL.md 只保留概要 + 渐进披露引用。`<skill-dir>` 指本 skill 目录，即 `.claude/skills/harness-knowledge-ingest/` 或知识库源目录中的 `harness-knowledge-ingest/`。所有 python 脚本命令通过 `powershell.exe -Command "..."` 执行，避开 Bash 在 Windows 中文路径下的编码/参数问题。

## Commands 详细

### Auto maintenance

如果只是想让 skill 自己完成常规知识库防腐，优先跑 `auto`：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' auto --project '<project-root>'"
```

`auto` 会按默认维护顺序执行：首建 `config.json`（若缺失）、`sync --update`、只读 `suggest-validators`、`verify`、`audit`。首次发现 `.harness/knowledge/config.json` 不存在时，`auto` 会自动写入启用版 `autoPromote` 配置，并让本次运行立刻按 confidence 规则提升满足门槛的长期知识。默认不会把 validator 建议写回条目；确认要把建议写入后再执行：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' auto --project '<project-root>' --apply-suggestions --suggest-status candidate"
```

常用参数：
- `--limit <n>`：限制本次 validator 建议的条目数。
- `--audit-limit <n>`：限制各类审计清单条目数。
- `--suggest-status active|candidate`：限定生成 validator 建议的 lifecycle，可重复。
- `--no-incremental`：强制不复用 archive 抽取缓存。

### Rebuild index

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' ingest --project '<project-root>'"
```

生成或刷新 `.harness/knowledge`。默认启用 archive 抽取缓存，未变化 archive 会复用 `.harness/knowledge/cache/archive-entries/*.json` 的原始抽取结果，但 lifecycle 会每次全局重算。自动生成条目默认为 `candidate`；如果来源 commit 不存在、来源 commit 之后相关文件发生变化、TTL 过期，或后续 verification 失败/降级，则标记为 `stale`。

如需强制全量重抽取：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' ingest --project '<project-root>' --no-incremental"
```

### Sync knowledge

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' sync --project '<project-root>'"
```

检查 `.harness/knowledge` 是否与 `.harness/archive` 和当前 HEAD 一致。输出 JSON 包含：

- `upToDate`
- `reasons`
- `archiveCount`
- `paths`

如果希望发现过期后自动刷新：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' sync --project '<project-root>' --update"
```

如需刷新时禁用抽取缓存：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' sync --project '<project-root>' --update --no-incremental"
```

### Verify knowledge validators

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' verify --project '<project-root>'"
```

`verify` 不重抽 `.harness/archive`，只读取当前 `.harness/knowledge/entries/**/*.json` 中显式声明的 `validators[]`，执行确定性检查，写回 `lifecycle.validation`，刷新 `index.json` / `index.sqlite` / `views/`，并生成 `reports/verification-report-*.md`。

支持的 validator：

```json
{
  "validators": [
    {
      "type": "file_exists",
      "path": "src/billing/ledger_reconciler.py",
      "description": "ledger reconciler file still exists"
    },
    {
      "type": "file_contains",
      "path": "src/billing/ledger_reconciler.py",
      "pattern": "LedgerReconciler",
      "description": "source still contains LedgerReconciler"
    },
    {
      "type": "symbol_exists",
      "symbol": "LedgerReconciler",
      "files": ["src/billing/ledger_reconciler.py"],
      "description": "LedgerReconciler symbol still exists"
    }
  ]
}
```

`command` validator 也支持，但默认禁用；只有项目显式开启 `knowledgeValidation.allowCommandValidators=true` 时才运行，且 `command` 必须是字符串数组。

### Suggest validators

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' suggest-validators --project '<project-root>' --limit 20"
```

默认只生成建议和 `reports/validator-suggestions-*.md`，不会改写 entries。建议来源是当前 entry 的 `scope.sourceFiles`、正文/标题/关键词中的稳定 token，以及项目文件中的实际内容。当前只生成安全的 `file_exists` / `file_contains` 建议。

如需把建议写入 entry JSON：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' suggest-validators --project '<project-root>' --limit 20 --apply"
```

可用 `--status active` / `--status candidate` 限定生命周期状态。建议写入后应运行 `verify --project <project-root>`，确认 validator 能实际通过。

### Promote candidate to active

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' promote --project '<project-root>' --id '<entry-id>' --note '<人工确认说明>'"
```

将一条 `candidate` 提升为 `active`，写入：

```text
.harness/knowledge/entries/active/<entry-id>.json
```

提升后会自动重建索引，并保留 active 条目。后续重新 ingest 时，同 ID 的 active 条目会覆盖自动生成的 candidate 条目。

默认禁止提升 `stale`。如果人工已经重新验证，可显式使用：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' promote --project '<project-root>' --id '<entry-id>' --note '<验证说明>' --allow-stale"
```

### Demote active after manual review

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' demote --project '<project-root>' --id '<entry-id>' --status stale --reason '<人工复核说明>'"
```

`demote` 只处理人工确认后的 `active` 条目，可降级到 `stale` 或 `candidate`。降级到 `stale` 时会写入 `manual demotion` stale reason，并在后续 ingest 中保留该人工维护条目。

### Optional active auto-demotion

默认不会自动改写 `active`。如明确希望脚本根据 `Active Review` 自动降级 active，可在 `.harness/knowledge/config.json` 中启用：

```json
{
  "activeLifecycle": {
    "autoDemote": true,
    "targetStatus": "stale"
  }
}
```

启用后，ingest 会把需要复核的 active 自动移动到 `targetStatus`（`stale` 或 `candidate`），记录 `lifecycle.autoDemoted=true` 和 `activeLifecycle auto-demotion` 原因。该能力只应在项目团队确认接受自动降级策略后启用。

### Optional confidence scoring and autoPromote

`ingest` 会为每个 entry 写入解释型 `confidence`，包含：

```json
{
  "confidence": {
    "score": 0.82,
    "level": "high",
    "signals": ["type_bonus:decision", "source_files_present:+0.03"],
    "lastCalculatedAt": "2026-07-01T12:00:00Z"
  }
}
```

confidence 不是“绝对正确率”，只表示当前证据强弱。分数会受条目类型、来源文件、时间衰减、stale/superseded/conflicted、validator 通过/失败、来源文件变更等信号影响。

`ingest` 单独执行时不会替项目首建策略文件；`auto` 首次发现项目没有 `.harness/knowledge/config.json` 时，会写入以下启用版配置并立即应用：

```json
{
  "autoPromote": {
    "enabled": true,
    "minConfidence": 0.82,
    "allowedTypes": ["decision", "api-contract", "requirement", "pitfall"],
    "requireValidators": false,
    "allowStale": false,
    "maxPerRun": 50
  },
  "confidence": {
    "ttlHalfLifeDays": 45,
    "sourceChangePenalty": 0.25,
    "stalePenalty": 0.35,
    "validatorPassBonus": 0.15,
    "validatorFailPenalty": 0.5,
    "supersededPenalty": 0.8,
    "conflictPenalty": 0.8
  }
}
```

自动提升只处理配置允许的类型，默认排除 stale/conflicted/superseded，且会写入 `lifecycle.autoPromoted=true`、`promotionNote` 和 `promotedAt`。一次性实现细节、测试证据、风险提醒仍不应自动提升为长期事实。

### Optional validator auto-demotion

默认不会因为 validator 失败自动改写 `active`。如明确希望确定性 validator 失败时自动降级 active，可在 `.harness/knowledge/config.json` 中启用：

```json
{
  "knowledgeValidation": {
    "enabled": true,
    "autoDemoteActive": true,
    "defaultTargetStatus": "stale",
    "allowCommandValidators": false
  }
}
```

启用后，`ingest` 和 `verify` 会把 validator 失败的 active 条目移动到 `defaultTargetStatus`，记录 `lifecycle.validation`，并写入 `validator failed:` stale reason。该机制适合代码事实、文件存在性、符号存在性、可重复命令等确定性事实；业务意图和团队取舍仍应保持为 candidate 或人工确认后的 active。

### MCP entry point

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge_mcp.py' --describe-tools"
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge_mcp.py'"
```

`harness_knowledge_mcp.py` 默认以 stdio 运行 `FastMCP`，暴露：

- `harness_knowledge_ingest`
- `harness_knowledge_sync`
- `harness_knowledge_auto`
- `harness_knowledge_audit`
- `harness_knowledge_verify`
- `harness_knowledge_suggest_validators`
- `harness_knowledge_query`
- `harness_knowledge_promote`
- `harness_knowledge_demote`

## 变更日志

## v1.7 补充能力

当前脚本额外支持：

- `audit --project <root> --limit <n>`：生成 `.harness/knowledge/reports/audit-report-*.md`，包含 `Candidate Review`、`Stale Review`、`Superseded Review`、`Conflict Review`。
- `entries/superseded/*.json`：当后续 archive 与旧条目有重叠文件且类型相近时，非 active 自动生成条目会被标记为 `superseded`，并写入 `lifecycle.supersededBy`。
- `entries/conflicted/*.json`：当同文件、同知识类型、共享主题词且出现“唯一来源/复用”与“不再/替代/改为”等相反信号时，非 active 自动生成条目会被标记为 `conflicted`，并写入 `lifecycle.conflictsWith`。
- 后续 archive 的 verification 出现失败或 pass ratio 降级时，旧的重叠 `test-evidence` 会标记为 `stale`，并写入 `newer verification degraded` stale reason。
- 默认增量 ingest：未变化 archive 复用 `.harness/knowledge/cache/archive-entries/*.json` 原始抽取缓存；`--no-incremental` 可强制全量重抽取。
- `scripts/harness_knowledge_mcp.py` 提供 stdio MCP server 入口和 `--describe-tools` 工具元数据输出。
- `audit` 新增 `Active Review`，当 `active` 条目被后续重叠 archive、潜在冲突或 verification 降级影响时，生成人工复核清单，但不会自动改写 active。
- `demote --id <entry-id> --status stale|candidate --reason <说明>`：人工确认后显式降级 active 条目，降级记录跨后续 ingest 保留。
- `.harness/knowledge/views/active-review.md`：列出需要人工复核的 active 条目。
- `.harness/knowledge/views/knowledge.base`：Obsidian Bases 入口，按 lifecycle folder 浏览 `.harness/knowledge/entries/**/*.json`。
- `mcp-config.example.json`：MCP client 配置示例。
- `evaluations/harness_knowledge_evaluation.xml` 和 `tests/fixtures/mcp-eval-project/`：固定 MCP evaluation fixture，便于后续用 evaluation harness 跑稳定问答。
- `verify` 命令与 `harness_knowledge_verify` MCP 工具：执行 entry-level `validators[]`，刷新 `lifecycle.validation`，生成 `verification-report-*`。
- `suggest-validators` 命令与 `harness_knowledge_suggest_validators` MCP 工具：从 entry 的 sourceFiles 和代码内容生成 validator 建议；默认只写报告，`--apply` 才写回条目。
- `views/superseded-items.md`：列出被后续归档取代的知识条目。
- `views/conflicted-items.md`：列出需要人工确认的潜在冲突知识条目。
- SQLite 新增 `entry_files(entry_id, source_file)` 表和 `idx_entry_files_source_file`，文件路径查询不再只依赖 JSON LIKE。
- `.harness/knowledge/config.json` 支持 `staleTtlDays`：当归档日期超过 TTL 时，非 `active`/`superseded` 条目会标记为 `stale`，并写入 `ttl expired` stale reason。

限制：

- `superseded` 目前是保守启发式，不自动改写人工确认的 `active`。
- `conflicted` 目前也是保守启发式，优先减少误报；人工确认的 `active` 不会被自动移动。
- 后续 verification 降级默认只自动处理非 active 的 `test-evidence`；active 通过 `Active Review` 提醒。只有显式启用 `activeLifecycle.autoDemote` 或 `knowledgeValidation.autoDemoteActive` 后才会自动降级 active。
- MCP evaluation fixture 是本 skill 的固定测试项目，不代表真实项目质量；真实项目仍需单独 smoke。
- `audit` 只生成审核清单，不自动 promote。

## v1.9 补充能力

- Entry 可显式声明 `validators[]`，当前支持 `file_exists`、`file_contains`、`symbol_exists`、`command`。
- `command` validator 默认禁用，避免知识库条目隐式执行任意命令。
- `verify --project <root>` 不重抽 archive，只对当前知识条目执行 validator，并刷新 manifest、SQLite、views 和 verification report。
- `ingest` 也会执行 validator；当 `knowledgeValidation.autoDemoteActive=true` 时，失败的 active 自动降级到 `defaultTargetStatus`。
- `suggest-validators` 默认生成只读建议报告；`--apply` 后写入 validators，并可立刻由 `verify` 检查。
- 单测扩展到 22 个，覆盖 validator 自动降级、verify 命令、suggest-validators、MCP verify/suggest 工具描述，以及 verify 刷新时保留 SQLite 基线条目。

## v1.11 补充能力

- `auto --project <root>`：一条命令完成默认安全维护流程：`sync --update`、只读 `suggest-validators`、`verify`、`audit`。
- MCP 新增 `harness_knowledge_auto`，给 agent 直接调用同一套维护流程。
- 默认 `auto` 不会写回 validator 建议；只有显式传入 `--apply-suggestions` 才会修改 entry JSON，并随后由 `verify` 检查。
- `--suggest-status active|candidate` 可限制写入或建议范围；建议真实项目首次使用仍优先只读跑报告。
- 单测扩展到 24 个，覆盖 `auto` 的只读默认路径、显式 apply 路径，以及 MCP tool metadata。

## v1.12 补充能力

- `ingest` 为所有 entry 写入 `confidence.score`、`confidence.level`、`confidence.signals` 和 `lastCalculatedAt`，让 agent 可以按证据强弱排序和解释判断。
- `.harness/knowledge/config.json` 支持 `autoPromote`：默认关闭，显式启用后只会提升配置允许类型中满足 `minConfidence` 的 candidate。
- autoPromote 默认排除 stale/conflicted/superseded，不处理一次性 implementation、test-evidence、risk；自动提升会记录 `lifecycle.autoPromoted=true`、`promotionNote` 和 `promotedAt`。
- `confidence` 配置支持时间衰减、来源变更、stale、validator、superseded/conflict 等惩罚或奖励，目标是减少人工筛选量，不是假装机器可以判断所有知识真伪。
- `index.json.ingestMode` 和 ingest report 新增 `confidenceScored`、`candidateAutoPromoted`，便于 agent 在运行后直接报告结果。
- 单测扩展到 34 个，覆盖 confidence 元数据、autoPromote 配置门槛、stale/age 置信度惩罚，以及既有 lifecycle/validator/auto/MCP 路径。

## v1.13 补充能力

- `auto --project <root>` 首次发现 `.harness/knowledge/config.json` 不存在时，会自动写入启用版 `autoPromote` + `confidence` 配置。
- 如果写入 config 时现有 index 已经 `upToDate=true`，`auto` 会主动重建一次索引，让自动提升在本轮生效，而不是等下一次运行。
- `auto` JSON 输出新增 `config` 摘要：`path`、`created`、`autoPromoteEnabled`、`appliedBy`、`candidateAutoPromoted`。
- `ingest` 单独命令仍不首建 config；项目策略的自动首建只发生在 `auto` 维护入口。
- 单测扩展到 35 个，覆盖“已有最新 index 但缺 config 时，auto 首建启用配置并立即提升”的路径。
