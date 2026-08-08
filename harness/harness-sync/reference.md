---
description: harness-sync 的能力契约、统一状态模型、报告收据和安全恢复参考。
---

# harness-sync 参考

## 1. 能力握手

工作流 family manifest 声明 `minimumCliVersion` 和 `capabilities`。`sync` 在任何高成本
阶段之前自行核对版本与能力；Skill 不要再运行独立的 `capabilities` 子进程。缺失时返回：

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

所有探测都必须有超时。完全不可用时返回 `PYTHON_RUNTIME_UNAVAILABLE`，并跳过仍依赖 Python 的变更状态阶段；远端知识和指令审计不允许回退到本地 Python 实现。

## 3. 统一同步

交互式：

```powershell
npx hunter-harness sync --project <项目路径> --profile interactive --progress jsonl --json
```

CI/非交互式：

```powershell
npx hunter-harness sync --check --project <项目路径> --profile general --progress jsonl --json
```

`--check` 是严格只读检查；`--dry-run` 是兼容别名。两者都不生成持久报告、receipt 或
投影。每个长阶段通过 stderr 输出受限 heartbeat；stdout 默认只输出：

```json
{
  "status": "WARN",
  "runId": "<run-id>",
  "components": {"ok": 7, "advisory": 1, "warn": 0, "fail": 0, "blocked": 0, "unknown": 0},
  "versions": {
    "cliVersion": "0.0.0",
    "workflowBundleVersion": "0.0.0",
    "adapterBundleVersions": {}
  },
  "remediations": [],
  "reportPath": ".harness/runtime/sync/<run-id>/reports/sync-report.json",
  "reportSha256": "<sha256>"
}
```

只读检查的 `reportPath/reportSha256` 为 `null`。详细报告必须受大小限制，并包含每个组件
的 `status`、`reasonCode`、`observedAt`、`durationMs`、输入/输出 hash、证据、是否自动
修复及 `nextAction`；只有显式 `--verbose` 才把组件级详情写到 stdout。

### 结构化修复

- `remediations[]` 含稳定 `id`、风险、写入范围、备份/回滚说明、预计耗时、是否需确认、
  `previewCommand` 与 `applyCommand`。
- `--apply safe` 只执行低风险、无需确认的修复。
- `--fix <id>` 只执行该项；需要覆盖受管 Adapter 时必须加 `--yes`。
- 指定修复时，其他组件仍参与诊断但保持只读。
- Adapter 覆盖由 refresh 事务执行，before snapshot 位于最新 committed refresh
  transaction；事务失败会自动回滚。预览永远不得产生写入。

## 4. 组件状态

| 组件 | 核心证据 | 失败/警告原则 |
|---|---|---|
| capability | CLI 版本、必需能力 | 不匹配立即 `BLOCKED` |
| adapter projection | 事务后的实际文件 hash | 使用 post-transaction 校验；partial refresh 不得把未选 adapter 标成 stale |
| knowledge | 远端职责声明 | 固定报告 `remote-only`、`fallback=false`、`localIndex=false`；不运行本地 ingest |
| rules | 审计—提案—应用契约 | `sync` 只给出 `instructions audit` 下一步，不改写文档或自动应用候选 |
| codebase map | manifest 文档清单、hash、生成时间 | 真实文件校验，不复用旧 display status |
| instruction graph | 入口、include 边、环、主题可达性 | 缺失引用或循环为 `FAIL` |
| config origins | canonical/projection 路径与 hash | 漂移 `WARN`，不静默覆盖 |
| changes | 五态分类及归档收据 | `INVALID`/`ORPHAN` 不自动删除 |
| CodeGraph | `codegraph status --json` 的 pending、数据库观察时间、watcher 可达性 | 输出 `CURRENT/PENDING/STALE/INDEX_PRESENT_UNVERIFIED/MISSING/UNKNOWN`；日志 mtime 只证明 watcher 活动，不证明索引完成；不自动全量 reindex |

全局状态优先级：`BLOCKED` → `FAIL` → `WARN` → `ADVISORY` → `OK`。任一 `UNKNOWN`
至少使全局结果为 `WARN`。远端知识可用性由实际 query/upload 收据判断，`sync` 不伪造本地 freshness。

## 5. Git 与 CodeGraph

增量基线来自上次成功 sync receipt 的 `headCommit`。首次运行或 receipt 不可用时，仅收集当前 HEAD 和有界文件统计；禁止固定 `HEAD~5`。

CodeGraph 状态探测优先读取 `codegraph status --json` 的权威 pending 列表；只有该 API
不可用时才退回受限文件扫描，并把来源标成 `database-scan` 或 `unverified`。`.agents/`、
`.cursor/`、`.claude/` 等 Adapter 投影和 Markdown 文档不计入源码 pending。daemon log
mtime 只写入 `watcherObservedAt`，不能冒充 `indexObservedAt`。只有服务可达、watcher 已
启用且权威 `pendingFileCount=0` 时为 `CURRENT`。不要在 sync 内执行全量索引。

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

## 9. 中文指令与规则提案

`sync` 只报告 `INSTRUCTION_AUDIT_REQUIRED`。需要优化时执行：

```powershell
npx hunter-harness instructions audit --json
```

服务端结合项目类型、现有文档、Codebase Map、近期变更总结和公开最佳实践生成中文提案。
提案先保存到 `.harness/state/local/instruction-proposals/`，项目文件保持不变。审阅后显式执行：

```powershell
npx hunter-harness instructions apply --proposal <proposal.json> --yes --json
```

应用必须校验基线 hash 并使用事务；文件在审计后变化则返回 `INSTRUCTION_PROPOSAL_STALE`。
近期变更中的经验只形成 rule candidates，`instructions apply` 也不得自动写入这些候选。

## 10. 完成判定

只有以下条件同时满足才能宣称同步成功：

- stdout 摘要与详细报告 hash 一致；
- 没有 `FAIL` 或 `BLOCKED`；
- 所有自动修复均有 post-transaction 证据；
- knowledge 组件明确为 remote-only，且未创建或刷新本地索引；
- 文档和规则组件未直接改写项目文件；
- 未把 `UNKNOWN` 描述成已验证；
- 第二次无输入变化的运行不产生投影 churn。
