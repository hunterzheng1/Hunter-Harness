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
