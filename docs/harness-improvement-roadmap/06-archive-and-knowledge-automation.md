# 阶段 06：归档与服务端知识自动化

## 目标

归档只负责形成可信、不可变、可恢复的本地历史输入，并把确定性的核心包交给统一远端同步模块。Platform 负责持久保存归档、投影变更资料、提取可复用知识和生成项目内容候选。

知识提取与查询统一在远端，避免本地和服务端维护两套知识源。规则、架构、配置和指令使用阶段 02 的项目内容同步协议，不混入归档原包，也不冒充知识。

## 依赖与并行边界

本阶段保留两个公共工作包，并在工作包内部继续拆分：

- **06A 服务端队列与提取**
  - `06A-1`：归档持久化、状态和任务入队。
  - `06A-2`：变更资料增量投影。
  - `06A-3`：知识提取、去重、索引和历史补处理。
- **06B Archive 接入**
  - `06B-1`：本地 `ArchiveEngine` 与关闭策略。
  - `06B-2`：核心包、outbox、恢复和进度上报。
  - `06B-3`：阶段 02 `RemoteSyncModule` 的 Archive Adapter。

06A 依赖阶段 01 的归档、变更文档、知识类型和状态 Schema，可与阶段 02、05 和 08 并行。06B-1 只依赖阶段 01，可与 06A 并行；06B-2 依赖 06B-1 以及已经冻结的 core-v2 和 `ArchiveIngestReceipt`；06B-3 依赖阶段 02 的 `RemoteSyncModule`、06B-2 的包收据以及 06A-1 的入队 Interface。

06A 拥有提取队列、知识条目和索引 Schema；06B 拥有本地归档事务和 Archive Adapter。两者通过 `ArchiveIngestReceipt` 和 `KnowledgeExtractionJob` 连接，不共享可变目录。阶段 07 只消费候选查询 Interface，阶段 09 只消费知识查询 Interface。

## 现状基线与主要问题

当前实现已经具备隔离 staging、不可变归档、确定性 ZIP、路径安全、上传失败保留待重试包以及本地终态先于网络操作等基础能力。这些能力必须保留。

仍需解决以下问题：

1. 单个归档模块同时负责关闭策略、Git 与发布资格、验证证据、敏感扫描、staging、摘要、manifest、耐久副本、监控、ZIP、上传和项目内容 Push，Module 边界过宽。
2. 同一 Change 会被多次递归扫描、读取和哈希；摘要和 manifest 也会重复生成。归档耗时随文件数和校验项叠加。
3. 服务停止存在重复调用；归档完成后还会串行启动两个嵌套 `npx` 进程执行 ZIP 上传和项目内容 Push。
4. 服务端在上传请求内完成版本发布和语义快照重建。归档越大，请求耗时和服务器瞬时压力越高。
5. `knowledge_status` 同时承担归档文档索引和可复用知识提取的含义，无法判断知识是否真的完成提取。
6. 固定的计划、账本、Git upstream 和 Push 门禁没有完全服从 `PlannedPhaseSet`、归档意图与结束方式，容易在归档时临时修补无关证据。
7. 本地事件流冻结后缺少独立操作进度；崩溃后也不能可靠复用已完成的 staging、ZIP 或远端收据。
8. 当前归档说明与实现存在顺序漂移，例如 manifest 生成时点、终态同步时点、未完成归档的最低材料和无 upstream 的处理方式。

## 目标模块边界

### `ArchiveEngine`

`ArchiveEngine` 是本地深模块，只负责：

- 根据 `ClosurePolicy` 判断能否结束 Change。
- 冻结输入快照并构建 staging。
- 生成结构化摘要、候选和最终 manifest。
- 原子发布本地归档。
- 写入本地归档收据和终态事件。

建议 Interface：

```text
prepareArchive(change, policy) -> ArchivePlan
finalizeLocalArchive(plan) -> LocalArchiveReceipt
resumeArchive(operationId) -> LocalArchiveReceipt
reconcileArchive(changeIdentity) -> ArchiveReconcileResult
```

`ArchiveEngine` 不访问 Platform，不启动 `npx`，不调用知识模型，也不上传规则、架构、配置或指令。

`ArchivePlan` 是只读预览，至少包含 `operation_id`、Change 身份、`ClosurePolicy` 哈希、来源快照哈希、预计归档路径、纳入与排除项、阻塞项、警告和预期输出。finalize 前任一输入变化都使计划过期，不能沿用旧确认。

