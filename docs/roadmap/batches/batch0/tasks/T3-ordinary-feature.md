# T3 — 普通功能（standard 档）

- **起始 commit**：`898c8ed3bbc1945b7a86e3641727a7342426356e`（干净树）
- **需求原文**：为 `harness_change.py status` 的每个 item 增加 `lastActivityAt`
  字段：取该 change 目录下 `events.ndjson` 最后一条事件的 `createdAt`（无事件时
  为 `null`）。字段语义：最近一次有记录的活动时间，供用户判断 change 是否陈旧。
- **验收条件（对实现者可见）**：
  1. 有事件的 change 返回非空 `lastActivityAt`（ISO-8601）；
  2. 无事件的 change 返回 `null`；
  3. `test_harness_change.py` 既有 42 测试全绿 + 新增回归测试。
- **禁止事项**：不解析 events.ndjson 之外的文件；不修改 events 写入方。
- **超时预算**：90 分钟墙钟。
- **独立验收保留项**：评估侧构造一个 events.ndjson 含乱序时间戳的 change，
  验证取的是「最后一条」而非「最大时间戳」。
- **风险档位**：standard。
- **中断恢复用途**：本任务同时是 T6 的载体（在 execute 关门前中断）。
