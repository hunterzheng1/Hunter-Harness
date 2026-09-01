---
name: harness-knowledge-ingest
description: "确认归档 ZIP 已上传并由 Hunter Platform 在服务端解包、校验和入库。客户端不再构建或维护本地知识索引。"
argument-hint: "status | retry-upload <archive.zip>"
effort: low
allowed-tools: [Bash(powershell.exe:*), Read, Glob, Grep]
disallowed-tools:
  - Bash(git *)
  - Bash(curl *)
---

# harness-knowledge-ingest

知识 ingest 由 Hunter Platform 负责：归档完成时，客户端生成一个确定性 ZIP
（含 `candidates/knowledge.json` 候选清单——由本包 `harness_knowledge_candidates.py`
从 design/plan/test-scenarios 与归档 summary 派生）；服务端收到后保存原包、
安全解包、发布核心文件，按候选抽取知识条目并重建项目语义索引。

客户端不得生成 `.harness/knowledge`、SQLite 索引、视图、报告或本地裁决。
历史版本数据只由升级兼容逻辑识别，不再执行。

## 归档包边界

允许上传的核心内容只有：

- `reports/final/summary-data.json`
- `spec/**/*.md`
- `plans/**/*.md`
- `archive-meta.md`
- `change-context.json`
- 包内 `archive-manifest.json`（由 CLI 生成）

日志、测试报告、审查报告、HTML、缓存、备份、凭据和临时文件不得进入归档包。

## Normal Workflow

1. 先读取最近归档操作记录中的 `archiveRemote`，以及本地状态目录
   `.harness/state/local/archive-packages/<change-key>.remote.json`。若 `archiveStatus=durable` 且
   `knowledgeStatus=ready`，直接报告已完成，禁止重新打包或上传。
2. 若存在 `.harness/state/local/archive-packages/<change-key>.zip`，只重试该包；
   禁止搜索实现源码、调用 Python 内部函数或手工重新拼包。
3. 只有旧归档没有 ZIP/回执时，调用公开命令重新生成并上传；`harness-archive`
   的 finalize 正常情况下会生成确定性 ZIP，并调用：

```powershell
powershell.exe -Command "npx hunter-harness archive upload --file '<archive.zip>' --change-key '<change-key>' --yes --non-interactive --json"
```

4. 检查响应中的包哈希、服务端保存状态和 `knowledge_status`。
4.5. **查询面回读验证（强制）**：`knowledgeStatus=ready` 只是入库回执，不代表可查。
    执行 `npx hunter-harness knowledge status --json` 确认 `pipeline.results_count`
    符合预期（有候选的归档应 > 0）；再用归档中的已知关键词跑一次
    `npx hunter-harness knowledge query "<已知关键词>" --json`，`count=0` 视为
    ingest 未真正完成——报告 `pipeline.jobs` 状态（queued/extracting/failed）
    并停止宣称 ready，不得仅凭上传回执收尾。
5. 只有服务端确认原 ZIP 已持久保存且知识状态为 ready，才删除本地待上传 ZIP。
6. 上传或 ingest 失败时保留 ZIP 与失败收据；修复连接后重试同一个 ZIP，不重新拼散文件。

## Ownership Rules

- 客户端：选择核心文件、生成稳定 manifest/ZIP、校验包哈希、上传与保留失败重试材料。
- 服务端：敏感信息扫描、ZIP 安全校验、原包持久化、解包、制品发布、知识 ingest、状态查询和下载恢复。
- 远端不可用：知识不可用；不得启动本地替代索引。
- 面向人的知识、提案、规则和说明默认使用中文。

## Forbidden Actions

- build_or_refresh_local_knowledge
- write_dot_harness_knowledge
- upload_logs_reviews_tests_or_temp_files
- call_legacy_python_ingest
- treat_upload_acceptance_without_durable_status_as_success
- delete_pending_zip_after_failed_upload

## Verification

确认归档命令的 JSON 结果同时包含：服务端 package 哈希、保存状态和知识状态。
若失败，确认 `.harness/state/local/archive-packages/` 中仍保留可重试 ZIP；若成功，确认
ZIP 已按收据策略清理，且平台下载接口可以恢复原包。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]] · 只有服务端持久化与 ingest 收据可证明知识已入库

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`knowledge-ingest` · 记录 package hash、服务端状态与失败重试路径