### `ArchivePackageBuilder`

`ArchivePackageBuilder` 根据已经发布且不可变的本地归档构建或复用确定性 ZIP：

```text
buildPackage(localReceipt, packageSchemaVersion) -> ArchivePackageReceipt
verifyPackage(packageReceipt) -> PackageVerification
```

`ArchivePackageReceipt` 与 `LocalArchiveReceipt` 分离。包构建失败不会撤销本地归档，也不会把 Archive 生命周期终态改为失败。

### `ArchiveOutbox`

`ArchiveOutbox` 只管理待上传核心包：

```text
enqueue(receipt, package) -> OutboxEntry
claim(entryId) -> ClaimedEntry
markStored(entryId, syncReceipt) -> void
markRetryable(entryId, reasonCode) -> void
```

只有 `ArchiveSyncReceipt.archive_status=stored`、项目身份匹配且包哈希一致，才可清理本地重试 ZIP。知识提取失败由服务端重试，不能要求客户端重复上传相同 ZIP。

`OutboxEntry` 至少记录 `entry_id`、`ArchivePackageReceipt` 引用、项目与 Change 身份、尝试次数、下次重试时间、租约、最近原因码和已确认的 `ArchiveSyncReceipt`。outbox 位于不可变归档树之外；清理或重建 outbox 不修改本地归档内容。

### `ArchiveRemoteAdapter`

`ArchiveRemoteAdapter` 调用阶段 02 的 `publishArchive()`，不复制鉴权、幂等、冲突、重试或 HTTP 逻辑。它把 Platform 的 `ArchiveIngestReceipt` 投影为阶段 02 的 `ArchiveSyncReceipt`，并校验项目、Change、包哈希和耐久状态。交互式 Archive 可以在执行前询问是否上传；非交互模式读取已冻结的项目偏好。用户取消上传不影响本地归档成功。

规则、架构、配置和指令的上传由阶段 03 的 Push 入口处理。Archive 编排层可以在本地归档完成后询问一次是否推送发生变化的项目内容，但只能把用户选择映射为 `SyncScope`，不能自行实现 Push。

### Platform 后台处理器

Platform 将归档处理拆为三个独立 Adapter：

- `ArchiveStore`：验证并耐久保存原始 ZIP。
- `ChangeProjectionWorker`：增量投影设计、计划和变更总结。
- `KnowledgeExtractionWorker`：提取、去重并索引可复用知识。

规则或架构候选通过 `ProjectContentCandidateWorker` 进入阶段 07 的治理流程，不能直接覆盖 canonical 文件。

`ArchiveIngestReceipt` 的最小结构为：

```text
ArchiveIngestReceipt = {
  schema_version,
  request_id,
  idempotency_key,
  project_id,
  change_key,
  archive_id,
  package_sha256,
  archive_status,
  change_projection_job_id,
  knowledge_extraction_job_id,
  project_content_job_id?,
  project_version,
  stored_at,
  retryable,
  reason_code?
}
```

`KnowledgeExtractionJob` 记录 `job_id`、`archive_id`、包哈希、提取器版本、提示词版本、索引 Schema 版本、状态、attempt、输入/输出哈希和原因码。任务重试不能改变归档包身份。

## 关闭策略

归档门禁必须由以下三类输入共同决定：

```text
ClosurePolicy = {
  disposition,      // completed | abandoned | superseded
  archive_intent,   // release-candidate | record-only
  planned_phase_set_ref?,
  available_evidence
}
```

具体规则如下：

| 结束方式 | 归档意图 | 必需材料 | Git 与远端要求 |
|---|---|---|---|
| `completed` | `release-candidate` | 所有已计划阶段的终态和发布所需验证证据 | 按发布策略严格检查 upstream、Push、CI 和候选证明 |
| `completed` | `record-only` | 所有已计划阶段的终态；未计划阶段写 `NOT_RUN` | 允许无 Git、无 upstream、本地提交或未 Push；作为事实记录，不作为阻断 |
| `abandoned` | `record-only` | 稳定 Change 身份、中文终止原因、最小终态记录 | 不要求计划、完整 ledger、upstream 或新提交 |
| `superseded` | `record-only` | 稳定 Change 身份、替代对象或中文原因、最小终态记录 | 不要求计划、完整 ledger、upstream 或新提交 |

