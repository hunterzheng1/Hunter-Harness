# 阶段 09：构建 Plan 意图与证据上下文

## 依赖与并行边界

必须先完成：

1. 阶段 05 的 `MapEvidenceBundle` Interface。
2. 阶段 06 的远端知识查询 Interface。
3. 阶段 07 的 canonical 规则读取 Interface。
4. 阶段 08 的 `PlanProfile`。

本阶段只拥有 `IntentContract`、`KnowledgeContext`、`EvidenceMap` 和 `PlanningContext`。它不修改 Map、知识索引、规则或 `PlanProfile`。上述依赖均可由内存 Adapter 和 fixture 提供，因此阶段 09 不需要等待阶段 13 页面完成。

## 目标

在开始设计前形成一个可复用的 `PlanningContext`，集中保存用户意图、远端历史知识、代码证据、项目约束和未决问题。后续设计、任务和场景都读取同一上下文，避免重复查询和重复读取。

## 当前问题

- 知识查询直接使用用户原始需求，查询词可能包含噪声。
- 固定返回较多结果，但缺少相关性、时效性和冲突标记。
- 查询发生在代码探索前，可能缺少模块名、符号和错误码。
- 设计、任务和场景可能分别读取相同文件或重新解释同一证据。
- codebase map、CodeGraph、项目规则和远端知识没有统一的证据表达。

## 设计方案

### 建立 `IntentContract`

在远端知识查询前，从用户输入中提取以下字段：

```yaml
schema_version: 版本
intent_id: 稳定身份
goal: 要解决的问题
user_visible_outcome: 用户最终看到或获得的结果
in_scope: 明确包含的范围
out_of_scope: 明确不做的内容
constraints: 兼容、安全、性能或交付约束
acceptance_examples: 2～5 个可观察示例
uncertainties: 仍然影响实现方向的歧义
source_input_hash: 用户输入指纹
```

如果用户输入已经充分，系统直接生成该契约，不要求用户重复确认。只有 `uncertainties` 中的事项进入阶段 10 的决策前沿。

### 使用有预算的远端知识查询

项目已绑定平台时，默认执行一次远端查询：

- 查询输入由目标、领域词、模块线索和约束组成。
- 不直接拼接完整对话或无关补充说明。
- 不搜索本地技能目录，不查找其他知识脚本。
- 远端失败时记录问题并继续，不建立本地索引或离线回退。

只有同时满足以下条件，才允许第二次定向查询：

- 第一次没有高相关结果，或结果存在明显冲突。
- 代码探索发现了新的模块、符号、错误码或历史迁移标识。
- 定向查询能够回答一个明确的规划问题。

单次 Plan 最多执行两次远端知识查询。

每次查询都产生可恢复的机器收据：

```text
KnowledgeQueryReceipt = {
  schema_version,
  query_hash,
  project_id,
  index_generation,
  result_ids[],
  source_versions[],
  result_set_hash,
  executed_at,
  reason_code,
  supersedes?
}
```

恢复时，查询哈希、项目身份、索引 generation 和结果集合均未变化，直接复用收据。索引 generation 变化不要求无条件重查；只有变化可能影响当前规划问题时才使对应知识分区失效。

### 生成压缩的 `KnowledgeContext`

后续阶段不直接消费未经整理的前 10 条结果。每条采用统一结构：

```yaml
source: 来源标识
verified_at: 已知验证时间
relevance: 与当前意图的关系
summary: 可复用结论
conflict: 是否与当前需求或代码冲突
```

`KnowledgeContext` 还记录 `schema_version`、`query_receipt_ref`、保留项 ID、压缩结果哈希和截断原因。默认只保留最相关的 3～5 条。服务端负责类型过滤、授权、检索排序和返回有界摘要；阶段 09 的 `PlanningContextBuilder` 负责按当前意图标注相关性、冲突并压缩为 `KnowledgeContext`。该压缩每个查询收据只执行一次并持久化结果哈希，阶段 10～12 不得再次调用模型重写同一结果。历史知识不能覆盖当前用户的明确要求。出现实质冲突时，将冲突转换成用户决策或非阻断问题。

### 建立一次性 `EvidenceMap`

代码探索输出以下结构，不为设计、任务和场景分别重新探索：

```yaml
modules: 受影响模块
symbols: 关键接口、类型和调用点
consumers: 主要调用方或下游影响
tests: 可复用测试、fixture 和验证入口
constraints: 代码和配置中确认的限制
unknowns: 尚未证实的内容
sources: codebase map、CodeGraph、文件或配置来源
```

探索路由：

1. codebase map 有效时，先用于模块导航。
2. `.codegraph/` 存在时，优先用 CodeGraph 理解符号和调用关系。
3. 使用定向文件读取补充实现细节。
4. 不在 Plan 中自动重建缺失的 codebase map 或 CodeGraph 索引。

### `PlanningContext` 是恢复状态，不是新的业务真相源

