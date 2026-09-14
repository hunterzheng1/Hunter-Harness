# O6 内部职责收敛与旧路径退役 — 设计文档（工作包 F）

> 状态：**F1、F2 已实施（2026-09-14）**；§0 决策点已由用户裁决采纳建议值；
> F3～F6 待实施。决策点 6（dependsOn 改名）经 F2 勘察复核发现前提不成立，
> 经重裁决定为 **B：永久仅文档消歧**——见 §0 表内批注。
> 本文落实任务书 `review-remediation-execution-2026-09-12.md` §12（O6），
> 对应实施顺序表工作包 **F**。
> §1 的八类事实归属矩阵基于 2026-09-14 三路只读勘察（Python 任务/验证侧、
> Python 归档/资产侧、TS 侧），全部结论带证据行号；行号以提交 `a6bfc61` 为基线。
> O6 是减法工作包：风险在误伤恢复链路，所有退役项须先证「无消费者」或
> 「有替代路径 + 只读兼容」。

## 0. 待裁决决策点（每项附建议值）

| # | 决策点 | 选项 | 建议值 |
|---|--------|------|--------|
| 1 | WI 拆分与顺序 | A. §3 六批（F1 热身→F2 tier→F3 验证引用→F4 收据登记→F5 归档投递→F6 资产通道）　B. 合并大批次 | **A**（减法批次须小步回归归因；F5 风险最高放最后，与 E1→E3 先例一致） |
| 2 | TS archive-outbox v2 与 local-authority | A. 退役删除（零生产接线、测试独占、无 FS port）　B. 保留待转正 | **A**（v2 自引入起无任何生产调用方，core barrel 只导出 v1；Python asset-outbox 已移植其模式，保留两份空转实现只剩认知成本。删除即「完成可执行退役」的最直接证据） |
| 3 | 归档投递权威侧 | A. Python 留存包 + `.remote.json` + republish 为唯一权威，TS archive-outbox v1 退役　B. TS outbox 转正、Python 侧退役　C. 维持双轨 | **A**（生产事实：TS outbox 的 enqueue 在 packages 全 src 零生产调用方，真正承载补传业务的是 `harness_archive.py cmd_republish`；但 v1 有 claim/ack/nack/gc 消费端接线，退役须先迁移 compose.ts/push-pull.ts 调用点——故单列 F5，不在本批拍板细节） |
| 4 | 验证事实三层拷贝收敛 | A. ledger 唯一权威，outcome.facts / summary-data 只留引用　B. 保守：只消除 load_ledger 双实现，拷贝保留　C. outcome schema v2 去拷贝 | **B 先行，C 记入 backlog**（outcome.json schema v1 是 E1 刚发布的跨进程契约，summary-data 是归档包跨仓契约；立即改 schema 牵动两仓。先消双实现这个纯内部重复，引用化待下次契约窗口） |
| 5 | 收据统一层力度 | A. 物理合并五载体为一个收据层　B. 登记边界：每载体明确权威范围 + 命名规范，不物理合并 | **B**（五载体生命周期/写入时机各异——gate-warnings 是降级审计、plan-finalization 是 v2 发布收据、review-carryover 是评审结转、projection-receipt 是投影对账、transitions 是阶段事件；物理合并风险大收益低。「同一事实一个权威」的要求它们各自满足，问题只是无登记） |
| 6 | `dependsOn` 三处同名异义 | A. gate DAG 依赖改名（task.json dependsOn 保留）　B. 不改 | ~~**A**~~ **重裁决=B 永久仅文档消歧（2026-09-14 用户裁定）**：原理由「纯内部重构」经 F2 勘察复核证伪——① gate DAG 节点 `dependsOn` 是持久化契约（requiredGateDag 写入 gate-policy.json；harness_phase.py 运行时消费+缺依赖校验；TS plan-evidence-pack.ts:955 运行时消费+重建；历史文件只读兼容链）；② profile `verificationGraph` 目标 `dependsOn` 是 `build-profile-v3.schema.json` 的 required 键（用户面契约），且经 `verification_target_identity` 进入证据身份哈希。两处改名均须走契约窗口 + 读兼容层，超出「内部重构」。**最终处置：字段名永久不动**，三义消歧登记表已落 harness-task/reference.md（F2），F4 命名规范登记表覆盖 |
| 7 | 资产双通道边界 | A. 文档明确语义分界：asset-receipts=消费语义（被采用/拒绝），asset-outbox=投递语义（送达远端），二者不同事实不算重复　B. 合并 | **A**（勘察确认二者是不同生命周期事实；真正要修的是 cmd_outbox_status/drain 门面寄居 harness_assets.py 的模块划分，F6 微调即可） |
| 8 | CLI stdout 违规治理范围 | A. 本工作包只治理 push-pull.ts republish 解析（最重一例）　B. 连同 codegraph-status.ts 一起 | **A**（codegraph-status 解析的是外部工具 codegraph 的 stdout，不是 harness Python 子命令，不属 O6「内部」职责范围；记录备查即可） |

