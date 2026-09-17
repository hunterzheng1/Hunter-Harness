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
  change_projection_job_id,      # 规划成功时必需；原子规划失败时缺省
  knowledge_extraction_job_id,   # 规划成功时必需；原子规划失败时缺省
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

## 实施记录

### 06A-M1：归档接收与知识流水线 Module

状态：已关闭。当前产物保留在 Hunter Platform 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `createKnowledgePipeline(...)` 的归档接收、任务规划恢复、知识任务入队与重试、Worker 完成/失败、知识查询和规则候选分页入口。
- `ArchiveStore`、`JobRepository`、`KnowledgeIndex` 与 `KnowledgeCommitPort`。结果可见性、Job generation/status、项目最新 generation、ready 状态和 output hash 必须在同一条件事务中提交。
- `ValidatedArchivePackage` 只由验证构造器形成。每个 ZIP entry 在读取内容、发放品牌和写 CAS 前先通过阶段 01 canonical 路径分类，再通过 core-v2 路径 allowlist、ZIP 资源边界、manifest、声明哈希、候选来源和 provenance 校验。
- canonical 归档身份由项目、包哈希、manifest 哈希和包/归档 Schema 版本组成；相同 canonical payload 的客户端 archive、Change 或项目版本元数据冲突固定为不可重试错误，不能形成重复归档或错绑 Job。
- 知识任务幂等身份包含包哈希、提取器、提示词和索引 Schema 版本，并按项目隔离。相同 generation 与相同 output 可幂等重放；不同 output 或旧项目 generation 被拒绝且不产生可查询结果。
- KnowledgeCandidate 与 ProjectContentCandidate 严格分流；知识结果限制为 `0..5` 条，按内容哈希去重并合并来源；规则候选在存储 Port 层固定类型、状态、limit 和 opaque cursor。
- legacy `knowledge_status` 只作为兼容输入，不推导阶段 01 拆分后的远端状态。

完成证据：

- 聚焦测试：`30/30` 通过。
- Server 回归：`525` 项通过；另有既有 PostgreSQL 集成测试 `8` 项因缺少测试数据库环境而跳过，这些跳过未计入通过证据。
- Server 类型检查、构建、限定范围 ESLint、根级 ESLint 和 diff check 通过。
- ZIP 级矩阵覆盖 nested `.env*`、`credentials.local*`、Windows 保留名与上标、ADS、非法字符、控制字符、反斜杠、点段、重复分隔符、大小写与 NFC collision；合法 nested `spec/**`、`plans/**` 和固定 core-v2 路径通过。
- 竞争探针覆盖旧 generation 与不同内容哈希晚到、项目隔离、提交失败回滚和并发同输出重放；拒绝路径均保持 Job 与 Index 零部分提交。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为 Platform 新的 `apps/server/src/knowledge-pipeline/**`、聚焦测试和 current/legacy fixture；未修改现有路由、迁移、数据库仓储、OpenAPI、页面或既有 Archive/Semantic 实现。

06A-M1 关闭后仍未接入的生产组合：

- 任务队列、真实 PostgreSQL Change Projection transaction 与生产 Worker Host 调度组合；Stage06A PostgreSQL pipeline Adapter、迁移和回滚边界以及 bounded Worker Host seam 已接入，但真实 PostgreSQL integration 仍需数据库环境。
- Platform HTTP 接收与查询路由、鉴权、OpenAPI 投影和生产 ZIP 验证器接线。
- `ChangeProjectionWorker`、`KnowledgeExtractionWorker`、`ProjectContentCandidateWorker` 与历史补处理作业。

### 06A-PG：Knowledge Pipeline PostgreSQL Adapter

状态：Adapter 与迁移已关闭；真实生产 Worker/队列调度组合仍待接入。

`apps/server/src/knowledge-pipeline/pg.ts`、迁移 `023_knowledge_pipeline_pg.sql` 与聚焦测试现已覆盖 Archive CAS、Knowledge/Change 事务回滚、generation/lease、全局容量 fence、严格 Job 状态闭包、复合项目外键、候选 cursor anchor 和 ready replay。PG focused/affected 门禁为 `89` 通过、`2` 个真实 PG integration 因缺少 `HUNTER_HARNESS_TEST_DATABASE_URL` 跳过；Server typecheck/build、限定 ESLint 和 diff check 通过，独立复审 Ready。跳过的 integration 不计入已验证通过数。

### 06A-2C：Change Projection Job 与原子提交契约

