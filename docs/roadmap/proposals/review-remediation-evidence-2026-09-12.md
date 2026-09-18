# 审核整改证据汇总 —— review-remediation-execution-2026-09-12

- 对应任务书：[review-remediation-execution-2026-09-12.md](./review-remediation-execution-2026-09-12.md)（§14 要求的最终交付物）。
- 证据整理日期：2026-09-18（代码改动集中落地于 2026-09-13～09-15，发布于 `3ae3d4c`；本文件为收口期逐项证据核对）。
- 状态枚举：完成 / 部分 / 阻塞 / 未验证。只写当前已核实内容，不夸大收益。
- 独立审核入口：任务书 §16 复审提示词原文可直接使用；本文件逐项给出提交哈希、路径符号与可重跑命令，供对照审查。

## 逐项证据

### R1 轻任务绕过阻断、非交互升级与深度风险升级

- 起始复现/缺口：risky 档轻任务靠提示词自觉阻断，无测试面硬性 gate；`finish --force` 非交互；深度风险升级路径可绕过。
- 最终实现与提交：`1b8a6a6` fix: R1-R3/O1 —— `harness/scripts/harness_task.py::cmd_finish`（L2052）轻任务门重写：阻断内容机器校验、`--force` 重分类为高风险重试、深度升级路径收口。
- 正向与反向测试：`3f5a6ac` 先行红灯回归（task finish 高危重写失败语义 23 行）；现由 `tests/test_harness_task.py` 覆盖。
- 运行证据：`python -m unittest tests.test_harness_task` → **81 项 OK**（2026-09-18 重跑，194.7s）。
- 状态：**完成**。限制：阻断校验基于变更内证据文件，不防御"伪造证据文件"本身（防篡改检测另行登记，暂不立项）。

### R2 finish 非完成闭包提交

- 起始复现/缺口：`finish` 在非完成状态下可提交闭包，半成品可进入收口。
- 最终实现与提交：`1b8a6a6` —— `cmd_finish` 自动提交分支仅在工作区干净且测试绿时执行；非完成闭包被拒绝。
- 测试：`3f5a6ac` 红灯回归 36 行；`tests/test_harness_task.py` 覆盖。
- 运行证据：同上 81 项 OK。
- 状态：**完成**。

### R3 归档中断恢复 + active_status/pending_commit 状态语义清晰化

- 起始复现/缺口：归档中断后状态不可恢复；状态投影语义模糊。
- 最终实现与提交：`1b8a6a6` —— `harness_task.py::cmd_finish` 终态写入与归档边界收口 + `harness/scripts/harness_archive.py`（中断恢复）。
- 测试：`3f5a6ac` 红灯回归（active_status/pending_commit 投影 82 行）；`tests/test_harness_archive.py` 覆盖恢复路径。
- 运行证据：`python -m unittest tests.test_harness_archive` → **155 项 OK**（2026-09-18 重跑，59.3s）。
- 状态：**完成**。

### R4 远端证据仓库绑定工作区产品树

- 起始复现/缺口：远端证据只绑定仓库 slug，`ci-evidence-import` 可拿别的工作区证据冒充本工作区产物。
- 最终实现与提交：`c4a08bc` fix: R4/R5 —— `harness/scripts/harness_ledger.py::_validate_ci_evidence_receipt`（L3518）绑定工作区产品树；`harness_gate.py` 场景收据 fail-closed 完整接线。
- 测试：`3f5a6ac` 红灯回归（ci-evidence-import 故障演练 38 行）；`tests/test_harness_ledger.py`、`tests/test_harness_gate.py` 覆盖。
- 运行证据：`python -m unittest tests.test_harness_ledger` → **110 项 OK**（2026-09-18 重跑，25.0s）；`tests.test_harness_gate` 同期 246 项联合回归 OK（2026-09-18 16-M2 批次）。
- 状态：**完成**。

### R5 远端证据验证 workflow 结论、head SHA 与必需检查覆盖