## 1. 八类事实归属矩阵（勘察实证）

### 1.1 任务状态 — `changes/<key>/task.json`

- **写入方（唯一模块）**：`harness_task.py`，全部经 `write_json_file`（:168）；
  写点 :880/:896（begin）、:1703（resume 恢复）、:1933（副作用归属）、
  :2474（finish 终态）、:2530（归档失败回滚）。
- **读取方**：`harness_change.py` 只读视图（:1617/:2004/:2015/:2062/:2091）；
  `cmd_status`（:2600）合成恢复视图。
- **恢复用途**：cmd_status 从 ledger + task.json 合成「档位/验证/脏树/下一步」；
  `_resume_terminal_finish`（:1674）。
- **外部消费者**：无（packages 全 src 0 处读 task.json）。
- **判定**：✅ 单一权威，无需收敛。

### 1.2 提交范围 — task.json `writeScope`/`dependsOn`（WI-3.3）

- **写入方**：begin（harness_task.py）；声明不可改（TASK_SCOPE_REDECLARED）。
- **读取方**：finish 实际 diff 越界校验（TASK_SCOPE_VIOLATION）；status 视图。
- **判定**：✅ 单一权威。⚠️ 遗留：`dependsOn` 三处同名异义
  （task.json 并行依赖 / gate DAG 节点依赖 / profile 验证目标依赖）→ 决策点 6
  （决策点 6 重裁决=B 永久仅文档消歧；三义登记表已落 harness-task/reference.md）。

### 1.3 风险策略 — tier/risk-classification/gate-policy

- **落盘处（4 处）**：risk-classification、`meta/gate-policy.json`、
  task.tier、task.declaredTier。
- **写入方（F2 勘察复核，实为三类六处）**：
  1. **文档构建 ×3**（全量重建，经 `gate_policy_document`）：gate classify（:4162）、
     **harness_context.py:1124 bootstrap-plan（勘察遗漏）**、task finish（:2232）
     ——**F2 已收敛为 `harness_gate.persist_gate_policy` 唯一入口**；
  2. **字段修补 ×2**（读-改-写局部字段，幂等）：harness_change.py:1155
     `allowLocalRelease`、harness_context.py:404 phasePlan——不同写语义，登记保留；
  3. **TS 派生回写 ×1（勘察遗漏）**：plan-evidence-pack.ts:1514 工作副本同步
     （权威=v2 计算/plan-profile，仅未发布时回写派生字段）——投影同步，登记保留。
- **tier 角色（F2 收敛）**：gate-policy.json 的 tier = **唯一权威**（归档 P13 文案、
  full-tier review 拦截、TS evidence-pack 均读它）；task.json.tier = **投影**
  （finish 终态从 persist 返回的权威文档同源投影，wiring 由篡改注入测试锁定）；
  task.json.declaredTier = **用户声明输入**（begin --tier floor，非裁决值）；
  risk-classification.json = **分类证据快照**（无生产读方，非 tier 权威）。
- **判定**：🟢 **F2 已收敛**——文档构建单写入方 + tier 一处权威+投影；
  字段修补/TS 回写两类异质写语义登记。

### 1.4 验证状态 — evidence/*.log + verification-ledger + 派生拷贝

- **原始证据**：`evidence/*.log`（task.py:1299 写）——无运行时一致性校验。
- **权威摘要**：`<state>/evidence/verification-ledger.json`
  （`write_ledger` harness_ledger.py:1148；恢复只信 ledger，task.py:1651 注释明示）。