补充约束：

- `completed` 只检查 `planned_phase_set_ref` 指向的 `PlannedPhaseSet.planned_phases`，不能固定要求 Test、Review 或 Submit；`abandoned`、`superseded` 允许没有阶段计划，但必须有最小终止事实。
- 未计划阶段不能通过补造报告或 ledger 伪装为已执行。
- 门禁输出必须区分“可自动修复”“需要用户选择”“仅发布候选需要”和“不可恢复损坏”。Agent 不应为通过 record-only 归档而修改产品文件或伪造证据。
- `release-candidate` 失败可以降级为用户确认的 `record-only`，但必须重新生成预览并记录决策，不能静默降级。

## 本地归档事务

推荐执行顺序：

1. 解析 `ClosurePolicy`，生成只读 `ArchivePlan`。
2. 对需要冻结的事件或后台写入执行一次 `quiesce`；失败语义必须明确，不能在结束后重复停止服务。
3. 计算输入快照指纹，并创建可恢复的确定性 operation。
4. 将允许归档的文件一次性投影到 staging。
5. 对最终 staging 执行结构、路径、凭据排除、预算和完整性检查；仅对准备进入远端核心包的投影执行阻断式敏感内容检查。
6. 在内存中一次性计算变更摘要、验证证明和候选。
7. 写入最终文件，并生成一份权威 manifest。
8. 在同一文件系统内原子发布本地归档；若只能跨卷复制，则显式执行最终哈希验证。
9. 写入 `LocalArchiveReceipt` 和不可变终态事件，并立即同步终态，停止页面阶段计时。
10. 生成或复用确定性 ZIP，写入 outbox；后续网络操作不再属于归档阶段耗时。

`LocalArchiveReceipt` 至少包含：

```text
LocalArchiveReceipt = {
  operation_id,
  change_identity,
  closure_disposition,
  archive_intent,
  source_snapshot_hash,
  archive_schema_version,
  archive_path,
  archive_manifest_hash,
  completed_at
}
```

`ArchivePackageReceipt` 至少包含：

```text
ArchivePackageReceipt = {
  operation_id,
  change_identity,
  source_archive_manifest_hash,
  package_schema_version,
  package_path,
  package_sha256,
  package_size,
  created_at
}
```

两份收据均不可依赖中文文案恢复。outbox 只接受通过 `verifyPackage()` 的 `ArchivePackageReceipt`。

## I/O 与性能约束

默认路径不得为每个检查项重新遍历完整目录。实现应建立一次内容清单，并让预算、安全、manifest 和包构建复用同一组文件元数据与哈希。

约束如下：

- staging 构建、最终内容扫描和必要的发布验证合计建议不超过三次全树读取。
- 新增检查器必须消费内容清单或流式读取 Interface，不能自行 `rglob` 全目录。
- 摘要只在内存中计算一次，最终写入一次；展示统计由 Platform 或读取端派生。
- 默认只生成一份最终 manifest。若需要记录 staging 身份，使用 `source_snapshot_hash`，不再生成两份完整文件清单。
- 同卷发布使用原子 rename；只有跨卷复制或恢复验证才重新读取全部文件。
- ZIP 哈希使用流式计算；压缩等级以整体耗时和包体积实测决定，不把最高压缩等级作为固定要求。
- 服务停止只执行一次；只有明确的失败恢复分支可以条件重试。
- 本地 staging 检查与远端包投影扫描共享同一内容清单；已排除且不会上传的本地报告不进入外发敏感扫描。

阶段 14 需要记录本地归档 P50/P95、文件数、输入字节数、全树读取次数、ZIP 构建时间和各步骤耗时，防止后续功能再次引入线性叠加。

## 核心包协议

现有 core-v1 继续兼容读取：

- `reports/final/summary-data.json`
- `spec/**/*.md`
- `plans/**/*.md`
- `archive-meta.md`
- `change-context.json`
- `archive-manifest.json`

core-v1 不包含日志、HTML、原始测试或评审报告、缓存、凭据和临时文件。这个边界保持不变。

core-v2 建议将体积较大的多用途摘要拆为：

```text
summary/change-summary.json
attestations/verification.json
candidates/knowledge.json
candidates/project-content.json
spec/**/*.md
plans/**/*.md
archive-meta.md
change-context.json
archive-manifest.json
```

