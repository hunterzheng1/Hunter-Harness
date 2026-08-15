# 阶段 13：调整 Platform 项目信息架构

## 目标

让运行、文件、长期项目资料、可复用知识和变更历史各归其位。同一内容只存一份，页面通过分类视图引用，不重复展示。

## 依赖与并行边界

本阶段按数据源拆为可并行页面工作包：

| 页面工作包 | 前置 Interface |
|---|---|
| 分支文件、版本记录 | 阶段 02 的分支快照、文件分页和差异 |
| 项目资料 | 阶段 05 的 Map 快照和阶段 07 的规则/指令投影 |
| 项目知识 | 阶段 06 的知识查询、状态和重试 |
| 变更记录 | 阶段 06 的归档/变更文档分页 |
| 分支监控 | 阶段 12 的 Plan 事件；其他生命周期事件沿现有兼容 Schema |

各页面可以使用契约 fixture 并行实现，但共享导航、项目工作台容器、API 客户端生成文件和设计 token 由单一前端整合工作包修改。任何页面不得为方便展示复制 Blob 或重新定义服务端状态。

## 数据接口要求

- 列表接口统一使用稳定排序、`limit` 和 opaque cursor；默认页不得先取全量再在前端切片。
- 详情按 ID 或版本读取；大文件按需加载，不随列表返回正文。
- 全局搜索必须带 actor 可访问项目 allowlist，并在存储层按内容类型过滤。
- 页面聚合只组合引用和状态，不产生第二份内容副本。
- 空状态、处理中、部分失败和无权限使用不同机器状态与中文说明。

## 一级页签

建议顺序：

1. 分支监控
2. 分支文件
3. 项目资料
4. 项目知识
5. 变更记录
6. 版本记录
7. API 密钥

## 分支监控

只展示运行、阶段、事件、状态和耗时。Sync 不进入监控；文件、知识和项目资料也不在此页展示。

## 分支文件

原“文件”页改为按分支浏览最近成功快照：

- 左侧是分支列表，显示提交短哈希、最后上传时间、文件数量和本次变化数。
- 右侧显示所选分支的完整有效文件树和文件内容。
- 提供“全部文件”和“本次变化”视图。
- 内部路径可按中文分类展示，但详情保留真实路径。
- 支持查看版本差异和恢复缺失文件。

“恢复缺失文件”必须调用阶段 02/03 的显式分支文件 Pull 预览，等价于选择 `branch_files + branch + snapshot_version`。页面不得直接写项目文件，也不得绕过本地修改、预览哈希和逐文件冲突确认。

列表需要分页或虚拟滚动，不能一次加载无限历史。

## 项目资料

集中展示长期项目级内容：

- 规则
- 架构地图与可执行架构约束
- 指令
- 配置

架构地图来自阶段 05 的已验证现状快照；可执行架构约束来自阶段 07 的 `architecture.md`。界面可在同一“架构”分类下分区展示，但不能合并正文或让其中一方覆盖另一方。

默认取远端默认分支的最新快照。无法确认默认分支时，显示实际来源分支和提交，不能静默当作 `main`。

项目资料是分支快照的分类视图，不复制 Blob 或另存一份正文。

## 项目知识

只保留：

- 可复用知识条目与关系。
- 搜索和生命周期状态。
- 来源 Change 和提取时间。
- 最近一次提取状态及失败重试入口。

移除规则、架构、设计、计划、变更总结和归档状态。知识统计只计算知识条目。

## 变更记录

展示每个 Change 的：

- 中文标题和稳定 Change Key。
- 设计、计划、场景和变更总结。
- 归档与知识提取状态。
- 原始归档 ZIP 下载入口。

这些内容可以搜索，但索引类型必须是“变更文档”，不能由 `search_knowledge` 返回。

项目级候选在变更记录中显示来源和处理状态，并提供前往对应治理流程的入口。页面本身不直接把候选写入规则、架构地图或知识库。

## 版本记录

展示分支快照和项目资料的远端版本、提交、上传时间和文件差异，不重复运行事件。

## 前端交互原则

- 上传入口先展示范围和差异，再确认。
- 下拉入口展示目标分支、远端版本和冲突数量。
- 文件缺失时提供“恢复”快捷操作。
- 冲突支持批量选择后调整个别文件。
- 归档原包只在变更记录下载。
- 所有状态使用中文可读说明，技术码折叠到“技术详情”。
- “导出全部”沿 `next_cursor` 顺序读取全部授权页面，并显示导出范围和结果数量；不能只导出当前已加载页。普通列表仍按需加载，不因导出能力恢复无界查询。