状态：已关闭。当前产物保留在 Hunter Platform 本地工作区，未提交、推送、合并或发布。

新增的 `ChangeProjectionJob`、Task Port 与 `ChangeProjectionCommitPort` 将项目归档排序用的 `project_generation` 与同任务 retry/lease `generation` 分离；旧 Archive 及其重试不能越过较新的项目投影。claim、renew、fail、retry、reap 和 commit 使用 owner、lease token、generation 与严格过期边界，旧 Worker 或过期 capability 不可发布。投影 input hash 只绑定 Archive/Package/Manifest/Change/Project Version 与 Schema 身份，不受知识 extractor、prompt 或 index 版本影响。

`ChangeDocument` 只允许 design、plan、test scenarios 和 change summary；路径复用阶段 01 canonical classifier 并应用类型 allowlist，时间为严格 Gregorian RFC 3339，文档数组 exact、dense、唯一且 code-point 稳定排序。公开 identity/hash helper、Task Port 与 commit seam 对 Proxy、accessor、symbol 和自定义原型零执行。内存 commit 同时校验最新项目代、活动租约、Job 状态与输出身份；失败不会部分发布，也不回滚耐久 Archive 或 Knowledge Job。

完成证据：聚焦 `42/42`；Server `539` 项通过，PostgreSQL `8` 项因缺少数据库环境跳过且未计为通过；Server 类型检查、构建、限定 ESLint 与 diff check 通过。最终独立复审 Ready，Critical、Important、Minor 均为 `0`。真实数据库事务与 Worker Adapter 仍待接入。

### 06A-2D/2E 与 ChangeProjectionWorker Adapter

状态：已关闭。当前产物保留在 Hunter Platform 本地工作区，未提交、推送、合并或发布。

- `test_scenarios` 精确绑定到阶段 11/12 的 `plans/<change>-test-scenarios.md`；普通 plan 不吞入场景，虚构 spec 路径和跨 Change 路径 fail closed。
- Change Projection ready 终态清除 owner、lease token 和 expiry；同输出重放返回无租约 ready，commit failure 保留原 projecting 租约和空文档快照。
- Worker 使用冻结的 lease capability，只投影 design、plan、test scenarios 与 change summary；独立 `ArchivePackageVerifierPort` 使用构造时固定的资源预算和完整验证收据，不从 Archive/ZIP 自报值放宽限制。
- Task、Archive、Verifier、Commit 返回值使用 descriptor-only exact snapshot。Job 是 queued/projecting/ready/failed 判别联合；所有可选标量、租约、输出和失败语义按状态闭合，hostile getter/Proxy 零执行且拒绝后无下游调用。
- 六种 mutating transition 验证 immutable identity、状态、项目代、任务代、attempt、lease、输出与失败语义；旧 Worker、过期 lease、stale project generation 和不同输出重放均 fail closed。失败不回滚耐久 Archive 或 Knowledge 状态。

完成证据：Worker 聚焦 `14/14`，Knowledge `46/46`，Server `558` 项通过；PostgreSQL `8` 项因缺少数据库环境跳过且未计为通过。Root typecheck、build、Platform Web production build、root lint 和 diff check 通过。06A-2D、06A-2E 与 Worker 最终独立复审均 Ready，Critical、Important、Minor 均为 `0`。

仍未接入：真实数据库 Change Projection transaction、生产队列调度与 Worker Host 组合、迁移与 PostgreSQL 集成测试、HTTP 查询与阶段 13 页面。

### 06A-WH：受控 Worker Host Adapter

状态：已关闭 bounded Worker Host seam。该工作包不伪造生产队列扫描、持久 owner/token/expiry lease 或缺失的 extractor/candidate producer；它只消费显式 job/batch dispatch，并把真实执行能力保留在注入 Port。

- Change Projection 路径按 job identity 调用既有 Worker，保留 allowlisted lease、generation 和 project-generation 错误及 retryability。
- Knowledge Extraction 路径执行 generation-bound `start → extract → complete/fail`；extractor 缺失、结果越界、候选身份或 receipt 漂移均 fail closed，complete 的 domain/storage/stale 错误不会污染 durable Job。
- Project Content Candidate 使用独立 result schema；未注入 authoritative producer 时明确返回 unavailable，不生成模拟候选。
- 所有 Port/result 经过 descriptor-only、Proxy/accessor/thenable、原型、时间、哈希、候选 schema 和状态闭包验证；batch 有界、去重、并发有界且保持输入顺序。

完成证据：

