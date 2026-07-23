<!-- @override section-id:"plan.delegate" -->
## 执行路由（宿主原生、无固定 agent 预检）

- 阶段 3 默认由主会话直接使用 CodeGraph/Read 完成探索，**不运行 `check-agents --agent harness-explorer`**。
- 只有多个独立模块、陌生大型代码库或可并行调查等高复杂度任务，且当前宿主显式提供通用隔离任务工具时，才可临时委派一次只读探索。
- 阶段 7.5 仅 `--adversarial` 或 auth/支付/迁移/并发等高风险规划启用；可用宿主临时隔离任务，否则主会话执行同一对抗检查。
- spawn 失败、空返回、0 tool uses、仅 "Done" 或元数据时立即 inline，`fallbackPolicy=inline-no-retry`。正常 inline 只记 `decision`，不显示 subagent 不可用告警。