## 分步实施

1. **13.1 查询契约**：为各页定义分页、排序、授权、详情和错误状态 fixture。
2. **13.2 工作台骨架**：统一导航、筛选、加载、空状态和技术详情组件。
3. **13.3 分支文件与版本**：实现快照树、变化视图、差异和恢复入口。
4. **13.4 项目资料**：展示规则、架构事实、架构约束、指令和配置的来源版本。
5. **13.5 项目知识与变更记录**：移除重复类型，增加提取状态、重试和归档下载。
6. **13.6 分支监控**：在阶段 12 事件 Schema 冻结后接入终态、耗时和中文事件。
7. **13.7 性能与可访问性**：验证分页、虚拟滚动、键盘操作、窄屏和错误恢复。

## 非目标

- 不在前端重建语义索引、Map 或规则投影。
- 不通过页面聚合复制内容 Blob。
- 不让展示用中文状态成为服务端状态源。
- 不为尚未冻结的 Plan 事件维护第二套长期兼容模型。

## 验收条件

- 可按分支查看完整有效文件，而不是全局 `.harness` 混合树。
- 项目资料能查看规则、架构、指令和配置，并标明来源。
- 项目知识不再重复展示项目资料和变更文档。
- 变更记录可查看归档状态并单独下载 ZIP。
- 页面请求有分页、游标或按需加载，不产生无界查询。
- 分支文件恢复复用 Pull 的预览、冲突和事务语义；导出全部不会静默遗漏后续游标页面。
- 同一内容在存储层没有因为多个页面而重复保存。

## 实施记录

### 13.1：Platform Information 查询契约

状态：已关闭。当前产物保留在 Hunter Harness 与 Hunter Platform 本地工作区，未提交、推送、合并或发布；页面、路由、数据库查询和工作台整合尚未实现。

已冻结的 v1 Interface：

- 六类页面查询统一使用有界 `limit`、opaque cursor、稳定排序、actor 项目 allowlist 和内容类型约束；Cursor 的真实性由显式 Server Port 验证，Schema 不把字符串格式冒充签名证明。
- Page 使用 ready、empty、processing、partial_failure、forbidden 六个基础/扩展可执行判别分支；`failed` 仅允许项目知识首次提取失败且结果为空。真实 Fastify/Ajv 与 Zod 逐例同判。列表只返回摘要与引用，正文和 Blob 仅按详情身份读取。
- 项目资料分别引用 Map 事实、架构约束、规则、指令和配置，不复制正文；项目知识只允许显式 knowledge entry；Change 文档与 Archive 下载引用独立；监控排除 Sync。
- Branch file restore 的 preview 与 confirmation 分为独立结构；组合 validator 只接受有界 serialized JSON，并精确绑定 project/source/version/scope/preview hash，以及 preview conflicts 与逐文件 decisions 的完整一一对应集合。最终 intent 不含正文、目标路径或直接写能力。
- Export-all 证明 request/response cursor 链唯一、连续、无环、终态为 null 且总数一致；不能把当前页当成全部结果。
- current/legacy、OpenAPI、TypeScript、fixture、sidecar 和生成声明在两仓字节一致；公共 reader browser-safe，无 Node-only 依赖。

完成证据：Harness 聚焦 `10/10`；Platform Contracts 与真实 OpenAPI `127/127`；跨仓动态 parity 为 Platform Information `22` 项、Archive receipt `6` 项；两仓 full lint、typecheck、build 与 diff check 通过，Platform Web production build `11` 个 route 通过。最终独立复审 Ready，阻断 finding 为 `0`。

13.1 关闭后仍未接入：

- 13.2 工作台导航、筛选、加载、空状态和技术详情组件。
- 13.3～13.6 各页面的 Server 查询/授权 Adapter、数据库游标、API 路由、客户端与页面。
- 13.7 Web 工作台性能、可访问性和错误恢复验收已在独立工作包中关闭；其生产数据写入与 API 组合仍见本文件末尾。

### 13.1-M2：项目知识失败态、显式标题与重试意图

状态：已关闭。`project_knowledge` 现在可用独立 `failed` 分支诚实表达零结果的首次提取失败；其他 view 不接受该状态。Knowledge Result 与列表项必需显式 `display_title`，不从 summary 截断推断。`knowledge_extraction_retry_intent` 是 request-only 严格 serialized 契约，绑定可信 actor、project、job 与 generation 外锚，并通过注入式 browser-safe SHA-256 Port 重建 canonical identity；不含执行 token 或直接重试能力。双仓 fixture 使用真实 canonical hash，Fastify/Ajv、Zod、OpenAPI、Web build 与跨仓 parity 已通过独立复审。

