---
description: harness .harness 状态目录分层协议。用于减少根目录散乱、统一 archive 前后结构，并兼容旧路径。
---

# State Layout Protocol

## 目标

`.harness/changes/<change-name>/` 是变更状态真相源，但根目录不得继续堆放所有文件。新产物按子目录分层；旧路径保留读取兼容。

## 双根布局（split-v1，2026-07 起）

新 Change 将**静态合同**与**动态运行状态**分离到两个唯一所有者：

```text
.harness/changes/<change-name>/        # contractRoot：静态合同（spec/plans/meta）
.harness/state/changes/<change-name>/  # stateRoot：动态状态（events/logs/ledger/tracking/reports/runtime）
```

- 合同由 `meta/change-context.json` 的 `stateOwnership.contractRoot` / `stateOwnership.runtimeRoot` 声明（schemaVersion 2）。
- 动态产物（`events.ndjson`、`logs/execution-log.md`、`evidence/verification-ledger.json`、`evidence/test-tracking.json`、reports、runtime）只写 stateRoot。
- 统一解析入口：`harness_paths.py` —— `resolve_change_layout()` 返回完整双根；`resolve_state_dir_for_contract()` 供 events/ledger/test_guard/gate 内部路由。
- **legacy-colocated**：未声明 `stateOwnership` 的旧 Change 继续读写共址布局；resolve 只读，**绝不静默搬迁**；显式迁移须 copy → hash verify → atomic pointer switch。
- 功能分支不得携带共享动态状态副本；checkpoint/archive 的 evidence snapshot 从 stateRoot 生成。

## 推荐结构

```text
.harness/changes/<change-name>/
├── meta/
│   ├── change-context.json
│   ├── worktree.json
│   ├── manifest.json
│   └── archive-meta.md
├── logs/
│   └── execution-log.md
├── spec/
├── plans/
├── evidence/
│   ├── verification-ledger.json
│   └── run-task-status.md
├── reports/
│   ├── test/
│   ├── review/
│   ├── package/
│   └── final/
│       ├── summary-data.json
│       └── final-summary.html
├── sqls/
├── scripts/
├── runtime/
│   └── service-session.json
└── backups/
    └── uncommitted-tests/
```

## service-session.json 与 serviceStart 契约

`runtime/service-session.json`（由 `harness_service.py ensure` 写入）记录 AI 托管服务会话：`pid`、`startedBy`（`AI`/`User`）、`moduleInputsHash`、`moduleInputsFiles`、`profile`、`startCommandHash`、`overlayPath`、`command`、`startedAt`。

服务复用（§5.3）必须**同时**比对 `moduleInputsHash` + `startCommandHash` + `profile` + `overlayPath` + 进程身份（pid 存活 + create time 匹配 `startedAt`）。任一变化 -> AI 自动 restart；身份无法确认 -> `needs-user-decision`；非 AI 用户进程永不自动 kill。

`build-profile.json` 的 `serviceStart.inputFiles`（glob 列表，相对 project 展开）是 `moduleInputsHash` 的来源。`harness_service.py ensure` 取 CLI `--files` ∪ `serviceStart.inputFiles` 计算依赖闭包；**空输入被拒绝**（exit 非 0），**不得生成可复用的空指纹**。通用项目 detect 无法猜 module 源，`inputFiles` 默认空数组，须人工配置。

## knowledge maintenance-outbox（§8）

归档 close 不再同步执行知识维护；它写一个 pending outbox 项即返回：

```text
.harness/knowledge/maintenance-outbox/
  pending/<archive-id>.json      # 待维护
  running/<archive-id>.json      # maintain 正在处理
  completed/<archive-id>.json    # 已完成（status=completed 或 completed_rules_pending_judge）
  failed/<archive-id>.json       # 失败（attempts+1，可重试）
```

项 schema：`{schemaVersion, archiveId, archivePath, archiveManifestHash, status, attempts, createdAt, lastError, pendingJudgements?, completedAt?}`。

`harness_knowledge.py maintain --project . --archive-id <id>` 单进程顺序：claim pending/failed -> running -> 增量 ingest（`build_index` 内含 in-memory near-dedupe，**不再二次磁盘 dedupe**）-> auto-supersede -> reverify-stale -> 导出残余 judge checklist -> running -> completed（或 `completed_rules_pending_judge` 若 `pendingJudgements>0`）。失败 -> failed（attempts+1，可重试）。completed 项重复 maintain 幂等。`harness-sync` 启动时扫描 pending/failed outbox 并执行 maintain。

