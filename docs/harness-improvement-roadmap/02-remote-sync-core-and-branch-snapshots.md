# 阶段 02：建立远端同步核心与分支快照

## 目标

在 Core 中建立唯一的远端同步实现。Skill、CLI、Archive 和 Sync 只能调用该模块，不得各自复制上传、基线、冲突和重试逻辑。

## 依赖与并行边界

必须先完成阶段 01 的内容分类、版本身份和路径契约。本阶段可与阶段 05、本阶段之外的阶段 06A 和阶段 08 并行。

本阶段只拥有 `RemoteSyncModule`、分支快照仓储和同步协议。阶段 03、04、06 只能通过 Interface 或测试 Adapter 接入，不能直接访问基线文件、CAS 或远端会话。OpenAPI 变更由 README 约定的契约整合工作包统一合并。

Interface、内存 Adapter、错误码和 fixture 冻结后，阶段 03 和阶段 04A 可以开始，不必等待真实 Platform Adapter 全部完成。

## 建议接口

```text
previewPush(scopes, sourceRef)
push(scopes, sourceRef, confirmation)
previewPull(scopes, sourceRef)
pull(scopes, sourceRef, conflictDecisions)
publishArchive(packageRef, sourceRef, expectedPackageHash)
getSyncStatus(sourceRef)
listBranchSnapshots(projectRef, cursor, limit)
listSnapshotVersions(branchRef, cursor, limit)
listSnapshotFiles(snapshotRef, cursor, limit)
getSnapshotFile(snapshotRef, path)
```

`sourceRef` 包含项目、分支、提交、客户端和可选 Change 身份。预览必须具有稳定哈希，最终写入前重新读取基线并校验预览；锁内预览发生变化时必须重新确认。

`publishArchive()` 是不可变包发布 Interface，不参与普通文件三方合并。它只接收阶段 06 已生成并验证的确定性包，不重新构建归档，也不结束 Change。幂等身份由项目、Change、包哈希和归档 Schema 版本组成；同一身份、相同哈希返回已有耐久收据，同一身份、不同哈希返回包冲突。

预览与收据至少采用以下结构：

```text
SyncOperation = { path, content_kind, action, local_hash?, remote_hash?, base_hash? }
SyncPreview = { preview_hash, source_ref, base_version, operations[], conflicts[] }
ConflictDecision = { path, resolution, expected_preview_hash }
SyncReceipt = {
  preview_hash,
  project_version?,
  artifact_id?,
  no_changes,
  applied[],
  skipped[],
  retryable[],
  reason_code?
}
ArchiveSyncReceipt = {
  request_id,
  idempotency_key,
  project_id,
  archive_id,
  change_key,
  package_sha256,
  archive_status,
  project_version,
  stored_at,
  retryable,
  reason_code?
}
```

`action`、`resolution` 和错误码必须使用阶段 01 的共享枚举。调用方不得从中文提示反推机器状态。

分页读取使用同一 opaque cursor 约定：

```text
Page<T> = { items[], next_cursor? }
BranchSnapshot = {
  project_id,
  branch_name,
  latest_version,
  commit_sha?,
  artifact_id,
  manifest_hash,
  file_count,
  changed_count,
  uploaded_at
}
SnapshotVersion = {
  branch_name,
  project_version,
  commit_sha?,
  artifact_id,
  manifest_hash,
  uploaded_at
}
SnapshotFile = { path, content_kind, size, content_hash, action? }
```

列表按稳定版本顺序和唯一 tie-breaker 排序；详情读取必须同时绑定 `artifact_id` 与路径，不能从“当前最新”指针重新解析历史版本。

## 分支快照模型

每个分支保存“最近一次成功上传后的完整有效快照”，而不是只保存本次增量。

- 文件未变化：复用已有 Blob，不重复传输。
- 文件变化：写入新 Blob，并创建新快照。
- 文件删除：新快照记录删除，旧版本仍可查看。
- detached HEAD：显示为“游离提交 `<short-sha>`”。
- 旧数据无分支：迁入“未标记分支”，不得猜测为 `main`。

## 冲突算法

以共同基线、当前本地内容和当前远端内容进行三方判断。相同三态在 Push 和 Pull 中可能产生不同动作，因此决策必须包含操作方向：