其中：

- `change-summary.json` 只保存页面和变更检索需要的稳定事实。
- `verification.json` 保存阶段、测试、评审、Git 和发布资格证明，不进入知识查询。
- `knowledge.json` 保存零至多条显式 `KnowledgeCandidate`，不是最终知识。
- `project-content.json` 保存规则、架构、ADR 或术语候选，不能直接覆盖项目内容。
- 原始日志和报告仍不上传；需要引用时只保存结构化结论、来源路径、内容指纹和必要片段。

迁移期继续读取 core-v1，并可由兼容 Adapter 投影旧 `summary-data.json`。所有新写入最终收敛到 core-v2，不能长期双写两份相同事实。

## 目标状态机

本地生命周期终态与远端后台状态分开：

```text
Preparing
  → Staging
  → Validating
  → LocallyArchived
  → PackageReady
  → RemoteStored
  → ChangeIndexQueued → ChangeIndexReady | ChangeIndexFailed
  → KnowledgeQueued → KnowledgeReady | KnowledgeFailed
  → ProjectContentCandidatesReady | ProjectContentCandidatesFailed
```

映射阶段 01 的公共状态：

- `archive_status`：ZIP 是否耐久保存。
- `change_index_status`：设计、计划和总结是否已进入变更索引。
- `knowledge_extraction_status`：可复用知识是否完成提取。
- `managed_snapshot_status`：规则、架构、指令和配置是否形成远端快照；不由归档推断。

`LocallyArchived` 是本地 Archive 阶段终态。后续网络和后台处理失败只更新各自状态，不能把已经成功的本地归档改成失败。

`PackageReady` 由独立 `ArchivePackageReceipt` 证明，不属于本地 Archive 阶段成功条件。`RemoteStored` 由 `ArchiveSyncReceipt.archive_status=stored` 证明，不等待知识任务。

## 操作进度与监控

不可变归档事件只记录生命周期事实。归档进行中的可变进度写入归档树外的本地状态，例如：

```text
.harness/state/local/archive-operations/<operation-id>.json
```

进度至少包括：

- 当前步骤和步骤序号。
- 开始、结束和持续时间。
- 已处理文件数与字节数。
- 是否正在重试以及稳定 `reason_code`。
- 本地归档、ZIP、远端存储和后台任务的独立状态。

进度可通过现有监控通道同步，但不能写回已经冻结的 `events.ndjson`。页面应在本地终态后停止 Archive 计时，并把远端保存和知识处理展示为后续状态。

## 崩溃恢复与幂等

归档 operation 使用以下内容形成确定性身份：

```text
change_identity + source_snapshot_hash + archive_schema_version
```

重试规则：

- staging 完整且 manifest 输入一致：从验证或发布步骤继续。
- 本地归档已存在且哈希一致：返回已有 `LocalArchiveReceipt`，不报“目标已存在”。
- ZIP 已存在且哈希一致：直接复用，不重新压缩。
- 服务端已返回匹配的耐久收据：只补同步本地收据并清理 outbox。
- 归档包已耐久保存但知识失败：由 Platform 重试知识任务，客户端不重传 ZIP。
- operation 超过租约且所有者不存在：由 reaper 标记可恢复或清理；不能永久保留 `RUNNING`。

恢复代码必须验证项目身份、Change 身份、路径边界和哈希，不能仅凭目录存在继续执行。

## 知识提取流程

```text
归档 ZIP 耐久保存
  → 事务性创建变更投影任务和知识提取任务
  → 读取显式知识候选与结构化摘要
  → 规则预筛选
  → 可选 AI 提炼
  → 去重与质量判断
  → 保存知识条目
  → 增量更新知识索引
```

归档中的 `KnowledgeCandidate` 与 `ProjectContentCandidate` 均使用阶段 01 冻结的共享 Schema，但属于两个不同类型：

- `KnowledgeCandidate` 描述可能形成可复用知识的结论，只能进入知识提取器。
- `ProjectContentCandidate` 描述可能更新规则、架构约束、ADR 或术语的项目内容，只能进入治理流程。
- 同一来源可以分别产生两类候选，但必须使用不同 ID、内容指纹和状态；服务端不能通过字段相似自动互转。

知识提取使用“归档包哈希 + 提取器版本 + 提示词版本”作为幂等身份。重复上传同一归档不能生成重复知识。