- 起始复现/缺口：远端证据未验证 workflow 结论/head SHA/检查覆盖，过期或半成品证据可通过。
- 最终实现与提交：`c4a08bc` —— `harness_ledger.py::cmd_import_ci_evidence`（L3627）接入校验：workflow 结论、head SHA、必需检查覆盖三重验证。
- 测试与运行证据：同 R4（ledger 110 项 OK）。
- 状态：**完成**。

### O1 任务最小闭环（begin→record→finish→close→archive）

- 起始复现/缺口：轻任务生命周期在风险升级与归档中断下不成闭环。
- 最终实现与提交：随 R1-R3 一并落地（`1b8a6a6`），归档恢复由 `harness_archive.py` 承担。
- 运行证据：`test_harness_task` 81 项 + `test_harness_archive` 155 项 OK（2026-09-18）。
- 状态：**完成**。

### O2 依赖/冲突检测与增量评审进入用户路径

- 起始复现/缺口：任务依赖与写面冲突无机器检测；增量评审缺口见任务书 §9.2 必测矩阵。
- 最终实现与提交：
  - §9.1 编排与冲突：`697ace4` feat: WI-3.3 —— `harness_task.py` 依赖与 write-scope 冲突检测（+436 行）。
  - §9.2 增量评审：`9965bb5` feat: WI-3.4 —— `harness_review.py` / `harness_fixback.py`（+270 行），diff-scope 判定、扩展信号、v3 findings 评审边界记录与跨轮 resolved-carryover。
- 测试：`tests/test_harness_review.py` 增量评审用例 14 项（diff-scope 快照/脏区、扩展信号开闭、carryover、移动文件行号偏移、resolved 复用不误判、v3 边界持久化、空边界 fail-open、统计边界一致等）。
- 运行证据：`python -m unittest tests.test_harness_review` → **68 项 OK**（2026-09-18 重跑，54.1s）。
- 状态：**完成**（代码侧）。限制：大规模真实使用下的漏审率对照（"对照完整评审检查漏审"）属 O5 效果对照域，见 O5。

### O3 实际成果证据层

- 起始复现/缺口：变更完成只有"目标"，没有结构化"实际成果"（动机/取舍/残余风险/未验证项）。
- 最终实现与提交：`2886bc3` feat: WI-E1 —— `harness_task.py::write_outcome`（L192）写 `meta/outcome.json`（goal 与 outcome 分字段，空白不凑数）；skill 契约 7 处同步。
- 运行证据：`test_harness_task` 81 项 OK；v1.0 瘦身后 `meta/outcome.json` 机制存续（`harness_task.py` L170-215 注释块确认）。
- 状态：**完成**。

### O4 资产生产/消费证据层与候选提升门禁

- 起始复现/缺口：知识资产生产侧有候选门禁，但消费侧无回执，效果不可追踪。
- 最终实现与提交：
  - `dcec4a0` feat: WI-E2 —— 资产元数据 + 消费收据链（`harness_assets.py` 等 11 文件，+2061 行）。
  - `a6bfc61` feat: WI-E3 —— Python `harness_asset_outbox.py`（413 行），消费收据 outbox 机制落地。
- 后续处置：**v1.0 瘦身（`03980aa`，依据 [2026-09-15-v2-slimming 决策](../../decisions/2026-09-15-v2-slimming.md)）退役了 `harness_assets.py` 消费收据整链**（215 行源 + 测试），保留 `harness_asset_outbox.py` 单跳机制。此为有记录的"可执行退役"，非缺陷回归。
- 运行证据：`python -m unittest tests.test_harness_asset_outbox tests.test_harness_knowledge_candidates tests.test_harness_f1_convergence tests.test_harness_f2_convergence tests.test_harness_f3_convergence` → **115 项 OK**（2026-09-18 重跑，2.5s）。
- 状态：**部分**（outbox 与候选门禁存续；消费回执链已按产品决策退役）。