| 基线 | 本地 | 远端 | Pull | Push |
|---|---|---|---|---|
| 不存在 | 缺失 | 新增 | 可新增到本地 | 无本地内容，跳过 |
| 存在 | 缺失 | 等于基线 | 视为本地删除；普通 Pull 保持删除，显式恢复时才写回 | 发布删除前必须在预览中明确显示 |
| 存在 | 等于基线 | 变化 | 可更新本地 | 无本地变化，跳过 |
| 存在 | 变化 | 等于基线 | 保留本地并提示可上传 | 可发布本地变化 |
| 任意 | 与远端相同 | 与本地相同 | 跳过 | 跳过 |
| 任意 | 相对基线均变化且结果不同 | 相对基线均变化且结果不同 | 逐文件选择本地、远端或取消 | 逐文件选择本地、远端或取消 |

不能用修改时间决定新旧。所有判断使用远端版本、提交身份、共同基线和内容哈希。

Pull 在写入前生成完整事务计划和 before snapshot。任一文件写入、哈希验证或投影验证失败时，必须原子回滚本次 Pull；不能留下部分新文件和部分旧文件。rename 同时检查源路径与目标路径的内容策略，不能只按目标路径分类。

## 并发与失败语义

- 获取协议锁后重新读取本地基线和远端版本。
- 锁前确认只对当时的预览有效；锁内预览变化必须重新确认。
- 敏感扫描跳过授权也绑定预览哈希，不能复用于新增内容。
- 是否执行内容扫描由阶段 01 的 `ContentKind` 策略决定；配置固定跳过内容扫描，但仍执行凭据路径排除和完整性校验。
- 空差异直接返回 `noChanges`，不创建提案、会话或空版本。
- 请求使用幂等键；失败不得留下已发布一半的快照。
- 远端发布失败保留可重试状态，不回滚在其之前已经成功并独立提交的本地维护动作；Pull 文件事务自身失败时仍按前述规则完整回滚。
- 归档包只有收到与项目、Change 和包哈希完全匹配的 `ArchiveSyncReceipt` 后才视为耐久保存；知识处理状态不影响该收据。

## 本阶段交付物

- Core 的 `RemoteSyncModule` 与 HTTP、内存测试适配器。
- 分支快照持久化、Blob 去重和不可变版本指针。
- 统一的 Push/Pull 预览结构和冲突决策结构。
- 归档不可变包发布 Interface、耐久收据和同包幂等语义。
- 分支、版本和文件的分页读取 Interface，供 CLI 恢复和 Platform 共用。
- 并发、幂等、空差异、断网重试和路径安全测试。

## 非目标

- 不实现完整交互式 Skill。
- 不调整 Sync 的检查项目。
- 不生成知识。
- 不重做前端页面。

## 验收条件

- 相同内容不会重复上传 Blob。
- 两个并发客户端不能用旧基线重复发布或覆盖未经确认的新预览。
- 本地文件误删后，预览能明确显示“恢复”。
- 本地有意删除不会被普通 Pull 静默恢复；显式恢复会绑定来源分支、版本和预览哈希。
- 本地和远端同时变化时不会自动覆盖任一侧。
- 同一归档包重复发布返回同一耐久结果，不会创建空版本或重新结束 Change。
- 所有调用方都能使用同一 Core 接口，且没有第二套上传实现。

## 实施记录

### 02-M1：Remote Sync Module 与内存 Adapter

状态：已关闭。当前产物保留在本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- `RemoteSyncModule` 的 Push、Pull、归档发布、状态查询和分支快照分页入口，以及注入式 `RemoteSyncPort`。
- 三方差异、稳定 `preview_hash`、锁内重新确认、冲突决策、显式恢复来源绑定、空差异和失败收据语义。
- `SyncOperation.source_path` 只允许用于 rename；源路径和目标路径必须同时通过阶段 01 的内容分类并属于同一同步范围。
- Push 和 Pull 的领域状态、幂等收据由 Port 原子提交；内存 Adapter 覆盖回滚、CAS Blob 去重、完整快照、删除 tombstone 和历史详情绑定。
- 归档请求幂等键包含项目、Change、包哈希和归档 Schema 版本；逻辑归档槽在同项目、Change 和 Schema 下拒绝异包覆盖。所有归档收据在返回前校验请求、项目、Change、包哈希和状态一致性。
- 分页 `limit` 在 Module 边界固定为安全整数 `1..100`；cursor 保持 opaque，由仓储 Adapter 解析并返回统一错误码。
- v0 fixture 中缺少分支身份的旧快照显式迁移到 `unmarked`，保留可证明的提交身份，不猜测为 `main`。

完成证据：

