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
