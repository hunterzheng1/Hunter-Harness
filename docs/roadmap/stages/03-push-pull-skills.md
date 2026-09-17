# 阶段 03：增加 Push 与 Pull Skill

## 目标

提供清晰、可手动调用、可按范围选择的上传与恢复入口。Skill 只负责理解用户意图、展示预览和收集确认，实际同步由阶段 02 的 Core 模块完成。

## 依赖与并行边界

依赖阶段 02 已冻结的 `RemoteSyncModule` Interface、内存 Adapter 和预览 fixture，不依赖真实服务端全部完成。本阶段可与阶段 05、06、07 和 08 的非重叠工作包并行。

本阶段拥有 Push/Pull 命令、Skill 和交互文案，不修改同步算法、远端快照仓储或内容分类。CLI 命令注册和 Skill 清单由单一整合工作包统一接线，避免与 Sync 或其他 Skill 并行冲突。

## `harness-push`

建议支持：

```text
/harness-push
/harness-push --scope config
/harness-push --scope rules,architecture
/harness-push --scope instructions
/harness-push --scope archive --change <change-key>
/harness-push --scope all
```

`--scope all` 只包含配置、规则、架构、指令和分支受管文件，不包含归档原包。归档必须显式使用 `--scope archive --change <change-key>`，避免误传历史包或无法确定目标 Change。

归档范围只选择阶段 06 已写入 outbox 的确定性包。命令可以重试上传或查询耐久收据，但不能重新运行 finalize、修改归档内容或重建 ZIP。不存在可复用包时，提示先完成本地归档，不在 Push 内隐式补做归档。

交互流程：

1. 选择上传范围。
2. 展示分支、提交、远端基线和实际变化文件。
3. 无变化时直接结束，不创建空版本。
4. 用户确认后上传。
5. 按内容分类显示成功、跳过、冲突和可重试项。

界面统一使用“上传到 Hunter Platform”，避免使用含义不明确的“提交”。

## `harness-pull`

将现有 `update` 的远端产物应用和冲突能力整理为 `pull`，并保留 `update` 兼容入口：

```text
/harness-pull
/harness-pull --branch main
/harness-pull --scope rules,architecture,config
/harness-pull --scope branch_files --branch main
/harness-pull --dry-run
```

常规下拉范围只包含配置、规则、架构和指令。分支文件恢复必须显式使用 `--scope branch_files` 并指定来源分支；预览中同时展示来源版本、提交、缺失文件和冲突。归档不出现在常规下拉列表；单个归档 ZIP 通过 Platform 的变更记录单独下载。

## 配置处理

- Push 与 Pull 均不对配置内容做敏感字段检查或遮盖。
- 路径白名单、凭据文件排除、哈希校验和冲突判断保持启用。
- 本地有修改时必须显示差异和决策，不得因为关闭扫描而直接覆盖。

## Skill 专一性

Skill 不应：

- 直接发 HTTP 请求。
- 自行读写基线或实现冲突算法。
- 启动嵌套 `npx` 进程调用另一个入口。
- 在无确认时上传规则、架构或指令。
- 把归档下载混入日常恢复。

Skill 的 Interface 只做以下映射：普通用户范围 → `SyncScope`，用户选择 → `ConflictDecision`，Core 收据 → 中文结果。归档范围是唯一例外，它将既有 `ArchivePackageReceipt` 映射到 `publishArchive()`，不进入普通 `previewPush()/push()`。任何新冲突类型必须先扩展阶段 02 的 Interface，不能只在 Skill 中增加分支。

## 本阶段交付物

- `harness-push` Skill、CLI 命令和中文交互文案。
- `harness-pull` Skill、CLI 命令及 `update` 兼容别名。
- 范围选择、预览、取消、冲突和断网重试测试。
- CLI 帮助和用户文档。

## 验收条件

- 用户可只上传指定内容类型。
- 用户可预览并恢复被误删的本地文件。
- 冲突时可逐文件选择，不出现无提示覆盖。
- 归档不在普通 Pull 中出现。
- 分支文件只在显式指定分支后恢复，本地有意删除不会被普通 Pull 撤销。
- 无变化时整个流程快速结束，服务端不产生空版本。

## 非目标

- 不在 Push 中构建归档、结束 Change 或触发知识提取。
- 不在 Pull 中下载归档历史或恢复运行时状态。
- 不在 Skill 中复制三方合并、事务回滚或版本查询逻辑。

## 实施记录

