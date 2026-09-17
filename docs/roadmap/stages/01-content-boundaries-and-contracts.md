# 阶段 01：统一内容边界与协议

## 目标

先确定“什么内容由谁产生、上传到哪里、能否恢复、在哪个页面展示”。本阶段只调整契约、类型和测试夹具，不实现完整 Push、Pull 或页面。

## 依赖与并行边界

本阶段没有前置阶段，是所有并行轨道的冻结点。阶段关闭前，其他阶段只能做只读调查或原型，不能合并依赖新字段的 Implementation。

本阶段独占以下共享区域：

- `ContentKind`、`SyncScope`、远端版本身份和状态枚举。
- 两仓 OpenAPI 的基础 Schema 与共享 fixture。
- canonical 路径白名单和排除规则。

阶段 02、05、06 和 08 只有在上述 Interface 及兼容读取通过契约测试后才能并行开始。

## 内容分类

| 内容类型 | 典型路径或来源 | 上传 | 常规下拉 | 远端归属 |
|---|---|---:|---:|---|
| 配置 | `.harness/project.yaml`、允许同步的 `.harness/config/**` | 是 | 是 | 项目资料 / 配置 |
| 规则 | `.harness/rules/**` | 是 | 是 | 项目资料 / 规则 |
| 架构 | `.harness/codebase/map/**` 及清单 | 是 | 是 | 项目资料 / 架构 |
| 指令 | `AGENTS.md`、已选择 Agent 的入口文档 | 是 | 是 | 项目资料 / 指令 |
| 分支文件 | 每个分支最近成功上传的受管文件快照 | 是 | 仅在显式指定分支时恢复 | 分支文件 |
| 变更资料 | 设计、计划、场景、变更总结 | 随归档 ZIP | 否 | 变更记录 |
| 归档原包 | 每个 Change 的不可变 ZIP | 是 | 不进入常规下拉 | 变更记录 / 原包下载 |
| 可复用知识 | 服务端从显式候选和归档摘要中提取 | 服务端生成 | 不下载为本地索引 | 项目知识 |
| 项目级候选 | Plan 或归档产生的规则、架构、ADR 等结构化候选 | 随归档 ZIP，不直接 Push | 否 | 变更记录 / 待审候选池 |
| 本地凭据 | `credentials.local`、`.env*`、令牌 | 否 | 否 | 不展示 |
| 运行时状态 | runtime、锁、租约、缓存、临时日志 | 否 | 否 | 仅监控事件按现有协议上报 |

## 安全与完整性边界

配置上传和下拉不做敏感字段识别、内容遮盖或敏感词扫描。合法配置不能因为包含 URL、账号名称或类似安全字段而被拒绝。

关闭内容扫描不等于取消边界校验。以下保护必须保留：

- 只允许固定路径集合，凭据文件和环境变量文件始终排除。
- 拒绝绝对路径、路径穿越、符号链接越界和未声明文件。
- 校验文件大小、内容哈希、清单结构和访问权限。
- 下拉写入前执行版本与冲突判断，不能静默覆盖本地修改。

规则、架构和指令沿用既有安全策略；若后续决定也取消内容扫描，应另建安全变更阶段，不与配置协议混改。

## 版本身份

每次远端快照至少记录：

```text
project_id
branch_name
commit_sha
change_key?
artifact_id
project_version
uploaded_at
client_id
manifest_hash
```

内容 Blob 按哈希去重，快照和版本不可变。更新“最新版本”只移动指针，不物理覆盖旧内容。

## 状态拆分

不要继续用一个 `knowledge_status` 表达多个含义。协议至少拆为：

- `archive_status`：ZIP 是否持久保存。
- `change_index_status`：设计、计划和总结是否进入变更索引。
- `knowledge_extraction_status`：可复用知识是否提取完成。
- `managed_snapshot_status`：规则、架构、指令和配置是否形成远端快照。

目标枚举如下；失败原因通过独立 `reason_code` 表达，不把错误码塞进状态值：

```text
archive_status = absent | uploading | stored | failed
change_index_status = not_scheduled | queued | indexing | ready | failed
knowledge_extraction_status = not_scheduled | queued | extracting | ready | failed
managed_snapshot_status = absent | publishing | ready | conflict | failed
```

每个状态对象还包含 `updated_at`、`reason_code?` 和 `retryable`。客户端遇到未知枚举时显示“版本不兼容”，不能猜测为成功。

## 共享 Schema 最小字段

后续阶段不得各自重新定义同名结构。阶段 01 至少冻结：