`PlanningContext` 可以持久化到 `meta/` 供中断恢复，但人类可审核的设计、任务和场景仍是最终真相源。上下文只保存证据、决策输入和来源，不复制完整文档正文。

`PlanningContext` 必须记录每个输入的版本身份：`PlanProfile` schema 版本、Map manifest 哈希、知识结果游标或查询身份、规则 manifest 哈希和用户意图哈希。恢复时只失效发生变化的分区，不能因为时间经过而无条件重新查询和探索。

最小机器结构为：

```text
PlanningContext = {
  schema_version,
  context_id,
  plan_profile_ref,
  planned_phase_set_ref,
  intent_contract_ref,
  knowledge_context_ref?,
  evidence_map_ref,
  rules_manifest_hash?,
  map_manifest_hash?,
  partition_hashes,
  unresolved_decision_ids[],
  status,
  created_at,
  supersedes?
}
```

`EvidenceMap` 同样包含 `schema_version`、稳定 ID、来源版本、内容哈希和预算使用量。`PlanningContext` 只保存引用与分区哈希，不内嵌完整 Map、规则正文或知识结果原文。

## 实施步骤

1. 定义 `IntentContract`、`KnowledgeContext`、`EvidenceMap` 和 `PlanningContext` 的最小 schema。
2. 将原始需求查询替换为结构化查询构造器。
3. 为第二次定向查询增加显式条件和计数限制。
4. 让服务端返回有界摘要、来源、索引 generation 和结果身份；由 `PlanningContextBuilder` 完成一次性意图相关压缩和冲突标注。
5. 将代码探索结果写成一次性 `EvidenceMap`。
6. 让阶段 10～12 复用同一上下文，而不是重复读取和查询。
7. 使用输入哈希识别上下文是否仍有效；用户更改目标或范围时，失效受影响部分。
8. 更新事件，只记录查询结论、冲突和失败，不记录冗长原始结果。

## 验收条件

- 项目绑定平台后，Plan 只使用公开的远端知识查询入口。
- 默认查询一次；第二次查询必须有明确触发原因。
- 查询失败不会触发本地索引或重复的 sync/query 循环。
- 设计、任务和场景能够引用同一份 EvidenceMap。
- 用户修改目标后，旧假设不会继续进入设计。
- 历史知识包含来源和时效信息，且不能静默覆盖当前需求。
- 简单修复仍遵守现有探索预算。

## 聚焦测试

- 原始需求包含多问题和口语时的结构化查询测试。
- 首次命中充分时不执行第二次查询。
- 首次无命中、探索发现错误码时执行一次定向查询。
- 远端超时和不可用时只记录一次失败。
- 历史知识与用户要求冲突时生成冲突项。
- 用户纠正范围后，EvidenceMap 局部失效并重新探索。
- codebase map 缺失时不在 Plan 中自动生成。

## 非目标

- 不在 Plan 中生成、更新或修复知识索引。
- 不把设计、规则、架构或变更文档当作知识查询结果。
- 不在阶段 10～12 重新执行相同知识查询或二次压缩。
- 不让远端历史知识覆盖当前用户的明确目标和约束。

## 实施记录

### 09-M1：Plan 意图、知识与证据上下文纯 Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `buildIntent(...)` 将原始需求收敛为稳定 `IntentContract`；原文只参与哈希，不复制进恢复状态。验收项保持 2～5 条并具有稳定身份。
- `buildKnowledgeQuery(...)` 生成有界查询并最多允许一次带明确原因的定向补充查询。查询状态和嵌套条件使用 plain-own、exact 的运行时校验；额外字段或错误类型不会触发查询。
- `compressKnowledge(...)` 只处理完整、canonical 的 `KnowledgeQueryReceipt`。收据 ID、结果集哈希、结果 ID、来源版本、状态和失败语义形成交叉闭包；空结果不能携带孤立来源版本，缺少来源版本的结果保持 `incomplete`，不伪造来源。
- `buildEvidenceMap(...)` 生成一次性有界证据引用。来源引用只包含类型、身份、版本和内容哈希；预算与实际来源、引用数量精确一致，不保存完整文档正文。
- `buildPlanningContext(...)` 完整解析阶段 08 Profile/阶段集、KnowledgeContext 和 EvidenceMap。KnowledgeContext 内嵌 canonical 查询收据，并由外部 `trusted_knowledge_receipt` 再次锚定；知识意图必须与当前 Intent 相同，不能通过重算自哈希替换收据或混入 foreign intent。
- 冲突项与 `unresolved_decision_ids` 形成可重算闭包。存在未决冲突时上下文固定为 `decisions_required`，历史知识不能静默覆盖当前要求。
- `invalidatePartitions(...)` 使用显式 `unchanged | set | remove` 更新，能够区分未变化与已删除。删除 knowledge、rules 或 map 会失效对应旧分区；删除 map 同时失效依赖它的 EvidenceMap。
- legacy fixture 只读投影且不能恢复为 ready；当前写入只使用 v1。

完成证据：

