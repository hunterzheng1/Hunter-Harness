# Backlog（跨期未做事项，防遗忘）

> 本文件记录已明确决策"要做但不在当期"的事项。每期规划时先读本文件。

## 语义索引 AI 增强（2026-07-12 grilling 决策，推迟到语义索引跑起来之后）

前置条件：语义索引（知识条目直采 + FTS 检索 + 图谱）已上线并积累真实数据。

- 服务端 AI 增强任务（复用 ai_jobs 设施）：知识条目去重/冲突检测建议、"建议 promote"清单。
- 语义 embedding 检索：PostgreSQL + pgvector，把跨项目搜索从 FTS 关键词升级为语义检索。
- 约束（已定，不可违背）：增强结果只存服务端派生层供页面展示，绝不写回项目；promote/demote 仍由 owner 在本地 CLI 确认，数据流保持单向。

## 服务端 CD 自动化（2026-07-12 grilling 决策，本期不做）

- GitHub Actions / 其他流水线的服务端部署与内容发布自动化。
- 本期仅保留 CI：`npm run check`（main + PR）。