```text
ContentKind = config | rule | architecture | instruction |
               branch_file | change_document | archive_package |
               knowledge_entry | knowledge_candidate |
               project_content_candidate

SyncScope = config | rules | architecture | instructions |
            branch_files | archive

SyncDirection = push | pull
SyncAction = add | modify | delete | restore | rename | no_change
ConflictResolution = keep_local | accept_remote | skip | cancel

ProjectContentCandidate = {
  candidate_id,
  candidate_type,
  source_change_key,
  evidence_refs[],
  rationale,
  proposed_content,
  content_hash,
  confidence,
  status,
  schema_version,
  provenance
}

KnowledgeCandidate = {
  candidate_id,
  source_change_key,
  source_refs[],
  summary,
  reusability_scope,
  content_hash,
  confidence,
  status,
  schema_version,
  provenance
}
```

```text
candidate_type = rule | architecture-decision | glossary
candidate status = pending | proposed | accepted | rejected | superseded
knowledge candidate status = pending | accepted | rejected | superseded
```

`KnowledgeCandidate` 只能进入阶段 06 的服务端知识提取器；`ProjectContentCandidate` 只能进入阶段 07 的项目内容治理。两类候选使用不同 ID 命名空间，不能因为来源或字段相似而直接互转。

### 机器字段命名

- OpenAPI、JSON、YAML、持久化收据和事件统一使用 `snake_case`。
- TypeScript Implementation 可以在模块内部使用 `camelCase`，但必须由 Adapter 显式映射；`camelCase` 不是第二套线上 Schema。
- 文档首次引用机器字段时使用规范字段名。展示文案不得自行创造同义字段。
- `PlanProfile.required_phases` 与持久化后的 `PlannedPhaseSet.planned_phases` 含义不同：前者是分类要求，后者是结合项目能力后实际冻结的阶段计划。

时间字段格式、游标排序和错误码在 OpenAPI 中定义。Markdown 文案不得成为机器状态源。

## 本阶段交付物

- 内容类型、同步范围和排除范围的共享常量或 Schema。
- 两类候选的 Schema、生命周期、来源引用和命名空间。
- 分支快照、状态拆分和分页接口的 OpenAPI 草案。
- Harness 与 Platform 的 OpenAPI 哈希一致。
- 内容分类的契约测试，覆盖配置、规则、架构、指令、知识、变更资料和归档。

## 非目标

- 不实现网络上传或下载。
- 不改 `harness-sync` 的交互。
- 不移除 `harness-knowledge-ingest`。
- 不重做 Platform 页面。

## 验收条件

- 同一文件在 Push、Pull、Archive、Platform 中得到一致分类。
- 分支文件不会混入常规 Pull；只有显式指定来源分支和版本后才能恢复。
- 配置内容不会因为安全字段名称而被拒绝，但凭据路径仍不会进入清单。
- 归档和变更资料不再被标为项目知识。
- 四种状态可以独立表达成功、处理中和失败。

## 实施记录

### 01-M1：内容分类与共享 Schema Module

状态：已关闭。当前产物保留在本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `ContentKind`、`SyncScope`、同步动作、冲突处理、候选、状态及路径分类 Schema。
- `classifyContentPath(input)` 与 `validateContentPathClassificationResult(input)` 的成功结果、失败原因码和错误优先级。
- current fixture、legacy fixture，以及旧归档收据的兼容读取。兼容读取只确认可证明的 `archive_status=stored`；其余三种 v1 状态保持 `unavailable`。

完成证据：

- 聚焦测试：`260/260` 通过。
- Contracts 全量测试：`386/386` 通过，未跳过测试。
- Contracts 类型检查、全仓 ESLint、Contracts 构建和 diff check 通过。
- Hunter Harness 工作区仅包含本工作包的 Module、测试、fixture 和 barrel export；Hunter Platform 工作区保持 clean。
- 两仓现有 OpenAPI SHA-256 一致：`D443F93E6FB75994D5FD4E86C51F7D40A3C2254B9939DFCFA989E35F264A4C64`。该文件尚未包含 01-M2 的新字段，因此此项只证明基线未漂移，不代表 01-M2 已完成。

阶段验收进度：

| 验收条件 | 01-M1 证据 | 阶段状态 |
|---|---|---|
| Push、Pull、Archive 和 Platform 分类一致 | canonical 路径、内容类型、Pull 策略、扫描策略和失败原因已冻结；两仓 TS、fixture 与 OpenAPI 投影一致 | 阶段 01 契约通过；真实 Adapter 待阶段 02、06、13 |
| 分支文件不进入常规 Pull | `branch_file` 固定为 `explicit_source_only`；相关契约测试通过 | 契约通过；真实恢复流程待阶段 02、03、14 |
| 配置不做内容敏感扫描，但凭据路径始终排除 | 只有 `config` 使用 `skip_content_scan`；任意路径段的 `credentials.local*`、`.env*` 均拒绝 | 契约通过；清单接入待阶段 02 |
| 归档和变更资料不标为项目知识 | 归档、变更、知识和候选本地路径均为 `CONTENT_PATH_NON_SCANNABLE_KIND`；候选 Schema 和 ID 命名空间独立 | 契约通过；服务端投影待阶段 06、13 |
| 四种状态独立表达 | 四个 strict 状态对象可独立表示处理中、成功和失败；legacy 不推导未知状态；OpenAPI 投影与 TS 一致 | 通过 |

