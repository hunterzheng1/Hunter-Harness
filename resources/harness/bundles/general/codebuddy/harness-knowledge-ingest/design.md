---
title: Harness Knowledge Layer 设计
status: draft
created: 2026-06-30
updated: 2026-06-30
related:
  - harness-knowledge-ingest/SKILL.md
  - harness-archive/SKILL.md
  - harness-codebase-map/SKILL.md
---

# Harness Knowledge Layer 设计

## 一句话结论

最优方案不是直接接一个通用 RAG 产品，而是在 Harness 内新增一层 evidence-first、lifecycle-aware 的项目知识层：

```text
.harness/archive/        # 不可变证据层：每次需求/开发/验证/审查/归档的原始材料
.harness/codebase/       # 当前代码库地图层：项目结构、约定、测试、风险
.harness/knowledge/      # 可检索知识层：从 archive 抽出的需求、决策、实现、风险、坑点
```

`archive` 负责保存事实证据，`knowledge` 负责让 AI 快速找到相关历史并判断这些历史是否仍然可信。

## 背景

当前多个本地项目已经积累了大量 `.harness/archive/**` 归档。归档里的 `reports/final/summary-data.json` 已经包含很强的结构化信息：

- `businessGoal`：本次变更的业务目标。
- `finalCommit` / `baseCommit` / `diffStat`：变更范围和版本边界。
- `changedFiles`：具体文件和文件级摘要。
- `verification`：测试和验证结果。
- `reviewSummary`：审查结论和遗留项。
- `maintenanceNotes`：后续维护者应知道的结论。
- `knownRisks` / `manualActions`：风险和人工动作。

这些归档已经足够作为知识抽取原料。缺失的是一层稳定的索引、检索和防腐机制：AI 在新需求开始前应能快速知道“以前有没有做过类似事情、当时为什么这么做、改了哪些文件、现在这些结论是否可能已经过期”。

## 目标

1. 让 AI 在新需求开始前快速找到相关历史需求、实现、决策、风险和测试经验。
2. 所有知识必须可追溯到原始归档、commit 和文件路径。
3. 旧知识不能被盲信，必须有 stale/superseded/conflicted 等生命周期状态。
4. 默认本地优先，不强依赖外部服务。
5. 后续可以渐进接入向量检索、知识图谱或可视化，但第一版不被这些外部组件绑死。

## 非目标

- 不把 `.harness/archive` 推倒重来。
- 不把通用向量库当唯一真相源。
- 不让 AI 自动把候选知识提升为 active。
- 不把项目私有归档默认汇总到全局公开知识库。
- 不在知识条目中保存 token、cookie、密码、密钥或私密原始聊天全文。

## 推荐架构

### 1. Evidence Layer

现有 `.harness/archive/YYYY-MM-DD-<change>/` 继续作为不可变证据层。

主要输入：

```text
.harness/archive/<archive>/reports/final/summary-data.json
.harness/archive/<archive>/spec/*
.harness/archive/<archive>/plans/*
.harness/archive/<archive>/reports/test/*
.harness/archive/<archive>/reports/review/*
.harness/archive/<archive>/logs/execution-log.md
```

原则：

- 原始归档不因知识抽取而改写。
- 知识条目只引用归档路径和摘要，不复制大量原始内容。
- 任何结论必须能回到 source archive 和 source commit。

### 2. Current Code Context Layer

`.harness/codebase/map-summary.md` 和 `.harness/codebase/map/**` 负责当前代码库结构、技术栈、测试方式、集成点、关注风险。

可选增强：

- CodeGraph：用于当前符号和调用链。
- `git log` / `git diff`：用于判断来源 commit 后相关文件是否变化。

### 3. Knowledge Entry Layer

新增 `.harness/knowledge/entries/*.json` 或 `.md`，保存从归档抽出的轻量知识条目。

推荐条目类型：

| type | 用途 |
|---|---|
| `requirement` | 历史需求、业务目标、用户意图 |
| `decision` | 架构/协议/产品取舍及原因 |
| `implementation` | 已实现能力、关键文件、模块边界 |
| `risk` | 已知风险、遗留问题、manual action |
| `test-evidence` | 真实验证结论、测试覆盖、跳过原因 |
| `pitfall` | 可复用踩坑经验 |
| `api-contract` | 接口、协议、schema、兼容性结论 |

### 4. Index And Retrieval Layer

第一版使用本地 SQLite：

```text
.harness/knowledge/index.json      # 人类可读 manifest
.harness/knowledge/index.sqlite    # FTS5 + metadata index
.harness/knowledge/context-packs/  # 每次查询生成的上下文包
```