## 读取兼容

所有 skill 读取状态时必须先读新路径，再兼容旧路径：

| 类型 | 新路径 | 旧路径兼容 |
|---|---|---|
| execution log | `logs/execution-log.md` | `execution-log.md` |
| ledger | `evidence/verification-ledger.json` | `verification-ledger.json` |
| worktree | `meta/worktree.json` | `worktree.json` |
| run status | `evidence/run-task-status.md` | `run-task-status.md` |
| final summary data | `reports/final/summary-data.json` | `summary-data.json` |
| final report | `reports/final/final-summary.html` | `final-summary.html` |

## 写入规则

新版本 skill 默认写新路径。为平滑迁移，允许同时在旧路径写一个简短指针文件，但不得再把大量产物堆在根目录。

## change-context.json

每个变更目录建议尽早写入：

```json
{
  "changeName": "<change-name>",
  "stateDir": ".harness/changes/<change-name>",
  "logsDir": ".harness/changes/<change-name>/logs",
  "evidenceDir": ".harness/changes/<change-name>/evidence",
  "reportsDir": ".harness/changes/<change-name>/reports",
  "scriptsDir": ".harness/changes/<change-name>/scripts",
  "archiveTarget": ".harness/archive/YYYY-MM-DD-<change-name>"
}
```

后续阶段应优先从该文件读取路径，避免手拼 change-name 导致路径拼写错误。

## state-snapshot.json（cluster 3 §3.6）

`meta/state-snapshot.json`（由 `harness_state.py` 写入）集中记录 project/worktree root、HEAD/base、profile/rules/map/knowledge/diff 各段指纹与相关文件。plan/run/test/review/submit 读取该快照；失效时由脚本刷新，**不得仅凭缓存跳过代码或验证门禁**。

schema：

```json
{
  "schemaVersion": 1,
  "generatedAt": "<iso>",
  "changeName": "<change-name>",
  "project": {"root": "<abs>"},
  "worktree": {"root": "<abs>"},
  "git": {"base": "<sha>", "head": "<sha>"},
  "segments": {
    "<segment>": {"fingerprint": "sha256:...", "files": ["..."], "capturedAt": "<iso>"}
  }
}
```

各段独立失效：`is_segment_stale(snapshot, segment, current_fingerprint)` 比较单段指纹；段不存在 → stale（需采集）。`refresh_segments(..., segments=["profile"])` 只重采受影响段，其他段保留原 capturedAt/fingerprint（缓存失效只重采受影响段）。

segment 的文件集由调用方（各 skill）决定：`capture_snapshot(..., segment_files={"profile": [...], "rules": [...]})`。snapshot 只负责采集 + 比对 + 失效，不负责发现文件。git 段记录 base/head；diff 段指纹由调用方按需用 `harness_ledger.compute_diff_hash` 采集后填入 segment_files。

## archive 结构

archive 后保持同样分层结构，不把 `.bak`、脚本、manifest、HTML 全部放在 archive 根目录。

未提交但用于验证的测试文件放入：

```text
backups/uncommitted-tests/
```

并在 `summary-data.json.uncommittedTestEvidence[]` 中说明。

## 项目配置：`.harness/config/harness.json`

Harness skill 读取的项目级配置（不提交 git）。缺失时使用下列默认值，**不得因缺失而阻断流程**——记 `decision` 事件说明使用了默认值。

```json
{
  "defaultWorktree": false,
  "knowledge": {
    "manualReview": false
  }
}
```

| 字段 | 类型 | 默认 | 用途 |
|------|------|------|------|
| `defaultWorktree` | boolean | `false` | plan「设计审批包」中 worktree 推荐的预填值；用户可在审批包内覆盖 |
| `knowledge.manualReview` | boolean | `false` | `true` 时 knowledge-ingest promote 等高价值操作需人工确认；`false` 时按 skill 默认策略 |

读取顺序：`.harness/config/harness.json` → 缺失则默认值。plan 阶段 5 设计审批包须读取 `defaultWorktree` 作为 worktree 选项的推荐值。
