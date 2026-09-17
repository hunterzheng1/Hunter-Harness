# T2 — 局部缺陷修复（fast/standard 档）

- **起始 commit**：`898c8ed3bbc1945b7a86e3641727a7342426356e`（干净树）
- **需求原文**：`harness_change.py` 的 `cmd_status` 在 `.harness/changes/` 不存在时
  返回空列表，但 `summary` 字段仍枚举全部状态键（值全 0）。需求：当没有任何
  change 时，`summary` 应包含一个显式 `total: 0` 字段，便于调用方区分
  「目录不存在」与「有 change 但分类失败」。
- **复现步骤**：`python harness/scripts/harness_change.py status --json` 于一个
  无 `.harness/changes/` 的目录 → 观察 `items: []` 且 `summary` 无 total。
- **验收条件（对实现者可见）**：
  1. 空 change 集时 `summary.total == 0`；非空时 `summary.total == len(items)`；
  2. 既有 42 个 `test_harness_change.py` 测试全绿；
  3. 新增回归测试覆盖空/非空两分支。
- **禁止事项**：不改 `classify_changes` 的分类语义；不动其他子命令。
- **超时预算**：60 分钟墙钟。
- **独立验收保留项**：评估侧用第三个场景（只有 INVALID change 的目录）验证
  total 计数与 items 一致。
- **风险档位**：standard（无风险信号时 classify 默认 standard）。