### 01-M2：跨仓契约 Adapter

状态：已关闭。当前产物保留在两仓本地工作区，未提交、推送、合并或发布。

已冻结和验证的 v1 投影：

- `RemoteVersionIdentity` 要求 `commit_sha`；只有 `change_key` 可选。阶段 02 的 `BranchSnapshot` 与 `SnapshotVersion` 仍允许旧数据缺少 `commit_sha`。
- `BranchSnapshot`、`SnapshotVersion`、`SnapshotFile` 及三个有界分页对象使用 opaque cursor 和稳定排序。
- 两类候选、四类独立状态和 legacy compatibility result 在两仓 OpenAPI、TypeScript 与 fixture 中逐字节一致。
- 既有 `ArchivePackageReceipt` OpenAPI 和全部 88 个 HTTP paths 未改变；既有与兼容 TypeScript parser 指向同一 wire schema。旧 `knowledge_status` 不推导三个未知的新状态。
- canonical artifacts 使用精确 `eol=lf` 规则；只读跨仓门禁显式接收 Platform 根路径，并检查 OpenAPI、sidecar、TypeScript source、current/legacy fixture 和生成声明的字节一致性。

完成证据：

- Harness 聚焦测试：`373/373` 通过；包含既有 CLI archive caller 的补充聚焦测试：`374/374` 通过。
- Harness 根级测试：`1095/1095` 通过。Contracts 类型检查、构建和全仓 ESLint 通过。
- Platform 聚焦测试：`125/125` 通过；根级测试 `969` 项通过。根级测试另有仓内既有 `1` 个文件、`8` 项跳过；这些跳过不属于本工作包，也未用于证明阶段 01 验收条件。
- Platform Contracts、Server 类型检查与构建、全仓 ESLint、Web production build 通过。
- 两仓 OpenAPI SHA-256 均为 `4770f494cd438783a7a66c608c6538abce5fe1b2f6469044569e8d0117f03c4b`；跨仓 source、fixture 与生成声明直接比较通过。
- 真实 Fastify/Ajv 与 Zod 边界矩阵覆盖必填提交身份、legacy empty/nullable 字段、hash、UUID、RFC 3339 offset、未知与缺失字段、整数边界；接受与拒绝结果一致。
- 两条独立复审均为 Ready，Critical 和 Important 均为 `0`；diff check 和精确修改范围检查通过。

01-M2 后续补充冻结了跨仓 canonical `ArchiveIngestReceipt v1`：归档、变更投影和知识提取使用独立嵌套状态；顶层 `retryable` 为必需且在归档已耐久保存时固定为 `false`，禁止顶层 `reason_code`，因此后台规划或知识任务失败不会要求客户端重传 ZIP。规划成功时两个任务 ID 必需，原子规划失败时不得伪造不存在的任务 ID。Platform 已移除私有收据联合类型并在产出边界使用共享 Schema；真实 Fastify/Ajv 与 Zod 的五组收据矩阵一致。补充验证为 Harness `374/374`、Platform `168/168`，两仓类型检查、构建、全量 lint、diff check 与字节 parity 通过；数据库测试未运行且未计为通过。最终独立复审 Ready，Critical、Important、Minor 均为 `0`。

01-M3 将共享 receipt reader 收敛为 browser-safe 的有界 serialized JSON 入口，移除 `node:util` 等 Node-only 依赖；非字符串 Proxy/getter 在任何反射前 fail closed。`request_id=archive_request:<64hex>` 与 `idempotency_key=sha256:<64hex>` 由真实 ArchiveOutbox fixture 冻结，Schema 只校验 wire 形状，不复制 Outbox 派生算法。补充验证为 Harness affected `437/437`、Contracts `403/403`、Platform Contracts/OpenAPI `126/126`、Platform Web production build `11/11` 页面，以及 10 项 artifact、17 项 Platform Information、6 项 Archive receipt parity；最终独立复审 Ready，Critical、Important、Minor 均为 `0`。

阶段 01 关闭后仍未接入的 Adapter：

- 阶段 02 Remote Sync Adapter：让既有 Core 路径策略消费阶段 01 的 canonical 分类，消除 `.harness/config/**` 等旧策略差异。
- 阶段 06 Archive 与 Platform Adapter：通过可信收据和 Worker Interface 产生归档、变更、知识与候选分类；不得通过本地路径字符串伪造这些来源。
- 阶段 13 页面 Adapter：按共享 `ContentKind` 和独立状态展示项目资料、分支文件、变更记录与项目知识。
