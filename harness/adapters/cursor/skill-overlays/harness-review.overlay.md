<!-- @override section-id:"review.delegate" -->
### 2. 审查执行（主会话优先）

若当前运行时支持隔离子任务且已安装 `harness-reviewer` 等价能力，则可委派只读子任务；否则**在主会话按同一 6 维度检查清单执行**，不得假设自定义 Agent 已安装。返回空 / 无报告正文 → 不 retry，继续主会话审查并记 `decision` 事件。