检索策略：

- 必须先按 metadata 过滤：project、type、status、source_files、archive date。
- 再做 SQLite FTS5 关键词召回。
- 后续可加 embedding 召回，但不能替代 metadata 和 provenance。
- 输出给 AI 的不是一堆 chunk，而是一个带来源、状态和风险说明的 context pack。

### 5. Optional Visualization Layer

第一版只生成 Obsidian 友好的 Markdown 视图：

```text
.harness/knowledge/views/knowledge-dashboard.md
.harness/knowledge/views/by-file.md
.harness/knowledge/views/by-decision.md
.harness/knowledge/views/stale-items.md
```

后续如果需要更强可视化，再考虑 Cognee、Graphiti、Neo4j/FalkorDB 或自建小型 HTML 报表。

## 数据模型

### Knowledge Entry

```json
{
  "schemaVersion": 1,
  "id": "hunter-harness.skill-ir-real-adapters.decision.cursor-adapter",
  "projectId": "hunter-harness",
  "type": "decision",
  "status": "active",
  "title": "cursor adapter 从 placeholder 升级为真实可执行产出",
  "summary": "Skill IR 的 cursor adapter 输出 .cursor/rules/<name>.mdc，cursor 纳入生产 enum，server preview/publish 对 cursor 放行。",
  "body": "该决策让 cursor 成为真实可安装 adapter；mcp 仍保持 placeholder 并在 preview/publish 时报 ADAPTER_NOT_IMPLEMENTED。",
  "keywords": ["skill-ir", "cursor", "adapter", "publish", "preview"],
  "source": {
    "archive": ".harness/archive/2026-06-30-skill-ir-real-adapters",
    "summaryData": ".harness/archive/2026-06-30-skill-ir-real-adapters/reports/final/summary-data.json",
    "sourceCommit": "fc4eb347ad977f2cff43e1a58a897ac41dcacc8c",
    "baseCommit": "6a0620fd15a7fc94da741e45115bb34e543870ad"
  },
  "scope": {
    "sourceFiles": [
      "packages/core/src/skill-ir/adapters/cursor.ts",
      "packages/contracts/src/registry.ts",
      "apps/server/src/registry/store.ts"
    ],
    "staleIfPathsChanged": [
      "packages/core/src/skill-ir/**",
      "packages/contracts/src/registry.ts",
      "apps/server/src/registry/**"
    ]
  },
  "lifecycle": {
    "createdAt": "2026-06-30",
    "verifiedAt": "2026-06-30",
    "lastCheckedAt": "2026-06-30",
    "confidence": "high",
    "supersedes": [],
    "supersededBy": null,
    "staleReasons": []
  }
}
```