### 13.2：项目工作台骨架

状态：已关闭。项目详情已接入七段权威导航、统一筛选与 loading/empty/processing/partial failure/forbidden/error 状态容器、折叠技术详情、键盘 roving tab、`Home`/`End`、完整 ARIA tab/panel 关联和窄屏横向导航。所有交互目标至少 `44px`；多实例 ID 唯一。未完成的数据页使用诚实 processing fallback，不伪造生产数据或 endpoint；既有监控、文件、知识、版本与 API Key 面板保持原行为。独立终审 Ready，focused `15/15`，typecheck、lint 和 production build 通过。

### 13.3：分支文件、版本、差异与恢复查询 Adapter

状态：已关闭。`BranchVersionQueryAdapter` 只消费阶段 02 M3～M6 的正式只读 Module：分支与项目级版本使用单一 opaque cursor 和稳定排序，列表不含正文，文件详情与 diff 绑定完整快照身份。恢复链先生成只读 preview，再用 13.1 组合 validator 校验 confirmation；request-only intent 保留完整 `selected_paths`、source identity 与 preview hash，不含正文、目标目录或写能力。真实非终页 cursor 已完成两页往返；独立终审 Ready，M3～M6 + 13.1 affected `165/165`。

### 13.4：项目资料查询 Adapter

状态：已关闭。项目资料只包含 config、rule、architecture map、architecture constraint 与 instruction，不把 Plan 伪装成资料。列表仅返回引用，详情按 UTF-8 正文重算 SHA-256 并与 Blob/content hash 双绑定；架构约束继续使用阶段 01 的 canonical `rule` content type。排序键由 category、path 与 snapshot version 唯一重建；ACL、cursor、五类页面状态、legacy 与 hostile 输入均 fail closed。独立终审 Ready，focused `19/19`。

### 13.5：项目知识与变更记录查询 Adapter

状态：已关闭。项目知识只投影 explicit knowledge entry 与显式标题；支持可信失败态和经独立 Authority Port 锚定的 request-only 重试意图，cursor verifier 仅严格布尔 `true` 放行。变更记录列表不含正文，design、plan、test scenarios 与 change summary 引用必须经独立 `ChangeDocumentReferencePort` 解析；document identity、project、Change、NFC path、type、content hash、Archive 与 package 身份在列表、记录详情和正文详情三条路径精确绑定。测试场景只接受 `plans/<change_key>-test-scenarios.md`，canonical Change Key 不能含路径片段。两个 Adapter 最终独立终审均 Ready；知识 affected `200/200`，变更 affected `192/192`，无跳过测试。

### 13.6a：分支监控只读 Query Adapter

状态：已关闭。当前产物保留在 Hunter Platform 本地工作区，未提交、推送、合并或发布；真实 RunStore、阶段 12 verifier 的跨仓生产装配、持久 cursor、Fastify 路由、Web API client 和监控页面均未接入。

- `BranchMonitorQueryAdapter` 只接受 13.1 的 `branch_monitor` current 查询与详情请求，并通过 `BranchMonitorSourcePort` 读取有界 serialized RunStore 投影。该 Port 只是只读 seam；当前工作包没有实现或修改生产 RunStore。
- 每个 Stage 12 bundle 必须经 `Stage12MonitorVerifierPort` 验证，并精确回显项目与 bundle SHA-256。列表只投影 Change 生命周期的 run 状态、当前阶段、时间、耗时和稳定排序键；详情只返回已验证 `event_id` 引用，不复制事件正文。
- actor allowlist、`run_event` 内容类型、排序、请求 cursor、source echo、项目、run 身份、页状态和数量上限均需一致。重复 run、错误排序、伪造 verifier、legacy 请求、hostile 输入和超过页上限均 fail closed；forbidden 与 partial failure 保持 13.1 的诚实页面状态。

完成证据：本轮聚焦测试 `16/16` 通过，无跳过。该证据只关闭纯 Query Adapter，不证明真实 RunStore、HTTP 路由、页面或阶段 12 跨仓接线已经完成。

13.2～13.6a 关闭后仍未接入：

- PostgreSQL 查询与持久 cursor Adapter、Fastify API 路由、Web API client，以及四类页面的真实数据 slot。
- 13.6 分支监控的真实 RunStore、阶段 12 verifier 生产装配、持久 cursor、Fastify API 路由、Web API client 和页面接线。
- 13.7 Web 工作台性能、可访问性和错误恢复验收已关闭；生产数据写入与 API 组合仍见本文件末尾。