- 聚焦测试：`7/7` 通过。
- 阶段 05、07A、08 与 09 的受影响测试：`4` 个文件、`202/202` 通过。
- 稳定树 Core 全量测试：`57` 个文件、`828/828` 通过，无跳过。
- Core 类型检查、构建、限定范围 ESLint 和 diff check 通过。
- hostile 矩阵覆盖收据与结果集自重哈希、冲突隐藏、foreign intent、孤立来源版本、查询状态额外字段和错误类型、证据预算与正文夹带，以及分区删除的级联失效。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/planning-context/**`、聚焦测试和 current/legacy fixture；未修改阶段 05～08 的冻结 Interface、现有 Plan 状态机、CLI、Skill、OpenAPI 或 Platform。

### 09-M2：Knowledge Query HTTP Contract、Platform Route 与 CLI Consumer

状态：契约、边界路由、CLI 消费端，以及 PostgreSQL 知识索引/查询收据持久化 Adapter 已关闭；生产 `main` 已注入该 Adapter。真实数据库 integration 仍依赖 `HUNTER_HARNESS_TEST_DATABASE_URL`，未注入服务时路由与 CLI 继续 fail closed。

- 两仓共享 `knowledge-query-http` v1 contract 绑定 `query_id`、`query_hash`、`receipt_id`、`result_set_hash`、项目身份、失败收据和摘要预算；响应只携带 bounded summary，不携带正文或本地索引回退。
- Hunter Platform 提供认证、项目绑定、幂等结果和稳定错误映射的 POST route；未知或 hostile service output 统一拒绝，不泄漏后端错误。
- `hunter-harness knowledge query` 已迁移到该 bounded endpoint，输出 `query_id`、完整可验证 `receipt` 锚点以及 `result_id/kind/summary/relevance/source` 等字段；不再调用旧 semantic-search 正文接口。解析、网络和 hostile transport 错误统一为固定 `REMOTE_UNAVAILABLE`，不回显远端原文。

完成证据：Harness contract `7/7`；Platform contract/route/OpenAPI `26/26`；PG 查询 focused `18/18`，知识 pipeline/route/PG affected `100/100`；Server 类型检查、构建、限定 ESLint 与 diff check 通过；OpenAPI hash 和 source/test/fixture 镜像校验通过；真实 PG integration 因缺少 `HUNTER_HARNESS_TEST_DATABASE_URL` 保留为环境限定。

### 09-M3：PlanningContext durable State Port

状态：合同与 reference Port 已关闭；生产文件系统 Adapter 和现有 `harness-plan` / Python 恢复接线仍未实施。

- 聚合身份固定为 `{project_id, change_key}`，并要求 `change_key === PlanProfile.change_id`。每个 Change 只有一个权威 current；完整 bounded canonical PlanningContext payload、descriptor/hash、append-only audit、command receipt 和待投递事件在同一 CAS/idempotent commit 中原子更新，不维护 payload shadow Map。
- 事件只允许 `context_created`、`context_replaced`、`partitions_invalidated`。替换必须绑定正确 `supersedes`；`context_replaced` 只允许零 partition delta，`partitions_invalidated` 必须携带更新并精确等于纯 `invalidatePartitions()` 的依赖闭包，包括 intent、map 和 profile 的级联失效。
- Profile partition witness 精确绑定 `stableHash(profile.classification_hash)`。conflict 不追加 current、audit 或 delivery；pending delivery 可在重启后查询并通过 exact identity ack，replay/conflict fail closed。
- v0 只读；Proxy、accessor、thenable、cycle、深度、节点、数组和总字节均在信任边界拒绝。

完成证据：最终 focused `10/10`、affected `23/23`；Core typecheck/build、scoped ESLint、diff check 通过；原 reviewer 最终 Standards/Spec Ready，profile witness、事件 delta、durable delivery 与 hostile seam findings 全部闭合。

09-M1 关闭后仍未接入的 Adapter：

- PlanningContext 的生产持久化、事件、恢复和现有 `harness-plan` / Python 状态机接线；PG 查询 Adapter 只负责索引快照与 durable receipt，不替代 PlanningContext 真相源。调用方必须把可信收据作为外部锚传给 PlanningContext，不能只信任内嵌自哈希。
- Codebase Map、canonical 规则、EvidenceMap 收集和模型压缩的真实调用 Adapter；纯 Module 不访问文件系统、网络或模型。
- PlanningContext 的持久化、事件、恢复和现有 `harness-plan` / Python 状态机接线。
- 阶段 10～12 的决策、产物与质量门必须消费该唯一上下文，不得重复查询、再次压缩或建立第二套意图来源。

## 停止条件和回退

如果现有知识 API 无法返回来源或时效字段，先保留兼容字段并在客户端标记「来源信息不完整」。不要为了完成本阶段伪造验证时间或相关性分数。

如果持久化 `PlanningContext` 会引入新的跨阶段真相源冲突，则先以内存对象和事件引用实现，再单独设计恢复格式。
