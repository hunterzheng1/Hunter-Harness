# 阶段 19：manifest 校准自动化与归档复盘卡


## 依赖与并行边界

依赖 test_guard manifest 既有 `record`/校验语义与锁（校准只复用既有通道，不改契约）；19-M1 消费 `harness_context.py` 的 bootstrap-execute 信封装配；19-M2 依赖 finalize 管线 summary-data、`harness_knowledge_candidates.py` 候选折叠链与 `harness_archive.py` 打包清单。两个工作包均为 additive 扩展，不改既有 schema 与命令行为。

## 背景与来源

来源：[Harness 流程全面调研与中立评估报告](../research/2026-09-17-harness-flow-review.md)：

- §4.2「[P2] manifest 校准自动化（编辑动作后 hook 式触发）」——修复回流造成的 manifest 漂移此前靠手动 `record` 校准，易遗漏；
- §4.5「[P2] 归档时生成任务级复盘卡（周期、attempt 数、门禁首过率、评审统计）喂平台知识库；重复出现的失败模式按 §2.3-D 判据升级为确定性规则或回归用例」。

## 工作包：19-M1 manifest 校准自动化（calibrate）

- Module / Adapter：`harness/scripts/harness_test_guard.py` 新增 `calibrate` 子命令；`harness/scripts/harness_context.py` bootstrap-execute 信封新增 `manifestCalibration` advisory。
- 输入 Interface：test_guard manifest（既有 schema）；`calibrate` report 模式只读检出 `hashDrift` / `attributeDrift` / `missing` / `untracked` 四类漂移。
- 输出 Interface：calibrate report JSON；`--apply` 仅对 `hashDrift` 复用 `record` 重录（同锁同校验，reason 限既有枚举）；`attributeDrift`（校验器不容 record 旁路）、`missing`（破坏性）、`untracked`（新增登记须保留 tdd-created / test-updated 显式意图）只报告不代为决策。
- 允许修改的路径：`harness/scripts/harness_test_guard.py`、`harness/scripts/harness_context.py`、`harness/scripts/tests/test_harness_test_guard.py`、`harness/scripts/tests/test_harness_context.py`。
- 禁止修改的共享区域：manifest schema、`record` 校验语义与锁、门禁链。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / `--apply` 时经既有 `record` 路径写 manifest。
- 兼容与回滚方式：纯新增子命令与 additive 信封键；hook 检出失败降级 `available=False` 不阻断 execute。
- 聚焦测试：`test_harness_test_guard.py` `CalibrateTests`（8 项）、`test_harness_context.py` `BootstrapManifestCalibrationTests`（3 项）。
- 依赖的 fixture：内存临时 manifest 与漂移夹具。
- 汇合门禁：上述聚焦测试全绿。
- 状态：已实施（2026-09-18，commit `f84fe1a`）。

## 工作包：19-M2 归档任务级复盘卡（retro-card）

- Module / Adapter：finalize 管线新增 step 8c；`harness_knowledge_candidates.build_retro_card` 纯从 summary-data 派生（不重读盘）；`harness_archive.py` `_archive_core_file_specs` 增 retro_card 条目；候选折叠链产出一条知识候选。
- 输出 Interface：`reports/final/retro-card.json`——周期、attempts 按阶段、门禁首过率（含 per-phase 明细）、评审统计、验证统计、未裁决丢弃计数；缺数据段降级 `dataGaps` 说明，不虚构。
- 归档与知识折叠：复盘卡随 core 包走（`add_if_file` 缺失自动降级）；折成一条知识候选，`entry_type` 取枚举内语义最近的 `implementation`，`keywords` 标 `retro-card`，`source_refs` 指包内 retro-card.json；空壳卡不发候选。
- 允许修改的路径：`harness/scripts/harness_knowledge_candidates.py`、`harness/scripts/harness_archive.py`、`harness/scripts/tests/test_harness_knowledge_candidates.py`、`harness/scripts/tests/test_harness_archive.py`、`harness/scripts/tests/test_harness_finalize.py`。
- 禁止修改的共享区域：summary-data schema、知识候选共享 Schema（阶段 01 冻结）、既有打包条目。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 写 `reports/final/retro-card.json`（finalize 既有产物目录）。
- 兼容与回滚方式：additive 管线步骤与打包条目；summary-data 缺段时降级 `dataGaps`，不阻断 finalize。
- 聚焦测试：`test_harness_knowledge_candidates.py` `RetroCardTests`（6 项）与 `RetroCandidateTests`（4 项）、`test_harness_archive.py` 打包断言、finalize 集成断言。
- 依赖的 fixture：合成 summary-data（完整与缺段两种）。
- 汇合门禁：聚焦测试全绿且 finalize / archive 既有测试无回归。
- 状态：已实施（2026-09-18，commit `f84fe1a`）。

## 验收条件

- 两个工作包各自的聚焦测试全绿，且 Python 既有测试无回归。
- 所有新命令面均为纯新增；manifest、summary-data、知识候选 Schema 零变更。
- 复盘卡为 finalize 派生产物，不引入第二真相源；`calibrate --apply` 只经既有 `record` 通道写 manifest。

## 非目标

- 不做失败模式自动升级为确定性规则（§2.3-D 判据的数据基础由复盘卡与阶段 18 提供，升级动作属后续项）。
- 不改动 TS core/CLI 任何文件。
- 漏审率对照与收益验证属 O5 专项，不在本阶段范围。