### Knowledge Index

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-30T18:00:00+08:00",
  "projectId": "hunter-harness",
  "headCommit": "fc4eb34",
  "entries": [
    {
      "id": "hunter-harness.skill-ir-real-adapters.decision.cursor-adapter",
      "type": "decision",
      "status": "active",
      "title": "cursor adapter 从 placeholder 升级为真实可执行产出",
      "sourceArchive": ".harness/archive/2026-06-30-skill-ir-real-adapters",
      "sourceCommit": "fc4eb34",
      "sourceFiles": ["packages/core/src/skill-ir/adapters/cursor.ts"]
    }
  ],
  "stats": {
    "active": 1,
    "candidate": 0,
    "stale": 0,
    "superseded": 0,
    "conflicted": 0
  }
}
```

## 生命周期与防腐机制

### 状态

| status | 含义 |
|---|---|
| `candidate` | 自动抽取但未人工确认 |
| `active` | 当前可用知识 |
| `stale` | 相关文件或依赖事实已变化，需重新确认 |
| `superseded` | 已被新归档或新决策取代 |
| `deprecated` | 明确废弃，但仍保留历史记录 |
| `conflicted` | 与另一条 active/candidate 知识冲突 |

### stale 判定

知识条目应被标记为 stale，而不是被删除，当满足任一条件：

1. 当前 HEAD 相比 `sourceCommit` 修改过 `staleIfPathsChanged` 覆盖的文件。
2. 后续 archive 修改了相同模块，并出现相同 type 或相似 keyword 的新条目。
3. 相关测试/验证结论在后续归档中失败或降级。
4. 条目超过项目配置的 TTL。
5. 同一 subject 出现互斥结论。

### supersede 判定

当新条目明确替代旧条目时：

- 新条目 `supersedes` 填旧条目 id。
- 旧条目 `supersededBy` 填新条目 id。
- 旧条目保留，但默认检索降权。

### conflict 判定

当两条 active/candidate 知识对同一 subject 给出不兼容结论时：

- 不自动删除任一条。
- 两条都标记 `conflicted` 或生成 conflict report。
- 输出 context pack 时必须提示用户/AI 先确认。

## Ingest 流程

`harness-knowledge-ingest` 应从 stub 扩展为如下流程。

### Phase 0：读取配置

读取：

```text
AGENTS.md / CLAUDE.md
.harness/context-index.json
.harness/knowledge/index.json
.harness/codebase/map-summary.md
```

### Phase 1：扫描归档

扫描：

```text
.harness/archive/**/reports/final/summary-data.json
```

跳过已经 ingested 且 checksum 未变化的 archive。

### Phase 2：抽取候选知识

从每份 `summary-data.json` 抽取：

- `businessGoal` → requirement。
- `maintenanceNotes` → decision / implementation。
- `knownRisks` → risk。
- `manualActions` → risk / action note。
- `changedFiles` → implementation / api-contract。
- `verification` → test-evidence。
- `reviewSummary` → risk / decision。

第一版可以规则抽取，不必依赖 LLM。

### Phase 3：去重和冲突检测

检查：

- 重复 id。
- 相同 source archive 的重复条目。
- 相同 subject + type 的近似重复。
- active facts 冲突。
- candidate 与 active 是否构成 supersede。

### Phase 4：防腐检查

对每条候选或 active 条目：

- 检查当前 HEAD 是否在 source commit 后修改了相关文件。
- 检查后续 archive 是否覆盖相同模块。
- 检查 TTL。
- 写入 `staleReasons`。

### Phase 5：写入 candidate

默认写 candidate，不自动 promote：

```text
.harness/knowledge/entries/candidate/*.json
.harness/knowledge/reports/ingest-report-YYYYMMDD-HHmm.md
```

### Phase 6：更新索引

更新：

```text
.harness/knowledge/index.json
.harness/knowledge/index.sqlite
```

### Phase 7：输出报告

报告包含：

- 本次扫描 archive 数量。
- 新增 candidate 数量。
- 去重数量。
- stale/superseded/conflicted 数量。
- 需要人工确认的条目。

## Query 流程

建议新增 `harness-knowledge-query`，或先作为 `harness-knowledge-ingest --query`。

### 输入

```text
用户新需求文本
当前项目路径
可选：相关文件路径、模块名、change-name
```

### 检索步骤

1. 根据需求文本抽取关键词、模块名、文件路径。
2. metadata 过滤：项目、active/candidate、相关路径、最近 archive。
3. FTS 检索：需求词、历史目标、维护结论、风险。
4. stale 检查：对命中的条目重新检查当前 HEAD。
5. 排序：active > candidate > stale > superseded；路径匹配优先；越新越高；有测试证据优先。
6. 生成 context pack。

### Context Pack

输出：

```text
.harness/knowledge/context-packs/YYYYMMDD-HHmm-<query-slug>.md
```

结构：

```markdown
# Knowledge Context Pack

## Query

<用户需求>

## High-confidence relevant history

- <title>
  - status: active
  - source: .harness/archive/...
  - commit: fc4eb34
  - why relevant: <命中原因>
  - key takeaway: <对本次需求有用的结论>

## Potentially stale history

- <title>
  - status: stale
  - stale reason: source files changed after source commit
  - source files: ...

## Related risks

- <risk title>

## Suggested files to inspect next

- packages/...
```

AI 在 `harness-plan` 前应先读 context pack，而不是盲目全量读 archive。

## 与现有 Harness Skill 的关系

| Skill | 协作方式 |
|---|---|
| `harness-archive` | 归档完成后提示运行 knowledge ingest；不在 archive 内直接改知识层 |
| `harness-sync` | 检查 knowledge index 是否过期，提示刷新 |
| `harness-codebase-map` | 提供当前项目结构和风险背景 |
| `harness-plan` | 新需求规划前读取 context pack |
| `harness-review` | 可引用历史 pitfall/risk 做审查关注点 |
| `harness-submit` | 不直接写 knowledge；提交后由 archive/ingest 闭环 |

## 外部方案取舍

| 方案 | 适合用途 | 不作为第一版核心的原因 |
|---|---|---|
| Graphiti / Zep | 借鉴 temporal context graph、fact invalidation、provenance、hybrid retrieval | 需要图数据库/外部运行时；Harness 第一版可先实现轻量 lifecycle |
| Cognee | 快速试验 AI memory、graph/vector、MCP、可视化 | 项目级 commit/path/stale 规则仍需 Harness 自己定义 |
| Microsoft GraphRAG | 大量 archive 的离线主题挖掘、社区摘要 | 偏 batch，不适合作为每次需求前的轻量实时防腐层 |
| Obsidian Smart Connections | 人类浏览、语义搜索、笔记关联 | 不能表达项目 lifecycle、commit provenance 和 stale 规则 |
| OpenAI File Search | 托管文件检索和 embedding 召回 | 适合作召回增强，不适合作唯一真相源 |
| LangGraph Memory | 借鉴 semantic/episodic/procedural memory 分类 | 是框架思想，不替代 Harness 本地证据层 |

参考资料：

- [Graphiti](https://github.com/getzep/graphiti)
- [Cognee](https://github.com/topoteretes/cognee)
- [Microsoft GraphRAG](https://microsoft.github.io/graphrag/)
- [Obsidian Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)
- [OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search)
- [LangGraph Memory](https://docs.langchain.com/oss/python/concepts/memory)

## 阶段路线图

### 短期：本地索引和查询入口

先用 SQLite FTS5 + metadata index，把所有 `.harness/archive/**/reports/final/summary-data.json` 索引起来，并做出 `harness-knowledge-query`。

短期目标：

- 不依赖 LLM，不接外部服务。
- 先覆盖 archive 清单、业务目标、commit、changedFiles、maintenanceNotes、knownRisks、manualActions。
- 支持按需求文本、关键词、change-name、文件路径检索。
- 输出 AI 可读的 `context-pack.md`，供新需求规划前读取。

短期产物：

```text
.harness/knowledge/index.json
.harness/knowledge/index.sqlite
.harness/knowledge/context-packs/*.md
```

### 中期：人类可视化和 AI 调用通道

在本地知识索引稳定后，接入 Obsidian/Dataview 做人类可视化，同时提供 MCP/CLI 给 AI 使用。

中期目标：

- 生成 Obsidian 友好的 Markdown 视图，例如知识仪表盘、按文件聚合、按决策聚合、过期知识列表。
- 提供 CLI 命令，例如 `harness-knowledge query "<需求>"`。
- 提供 MCP 工具或等价入口，让 Claude Code、Codex、Cursor 等 agent 在计划前拿到 context pack。
- 让 `harness-plan` 在新需求开始前可以主动读取相关历史，而不是依赖用户手动提醒。

中期产物：

```text
.harness/knowledge/views/knowledge-dashboard.md
.harness/knowledge/views/by-file.md
.harness/knowledge/views/stale-items.md
CLI: harness-knowledge query
MCP/tool: knowledge.query
```

### 长期：图谱后端和跨项目防腐

如果知识量、跨项目复用和防腐关系变复杂，再把 Graphiti 或 Cognee 接成 graph backend。

长期目标：

- 用图谱表达 requirement、decision、implementation、risk、file、commit、archive 之间的关系。
- 支持跨项目相似需求检索和可复用坑点迁移。
- 引入 temporal fact invalidation：旧知识被 supersede/stale/conflict，而不是被删除。
- 保留 Harness 本地 index 作为轻量可用路径，graph backend 只做增强，不做唯一真相源。

长期候选：

- Graphiti：更适合 temporal knowledge graph 和 fact invalidation。
- Cognee：更适合快速试验 graph/vector/MCP/可视化组合。
- 本地 embedding 或 sqlite-vec：作为召回增强，而不是 provenance 来源。

## MVP 里程碑

### M1：Archive Index

目标：把现有 archive 变成可查清单。

产出：

- 扫描所有 `summary-data.json`。
- 生成 `.harness/knowledge/index.json`。
- 生成一份 `knowledge-dashboard.md`。
- 支持按 keyword/change/files 搜索。

验收：

- 能列出每个 archive 的 businessGoal、commit、changedFiles、risk。
- 不需要 LLM。

### M2：Knowledge Entries

目标：从 archive 抽取结构化 candidate。

产出：

- `entries/candidate/*.json`
- `ingest-report-*.md`
- SQLite FTS5 index。

验收：

- 每个条目有 source archive、source commit、source files。
- 能识别重复条目。
- 默认不自动 promote。

### M3：Query Context Pack

目标：新需求前生成 AI 可读上下文包。

产出：

- `context-packs/*.md`
- query 命令或 skill 参数。

验收：

- 输入一段需求，返回相关历史、风险、文件、过期提示。
- 输出不超过可控长度，优先 high-confidence 结果。

### M4：Stale Detection

目标：防腐机制可用。

产出：

- `status=stale/superseded/conflicted`。
- `staleReasons`。
- `stale-items.md`。

验收：

- 来源 commit 后相关文件被修改时，命中条目标记 stale。
- 后续 archive 覆盖旧决策时，旧条目标记 superseded。
- 冲突条目不会被静默覆盖。

### M5：Optional Graph/Vector Enhancement

目标：当数据规模变大后增强召回和可视化。

可选路线：

- 本地 embedding + sqlite-vec。
- Cognee 作为 graph/vector/MCP 实验后端。
- Graphiti 作为 temporal graph 后端。
- Obsidian 视图作为轻量人类 UI。

## 推荐目录结构

```text
.harness/knowledge/
├── index.json
├── index.sqlite
├── config.json
├── entries/
│   ├── active/
│   ├── candidate/
│   ├── stale/
│   ├── superseded/
│   └── conflicted/
├── reports/
│   └── ingest-report-YYYYMMDD-HHmm.md
├── context-packs/
│   └── YYYYMMDD-HHmm-<query-slug>.md
└── views/
    ├── knowledge-dashboard.md
    ├── by-file.md
    ├── by-decision.md
    └── stale-items.md
```

## Skill 形态建议

### harness-knowledge-ingest

职责：

- 扫描 archive。
- 抽取 candidate。
- 去重、冲突检测、防腐检查。
- 更新 index。
- 生成报告。

建议触发：

- `ingest knowledge`
- `rebuild knowledge index`
- `从归档生成知识索引`
- `刷新项目知识库`

### harness-knowledge-query

职责：

- 根据新需求检索历史知识。
- 生成 context pack。
- 明确展示 active/stale/conflicted。

建议触发：

- `查找相关历史需求`
- `根据历史归档理解这个需求`
- `生成需求上下文包`
- `knowledge query <需求文本>`

如果暂时不想新增 skill，可先把 query 作为 `harness-knowledge-ingest` 的参数模式。

## 风险与约束

- 规则抽取第一版可能遗漏隐含决策；先保证 provenance 和可回溯，再逐步引入 LLM 精炼。
- stale 检测不能等同于“事实一定失效”，只能提示“需要重新确认”。
- SQLite/FTS 适合本地 MVP；跨项目全局检索需要额外设计 project boundary。
- 向量召回容易命中过期知识，所以必须始终显示 lifecycle 和 source。
- 知识条目不应复制大量私密原文，避免变成二次泄漏源。

## 后续打开问题

1. `active` 是否需要人工确认，还是允许高置信规则自动 active。
2. `.harness/knowledge` 是否仍保持项目本地不提交，还是部分 views 可提交。
3. 是否需要跨项目全局知识索引，例如 `E:\Agent Memory` 层汇总各项目高价值 pitfall。
4. `harness-plan` 是否强制读取 context pack，还是仅在存在相关命中时读取。
5. 是否新增独立 `harness-knowledge-query` skill，还是先合并在 ingest skill。

## 推荐实施顺序

1. 短期先实现 M1：不用 LLM，只用 SQLite FTS5 + metadata index 索引 `summary-data.json`。
2. 短期继续实现 M3 的最小版：提供 `harness-knowledge-query`，输入需求文本后生成 `context-pack.md`。
3. 中期实现 M2：规则抽取 candidate entries，并生成 Obsidian/Dataview 友好的 views。
4. 中期把 query 能力接成 CLI/MCP/tool 入口，让 `harness-plan` 在新需求前读取 context pack。
5. 中长期实现 M4：stale/superseded/conflicted 防腐。
6. 长期当知识量和跨项目关系变复杂后，再评估 Graphiti/Cognee/embedding 作为 graph/vector backend。

这条路线最大化复用现有归档资产，也避免第一版陷入外部产品集成。它把 Harness 最擅长的东西保留下来：证据、阶段、验证、归档和可追溯性。

## 2026-06-30 当前落地状态（v1.3）

已实现：

- `harness-knowledge-ingest` 聚焦整理/同步/生命周期维护。
- 新增独立 `harness-knowledge-query`，聚焦新需求前查询历史和生成 context pack。
- `sync --project <root>` 可检查 `index.json`、`index.sqlite`、archive checksum、archive 增删和 HEAD 是否变化。
- `sync --update` 可在索引过期时自动刷新，不改写 `.harness/archive/**`。
- `query` 支持 `--file`、`--status`、`--type`、`--limit` metadata 过滤。
- 查询输出包含 `planInput.kind=harness-knowledge-context-pack`，供 `harness-plan` 读取。
- 每次查询生成 `.harness/knowledge/context-packs/latest.json` 作为稳定指针。
- SQLite 增加 status/type/source_archive metadata index。
- `harness-sync` 增加知识库检查阶段。
- `harness-plan` 增加阶段 0.5：规划前自动查询历史知识。
- Vault `AGENTS.md`/`CLAUDE.md` 已加入 Harness 知识库使用规则入口。

仍建议后续继续：

- `audit-stale` / `review-candidates`：批量辅助确认哪些 candidate 值得 promote。
- 冲突检测：同 subject 的 active/candidate 矛盾报告。
- Obsidian Bases/Dataview 视图增强。
- MCP 工具入口，让不同 agent 不必拼 CLI 命令。

## 2026-07-01 当前落地状态（v1.4）

新增已实现：

- `audit --project <root> --limit <n>`：生成候选、过期、已取代知识的审核报告。
- `.harness/knowledge/reports/audit-report-*.md`：包含 `Candidate Review`、`Stale Review`、`Superseded Review`。
- SQLite 新增 `entry_files(entry_id, source_file)` 表与 `idx_entry_files_source_file`，文件路径过滤从 JSON LIKE 推进到结构化表。
- 基础 `superseded` 检测：后续 archive 与旧条目文件重叠且知识类型相近时，非 active 自动生成条目标记为 `superseded`，并写入 `lifecycle.supersededBy`。
- `.harness/knowledge/views/superseded-items.md`：用于 Obsidian 浏览已被后续归档覆盖的知识。
- TTL 防腐：`.harness/knowledge/config.json` 可配置 `staleTtlDays`，超过归档日期 TTL 的非 `active`/`superseded` 条目会标记为 `stale` 并记录 `ttl expired` 原因。

仍未实现：

- `conflicted` 自动判定和 conflict report。
- 后续测试失败/降级导致旧 test-evidence stale。
- 真正增量 ingest（当前 sync 可检测 checksum，ingest 仍重建生成层）。
- MCP 工具入口。

## 2026-07-01 当前落地状态（v1.5）

新增已实现：

- 保守 `conflicted` 自动判定：同文件、同知识类型、共享主题词，并同时出现“唯一来源/复用”与“不再/替代/改为”等相反信号时，非 active 自动生成条目标记为 `conflicted`。
- 冲突条目写入 `.harness/knowledge/entries/conflicted/*.json`，并在 `lifecycle.conflictsWith` 和 `staleReasons` 中保留冲突来源。
- `audit` 报告新增 `Conflict Review`，JSON 输出新增 `conflictReview`。
- `.harness/knowledge/views/conflicted-items.md`：用于 Obsidian 浏览需要人工确认的潜在冲突。

仍未实现：

- 人工确认的 `active` 条目暂不自动移动或降级，只保留后续人工处理空间。
- 后续测试失败/降级导致旧 test-evidence stale。
- 真正增量 ingest（当前 sync 可检测 checksum，ingest 仍重建生成层）。
- MCP 工具入口。

## 2026-07-01 当前落地状态（v1.6）

新增已实现：

- 后续 archive 的 verification 出现失败、错误、失败状态或 pass ratio 降级时，旧的重叠 `test-evidence` 自动标记为 `stale`，并写入 `newer verification degraded` stale reason。
- 默认增量 ingest：`.harness/knowledge/cache/archive-entries/*.json` 保存按 archive checksum 和 HEAD 绑定的原始抽取结果；未变化 archive 会复用缓存，随后仍全局重算 dedupe、conflict、superseded、TTL 和 verification degradation。
- `ingest --no-incremental` 和 `sync --update --no-incremental` 可强制全量重抽取。
- `index.json` / CLI 摘要 / ingest report 新增 `ingestMode`，包含 `archivesExtracted`、`archivesReused`、`cacheWrites`。
- 新增 `scripts/harness_knowledge_mcp.py`：提供 stdio FastMCP server 入口，并支持 `--describe-tools` 输出工具元数据。
- 单测从 10 个扩展到 13 个，覆盖 test-evidence 降级、增量缓存复用、MCP 工具描述。

仍保守保留：

- 人工确认的 `active` 条目暂不自动移动或降级；后续 verification 降级、conflict、superseded 都只自动处理非 active 生成条目。
- MCP server 入口复用本地 Python `mcp.server.fastmcp`；未引入独立包管理或发布配置。

## 2026-07-01 当前落地状态（v1.7）

新增已实现：

- `audit` 新增 `Active Review`：对 `active` 条目做只读复核分析，遇到后续重叠 archive、潜在 conflict 或 verification 降级时，输出 `activeReview` JSON 和报告段落。
- `.harness/knowledge/views/active-review.md`：Obsidian Markdown 视图列出需要人工复核的 active 条目。
- `demote --project <root> --id <entry-id> --status stale|candidate --reason <说明>`：人工确认后显式降级 active 条目；降级到 stale 时写入 `manual demotion` stale reason。
- 带 `lifecycle.demotedAt` 的人工降级 candidate/stale 条目会跨后续 ingest 保留，并覆盖同 ID 自动生成条目。
- `.harness/knowledge/views/knowledge.base`：Obsidian Bases YAML 入口，按 lifecycle folder 浏览知识条目 JSON 文件。
- `mcp-config.example.json`：MCP client 配置示例。
- MCP server 暴露 `harness_knowledge_demote` 工具。
- 单测从 13 个扩展到 15 个，覆盖 active review、manual demote、Bases YAML、MCP demote 工具描述和配置示例。

仍保守保留：

- `active` 不会被自动改写；脚本只提示复核，实际移动必须通过 `demote` 显式执行。
- MCP evaluation 需要固定 fixture 项目；当前没有内置通用 evaluation 数据集。

## 2026-07-01 当前落地状态（v1.8）

新增已实现：

- `.harness/knowledge/config.json` 支持 `activeLifecycle.autoDemote` 和 `activeLifecycle.targetStatus`。
- 默认仍不自动改写 `active`；当显式启用 `autoDemote=true` 时，ingest 会基于 `Active Review` 自动将受影响 active 移动到 `stale` 或 `candidate`。
- 自动降级会记录 `lifecycle.autoDemoted=true`、`lifecycle.demotedAt`、`lifecycle.demotionReason`，降级到 stale 时写入 `auto demotion` stale reason。
- 新增固定 MCP evaluation fixture：`tests/fixtures/mcp-eval-project/`，包含 3 个稳定 archive。
- 新增 `evaluations/harness_knowledge_evaluation.xml`，包含 10 个稳定问答，覆盖 source-of-truth 演进、路径、manual action、webhook contract 和 fixture project id。
- 单测从 15 个扩展到 17 个，覆盖配置化 active auto-demote 和 evaluation fixture 可查询性。

仍保守保留：

- `activeLifecycle.autoDemote` 默认关闭；真实项目是否启用由项目配置显式决定。
- graph/vector/global index 仍未纳入 MVP；需要单独设计跨项目边界和过期知识防腐策略。

## 2026-07-01 当前落地状态（v1.9）

新增已实现：

- 引入 entry-level `validators[]`，用于把知识条目从“人工感觉仍有效”推进到“可被确定性证据持续验证”。
- 支持 `file_exists`、`file_contains`、`symbol_exists`、`command` 四类 validator。
- `command` validator 默认禁用；只有项目配置 `knowledgeValidation.allowCommandValidators=true` 时才执行，且命令必须是字符串数组。
- 新增 `verify --project <root>`，不重抽 archive，只验证当前 `.harness/knowledge/entries/**/*.json`，写回 `lifecycle.validation`，刷新 manifest、SQLite、views，并生成 `verification-report-*`。
- `ingest` 也执行 validator，并在 `ingestMode` 中记录 `validationChecked`、`validationFailed`、`validationAutoDemoted`。
- `knowledgeValidation.autoDemoteActive=true` 时，validator 失败的 active 可自动降级到 `defaultTargetStatus`，默认目标为 `stale`。
- MCP 新增 `harness_knowledge_verify` 工具。
- 单测从 17 个扩展到 20 个，覆盖 validator 自动降级、verify 命令、MCP verify 工具描述，以及 verify 刷新时保留 SQLite 基线条目。

仍保守保留：

- 没有 validator 的条目不会因为本机制自动降级；它们仍走已有 TTL、冲突、superseded、Active Review 等逻辑。
- validator 只适合代码事实、文件事实、符号事实、可重复命令事实；业务意图和团队取舍不能完全交给机器。
- graph/vector/global index 仍未纳入 MVP；v1.9 的目标是减少日常人工审计，不是替代所有人工判断。

## 2026-07-01 当前落地状态（v1.10）

新增已实现：

- 新增 `suggest-validators --project <root>`，从当前 entry 的 `scope.sourceFiles`、正文/标题/关键词 token 和真实项目文件内容生成 validator 建议。
- 默认只写 `reports/validator-suggestions-*`，不修改条目。
- `--apply` 会把建议写入 entry JSON，并刷新 manifest/SQLite/views；随后可用 `verify` 立即检查。
- 支持 `--status active` / `--status candidate` 过滤目标生命周期状态。
- MCP 新增 `harness_knowledge_suggest_validators`。
- 单测从 20 个扩展到 22 个，覆盖只读建议、apply 后 verify 可检查、MCP 工具描述。

仍保守保留：

- 当前只自动建议安全的 `file_exists` / `file_contains`；不会自动生成 `command` validator。
- 建议生成不会从不相关文件中猜测事实，只基于 entry 已声明的 sourceFiles。
- 真实项目首次使用建议先只读跑报告，再决定是否 `--apply`。

## 2026-07-01 当前落地状态（v1.11）

新增已实现：

- `auto --project <root>`：把常规知识库维护收敛成一条命令，顺序执行 `sync --update`、只读 `suggest-validators`、`verify`、`audit`。
- `auto` 默认不会写回 validator 建议，避免自动维护隐式改变知识生命周期；需要修改 entry JSON 时必须显式传入 `--apply-suggestions`。
- `--suggest-status active|candidate` 可限制 validator 建议或写入范围，适合先从 `candidate` 小范围试跑。
- MCP 新增 `harness_knowledge_auto`，agent 可以不拼 CLI 命令，直接调用默认维护流程。
- 单测从 22 个扩展到 24 个，覆盖 `auto` 只读默认路径、显式 apply 路径，以及 MCP tool metadata。

仍保守保留：

- 自动流程不自动 promote candidate；高价值 candidate 仍需要明确确认后再 `promote`。
- 默认不自动改写 active；active 的自动降级仍受项目配置 `activeLifecycle.autoDemote` / `knowledgeValidation.autoDemoteActive` 控制。
- 当前 validator 建议仍只生成保守的 `file_exists` / `file_contains`，不自动生成 `command` validator。

## 2026-07-01 当前落地状态（v1.12）

新增已实现：

- `ingest` 为所有知识条目写入解释型 `confidence`，包含 `score`、`level`、`signals` 和 `lastCalculatedAt`。
- `.harness/knowledge/config.json` 新增 `confidence` 配置，可调整时间衰减、来源文件变更、stale、validator、superseded/conflict 等惩罚或奖励。
- `.harness/knowledge/config.json` 新增 `autoPromote` 配置；默认关闭，显式启用后只提升高置信度、长期类型的 candidate。
- autoPromote 默认只允许 `decision`、`api-contract`、`requirement`、`pitfall`，排除 stale/conflicted/superseded，且不会自动提升一次性 implementation、test-evidence、risk。
- 自动提升会写入 `lifecycle.autoPromoted=true`、`promotionNote` 和 `promotedAt`，并在 `index.json.ingestMode` / ingest report 中记录 `candidateAutoPromoted`。
- `index.json` manifest 中保留每条 entry 的 `confidence` 摘要，方便 query、audit、agent 后续按证据强弱使用。
- 单测扩展到 34 个，覆盖 confidence 元数据、autoPromote 门槛、stale/age 惩罚，以及既有 auto/validator/MCP 路径。

仍需保持的边界：

- confidence 不是事实正确率，只是当前证据强弱；不能替代人类对业务意图、取舍和未编码契约的判断。
- autoPromote 默认关闭；真实项目应先跑一次默认 ingest，观察高置信候选的类型和数量，再决定是否写入配置。
- validator 仍只适合确定性事实，例如文件存在、符号存在、源码片段或可重复命令；业务策略不应强行转成伪确定性 validator。
- graph/vector/global index 仍属于后续增强，不应混入本地项目的第一层生命周期判断。

## 2026-07-01 当前落地状态（v1.13）

新增已实现：

- `auto --project <root>` 首次发现 `.harness/knowledge/config.json` 不存在时，会自动写入启用版 `autoPromote` + `confidence` 配置。
- 首建配置内容直接启用 `autoPromote.enabled=true`，门槛 `minConfidence=0.82`，允许类型为 `decision`、`api-contract`、`requirement`、`pitfall`。
- 如果写入 config 时现有索引已经是最新状态，`auto` 会主动 `build_index` 一次，让本轮就发生自动评分和提升。
- `auto` 输出新增 `config` 摘要，包含配置路径、是否新建、是否启用 autoPromote、由 `sync` 还是 `auto-rebuild` 应用，以及本轮自动提升数。
- `ingest` 单独命令仍不负责首建策略文件，避免低层重建命令在用户未选择 `auto` 维护入口时写入项目策略。
- 单测扩展到 35 个，覆盖“已有最新 index 但缺 config 时，auto 首建启用配置并立即提升”的路径。

仍需保持的边界：

- 自动首建启用配置会减少人工确认量，但不是所有 candidate 都该进入 active；类型、置信度、stale/conflict/superseded 过滤仍是必要护栏。
- 如果项目不希望自动提升，应在第一次运行 `auto` 前手动创建 `config.json` 并设置 `autoPromote.enabled=false`。
