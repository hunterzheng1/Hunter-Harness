# 阶段 20：修复轮次验收测试防篡改


## 依赖与并行边界

复用 test_guard 既有 manifest/锁/`record` 通道与 execute 阶段门禁的 begin/close 比对（不改其契约）；只读 plan 侧 `meta/scenario-manifest.json` 的 `testFile` 声明取得验收测试文件集，与阶段 16 的场景契约同源。判定语义与阶段 19 相邻且互补：calibrate 负责「检出并自动重录一般测试漂移」，本阶段负责「验收测试变更必须人工 ack，calibrate 不得代为重录」。不依赖阶段 17/18。

## 背景与来源

- 报告 §4.2 / §5.3「[P1] 修复轮次验收测试防篡改」：修复/重试/fixback 轮次的 diff 若触碰 plan 声明的验收测试文件，确定性阻断并升级人工确认；一般测试文件维持现 advisory。依据报告 §2.3-A 与 SDLC Playbook Stage 4「the loop itself needs protecting」。
- 2026-09-17 决策（`docs/decisions/2026-09-17-adopt-flow-review-short-term.md`）将该建议登记为「暂不立项」；2026-09-18 用户裁决重新立项。裁决依据：报告 P1–P3 建议已全部收口，本项是唯一剩余 P1 代码缺口；实现面小，且已有 `--circuit-ack` 显式放行先例可循。
- 现状证据：execute SKILL「陈旧测试安全修复」为提示词级条件；coding-checklist 对测试文件改动仅 WARN；review 默认不阻塞——修复轮次改断言「洗绿」无确定性防线。
- 实现位置选 test_guard 登记层（报告所称「精确暂存层」的既有实现），而非 review 门禁：登记层是唯一能确定性区分「创建 vs 修改」的接缝，且其 close 比对已 fail-closed。

## 工作包：20-M1 验收测试变更人工 ack 强制

- Module / Adapter：`harness_test_guard.py`（新增验收测试集读取 `_acceptance_test_files`；`record` 增 `--acceptance-ack`；`calibrate` 对 hashDrift 做「可自动 / 需 ack」分区）、`harness_context.py`（bootstrap-execute 校准 advisory 透传 `ackRequired`）、`harness-execute/SKILL.md` 与 `testing-checklist.md` 规程更新。
- 输入 Interface：`meta/scenario-manifest.json`（含 v2 包装体，沿用 `hpf.unpack_v2_scenario_manifest` 解包）+ test_guard manifest。
- 输出 Interface：`ACCEPTANCE_TEST_ACK_REQUIRED` 阻断码（列出命中文件与提示）；manifest 条目新增可选审计戳 `acceptanceAck: {note, at}`；calibrate 结果新增 `ackRequired` 分区与对应 hint。
- 判定规则：plan 声明的验收测试文件（scenario `testFile` 值）以 `test-updated` / `stale-test-repair` 登记（即**创建之后**的修改）必须带非空 `--acceptance-ack` 说明；`tdd-created`（首次创建）不受限；非验收测试文件维持原行为;`calibrate --apply` 只要存在验收测试漂移即整体放弃自动重录（含同批非验收漂移——manifest 全量校验不容子集重录），验收文件并入 `ackRequired` 只报告并给出列全漂移文件的人工 record 命令。
- 允许修改的路径：`harness/scripts/harness_test_guard.py`、`harness/scripts/harness_context.py`、`harness/harness-execute/SKILL.md`、`harness/harness-execute/testing-checklist.md`、`harness/scripts/tests/test_harness_test_guard.py`、`harness/scripts/tests/test_harness_context.py`。
- 禁止修改的共享区域：manifest 既有字段语义与 `record` 锁/校验语义、门禁链其它规则、scenario manifest schema。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 经既有 `record` 路径写 manifest。
- 兼容与回滚方式：`--acceptance-ack` 为可选参数；`acceptanceAck` 为条目可选键（两版 shape 校验器均不拒额外键）；calibrate 仅新增分区键。scenario manifest 缺失/不可读/为空时降级跳过检查（结果带 `available=False` + reason），不阻断 execute。
- 聚焦测试：`test_harness_test_guard.py` `AcceptanceTamperTests`；`test_harness_context.py` 校准 advisory 透传断言。
- 依赖的 fixture：合成 scenario manifest（legacy 形态、v2 包装体、缺失三态）。
- 汇合门禁：聚焦测试全绿，且 test_guard / context 既有测试无回归。
- 状态：已实施（20-M1，2026-09-18）。
- 状态：实施中（2026-09-18）。

## 验收条件

- 验收测试文件的修改登记在无 ack 时确定失败，且不写入 manifest（fail-closed）。
- 带 ack 登记成功时条目携带 note 与时间戳，close 比对可通过。
- `calibrate --apply` 对验收测试 hashDrift 只报告（`ackRequired`），不自动重录，杜绝自动旁路。
- 一般测试文件与 `tdd-created` 路径行为零变化；scenario manifest 缺失时降级不阻断。
- TS core/CLI 零改动。

## 非目标

- 不做按轮次（fixback/retry）细分的判定——按「创建后修改」语义一刀切；误伤可由一次显式 ack 消解。
- 不引入签名/密码学收据（属报告 I4，归 P0 引擎化范围）。
- 不改 review 门禁既有 advisory 语义（一般测试文件继续仅警告）。