- worker-host focused `19/19`；worker-host、Knowledge、Change Projection 与 PG affected `108/108`；
- Server typecheck、build、限定 ESLint 与 diff check 通过；
- 独立双轴复审 Ready，P1/P2 finding 为 `0`，最终 worker host SHA-256 为 `E983ABB25863D5B93583C32B269BBC92158280532E34CBF74D40462C69DCFB32`。

该 seam 关闭后仍未接入真实队列 scheduler、durable worker lease fields、HTTP 路由、生产 extractor/candidate producer 和历史补处理；这些仍需各自的持久契约与生产组合。
- 06B 本地 `ArchiveEngine`、核心包、outbox 和阶段 02 `RemoteSyncModule` Archive Adapter。

### 06B-1：本地 ArchiveEngine 与关闭策略 Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `prepareArchive(change, policy)` 根据关闭方式、归档意图、阶段 08 `PlannedPhaseSet`、证据和一次性内容清单生成只读 `ArchivePlan`。
- `finalizeLocalArchive(plan)` 验证计划身份、来源快照和 staging 闭环后，原子提交不可变本地归档、终态 operation 证据与 `LocalArchiveReceipt`。
- `resumeArchive(operation_id)` 从 staging、发布后或收据写入后的崩溃点恢复；`reconcileArchive(change_identity)` 只根据完整身份和哈希协调本地终态。
- ArchiveEngine 直接使用阶段 08 公开 `plannedPhaseSetSchema` 验证完整阶段集和 `outcome=configured`，再投影 `planned_phases`。弱 ID/hash/list 引用、伪造身份或不可发布阶段集固定拒绝，未建立第二套 Plan Schema。
- `completed + release-candidate` 严格检查发布证据且不能静默降级；`completed + record-only` 只检查实际计划阶段；`abandoned` 和 `superseded` 的 record-only 路径不被 Git、upstream、Push 或 CI 缺失阻断。
- operation 身份由 Change 身份、来源快照哈希和归档 Schema 版本形成。输入漂移使计划过期；相同输入、相同完成证据和相同收据可幂等重放。
- staging 恢复会从实际文件重算每个 entry 的路径、内容哈希、大小、manifest payload 与 manifest 哈希。已发布归档、operation 和 receipt 的 operation、Change、关闭方式、意图、Schema、路径、来源、manifest 与 `completed_at` 全字段绑定。
- 内容路径在 NFC 与大小写折叠后检测来源间和生成文件碰撞；Current/legacy 收据的归档路径和身份使用 canonical 相对路径边界。一次内容 inventory 供预算、路径、摘要和 manifest 复用。

完成证据：

