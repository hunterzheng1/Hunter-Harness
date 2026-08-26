<!-- @override section-id:"review.delegate" -->
### 2. 审查执行（独立评审优先）

环境已安装 pi-subagents 扩展（提供 `subagent` 工具）时，默认优先临时委派一次只读审查，**不要求安装固定 `harness-reviewer`，也不运行固定 `harness-reviewer` 预检**。子任务只读取 diff、规则和测试证据；主会话核验并写报告。无法委派、spawn 失败、空返回或无报告正文 → 不 retry，继续主会话审查。每次都记一条 `decision`，用 `REVIEW_DELEGATED` 或相应 `REVIEW_INLINE_*` 原因码说明是否委派及原因；正常 inline 不显示为故障。