### O5 重新建立可信的收益证据

- 要求（§11）：对照原生 Agent、审核基线与新候选版本的受控实验，≥3 次重复，统计 gate 命中率/人工接管率/返工率/缺陷逃逸率/省时。
- 现状：**未执行**。该实验需要冻结对照版本、真实项目样本与多轮重复测量，属检查点 G 专项窗口，超出代码整改范围；本批不做，避免以轶事替代数据。
- 状态：**未验证**（未执行，原因：实验资源与窗口未排期；建议独立立项）。

### O6 责任收敛与资产瘦身（F1-F6 + 决策点 6）

- 起始复现/缺口：context/review/publish 三处知产责任重叠；findings 双轨；同步分发收口缺失；部署描述与退役标准缺失。
- 最终实现与提交（系列）：
  - F1 `64f1f95`：findings 生命周期收敛（`harness_findings.py` +115）；
  - F2 `f344585`：review 知产责任收敛（`harness_review.py` +76）；
  - F3 `f313317`：findings 单一职责 + review 消费链收口；
  - F5a `39c03ec`：分发收口（send 责任单源）；
  - F5b `d2844db`：context 投影归档投影责任收敛；
  - F6 `8a17cae`：harness 侧消费候选提升 + outbox 聚合；
  - 决策点 6 `305590e`：remediate 退役（`harness_remediate.py` -355 行）+ publish 部署描述对齐。
- 设计文档：[batch3/design-o6-responsibility-convergence-2026-09-14.md](../batches/batch3/design-o6-responsibility-convergence-2026-09-14.md)。
- 运行证据：F1/F2/F3 convergence 测试含于上述 115 项 OK。
- 状态：**完成**。限制：§12.4"短期残留指引"类文档级残留在 v1.0 瘦身（`03980aa`）中进一步收敛，以 v1.0 投影根清单为准。

## 附录（§14 要求的汇总事实）

- **两仓版本**：整改发布于 `3ae3d4c`（tag `workflow-harness-v0.4.22`；workflow-harness 0.4.22 + hunter-harness 0.4.19 + bundle 0.2.82）。当前 npm dist-tags：`hunter-harness@1.1.0`、`@hunter-harness/workflow-harness@1.0.0`（2026-09-18 经 `npm view` 权威源核验）——整改内容均已包含在现行版本中。
- **新旧状态兼容**：`active_status`/`pending_commit` 投影回归（`3f5a6ac` 红灯 → `1b8a6a6` 修复），`test_harness_archive` 155 项覆盖中断恢复与状态投影。
- **故障演练**：`ci-evidence-import` 故障演练回归 38 行（`3f5a6ac`），R4/R5 修复（`c4a08bc`）后 `test_harness_ledger` 110 项绿。
- **对照原始数据**（冻结版本效果对照）：未执行，同 O5。
- **资产消费案例**：outbox 单跳机制测试绿；完整消费回执链按 v1.0 瘦身决策退役（见 O4）。
- **退役清单**：O6 决策点 6（remediate 退役，`305590e`）+ v1.0 瘦身退役面（`03980aa`：知识资产生产/消费/回执整链、策略固化器、报告渲染器、回放工作台等）。
- **工作区与远端状态**：2026-09-18 收口时 `main` 工作区干净、与 `origin/main` 同步；CI 配置 `.github/workflows/check.yml` 存在。
- **未执行检查及原因**：① O5 受控效果实验（资源/窗口未排期）；② 真实 GitHub Actions 全量绿收据（本证据以本地聚焦套件 529 项全绿代替：task 81 + ledger 110 + review 68 + archive 155 + O3/O4/O6 批次 115）；③ 大规模增量评审漏审率对照（并入 O5 域）。

## 剩余阻塞

- O5（收益证据受控实验）未排期 —— 建议独立立项，不阻塞本任务书其余检查点。
- O4 消费回执链为产品决策性退役，如需恢复须先撤销 v1.0 瘦身对应条目。