- 聚焦测试：`37/37` 通过，未跳过测试。
- 当前稳定工作树上的 Core 全量测试：`560/560` 通过，未跳过测试；该计数同时包含并行 05-M1 的已落盘测试。
- Core 类型检查、构建、限定范围 ESLint、根级 ESLint 和 diff check 通过。
- 独立返修后复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 补充运行时探针验证：归档收据五个身份字段和状态错配均被拒绝；同槽异包并发只有一个成功；同包可跨 Module 实例复用耐久收据；Sync 与 Archive 嵌套收据不会被调用方修改污染；非法分页输入不会触达 Port。
- 修改范围仅为新的 `packages/core/src/remote-sync/**`、聚焦测试和 v0/v1 fixture；未修改 OpenAPI、CLI 注册、既有 Sync、canonical 路径或 Platform 文件。

当前阶段验收进度：

| 验收条件                          | 02-M1 证据                                                                                             | 阶段状态                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 相同内容不重复上传 Blob           | 内存 Adapter 按内容哈希去重，完整快照复用 Blob                                                         | Module/内存 Adapter 通过；真实持久仓储待接入                    |
| 旧基线和旧预览不能覆盖新状态      | 协议锁内重读、revision CAS、预览哈希和并发探针通过                                                     | Module/内存 Adapter 通过；HTTP 并发流程待验收                   |
| 本地删除保持，显式恢复绑定来源    | 普通 Pull 把本地删除列为 `restore` 但不执行；`accept_remote` 同时校验预览、artifact 和 project version | 通过；CLI 恢复入口待阶段 03                                     |
| 双边变化不自动覆盖                | 三方矩阵要求逐路径决定，取消和缺失决定均有固定失败语义                                                 | 通过                                                            |
| 归档同包幂等且异包冲突            | request key、logical slot、耐久收据回验和跨实例重放探针通过                                            | Module/内存 Adapter 通过；Platform Archive Adapter 待阶段 06B-3 |
| 所有调用方使用同一 Core Interface | Interface 已冻结，尚未改造既有调用方                                                                   | 待阶段 03、04 和 06B-3 接入，不计为阶段完成                     |

02-M1 关闭后仍未接入的 Adapter：

- Platform HTTP 与持久仓储 Adapter：实现真实协议锁、事务、Blob、分支快照、opaque cursor 和归档耐久收据，并通过跨仓契约测试。
- 阶段 03 Push/Pull Skill 与 CLI Adapter：把交互确认、兼容入口和显式恢复映射到唯一 `RemoteSyncModule`。

### 02-M2：Archive stable identity 契约增量

状态：已关闭。当前产物保留在本地工作区，未提交、推送、合并或发布。

`ArchivePackageRef` 现必需携带已验证的稳定 `archive_id`；该身份进入远端幂等请求身份并由 stored、failed 和跨 Module replay 收据精确回显。逻辑槽仍绑定项目、Change 与 Archive Schema，同槽的包哈希或 Archive 身份漂移均 fail closed。真实 `RemoteSyncModule + InMemoryRemoteSyncPort` 已覆盖成功、失败、重放与六字段收据篡改；v0 缺少可证明 Archive 身份时只读 fail closed，不猜测迁移。

完成证据：聚焦与 02/06B 受影响测试 `108/108`，Core 全量 `63` 个文件、`993/993`，类型检查、构建、限定 ESLint 与 diff check 通过；最终独立复审 Ready，Critical、Important、Minor 均为 `0`。

### 02-M3～M6：Platform 分支快照读取、项目级版本与 opaque cursor

状态：已关闭。M3～M6 关闭时只完成内存 Adapter；后续 PostgreSQL 持久 Adapter 的进度见 02-M7。HTTP 路由和页面接线仍未实现。

已冻结的只读 Interface 与内存 Adapter：

- `BranchSnapshotRepositoryPort`、`BlobReadPort` 与 `RestorePreviewPort` 分离；快照只持久化不可变 metadata 和 Blob 引用，不复制正文或建立第二套影子快照。
- 分支、项目级版本、分支版本、文件、详情与 diff 均绑定 actor allowlist、project、branch、commit、project version、artifact、manifest 和请求 cursor；所有 Repository 输出在 Module 信任边界重验 canonical manifest 与请求身份。
- 项目级版本由单一 Repository 查询完成全局分页，不先列分支再拼接；排序为上传时间降序、版本升序，并使用完整快照身份与文件引用作唯一 codepoint tie-breaker。
- cursor 由服务端状态 Port 签发固定 `43` 字符单段 base64url token；token 不内嵌长身份，同一 canonical capability 复用唯一 token，并精确绑定 actor、project、query、可选 branch/快照身份和安全 offset。未知、篡改、跨 scope、旧 dot cursor 均 fail closed。
- 分页后置条件统一要求 offset 为安全整数，续页非空，且 `next_offset === current_offset + items.length`；恢复预览跨页查找有页数、记录数、进度和 cursor cycle 上限。
- Restore preview 只读绑定 actor、client、source ref/version、`branch_files` scope、完整 selected paths 与 conflict 集；不授予写能力。
- current v1 reader、Memory seed 和所有 Repository 输出共用唯一 canonical file refs/manifest validator；UTF-8 正文要求 Unicode scalar 与字节 round-trip 精确一致。

