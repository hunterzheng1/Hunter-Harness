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
