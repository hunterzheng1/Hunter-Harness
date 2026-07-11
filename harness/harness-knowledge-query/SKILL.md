---
name: harness-knowledge-query
description: "根据新需求、设计任务、代码修改请求或问题排查，在规划和编码前查询 .harness/knowledge 历史上下文。适用场景：query knowledge、查找历史需求、根据归档理解需求、继续之前类似开发、生成需求上下文包。"
argument-hint: "<需求文本> [--file <path>] [--status active|candidate|stale]"
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

# harness-knowledge-query

根据用户的新需求或排查问题，从项目本地 `.harness/knowledge` 中检索历史需求、决策、实现、风险和测试证据，并生成 AI 可读的 context pack。

此 skill 只负责查询和使用知识。整理、同步和 promote 条目由 `harness-knowledge-ingest` 负责。

## Triggers

- query knowledge
- knowledge query
- 查找相关历史需求
- 根据历史归档理解这个需求
- 结合之前做过的内容
- 继续之前类似开发
- 生成需求上下文包
- 在规划前查历史

## Automatic Use

当用户提出新功能、改造、排查、设计方案、继续历史任务，且项目存在 `.harness/archive` 或 `.harness/knowledge` 时，AI 应主动运行本 skill，不需要等用户提醒。

如果 `.harness/knowledge/index.json` 不存在或已过期，先运行：

```powershell
powershell.exe -Command "python '<ingest-skill-dir>\scripts\harness_knowledge.py' sync --project '<project-root>' --update"
```

然后再查询。

## Commands

`<ingest-skill-dir>` 指同级 `harness-knowledge-ingest/` 目录；查询逻辑复用其脚本。所有 python 脚本命令通过 `powershell.exe -Command "..."` 执行，避开 Bash 在 Windows 中文路径下的编码/参数问题。

### Query by requirement

```powershell
powershell.exe -Command "python '<ingest-skill-dir>\scripts\harness_knowledge.py' query --project '<project-root>' --query '<用户需求原文>'"
```

### Query with metadata filters

```powershell
powershell.exe -Command "python '<ingest-skill-dir>\scripts\harness_knowledge.py' query --project '<project-root>' --query '<需求或关键词>' --file '<source-file>' --status active"
```

可重复使用：

- `--file <path>`：只返回关联到指定文件的知识。
- `--status active|candidate|stale|superseded|conflicted`：按生命周期过滤。
- `--type requirement|decision|implementation|risk|test-evidence|pitfall|api-contract`：按知识类型过滤。
- `--limit <n>`：限制返回数量。

## Workflow

1. 确认项目根目录。
2. 运行 `sync --project <root>`。
3. 如果 `upToDate=false`，运行 `sync --update`。
4. 用用户原始需求作为 `--query` 查询。
5. 如已知道相关文件，追加 `--file` 过滤。
6. 读取 JSON 输出中的 `contextPack`。
7. 在 `harness-plan`、设计、代码探索或实现前，把 context pack 当作必读输入。

## Output Contract

查询输出 JSON 包含：

- `matchCount`
- `contextPack`
- `filters`
- `planInput`
- `matches`

`planInput.kind` 必须为 `harness-knowledge-context-pack`。后续 `harness-plan` 应读取 `planInput.path`。

每次查询还会更新稳定指针：

```text
.harness/knowledge/context-packs/latest.json
```

该文件包含最新 query、context pack 路径和 `matchIds`，供后续流程快速读取最近一次知识上下文。

## Interpretation Rules

- `active`：可优先采用，但仍要结合当前代码验证。
- `candidate`：有参考价值，不是当前事实。
- `stale`：只能作为历史线索，必须重新检查代码和归档。
- `superseded` / `conflicted`：必须显式提示风险，不得静默采用。

## Forbidden Actions

- rebuild_index_without_need
- treat_candidate_as_current_fact
- treat_stale_as_current_fact
- skip_context_pack_before_planning
- copy_large_archive_content_into_prompt

## Verification

```powershell
powershell.exe -Command "python -m unittest '<ingest-skill-dir>\tests\test_harness_knowledge.py'"
powershell.exe -Command "python '<ingest-skill-dir>\scripts\harness_knowledge.py' query --project '<real-project-root>' --query '<真实需求>'"
```

确认输出中存在 `contextPack`、`planInput.kind=harness-knowledge-context-pack`，且 context pack 文件包含 `Before planning`。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]] · query 成功须含 `contextPack`/`planInput.kind` 与 `latest.json` 写入

## Output Format

执行完成后展示：

- 用户需求原文与生效的过滤条件（`--file`/`--status`/`--type`/`--limit`）。
- `matchCount` 与按状态分组的命中数（active/candidate/stale/superseded/conflicted）。
- `contextPack` 路径与 `latest.json` 指针。
- 命中 stale/superseded/conflicted 时显式提示风险。
- 下一步建议（context pack 已就绪 → 进入 `/harness-plan`；索引过期 → 先 `sync --update`）。

## 渐进披露

- 本 skill 暂无 `checklist.md` / `reference.md` 支持文件，规则全部在 SKILL.md。若 Output Contract / Interpretation Rules 后续扩展变重，应拆到 `reference.md`。

## 交互白名单

**无** AskUserQuestion；`stale`/`conflicted` 命中记 `issue`，不阻断 query。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`knowledge-query` · 独立运行时控制台报告；变更上下文写 decision/issue/artifact