- **读取方（双实现）**：`harness_ledger.load_ledger`（:1133，10+ 调用点）
  vs **`harness_archive.py:487` 自定义 load_ledger**（8 个读点
  607/738/1283/1660/2981/3068/5591/6325，自带候选路径逻辑）。🔴
- **独立解释者**：`harness_task._ledger_verifications`（:1650）vs
  `harness_verification.py` REUSE 判定（:251-272，自实现 evidenceId/
  productIdentity 匹配语义）。🔴 同一证据两套解读。
- **派生拷贝链**：ledger → outcome.facts.verifications（task.py:240-247）
  → summary-data 聚合（archive.py:5551+）。三层同事实。
- **判定**：🔴 双实现 + 双解释者 + 三层拷贝 → F1（双实现）/ F3（拷贝，决策点 4）。

### 1.5 执行收据 — 五载体分散

| 载体 | 写入方 | 语义 |
|---|---|---|
| verification-ledger.json | harness_ledger.py:1148 | 验证证据账本 |
| transitions.ndjson | harness_context | 阶段事件（范围外） |
| gate-warnings.ndjson | harness_gate.py:157 | 降级门审计收据 |
| plan-finalization.json | harness_gate.py:2715 | v2 发布收据 |
| review-carryover-*.json | harness_gate.py:2735 | 评审结转 |
| projection-receipt.json | harness_gate.py:311 | 投影对账 |

- **判定**：🟡 各载体语义/生命周期不同，无「同一事实双写」；问题是**无登记**，
  「收据」概念无统一清单 → F4（决策点 5，登记不合并）。

### 1.6 归档回执 — Python 留存重投 vs TS outbox 半接线

- **Python 侧（实际生产链）**：`meta/archive-execute-result.json`（:2474）、
  `meta/archive-receipt.json`（:2495，harness_change.py:216-250 读并 sha256 校验）、
  留存包 `state/local/archive-packages/<key>.zip`（:9956）、
  durable 回执 `<key>.remote.json`（写 :10301，读 :10877）、
  republish 重投（`cmd_republish` :10892）、repair（:10649）。
- **TS 侧**：`packages/core/src/archive-outbox/` v1 只有消费端接线
  （compose.ts:46-84 / archive-remote-adapter ack/nack / outbox-gc），
  **enqueue 全 src 零生产调用方**；v2 与 local-authority 测试独占、无 FS port、
  core barrel 未导出。读写 `.harness/state/local/archive-outbox/`。
- **判定**：🔴 同一「归档包投递」事实双轨；TS 侧三套实现两套空转 → F5
  （决策点 2/3）。另：CLI `push-pull.ts:55-78` 解析 republish stdout 的
  `payload.ok`/`reasonCode` 改写业务判定——任务书「不长期通过捕获子命令
  stdout 组合业务」的最重违规实例（决策点 8）。

### 1.7 摘要 — outcome.json / summary-data.json 分层清晰但有拷贝

- **outcome.json**（E1，schemaVersion 1）：存活期权威；写入方唯一
  （`write_outcome` task.py:206，唯一调用点 :2425）；消费方仅 harness_task
  内部（_summary_block、写后读回校验）。
- **summary-data.json**：归档期聚合（`collect_summary_data` archive.py:5551）；
  消费方 knowledge_candidates(:4823)/harness_change 校验(:225)/republish/repair/replay。
- **判定**：🟡 生命周期分层正确（存活期 vs 归档期）；唯 verifications/commit/
  closure 子集是 ledger 事实的拷贝（同 1.4 链）→ 随 F3 一并处理。

### 1.8 资产队列 — asset-outbox + asset-receipts

- **asset-outbox**（E3）：`state/local/asset-outbox/{records,journal}/`，
  harness_asset_outbox.py 全动词自包含，journal 先行写对账。
- **asset-receipts**（E2）：`state/local/asset-receipts/<kc_id>.ndjson` 追加，
  harness_assets.py:83。
- **判定**：🟡 两通道语义不同（消费回执 vs 投递闭环），不算同一事实双权威
  （决策点 7）；真正问题：outbox 门面命令（cmd_outbox_status :190 /
  cmd_outbox_drain :203）寄居 harness_assets.py，模块划分含混 → F6 微调。

### 1.9 横切：基础设施级重复

