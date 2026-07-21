---
name: harness-knowledge-ingest
description: "从 .harness/archive 归档整理、同步和维护项目知识索引。适用场景：ingest knowledge、sync knowledge、rebuild knowledge index、promote knowledge、确认知识条目、检查知识库是否过期。"
argument-hint: "auto | sync | ingest | audit | promote <entry-id> | demote <entry-id> | mcp"
effort: medium
allowed-tools: [Bash(powershell.exe:*), Read, Write, Edit, Glob, Grep]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(cp *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
---

# harness-knowledge-ingest

从 `.harness/archive/**/reports/final/summary-data.json` 抽取项目知识，生成并维护本地 `.harness/knowledge/` 索引。

当前实现是本地、离线、无 LLM、无外部服务的 SQLite FTS MVP，已经支持基础生命周期：`candidate`、`stale`、`active`、`superseded`、`conflicted`。按新需求查询历史由独立的 `harness-knowledge-query` 负责。

## Triggers

- ingest knowledge
- sync knowledge
- rebuild knowledge index
- promote knowledge
- 确认知识条目
- 从归档生成知识索引
- 刷新项目知识库
- 检查知识库是否过期

## Required context

- AGENTS.md / CLAUDE.md
- `.harness/archive/**/reports/final/summary-data.json`
- `.harness/knowledge/index.json`
- `.harness/codebase/map-summary.md`（如存在）
- design.md

## Purpose

解决两个问题：

1. **整理知识库内容**：把归档里的 `businessGoal`、`changedFiles`、`maintenanceNotes`、`knownRisks`、`manualActions`、`verification`、`reviewSummary` 抽成知识条目。
2. **维护知识生命周期**：检查索引是否过期，保留 active 条目；高置信 candidate 由 `autoPromote` 自动提升；其余 candidate/conflicted 由 **Agent judge** 闭环裁决，不再默认输出人工待办清单。

## Outputs

```text
.harness/knowledge/index.json
.harness/knowledge/index.sqlite
.harness/knowledge/entries/candidate/*.json
.harness/knowledge/entries/active/*.json
.harness/knowledge/entries/stale/*.json
.harness/knowledge/entries/superseded/*.json
.harness/knowledge/entries/conflicted/*.json
.harness/knowledge/cache/archive-entries/*.json
.harness/knowledge/reports/ingest-report-YYYYMMDD-HHmmss.md
.harness/knowledge/reports/verification-report-YYYYMMDD-HHmmss.md
.harness/knowledge/reports/validator-suggestions-YYYYMMDD-HHmmss.md
.harness/knowledge/reports/audit-report-YYYYMMDD-HHmmss.md
.harness/knowledge/views/knowledge-dashboard.md
.harness/knowledge/views/by-file.md
.harness/knowledge/views/stale-items.md
.harness/knowledge/views/superseded-items.md
.harness/knowledge/views/conflicted-items.md
.harness/knowledge/views/active-review.md
.harness/knowledge/views/knowledge.base
.harness/knowledge/context-packs/*.md
```

## Commands

`<skill-dir>` 指本 skill 目录。所有 python 脚本命令通过 `powershell.exe -Command "..."` 执行。完整命令示例与 config.json 配置见 `reference.md`「Commands 详细」。

| 命令 | 用途 |
|---|---|
| `auto` | 一键防腐：首建 config、sync --update、**默认**写回 validator 建议、verify、audit；随后由 **Agent** 执行 judge 闭环 |
| `ingest` | 重建/刷新知识索引，抽取 candidate；`--no-incremental` 强制全量重抽取 |
| `sync` | 检查 index 与 archive/HEAD 一致性；`--update` 自动刷新 |
| `promote` | candidate→active（显式 promote 或 autoPromote / judge 触发） |
| `demote` | active→stale/candidate（显式 demote 或自动降级策略触发） |
| `audit` | 生成 Candidate/Stale/Superseded/Conflict/Active Review 报告 |
| `verify` | 执行 entry validators，刷新 lifecycle.validation，生成 verification-report |
| `suggest-validators` | 生成 file_exists/file_contains validator 建议；`--apply` 写回 entry |
| `mcp` | FastMCP stdio 入口，暴露 9 个工具（见 reference.md） |

config.json 配置项（autoPromote / confidence / activeLifecycle / knowledgeValidation）详见 `reference.md`「Commands 详细」。

## Workflow

### Phase 0：确认项目根目录

项目根目录必须包含 `.harness/`。如果 `.harness/archive/` 不存在或没有 `summary-data.json`，报告当前项目暂无可索引归档，不要伪造知识。

### Phase 1：重建本地知识索引

运行：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' ingest --project '<project-root>'"
```

生成：

- `index.json`：人类可读 manifest。
- `index.sqlite`：SQLite FTS5 检索索引。
- `entries/candidate/`：自动抽取、待确认知识。
- `entries/stale/`：来源 commit 缺失、无法比较，或来源 commit 后相关文件变化的知识。
- `entries/active/`：人工确认后可长期引用的知识。
- `views/`：Obsidian 友好的浏览视图。
- `reports/`：本次 ingest 报告。

### Phase 2：一键 auto（推荐入口）

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' auto --project '<project-root>'"
```

`auto` 默认会写回确定性 validator 建议（`--no-apply-suggestions` 可关闭）。JSON 返回含 `lifecycle` 摘要（validatorsApplied、autoPromote、pendingAgentJudge 等）。

### Phase 3：Agent judge 闭环（auto 之后必须执行）

当 `lifecycle.pendingAgentJudge > 0`、存在 `pending-judge` outbox，或 `judge export` 的 `counts.pending > 0` 时：

1. `judge export`（或读 maintain 产出的 pending judgements）
2. Agent 读取 export JSON，按 `reference.md`「Agent judge 启发式」批量写 `reports/judge-decisions-<ts>.json`
3. `judge apply --apply <decisions.json>`（`knowledge.manualReview=true` 时需用户显式 `--force`）
4. 向用户输出 **已处理报告**（promoted/dropped/superseded/kept/skipped 计数 + 报告路径）

**禁止**默认输出「请人工确认 N 条 candidate」类五步待办清单。拿不准的 candidate 保持 `candidate` 状态留待下轮，记入 `skippedCandidates` 即可。

裁决体量：`config.judge.maxCandidatesPerRun`（默认 100）；conflicted 优先全量裁决。

### Phase 4：同步检查（可选）

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' sync --project '<project-root>'"
```

当 `upToDate=false` 时，运行 `sync --update` 或重新 `auto`，再交给 `harness-knowledge-query` 查询。

### Phase 5：显式 promote/demote（例外路径）

仅在用户点名单条、或 `manualReview=true` 需人工确认时使用 `promote` / `demote`。日常归档后不要逐条人工复核。

**发布门禁**：promote / judge apply / autoPromote 会校验来源归档——`reportPipeline.sourceConsistency` 缺失或失败、authoritative pointer /hash 不通过的归档，其条目带 `lifecycle.publishBlocked`，只能停留在 quarantined candidate。先 `harness_archive.py repair` 修复并重新 ingest，再 promote（详见 `reference.md`「发布门禁」）。

### Phase 6：解释同步结果

回复用户或交给后续 skill 前，应说明：

- 索引是否最新。
- 如需刷新，具体原因是 archive 增删、checksum 变化、sqlite 缺失，还是 HEAD 改变。
- 本次是否自动刷新。
- 当前 `active` / `candidate` / `stale` 的数量。

## Knowledge extraction rules

- Detect duplicate IDs, duplicate content, and conflicting active facts.
- Keep project-local entries excluded from any global index unless explicitly selected.
- Validate lifecycle relationships.
- Default generated entries are `candidate`; only config-gated `autoPromote` may promote high-confidence long-lived entries to `active`.
- Preserve provenance: every entry must include source archive, summary path, source commit, and source files when available.
- Do not edit `.harness/archive/**` during ingest.
- Do not copy secrets into `.harness/knowledge`.

## Lifecycle rules

- `candidate`：自动抽取；高置信 + 白名单类型可由 autoPromote 提升；其余由 Agent judge 裁决或保持 candidate。
- `active`：autoPromote、judge promote，或显式 promote 后可用。
- `stale`：来源 commit 缺失、来源 commit 后相关文件变化，或当前代码无法证明旧结论仍有效。
- `superseded`：被后续归档/决策取代。
- `conflicted`：与另一条 active/candidate 知识冲突。

## Forbidden actions

- auto_promote_candidate_knowledge_without_config_and_confidence_gate
- erase_conflicts
- include_project_local_by_default
- mutate_archive_evidence
- store_secrets
- treat_stale_knowledge_as_current_fact

## Allowed capabilities

- read
- search
- write_candidate_knowledge
- write_active_knowledge_after_manual_confirmation
- write_confidence_scores
- auto_promote_high_confidence_knowledge_when_configured
- agent_judge_knowledge_lifecycle
- write_knowledge_index
- write_obsidian_views

## Verification

本 skill 自带最小测试：

```powershell
powershell.exe -Command "python -m unittest '<skill-dir>\tests\test_harness_knowledge.py'"
```

完成脚本修改后必须至少运行该测试。若在真实项目中验证，还应运行：

```powershell
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' auto --project '<real-project-root>'"
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' ingest --project '<real-project-root>'"
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' suggest-validators --project '<real-project-root>' --limit 20"
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' verify --project '<real-project-root>'"
powershell.exe -Command "python '<skill-dir>\scripts\harness_knowledge.py' sync --project '<real-project-root>'"
```

并确认 `index.json`、`index.sqlite`、`views/knowledge-dashboard.md`、`reports/verification-report-*.md` 存在，且 sync 输出 `upToDate=true`。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]] · ingest/sync 须绑定 `upToDate`/产物路径证据

## Output Format

执行完成后展示：

- 本次命令（ingest/sync/promote）与目标项目根。
- `upToDate` 及 `reasons`（sync）或新增/覆盖条目数（ingest/promote）。
- 当前 `active` / `candidate` / `stale` 数量统计。
- 产物路径（`index.json`、`index.sqlite`、`views/`、`reports/`）。
- `lifecycle` 摘要：`validatorsApplied`、`candidateAutoPromoted`、`pendingAgentJudge` 等。
- **已处理报告**（auto + judge 后）：promoted/dropped/superseded/kept/deferred/skipped 计数与 `reports/judge-decisions-*.json`、`judgements-*.json` 路径；人工判断还会追加到 `judgements/decisions.json`，后续 ingest 不得抹除。`defer` 必须带 `reviewAfter`，到期前不重复进入待判断清单。
- 仅当 `upToDate=false` 时建议 `sync --update`；查询历史 → `/harness-knowledge-query`。**禁止**默认列出「请人工确认 N 条 candidate」待办。

## 渐进披露

- **Read `reference.md`** 仅在执行命令或查阅 config.json 配置时 — 含 Commands 详细示例（9 命令的 powershell 示例 + config.json 配置）与变更日志（v1.7–v1.13 补充能力）。

## 交互白名单

**仅当** `.harness/config/harness.json` 中 `knowledge.manualReview=true` 时，promote/demote 高价值条目需 blocking user confirmation；否则按 skill 默认策略 + `decision` 事件。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`knowledge-ingest` · 默认控制台报告；变更上下文写 phase/decision/issue/artifact
