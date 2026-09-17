# T4 — 跨模块变更（standard 档）

- **起始 commit**：`898c8ed3bbc1945b7a86e3641727a7342426356e`（干净树）
- **需求原文**：把 T3 的 `lastActivityAt` 字段透传到 TS 侧：`packages/cli` 中消费
  `harness_change.py status` 输出的类型定义增加该字段（`string | null`），并在
  相应的投影/序列化处保持 snake_case 线上契约（如已有 camelCase 投影则补投影）。
- **验收条件（对实现者可见）**：
  1. Python 侧输出、TS 类型、序列化三处一致；
  2. `tsc -b` 与相关聚焦测试绿；
  3. 契约测试覆盖新字段的两种取值（非空/null）。
- **禁止事项**：不引入新的抽象层/provider；不改无关命令的类型。
- **超时预算**：120 分钟墙钟。
- **独立验收保留项**：评估侧检查 OpenAPI/JSON 输出确无第二套命名。
- **风险档位**：standard（涉及 artifact-protocol 邻接，若 classify 升档按升档后
  流程执行——这本身是测量点：风险升级是否正确触发）。