- **原子 JSON 写实现**（F1 实施时复核，实际约 10 份而非勘察的 3 份）：
  `harness_state.write_json`（:51，**F1 起为唯一权威**）、
  ~~`harness_task.write_json_file`~~、~~`harness_gate._write_json`~~（均已删除，F1）；
  保留待收敛：`harness_fixback._write_json`(:59)、`harness_environment._write_json`(:116)、
  `harness_change._write_json`(:139)、`harness_context._write_json_atomic`(:86)、
  `harness_archive.write_json`(:155)、`harness_service.write_json`(:259)、
  `harness_profile.write_json`(:518)、`harness_ledger.write_ledger`(:1148，账本
  专用含 fsync，合理保留)。
  **保留理由（依赖环约束）**：`harness_state` 依赖 `harness_ledger`，后者依赖
  `harness_profile`/`harness_plan_finalize`——下游模块无法反向 import state。
  彻底收敛需引入零依赖叶模块 `harness_jsonio` → 记入 backlog（候选 F4 或独立批次）。
- **私有跨用已消除（F1）**：task.py:2247 `hg._write_json` → `hs.write_json`；
  context.py:1124 `hg._write_json` → 模块自有 `_write_json_atomic`。
- **TS 读 Python 状态（合规透传，登记备查）**：plan-evidence-pack.ts 读
  gate-policy.json/plan-profile.json；doctor.ts 读 context-index.json/
  events.ndjson；push-pull.ts:472 枚举 archive 目录名（报错提示）。
- **TS 侧重复族**（备查，本包不扩张）：
  outbox 族 5+1 套（archive-outbox v1/v2/local-authority/plan-event-outbox/
  planning-context outbox/Python asset-outbox——语义各异，v2 与
  local-authority 空转）；sync/推送族 4 套；回执/发布落盘族 3 套。

## 2. 重复权威候选清单（按证据强度排序）

| # | 候选 | 证据 | 处置 WI |
|---|------|------|---------|
| 1 | ~~gate-policy.json 文档构建双写入方~~ **F2 已收敛** | `harness_gate.persist_gate_policy` 唯一入口（classify/bootstrap-plan/task finish 三写点）；字段修补与 TS 回写为异质写语义已登记 | F2 ✅ |
| 2 | TS archive-outbox v2 / local-authority 空转 | 零生产调用方、测试独占、barrel 未导出 | F5（决策点 2） |
| 3 | ~~load_ledger 双实现~~ **F1 已收敛** | harness_archive.load_ledger 委托 harness_ledger；候选优先级统一为 ledger 权威顺序（evidence/ 跨 root 优先） | F1 ✅ |
| 4 | ledger 双解释者 | task.py:1650 vs verification.py:251-272 | F3 |
| 5 | 验证事实三层拷贝 | ledger→outcome.facts→summary-data | F3（决策点 4） |
| 6 | ~~原子写重复 + 私有跨用~~ **F1 已收敛 task/gate/context**；其余 7 份保留（§1.9 依赖环约束） | — | F1 ✅ / backlog |
| 7 | 归档投递双轨 | Python republish(:10892) vs TS outbox v1 半接线 | F5（决策点 3） |
| 8 | CLI stdout 业务解析 | push-pull.ts:55-78 | F5（决策点 8） |
| 9 | ~~dependsOn 三处同名异义~~ **已关闭（决策点 6 重裁决=B）** | task.json / gate DAG 节点 / profile 验证目标；改名前提「纯内部重构」经 F2 复核证伪（持久化契约 + TS/Python 运行时消费 + schema required 键 + 身份哈希）；字段名永久不动，文档消歧登记即最终处置 | F2 ✅（文档消歧） |
| 10 | 收据五载体无登记 | §1.5 表 | F4（决策点 5） |
| 11 | outbox 门面寄居 assets | assets.py:190/:203 | F6（决策点 7） |
| 12 | ~~tier 四处落盘~~ **F2 已收敛** | 一处权威（gate-policy tier）+ 投影（task.tier 同源投影，篡改注入测试锁定）+ 声明输入（declaredTier）+ 证据快照（risk-classification）角色登记 | F2 ✅ |

## 3. WI 拆分建议