核心 Interface 至少包括：

```text
acceptArchive(package, manifest) -> ArchiveIngestReceipt
enqueueKnowledgeExtraction(archiveId, extractorVersion) -> JobReceipt
retryKnowledgeExtraction(jobId) -> JobReceipt
queryKnowledge(projectId, query, limit) -> KnowledgeResult[]
listRuleCandidates(projectId, cursor) -> CandidatePage
```

`acceptArchive` 完成结构与哈希验证、CAS 持久化和事务性任务创建后即可返回。它不能在请求内等待 AI 提取或执行全项目语义重建。

`acceptArchive` 成功只表示 ZIP 已耐久保存；知识任务失败不能改变 `archive_status`。`queryKnowledge` 固定过滤知识类型，`listRuleCandidates` 不复用知识查询结果。

每个 Change 建议生成 1 至 5 条高价值知识；没有可复用内容时允许生成 0 条。不得为了填充数量保存命令输出、临时排错、文件清单或一次性实施细节。

归档中的结构化决策、重复评审结论和失败模式可以作为阶段 07 的规则候选证据，但它们与知识条目是两种独立投影：

- 知识提取器负责生成可查询的复用知识。
- 规则治理模块只读取按项目去重后的候选和证据游标，生成待审提案。
- 单次归档结论不得自动升级为 canonical 规则。
- 规则提案被接受、拒绝或废弃后，Platform 保留处理状态，避免下次重复建议。

## 服务端资源控制

- ZIP 上传只做结构验证、哈希验证、耐久存储和事务性入队。
- 变更投影、知识提取和项目内容候选使用独立的有界队列与并发上限。
- 新归档优先做增量文档 upsert，不为每个归档重建整个项目语义索引。
- 全量重建只用于 Schema 迁移、显式修复或完整性恢复，并使用独立任务和限流。
- 查询不触发无界的全项目重建。
- 迁移任务使用 Schema 版本；旧分类在完成重建前不得冒充当前知识。
- 同一项目的发布顺序和索引 generation 通过条件更新或项目级队列保证，不能由较旧任务覆盖新版本。

## 可复用的旧逻辑

不恢复完整的本地 SQLite、FTS、MCP 和本地生命周期系统，只迁移纯提取规则：

- 优先读取显式 `knowledgeCandidates`。
- 从变更总结、决策、风险和维护说明中提取结论。
- 生成稳定 ID、内容指纹、来源 Change、置信度和生命周期状态。
- 相同内容合并来源，不重复创建条目。
- 查询只读取现成索引，不在每次 Query 时调用 AI。

## `harness-knowledge-ingest` 的退役条件

面向用户的 Skill 可以移除，但必须先满足：

- ZIP 持久保存后自动创建提取任务。
- 页面可查看待提取、提取中、已完成和失败。
- 失败任务可在 Platform 重试。
- 历史归档可批量补处理。
- 同包重传能识别旧提取器版本并触发必要重建。
- Query 只返回显式知识类型，不混入规则、架构、设计或计划。

在上述条件全部完成前，保留兼容入口并标记为过渡能力；兼容入口只触发或查询同一套服务端任务，不能继续维护本地知识实现。

## 分步实施

1. **06.1 关闭策略与本地收据**：实现 `ClosurePolicy`、`ArchivePlan`、`LocalArchiveReceipt` 和关闭矩阵；先修复 `PlannedPhaseSet.planned_phases`、record-only 与未完成归档的语义。
2. **06.2 本地 Archive Engine**：抽离纯本地事务，统一 staging、摘要、manifest、原子发布和终态同步；移除重复服务停止。
3. **06.3 I/O 收敛与恢复**：共享内容清单和哈希，加入确定性 operation、resume、reconcile 与 reaper；分别处理本地归档和核心包收据。
4. **06.4 状态与服务端入队**：实现阶段 01 的拆分状态、归档收据、ZIP CAS 持久化和事务性任务创建。
5. **06.5 增量变更投影**：将设计、计划和总结投影到变更索引，不进入项目知识。
6. **06.6 知识与项目内容候选**：实现 core-v2 候选、AI 提炼、去重、质量门和候选治理入口。
7. **06.7 Package Builder、Archive Outbox 与 Core Adapter**：生成 `ArchivePackageReceipt`，移除嵌套 `npx`，通过阶段 02 `publishArchive()` 上传 ZIP；本地终态和网络状态完全分离。
8. **06.8 进度与页面状态**：上报本地步骤、远端保存、变更投影和知识任务的独立进度。
9. **06.9 历史补处理**：有界批次、断点游标、提取器版本升级和失败重试。
10. **06.10 兼容入口退役**：页面具备状态、重试和补处理后，再隐藏并移除用户侧 Ingest Skill、旧字段和重复上传入口。