完成证据：分支快照聚焦测试最终 `26/26`，与 13.1/13.3 受影响矩阵最终 `165/165`，Platform 与 Harness typecheck、lint、build、diff check 通过，Platform Web production build `11` 个 route；M3、M4、M5/M6 与 13.3 的独立终审均 Ready，Critical、Important、Minor 为 `0`。

### 02-M7：Platform PostgreSQL 分支快照持久 Adapter

状态：已关闭。当前产物保留在 Hunter Platform 本地工作区，未提交、推送、合并或发布；HTTP 路由、生产仓储装配、CLI 和页面接线仍未实现。

- `PgBranchSnapshotPort` 复用 M3～M6 已冻结的 `BranchSnapshotRepositoryPort`、`BlobReadPort` 与 `CursorVerifierPort`，不另建查询模型。迁移 `018_branch_snapshots.sql` 分离不可变快照 metadata、文件引用、内容 Blob 与 opaque cursor capability；相同正文按 `content_hash` 去重，不为不同页面复制 Blob。
- 快照身份冲突在同一事务内 fail closed；失败事务不会遗留本次新增 Blob。项目版本、分支版本和文件分页继续使用稳定排序与持久 cursor，cursor 精确绑定 actor、项目、查询类型、分支或快照身份及 offset。
- 并发写入验证同一不可变身份只有一个 winner；loser 回滚其新增 Blob。`20` 个并发请求对同一 canonical capability 只形成一个持久 token，跨 Adapter 实例可继续验证；actor、allowlist、查询 scope 或身份漂移均被拒绝。

完成证据：分支快照单元测试 `26/26`、Server typecheck/build、Web production build `11` 个 route、scoped lint 与 diff check 通过；独立终审 Ready。当前环境未配置 `TEST_DATABASE_URL`，因此 PostgreSQL integration 的 `5` 项明确 skip，不将 fake/memory 结果冒充真实 PostgreSQL 证据；独立终审使用的临时数据库容器已删除。

02-M7 关闭后仍未接入：

- Platform HTTP 路由和生产仓储装配，以及阶段 03 的 CLI/Skill 恢复入口。
- 阶段 04 Sync Adapter：只投影检查输入和用户选择，不复制差异、基线或上传算法。
- 阶段 06B-3 Archive Adapter：把核心包和 outbox 收据投影到 `publishArchive()`，并校验 Platform 收据后再清理重试包。

### 02-M8：Remote Sync Branch Snapshot Producer 合同

状态：合同包已关闭。新生产写路径只接受显式 Remote Sync `SourceRef`、commit、project version、artifact、manifest、diff、逐文件 action/content kind/media type/hash/size 和正文；旧 Finalize 或缺失身份的数据不能进入该写路径，也不会猜测 `main`。

- producer 对完整 `SourceRef`、expected revision 和 idempotency key 建立一次 transaction-bound commit 调用；实现必须把 Remote Sync 版本和快照放入同一数据库事务，或在返回 committed 前写入可恢复 outbox。
- 空差异返回 `no_changes`，不调用 durable commit Port、不创建空版本。new/replay 返回值重新验证完整不可变快照、canonical manifest 和请求身份；conflict 使用固定结果。
- 输入、依赖、Promise 和 Port 输出采用 descriptor-only、累计 node/text/depth/array bounds；Proxy、accessor、cycle、extra Port 字段与 hostile rejection 均 fail closed 且不执行 getter。

完成证据：producer 与既有 Branch Snapshot 聚焦测试 `35/35`；Platform Server typecheck、build、scoped ESLint 与 diff check 通过；独立终审 Standards/Spec Ready，原资源边界、Promise rejection、Port exact shape、SourceRef 丢失和空版本 findings 全部闭合。

02-M8 的事务写入 seam 已实现：Platform 现有 `remote-sync-pg` 以同一 `PoolClient` 原子写入 Remote Sync version、artifact、Branch Snapshot、branch pointer 和 durable receipt，并由 `main.ts` 注入 transaction-bound Branch Snapshot producer。HTTP `remoteSync` 仍不注入：冻结的 Push prepare/commit 合同只携带文件元数据，没有受控的文件内容/上传引用，不能安全地把非零文件写入 Branch Snapshot；在该合同补齐前继续 fail closed，而不把 memory service 或 legacy Finalize 冒充生产实现。
