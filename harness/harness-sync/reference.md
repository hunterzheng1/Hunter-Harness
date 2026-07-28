---
description: harness-sync 的能力契约、统一状态模型、报告收据和安全恢复参考。
---

# harness-sync 参考

## 1. 能力握手

统一入口执行前读取：

```powershell
npx hunter-harness capabilities --json
```

工作流 family manifest 声明 `minimumCliVersion` 和 `capabilities`。CLI 在任何高成本阶段之前核对版本与能力；缺失时返回：

```json
{
  "status": "BLOCKED",
  "reasonCode": "BLOCKED_CAPABILITY_MISMATCH"
}
```

不得通过直接运行内部脚本绕过该阻塞。打包 smoke 会从已发布 Skill 文档抽取所有 `hunter-harness` 命令，并验证安装后的 CLI 能力清单和 `--help`。

## 2. Python runtime

CLI 按以下顺序解析 Python，并在详细报告中记录来源：

1. `HUNTER_HARNESS_PYTHON`
2. 项目受管 runtime（`.harness/runtime/python`、`.venv`）
3. `uv run python`
4. Windows `py -3`
5. `python3`
6. `python`

所有探测都必须有超时。完全不可用时返回 `PYTHON_RUNTIME_UNAVAILABLE`，且不得进入 knowledge 或 rules 阶段。

## 3. 统一同步

交互式：

```powershell
npx hunter-harness sync --project <项目路径> --profile interactive --progress jsonl --json
```

CI/非交互式：

```powershell
npx hunter-harness sync --project <项目路径> --profile general --progress jsonl --json
```

`--dry-run` 只做只读检查或事务预览，不应生成持久报告、receipt 或投影。每个长阶段通过 stderr 输出受限 heartbeat；stdout 只输出：

```json
{
  "status": "WARN",
  "runId": "<run-id>",
  "components": {"ok": 7, "warn": 1, "fail": 0, "blocked": 0, "unknown": 1},
  "reportPath": ".harness/runtime/sync/<run-id>/reports/sync-report.json",
  "reportSha256": "<sha256>"
}
```

详细报告必须受大小限制，并包含每个组件的 `status`、`reasonCode`、`observedAt`、`durationMs`、输入/输出 hash、证据、是否自动修复及 `nextAction`。

## 4. 组件状态

| 组件 | 核心证据 | 失败/警告原则 |
|---|---|---|
| capability | CLI 版本、必需能力 | 不匹配立即 `BLOCKED` |
| adapter projection | 事务后的实际文件 hash | 使用 post-transaction 校验；partial refresh 不得把未选 adapter 标成 stale |
| managed blocks | 全文件解析树 | 重复 ID、嵌套、闭合不匹配为结构错误 |
| knowledge | manifest、entry 文件、SQLite ID 集合 | 三者不一致为 `FAIL`；进度与性能指标落报告 |
| rules | 投影收据、冲突、待评审数 | 真实分歧只报告，不覆盖 |
| codebase map | manifest 文档清单、hash、生成时间 | 真实文件校验，不复用旧 display status |
| instruction graph | 入口、include 边、环、主题可达性 | 缺失引用或循环为 `FAIL` |
| config origins | canonical/projection 路径与 hash | 漂移 `WARN`，不静默覆盖 |
| changes | 五态分类及归档收据 | `INVALID`/`ORPHAN` 不自动删除 |
| CodeGraph | 服务、索引提交、pending、watcher lag | 证据不足为 `UNKNOWN`；不自动全量 reindex |

全局状态优先级：`BLOCKED` → `FAIL` → `WARN` → `OK`。任一 `UNKNOWN` 至少使全局结果为 `WARN`。

## 5. Git 与 CodeGraph

增量基线来自上次成功 sync receipt 的 `headCommit`。首次运行或 receipt 不可用时，仅收集当前 HEAD 和有界文件统计；禁止固定 `HEAD~5`。

CodeGraph 最多执行受限状态探测/短退避复查。不可用或 watcher 尚未追平时报告 `UNKNOWN`/`WARN` 和明确后续动作。不要在 sync 内执行全量索引，不使用依赖 shell 连接符的跨平台命令。

## 6. Instruction graph

验证 `AGENTS.md`、`CLAUDE.md`、`CODEBUDDY.md` 与 `.harness/context-index.json` 的引用图：

- Claude 可单向引用 AGENTS，共享约束保持单一真源。
- 禁止 AGENTS 反向引用 CLAUDE 形成环。
- 最多读取 64 个文件、深度 8、总量 512 KiB。
- 入口可以很薄；主题只需通过引用图可达，不要求复制到每个入口。

## 7. Config origins

典型 canonical 来源位于 `docs/ai/harness/`，`.harness/config/` 为生成投影。报告同时给出两侧路径、hash、来源类型与 drift，不把投影误判成真源。

## 8. Change 五态与清理

- `ACTIVE`：合法活动变更。
- `ARCHIVED_LEFTOVER`：已由可验证 receipt 归档，但活动目录残留。
- `RECOVERABLE`：残留可安全隔离恢复。
- `ORPHAN`：缺少可信归档证据。
- `INVALID`：结构或收据不合法。

先预览：

```powershell
npx hunter-harness doctor --managed-blocks --json
```

change cleanup 由同步报告提供具体动作。只允许已验证的 `ARCHIVED_LEFTOVER` 进入删除路径；`RECOVERABLE` 只能移入隔离区；`ORPHAN`/`INVALID` 保持原状并提示人工处理。

## 9. 规则候选

非交互 sync 只报告待评审数。用户主动要求评审时，先读取候选：

```powershell
npx hunter-harness rules-review --json
```

公共规则变更仍需展示 evidence 和 diff，并由用户确认。应用后的 decision 必须绑定 candidate revision 与目标 hash；目标变化返回 `RULE_PATCH_STALE`，不得强制覆盖。

## 10. 完成判定

只有以下条件同时满足才能宣称同步成功：

- stdout 摘要与详细报告 hash 一致；
- 没有 `FAIL` 或 `BLOCKED`；
- 所有自动修复均有 post-transaction 证据；
- knowledge 的 manifest、文件、SQLite 集合一致；
- 未把 `UNKNOWN` 描述成已验证；
- 第二次无输入变化的运行不产生投影 churn。