06.1～06.3 与 06.4～06.6 可在阶段 01 契约冻结后并行；06.7 的 Package Builder 可在 core-v2 和 06.1 收据稳定后开始，Remote Adapter 必须等待阶段 02 Interface 和 06.4 收据稳定；06.8 在状态 Schema 冻结后可并行开发页面；06.9～06.10 最后串行收尾。

## 测试与验收设计

### 本地 Archive Engine

- 覆盖 `completed`、`abandoned`、`superseded` 与两种归档意图的关闭矩阵。
- 覆盖无 Git、无 upstream、本地未 Push、跳过未计划阶段和发布候选严格门禁。
- 统计默认路径的全树读取次数，防止检查器各自重复扫描。
- 崩溃发生在 staging、manifest、原子发布、ZIP 和收据写入后的恢复结果均幂等。
- `LocalArchiveReceipt` 与 `ArchivePackageReceipt` 可独立恢复；包构建失败不改变本地终态。
- 本地归档成功后，上传失败不会删除归档或改变本地终态。
- 相同输入重复归档返回同一内容身份，不生成重复目录和重复 ZIP。

### Core 与 Platform

- 上传成功、知识失败：归档仍可下载，知识任务可重试。
- 同一 ZIP 重传：不重复创建版本、任务或知识。
- 设计、计划、规则、架构和验证证明不会出现在知识查询结果中。
- 新归档只增量更新对应文档，不触发无界全项目重建。
- 旧任务晚于新任务完成时，不能覆盖新 generation。
- 历史补处理只新增缺失结果或升级旧提取版本。

### 监控与性能

- 本地归档发布后立即停止阶段计时；后置服务停止、ZIP 构建与上传和项目内容 Push 不继续累加 Archive 时长。步骤 2 的预快照 `quiesce` 仍属于本地归档准备，不与后置停止混淆。
- 页面分别展示本地归档、远端存储、变更投影、知识提取和项目内容候选状态。
- 记录各步骤耗时、输入字节、文件数、重试次数和服务端队列等待时间。
- 无变化或已有匹配收据时快速返回，不启动网络请求、模型任务或重复压缩。

## 非目标

- 不恢复本地 SQLite、FTS、向量索引或离线查询。
- 不把设计、计划、规则、架构、验证证明或命令输出写成知识。
- 不让知识任务失败回滚已经耐久保存的归档 ZIP。
- 不在归档进程或上传请求内执行长时间 AI 提取。
- 不把规则、架构、配置和指令塞进归档 ZIP 代替项目内容快照。
- 不把归档下载混入常规 Pull；单个原包仍从 Platform 变更记录按需下载。

## 验收条件

- `ArchiveEngine`、`ArchivePackageBuilder`、`ArchiveOutbox`、`ArchiveRemoteAdapter` 和 Platform Worker 具有独立 Interface、测试和失败语义。
- 归档门禁服从 `PlannedPhaseSet.planned_phases`、结束方式和归档意图，不再为 record-only 或未完成归档补造无关证据。
- 默认归档路径不再重复扫描和哈希同一目录，性能指标可观测且有回归测试。
- 本地终态先于所有慢速网络和后台操作，监控计时准确。
- 归档成功后可自动上传 ZIP；断网、崩溃和重复运行均可恢复。
- ZIP 耐久保存后自动触发变更投影和知识提取，不需要手动 Ingest。
- 上传失败可重试，本地 ZIP 不丢失；远端已保存后不因知识失败保留无意义的重传包。
- 历史未提取归档可补处理。
- 设计、计划、规则和架构不会出现在知识查询结果中。
- Archive、变更投影、知识提取、项目内容候选和受管快照具有独立状态。
- 移除用户 Ingest Skill 后仍能查看状态、重试和补处理。
- Skill、reference、checklist、CLI 中文提示、OpenAPI 和实际执行顺序保持一致。