### 13.6b：项目资料 PostgreSQL Source 与生产组合

状态：已关闭。`PgProjectMaterialsSource` 只从当前 immutable branch snapshot 读取项目资料的引用，详情按单 Blob 重算正文身份；列表不读取正文，cursor 绑定 actor、项目、排序和完整 current snapshot。生产组合使用独立的 `HUNTER_PROJECT_MATERIALS_CURSOR_SECRET` / `HUNTER_PROJECT_MATERIALS_CURSOR_SECRET_FILE`，不复用分支监控密钥；缺少密钥时不发布该 view，由现有路由返回 `503`。短密钥、空文件和密钥文件读取失败均 fail closed。`main` 复用同一 `Pool`，并以 `PgBranchSnapshotPort` 同时提供快照读取和 Blob reader。

完成证据：

- Materials source、production composition、routes 受影响测试 `62` 项通过；其中 `1` 项真实 PostgreSQL 集成测试因当前环境没有数据库而跳过，该项不计入通过数。
- Server typecheck、build、限定 ESLint 与 diff check 通过；独立 actual-diff 复审 Ready，Standards 与 Spec 均为 `Yes`，阻断 finding 为 `0`。

13.6b 关闭后仍未接入：

- branch snapshot 的生产写入者尚未接入 Push/Finalize，因此没有快照时 Materials view 仍诚实返回 `processing` 或 `503`。
- 项目知识与变更记录仍缺 Stage 06 的生产持久真相源；导出 POST/download 仍需单独冻结 HTTP 创建、幂等、权限、过期和流式响应语义。
- 13.7 Web 工作台性能、可访问性和错误恢复验收已关闭；生产数据写入与 API 组合仍见本文件末尾。

### 13.6c：导出制品内部存储与元数据

状态：已关闭内部工作包。`canonical_jsonl_v1` contract、分页流式导出 Module、受控私有目录 authority、Windows/POSIX 受控文件发布、CAS Local Adapter 与 PostgreSQL metadata migration/adapter 已分别通过独立复审。制品写入使用有界 chunk、独立 hash/length/readback 和失败不返回 partial proof；metadata 的幂等、过期 claim/ack、项目级级联和 mixed-project batch 清理使用显式事务与 cursor。该工作包没有修改现有导出 GET 的响应，也没有接入 HTTP POST、下载路由或现有 `getBlob()`。

完成证据：

- M6A/M6B/M6C/M6C0/M6C3/M6D focused 与受影响测试均通过；Windows Local CAS focused `19/19`，真实 PostgreSQL metadata focused `8/8`，无把环境跳过计入通过。
- Platform typecheck、build、限定 lint、diff check 与独立 actual-diff 复审通过；CAS 复审确认 canonical 文件均走受控原子发布，guardian/receipt identity 与 live-reference 检查保持 fail closed。

13.6c 关闭后仍未接入：

- HTTP 制品创建/重放的状态码、lookup-first 顺序、Idempotency-Key 冲突语义仍需产品裁决；现有 GET `:export-all` 继续是只读 proof 操作。
- 下载的授权不泄露、过期状态、媒体类型、Content-Disposition、流式 backpressure/range 和 request-id 响应仍需独立 HTTP contract；在契约冻结前不接 routes/main。

### 13.7：Web 工作台性能与可访问性

状态：已关闭。Web 工作台的权威查询路径保持 bounded page/cursor 读取，不恢复 legacy 全量列表；列表 cursor cycle、重复/空游标、详情 generation 和迟到响应均 fail closed。文件正文缓存绑定 `project_id + project_version + content_sha256`，同项目版本刷新不会在新 metadata 下复用旧正文；保存后的 refresh 期间禁用文件选择与 mutation controls，并清理 draft，避免 refresh race 覆盖用户新选择。

Legacy fallback 与新工作台的文件树、筛选、编辑/重命名/删除、编辑器关闭/保存/取消、summary 和 toolbar controls 均提供键盘可达的 `44px` touch target；筛选状态使用 `aria-pressed`。未接入的数据页继续显示诚实 processing/error 状态，不伪造生产数据。

完成证据：

- Web/Platform focused `45/45`（4 files）；workspace/race 回归覆盖 `12/12`；
- Root 与 Web typecheck、root lint、限定 ESLint、diff check 通过；
- Web Next production build 生成 `11` routes；
- 独立双轴复审 Ready，P1/P2 finding 为 `0`。

13.7 关闭后仍未接入：分支快照生产写入者、知识/变更持久真相源、导出 HTTP create/download 生命周期与完整生产 API 组合；这些不能由页面工作包推断或代替。
