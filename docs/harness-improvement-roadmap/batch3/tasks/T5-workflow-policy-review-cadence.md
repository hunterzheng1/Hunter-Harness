# T5' — workflow-policy riskTiers 字段演进（full 档完整流程补测）

- **起始 commit**：`0b2ab3a`（WI-1 完成态：tier/mode 单一权威已合入，main 干净树）
- **需求原文**：`harness/contracts/workflow-policy.json` 的 `riskTiers.<tier>`
  增加可选字段 `reviewCadence`（该档位下 review 阶段是否必跑的语义说明，
  取值 `"mandatory" | "conditional"`；full 档为 mandatory，fast/standard 为
  conditional）。要求：
  1. strict loader（`harness_workflow_policy.py`）接受新字段：存在时校验
     类型与取值，缺失时行为与变更前完全一致（旧文件读取不报错）；
  2. workflow-policy.json 三个档位实际写入该字段；
  3. 提供旧/新双 fixture 的兼容读取测试（旧 = 无该字段，新 = 有该字段），
     `test_harness_workflow_policy.py` 全绿；
  4. bundle 投影同步（`packages/workflow-data-harness/harness/bundles/java/pi/`
  下的 harness_workflow_policy.py 副本——改 harness/scripts/ 后须 sync+bundle，
     记录的坑）。
- **验收条件（对实现者可见）**：
  1. 旧 fixture（变更前形态）读取行为与变更前完全一致；
  2. 新写入的 policy 含 `reviewCadence`，非法取值被 strict loader 拒绝；
  3. 兼容测试含旧/新双 fixture；`test_harness_workflow_policy.py` 全绿；
  4. tier-mode-parity 测试仍绿（workflow-policy.json 被该测试复制为 fixture，
     字段演进不得破坏跨语言契约测试）。
- **禁止事项**：不删除旧字段；不引入版本协商机制（单可选字段不需要）；
  不改 risk-signals.json（那是另一个契约，本任务不动信号语义）。
- **超时预算**：180 分钟墙钟（full 档五阶段 + apiTest 记账 + review 全套仪式，
  对照 batch0 T5 的 120 分钟预算上调——T5 原任务未跑 full 档流程）。
- **独立验收保留项**：评估侧验证「缺字段≠损坏」：损坏 JSON 仍走原有失败路径，
  不得因兼容逻辑放宽。
- **风险档位**：full（共享状态 schema 变更 + 兼容读取；`workflow-policy`
  子串命中 shared-state full marker，Python classify 与 TS classifyPlan 双端
  一致升 full——WI-1 单一权威的端到端验证点）。
- **流程要求**：plan 文档显式 `风险等级: full`；五阶段完整流程
  plan → execute → review → submit → archive（full 档 defaultPhases）；
  验证集 compile/unitTest/unitTestFull/apiTest 四项。
- **apiTest 记账**：走 `DEGRADED: <reason>` 路径（batch3 设计已裁决：不依赖
  B3-1；NOT_APPLICABLE 记账被 gate close 拒绝是已知缺口，如再遇到记录为
  B3 系列发现，不现场发明机制）。
- **测量点**（对照 batch3 设计 §WI-2）：
  1. full 档流程维护（严格口径：协调命令合计），对照 T4' 0.87 min——
     预期 review+submit 仪式增加 ~0.5-1 min；
  2. review 阶段全套仪式成本（T6' 已有恢复链数据，本次是正常路径）；
  3. post-run classify 升档路径：workflow-policy.json 命中 shared-state
     marker → signals 含 shared-state → observed=full（CONTRACT_SCHEMA_PATHS
     不含 workflow-policy.json 本身，但 shared-state marker 子串命中）；
  4. apiTest 记账路径明确性（DEGRADED 带理由，不允许跳过不记）。
- **门槛**：批次 2 四门槛（手工修元数据 0 / 流程维护 ≤1.1 min / 质量零回退 /
  恢复演练）+ full 档特有：apiTest 记账路径明确。