### 03-M1：Push/Pull 交互编排 Module

状态：已关闭。当前产物保留在 Hunter Harness 本地工作区，未提交、推送、合并或发布。

已冻结的 v1 Interface：

- 普通 Push/Pull 的预览、确认、取消、冲突选择和执行投影统一由 `push-pull-orchestration` Module 编排；三方 diff、冲突、幂等、锁内 stale 校验和实际变更仍由阶段 02 `RemoteSyncModule` 唯一实现。
- `all` 只包含普通项目内容和分支受管文件，不包含 `archive`。普通 Push/Pull request、current compatibility 与 legacy compatibility 共用同一请求不变量验证。
- Push 无变化时返回 `no_changes`，不创建确认或调用执行入口。Pull 默认只读预览，不恢复本地有意删除；分支文件必须显式来源分支。
- 删除恢复只允许 `accept_remote`，并绑定 preview hash、artifact、version 和来源；rename 保留 `source_path`。冲突选择只投影阶段 02 已冻结的机器决策，不增加新冲突类型。
- hard 敏感阻断不能生成确认；可覆盖风险必须显式确认。伪造、跨方向、过期或错 preview 的确认均不调用执行入口。
- 执行成功前重新验证阶段 02 receipt 的 `preview_hash` 与已确认 preview 完全一致；错绑回执固定返回 `PUSH_PULL_RECEIPT_INVALID`。
- 机器收据和中文展示投影分离；legacy `sync`/`upload` 输入只读归一化，语义无效、双写或必须走独立 Archive 路由的输入 fail closed。

完成证据：

- 聚焦测试：`18/18` 通过。
- 受影响的阶段 01 契约与阶段 02 RemoteSync 测试：`4` 个文件、`420/420` 通过。
- Core 类型检查、构建、限定范围 ESLint 和 diff check 通过；CLI 类型检查通过。
- hostile 矩阵覆盖错绑 dependency receipt、current/legacy 普通 Archive 请求、错误 Pull source mode、缺失分支的 legacy restore、伪造确认和零执行调用计数。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/push-pull-orchestration/**`、聚焦测试和 current/legacy fixture；未修改 CLI 注册、Core barrel、阶段 02、OpenAPI、Skill 或文档入口。

### 03-M2：CLI Push/Pull Adapter 与预注册入口

状态：适配器已落盘。CLI 已注册 `harness-push`、`harness-pull`（及 `pull` 兼容别名）；优先读 `HUNTER_REMOTE_SYNC_URL`、`HUNTER_REMOTE_SYNC_TOKEN` 与 `HUNTER_REMOTE_SYNC_ACTOR_ID`，缺失字段回退 `hunter-harness connect` 写入的 `.harness/credentials.local.yaml`（connect 现会落盘 actor_id；旧绑定缺 actor_id 时 push/pull 路径经 key-info 自动补全并写回）；两者齐备时使用带认证、SourceRef/actor 绑定的真实 HTTP transport，否则固定 fail closed。Platform 端 Pull 工作区事务与生产 GC 调度仍需独立门禁后才能关闭本阶段。

- `PushPullCliPort` 只负责输入边界快照、方向与 preview/confirm/execute 绑定、中文与 JSON 投影；三方 diff、敏感扫描、幂等和本地事务仍由 Core Module/RemoteSync Port 负责。
- `archive` 是显式 Push 分支，只消费已有 outbox claim，不进入普通 Push/Pull 预览。
- 缺失或不可信 Adapter 不调用旧 HTTP fallback，命令返回稳定 `PUSH_PULL_CLI_UNAVAILABLE`；HTTP transport 只走合同化 Push/Pull 路由，不把旧 archive fallback 当作同步实现。

完成证据：CLI Push/Pull focused `35/35`、HTTP transport actor-binding focused `1/1` 通过；CLI/Core 类型检查和构建通过。Skill bundle 发布、Platform Pull 工作区事务与跨进程生产 GC 仍列为后续关键路径工作包。

03-M1 关闭后仍未接入的 Adapter：

- 现有 `update` 兼容别名与旧 Push/Update 调用面的迁移；本工作包未把旧 CLI 长跑测试计入通过证据。
- 阶段 06B-3 Archive Adapter。显式 Archive Push 只消费既有 outbox 包并调用 `publishArchive()`，不进入普通请求。
- 真实远端错误、断网重试和页面/终端交互验收，由 CLI/Skill Adapter 与阶段 14 真实流程统一验证。