| WI | 范围 | 性质 | 依赖 |
|----|------|------|------|
| **F1 基础设施去重** ✅ 已实施（commit 见下） | 原子写收敛 harness_state（task/gate 调用点迁移 + 删除两份实现）；archive.load_ledger 委托 harness_ledger（{}透传保持 min-set 语义）；task/context 消除 hg._write_json 私有跨用；**附带修复**：`harness_ledger._state_dir` 补无 git 环境的项目根路径形态推导（对齐 archive.find_project_root 长期行为，修复委托暴露的解析分叉）；E3 容量测试时间戳同刻抖动修正 | 纯内部重构，零行为变化 | 无 |
| **F2 tier 单一权威** ✅ 已实施（commit 见下） | gate-policy 文档构建收敛 `persist_gate_policy` 单入口（classify/bootstrap/finish 三写点 + 源码守卫红测）；tier 收敛为「一处权威 + 投影」（task.json.tier 投影自 persist 返回的权威文档，篡改注入 wiring 测试锁定）；字段修补/TS 回写异质写语义登记；dependsOn 改名**经重裁决取消**（决策点 6 前提证伪，最终裁定 B：永久仅文档消歧，三义登记表已落 harness-task/reference.md） | 内部重构 | F1 |
| **F3 验证事实治理** | ledger 双解释者收敛（共享读取器/判定器）；拷贝引用化记入 backlog（决策点 4） | 内部重构 | F1 |
| **F4 收据登记** | reference 文档建「收据登记表」：载体/写入方/语义/保留理由；dependsOn 等命名规范 | 文档 + 可选轻代码 | 无 |
| **F5 归档投递收敛** | TS v2/local-authority 退役（决策点 2）；v1 退役迁移（决策点 3）；push-pull republish stdout 治理 | **跨语言、风险最高** | F1 |
| **F6 资产通道边界** | outbox 门面命令迁位或文档钉边界；assets/outbox 职责说明 | 轻量 | E3 已就位 |

每批沿用既有工作方式：TDD（减法批次先写「旧路径不存在/新路径唯一」的
契约测试）→ 全量回归 + doc-contract → 单独提交 → 追加当日记忆。

## 4. 退役清单草案（逐项保留理由在对应 WI 交付时补齐）

| 项 | 处置 | 退出条件 |
|---|---|---|
| TS archive-outbox v2 + v2-memory + local-authority | 删除（决策点 2 采纳后） | 测试独占，删除连带测试即完成 |
| TS archive-outbox v1 | 退役（决策点 3 采纳后） | compose.ts/push-pull.ts/outbox-gc 调用点迁移至 Python 权威链 |
| ~~harness_archive.py:487 自定义 load_ledger~~ | 已删除（F1，委托 harness_ledger） | 8 读点回归绿；语义差异（{}透传、优先级顺序）由 F1 契约测试锁定 |
| ~~task.py write_json_file / gate.py _write_json~~ | 已删除（F1） | 全量 1679 绿 |
| ~~`hg._write_json` 私有跨用~~ | 已消除（F1，task.py:2247 + context.py:1124 两处） | 全量绿；gate-policy 双写入方策略问题留 F2 |
| ~~gate-policy 文档构建三写点~~ | 已收敛（F2，`persist_gate_policy` 唯一入口；classify/bootstrap-plan/task finish） | 源码守卫红测（task/context 禁直写）+ 委托行为测试绿；全量 1688 绿 |
| ~~task.json.tier 独立写入~~ | 已收敛（F2，投影自 persist 返回的权威文档） | 篡改注入 wiring 测试锁定投影方向；全量绿 |
| 其余 7 份 write_json 变体 | 保留（§1.9 依赖环约束） | 待叶模块 harness_jsonio 批次 |
| §4.3 只读兼容层（plan-finalization 读取 / legacy CI 收据迁移 / adoption_metrics） | **保留** | roadmap 14 管辖，验收后退役——本文登记退出条件 |

## 5. 验收对齐（任务书 §12 末段）

- 交付时给出前后对比：重复权威计数（本表 §2 的 12 项）逐项状态；
  模块数/重复状态数量/恢复复杂度变化。
- 不以 LOC 减少自证解耦；所有旧路径全留不得宣称退役完成。
- 每 WI 完成更新本文状态行；全部完成后 F 批次总回归 + 移交 G（O5）。