- Archive 聚焦测试：`51/51` 通过；与阶段 08 合并聚焦测试：`85/85` 通过，无跳过。
- 稳定树 Core 全量测试：`51` 个文件、`720` 项测试通过，无跳过。
- Core 类型检查、构建、限定范围 ESLint 和 diff check 通过。
- 崩溃与 hostile 矩阵覆盖 staging 内容篡改、已发布内容篡改、收据全字段与完成时间篡改、Port 修改或清除终态证据、NFC/大小写路径碰撞，以及弱、伪造和不可发布阶段集。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/archive-engine/**`、聚焦测试和 current/legacy fixture；未修改现有 Archive、CLI、共享入口、阶段 08、OpenAPI 或 Platform。

06B-1 关闭后仍未接入的 Adapter：

- 真实文件系统 inventory、quiesce、staging、原子 rename/跨卷验证、终态事件和操作进度 Adapter。
- 06B-2 `ArchivePackageBuilder`、core-v2、`ArchiveOutbox`、租约、reaper 和 ZIP 恢复。
- 06B-3 阶段 02 `RemoteSyncModule.publishArchive()` Adapter，以及 06A `ArchiveIngestReceipt` 的严格投影。
- 现有 Archive/CLI/Skill 的兼容迁移和旧流程接线；本工作包未移除嵌套命令或旧上传入口。

### 06B-2a：确定性 ArchivePackageBuilder Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v2 Interface：

- `buildPackage(...)` 严格消费 06B-1 的 `LocalArchiveReceipt`、canonical 本地 inventory 和独立 `CoreV2Projection`。06B-1 不被要求临时生成候选或 change-context；投影由独立 Adapter 提供。
- source manifest 的 canonical bytes、精确 entry 清单、哈希、大小和 inventory 形成闭包。包使用固定 ordering、mtime、mode 与 compression 配置，内容身份可跨重试复用。
- package manifest 内嵌完整 source receipt identity、inventory/projection hash、读取计数和完成时间。operation/cache 身份绑定三侧完整不可变输入；同 operation 的任一漂移固定返回 immutable conflict。
- `verifyPackage(...)` 不信任 ZIP、manifest 或 receipt 的自哈希。它从可信 expected 三元组和持久 completion evidence 重建 expected entries、manifest、package bytes 与完整 receipt，再逐项比较并重新执行 canonical path、Core-v2 allowlist 和 candidate provenance 闭包。
- candidate 只能引用已经读取、校验哈希且不是 candidate 的 package entry；self/cross-candidate、change/archive/evidence identity 漂移均拒绝。
- immutable completion evidence 通过 `ArchivePackagePort` 持久化。新 Builder 实例可在同一 Port 上验证已有包；verify 不依赖进程内 Map，损坏或漂移证据使用稳定机器错误。
- Module 与 current v2 compatibility normalizer 共用唯一严格验证：plain own-data/exact keys、dense canonical unique string arrays、canonical 相对路径和 Gregorian RFC3339。无效日期、traversal、accessor 或 throwing coercion 均无抛失败；core-v1 只读投影为 `legacy_read_only`。

完成证据：

- 聚焦测试：`27/27` 通过。
- 06B-2a 与真实 06B-1 的受影响测试：`78/78` 通过。
- 稳定树 Core 全量测试：`58` 个文件、`858/858` 通过。
- Core 类型检查、构建、限定范围 ESLint 和 diff check 通过。
- hostile 矩阵覆盖 `../escape` 全量自重哈希、schema/package/ZIP 配置漂移、项目身份伪造、重启验证、损坏 completion 时间、候选 self/cross 引用、compat 日期/路径/accessor/throwing `toString`。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/archive-package-builder/**`、聚焦测试和 v2/v1 fixture；未修改 06B-1、阶段 02、Outbox、Remote Adapter、CLI、Skill 或共享契约。

06B-2a 关闭后仍未接入的 Adapter：

- `ArchiveOutbox` 的持久记录、租约、claim/ack/nack、重启恢复和本地 ZIP 保留策略。
- `ArchiveRemoteAdapter` 到阶段 02 `publishArchive()` 与 06A `ArchiveIngestReceipt` 的接线、远端 durable receipt 和知识入队状态。
- 真实 ZIP/文件系统 Port、现有 Archive CLI/Skill 迁移、Platform Worker、历史补处理与页面状态。

### 06B-2b：ArchiveOutbox 纯 Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `enqueue / claim / renew / ack / nack / reap / inspect` 使用注入式原子 `ArchiveOutboxPort`，记录 `pending | leased | retry_wait | acknowledged | dead_letter`。进程重启只读取 Port，不依赖内存真相。
- enqueue 不接受调用方伪造的 `{ valid: true }`。Module 必须调用注入的 `ArchiveOutboxPackageVerifierPort`；验证证据完整绑定 package operation、receipt/package/manifest hash、ZIP 引用与大小、immutable identity、验证时间和 evidence hash，并持久化到记录。
- 相同 package operation 和完整不可变输入幂等；receipt、package、manifest 或 ZIP 引用漂移固定 immutable conflict。缺失、拒绝、异常或 hostile verifier 均 `PACKAGE_UNVERIFIED` 且零写入。
- lease 绑定 owner、token、generation 和 expiry。claim/renew/nack/ack/reap 共享唯一 CAS 边界；`swapped=true` 的返回记录必须与 proposed next 的完整 stable identity 精确相等，漂移固定 Port 错误。
- capability 输入先经过 descriptor-only plain/exact snapshot。getter、错误 entry/token/owner/generation 或 stale lease 不执行时钟、读取或 CAS；过期 lease 不能 ack，也不产生 cleanup intent。
- nack 使用有界确定性退避并可进入 dead-letter。断网、远端失败或重启不删除本地 ZIP，也不修改 `LocalArchiveReceipt`。
- ack 只接受与 package、项目、Change、archive、idempotency 和 durable 状态完整绑定的阶段 02 `ArchiveSyncReceipt`。只有 verified durable ack 且 retention policy 允许时才返回 cleanup intent；Module 从不删除文件。
- current record 和所有 Port 返回使用严格运行时闭包；v0 只读、fail closed，不恢复租约、durable receipt 或 cleanup 权限。

完成证据：

- 聚焦测试：`18/18` 通过。
- Outbox、06B-1、06B-2a、阶段 02 与契约受影响测试：`396/396` 通过。
- 稳定树 Core 全量测试：`60` 个文件、`905/905` 通过。
- Core 类型检查、构建、限定范围 ESLint 和 diff check 通过。
- hostile 矩阵覆盖伪造/拒绝/异常 verifier、过期 ack、五条 CAS 返回漂移、claim getter、stale token/owner/generation、重启、退避、dead-letter、retention 和 legacy。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/archive-outbox/**`、聚焦测试和 current/legacy fixture；未修改 PackageBuilder、RemoteSync、CLI、Skill、OpenAPI 或 Platform。

06B-2b 关闭后仍未接入的 Adapter：

- 真实持久 Outbox Port、ZIP 读取与 06B-2a verifier bridge、租约/reaper 调度和可恢复 cleanup 执行。
- Archive CLI/Skill 的 outbox 触发、重试和中文状态接线，以及 Platform Worker、页面和历史补处理。

### 06B-3：ArchiveRemoteAdapter

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

Adapter 直接消费阶段 01 canonical serialized `ArchiveIngestReceipt`，不保留本地影子 v1 类型或 fixture。规划成功和原子规划失败都以 `archive_status=stored` 为耐久事实；后台 Change/Knowledge 失败只留在嵌套状态，不触发 nack 或 ZIP 重传。request、idempotency、project、change、stable archive、package、manifest、project version 与时间均精确绑定；阶段 02 stored/failed 收据同样绑定 stable archive identity。只有验证后的 acknowledged Outbox 后继状态才能产生绑定原 opaque ZIP ref 的 cleanup intent；伪造 ack/nack、alias、throw、过期 lease 与收据漂移均 fail closed。

完成证据：聚焦 `24/24`，扩大受影响矩阵 `378/378`，Core 全量 `63` 个文件、`997/997`；Core typecheck、build、限定 lint、跨仓 parity 与 diff check 通过。最终独立功能审查无 finding，唯一 EOF 格式项修复后复核 Ready。

仍未接入：真实持久 Outbox/ZIP reader/verifier bridge、HTTP Remote Port、cleanup executor、调度宿主和 Archive CLI/Skill 触发。

06B-2b/06B-3 的生产接线当前暂停在 T0 契约包：`LocalArchiveZipRef` 尚无受信 resolver/root 绑定，`ArchiveOutboxPort` 尚无持久序列化、事务和跨进程重启语义，verifier bridge 缺少可信 `LocalArchiveReceipt + inventory + CoreV2Projection` 输入，RemoteSync production 尚无 Archive publish seam，旧 `change_archive_packages`/`/archive-package` 也不能无损冒充新收据。接线前必须冻结 durable layout/CAS、ZIP/CAS 项目隔离、verifier 输入、canonical Archive publish/legacy 迁移及 cleanup/reaper 语义；本轮未发明 migration、HTTP path 或生产 wiring。

**接线进度（2026-08-16，T0 提案已批准并施工完成）**：

- ✅ **T0 契约包**：五项冻结决策见 `06b3-t0-freeze-proposal.md`（owner 已批准）。
- ✅ **W1 ZIP resolver + CAS**：`packages/cli/src/archive-production/cas-store.ts`——内容寻址存储 + 自签 binding + 字节复核 + 项目隔离；hostile 矩阵 8/8。
- ✅ **W2 FS Outbox Port + gc**：`fs-outbox-port.ts`（durable layout/CAS/重启语义）+ `hunter-harness archive outbox gc`（显式选择器、intent 先落盘、CAS 引用计数、dead-letter）；测试 11/11。
- ✅ **W3 包验证器 + publish seam**：`production-ports.ts`（字节级三方一致 + receipt 自签 + 冻结 evidence 契约形状）；`remote-http.ts` 的 `commitArchive` stub 实装为 POST `archives:ingest`（路由缺失/不 conform 均 fail closed，绝不冒充 legacy）；平台路由实现属阶段 13 切片。
- ✅ **W4 生产组合接线**：`compose.ts` 单实例组合（FS outbox + resolver + verifier + RemoteSyncModule publisher → ArchiveRemoteAdapter）；`harness-push --scope archive` 从 durable record claim；core barrel 补导出冻结工厂。
- ✅ **W5 全链路 e2e**：build → CAS → enqueue → claim → publish → ack(acknowledged) → gc(cleaned) 真实收据全通；push/pull skill 契约测试翻转为发布语义（policy/capabilities/bundle 三处登记）。
- 剩余：平台侧 `archives:ingest` 路由实现（阶段 13 切片）与真实环境联调、Platform Worker reaper。

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
