# T1 — 文档修改（fast 档）

- **起始 commit**：`898c8ed3bbc1945b7a86e3641727a7342426356e`（干净树）
- **需求原文**：`harness/harness-execute/SKILL.md`（阶段 5 与关键规则表）声称
  execute 关门检查为「10 项」，但 `testing-checklist.md` 的「关门检查」清单实际
  含 12 个复选框（后两项为「API 维度状态正确」与「未清理→WARN」）。请把
  SKILL.md 中两处「10 项」修正为与 `testing-checklist.md` 实际条目数一致的表述，
  其余内容不变。
- **验收条件（对实现者可见）**：
  1. diff 仅触及 `harness/harness-execute/SKILL.md` 中含「10 项」的两处；
  2. 新表述与 `testing-checklist.md` 实际条目数一致（评估侧数条目核验）；
  3. 文档契约测试（`test_harness_doc_contract.py`）通过。
- **禁止事项**：不修改任何 Python/TS 代码；不改 testing-checklist.md 本身；
  不重排格式。
- **超时预算**：30 分钟墙钟。
- **独立验收保留项（不提供给实现者）**：评估侧检查 SKILL.md 未要求修改的
  其他段落零 diff；并核对 `coding-reference.md`/`testing-reference.md` 中的
  「10 项」表述未被顺手修改（它们不在本任务范围）。
- **风险档位**：fast（defaultPhases plan/execute/archive，unitTest）。
- **备注**：2026-09-07 采集运行前核验发现原 T1 前提（租约 TTL 文档过时）不成立
  ——SKILL 与代码均为 3600。本任务已改为核验过的真实差异。
