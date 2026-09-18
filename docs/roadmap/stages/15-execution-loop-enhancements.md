# 阶段 15：执行环与支撑环增强

## 依赖与并行边界

依赖阶段 01 的内容边界与字段命名契约；消费阶段 11/12 已冻结的 plan 产物模型（两件套 6 target、scenario-manifest、review 产物路径）。

本阶段只修改 harness Python 脚本层（`harness/scripts/**`）、其聚焦测试（`harness/scripts/tests/**`）与对应 skill 文档（`harness/harness-*/**.md`）。不修改 TS core/CLI、不修改阶段 01～14 拥有的 canonical 结构与契约注册表条目。Plan 侧两项建议（codebase-map 进 Clarify、publish 补丁式修订）按归档规则分别落入阶段 10（10-M4）与阶段 11（11-M4），不属于本阶段。

工作包之间修改文件不重叠，可串行实施；任一工作包不得顺手修改其他工作包拥有的脚本命令面。

## 背景与来源

来源：[Harness 流程全面调研与中立评估报告](../research/2026-09-17-harness-flow-review.md) §4/§6（2026-09-17）。报告为 advisory，本阶段是其中被采纳的 P2/P3 执行环建议的立项承载：

- F2 关联：失败→修复→重试无结构化重试策略与断路器（§4.2）。
- §4.4：record-quirk 依赖人工写签名。
- §4.6：轻任务档位裁决信号不可解释。
- §4.3：scenario→finding→fixback 闭环状态缺可查询视图。

报告的 P0（编排引擎化，D4 暂缓）、P1 增量评审（移交 O2 专项）、P1 验收测试防篡改（2026-09-17 决策暂不立项）、P1 R1–R5（移交审核整改任务书）不在本阶段范围。

## 工作包：15-M1 轻任务档位裁决可解释（classify --dry-run）

- Module / Adapter：`harness/scripts/harness_task.py`（begin 命令面）。
- 输入 Interface 及版本：`harness_gate.classify_risk` 共享信号契约 `risk-signals.json`（只读消费）；`harness_task._full_signals_for_paths`、`_tier_from_classification`、`_apply_tier_floors` 现有纯函数。
- 输出 Interface 及版本：`harness_task.py begin --dry-run` 结构化信封：每信号值 vs 命中阈值、workspaceBreakdown、裁决 tier、floor 调整过程；不落 task.json、不建 change 目录、不写任何文件。
- 允许修改的路径：`harness/scripts/harness_task.py`、`harness/scripts/tests/test_harness_task.py`（或既有 task 聚焦测试文件）、`harness/harness-task/SKILL.md` 命令清单（若该 skill 存在命令表）。
- 禁止修改的共享区域：`harness_gate.py` 分类权威逻辑与 `risk-signals.json`；finish 的 post-run 裁决链。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否（dry-run 纯只读，连 task.json 都不落）。
- 兼容与回滚方式：纯新增选项；不带 `--dry-run` 的 begin 行为零变化。
- 聚焦测试：dry-run 输出含全部信号与阈值对照；full 信号命中时 dry-run 给出拒绝解释而不拒绝退出码语义混淆（dry-run 只报告不拒绝）；dry-run 不产生任何文件副作用。
- 依赖的 fixture：临时 git 仓库 + 构造路径集。
- 汇合门禁：task 聚焦测试全绿。
- 状态：已实施（2026-09-17）：以 `begin --dry-run` 落地（与 begin 裁决同源信号，比独立 `classify` 子命令少分叉）；纯只读零副作用；信号源 = `--write-scope` 声明路径 + 当前脏树视图（`_dirty_paths` 同步修复为 `--untracked-files=all`——untracked 目录折叠曾漏判 auth marker，finish post-run 同视图一并受益）。

## 工作包：15-M2 record-quirk 失败指纹自动建议

- Module / Adapter：`harness/scripts/harness_preflight.py`（record-quirk 命令面）。
- 输入 Interface 及版本：只读消费 `<state>/evidence/verification-ledger.json` FAIL 条目、`<state_root>/runtime/run-sessions/*/session.json` FAIL 收据、`<state>/reports/review/review-findings.json`（可选存在）。
- 输出 Interface 及版本：`record-quirk --suggest` 结构化信封：`suggestions[] = {pattern, suggestedAction, evidence[], occurrences}`；**只打印不写入**。触发判据采用调研报告 §2.3-D：同一失败指纹出现 ≥2 次才进入建议。
- 允许修改的路径：`harness/scripts/harness_preflight.py`、其聚焦测试文件。
- 禁止修改的共享区域：`build-profile.json` 的写入路径（`cmd_record_quirk` 落盘逻辑不动）；`knownPreexistingErrors`/`shellQuirks` schema 不扩展。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否（`--suggest` 纯只读；人工确认后走现有 record-quirk 落盘）。
- 兼容与回滚方式：纯新增选项；持久化 schema 零变更。
- 聚焦测试：构造含重复失败指纹的 ledger/run-sessions fixture → 建议命中且带 evidence；单次失败不建议；无失败证据时输出空建议而非报错。
- 依赖的 fixture：合成 ledger/run-sessions JSON。
- 汇合门禁：preflight 聚焦测试全绿。
- 状态：已实施（2026-09-17）：`record-quirk --suggest` 只读聚类 ledger validations 与 run-sessions FAIL 收据（指纹 = 归一化命令 + exitCode + 归一化输出尾部 sha1 前 12 位），同一指纹 ≥2 次才建议并附 evidence，已在档指纹标注 `alreadyRecorded`，全程不落盘。

## 工作包：15-M3 执行失败断路器

- Module / Adapter：新增独立判定函数（优先挂在 `harness_context.py bootstrap-execute` 前的预算检查链，或新脚本；实施时以最小接缝为准）。
- 输入 Interface 及版本：只读消费 verification-ledger validations（含 status/scenarios/attempt）与 run-sessions FAIL 收据（command/exitCode/输出尾部）。
- 输出 Interface 及版本：结构化信封：同一（scenario, verification kind, 失败指纹）键连续 ≥2 次失败 → `circuit_open`，阻断继续执行并升级人工确认；否则 `closed`。失败指纹 = exitCode + 输出尾部归一化哈希（截断、去时间戳/路径等易变段）。
- 允许修改的路径：判定函数所在脚本、`harness/scripts/harness_context.py`（接线）、对应聚焦测试。
- 禁止修改的共享区域：ledger 写入路径与收据 schema；不新增持久化状态（纯派生判定，避免引入第二真相源）。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否。
- 兼容与回滚方式：新检查默认生效但可用显式确认覆盖（人工确认后放行，语义同既有 blocking 确认模式）；旧 change 目录无 ledger/sessions 时判定 closed。
- 聚焦测试：连续 2 次同指纹失败 → open；不同指纹不累计；人工确认覆盖后放行；无历史 → closed。
- 依赖的 fixture：合成 ledger + run-sessions。
- 汇合门禁：context 聚焦测试全绿。
- 状态：已实施（2026-09-17）：`harness_context.execute_circuit_check` 按 startedAt 排序从最新向回望，同（verification kind, 失败指纹）连续 ≥2 次 FAIL 判 open 并阻断 `bootstrap-execute`（`EXECUTE_CIRCUIT_OPEN` 信封含 recoveryAction）；`--circuit-ack "<理由>"` 人工确认放行并在成功信封以 `circuitBreaker.overridden/ackNote` 留痕；纯派生不持久化，无历史判 closed。

## 工作包：15-M4 review 三链闭环状态表

- Module / Adapter：`harness/scripts/harness_review.py`（status 命令）。
- 输入 Interface 及版本：`meta/scenario-manifest.json`、`reports/review/review-findings.json`、`reports/review/fixback-dispositions.json`、`<state_root>/fixback/batches/*.json`（全部只读）。
- 输出 Interface 及版本：`harness_review.py status --change <cn>`（新增 `--change` 别名，保留 `--change-dir`）输出 scenario→finding→fixback 三链 join 表：每 scenario 的 findings 计数、按 severity 分布、disposition 状态、关联 fixback batch/issue 状态。
- 允许修改的路径：`harness/scripts/harness_review.py`、其聚焦测试文件。
- 禁止修改的共享区域：findings/dispositions 的写入 schema（finding 可选 `scenarioRefs` 字段若需要，须保持可选且旧文件无该字段仍可校验通过）；fixback 批次 schema。
- 是否访问网络 / 调用模型 / 写文件：否 / 否 / 否。
- 兼容与回滚方式：status 输出新增字段不删除既有字段；finding 无 scenarioRefs 时按 path 启发式反挂并标注 `linkage: heuristic`。
- 聚焦测试：三链齐全时精确 join；缺 scenario-manifest 时降级为现有 findings×dispositions 视图；`--change` 与 `--change-dir` 等价。
- 依赖的 fixture：合成 scenario-manifest + findings + dispositions + fixback batch。
- 汇合门禁：review 聚焦测试全绿。
- 状态：已实施（2026-09-17）：`status` 输出新增 `scenarioChain` 三链 join（finding 关联优先 `scenarioRefs` declared，否则按 path 启发式并标注 `linkage=heuristic`；fixback 经 `issueId == finding.id` 对齐）；新增 `--change` 别名（与 `--change-dir` 互斥，冲突报 `STATUS_ARGS_CONFLICT`）；scenario-manifest 缺失/不可读时优雅降级为 findings×dispositions 视图（`available=false`）。

## 后续登记（已立项建议、不在本阶段当前工作包内）

| 建议 | 报告依据 | 定位 |
|---|---|---|
| Execute 场景 DAG 波次并行（首试点 standard 档） | F2、§4.2、§2.3-B | 已立项为阶段 16：16-M1 契约+advisory 波次派生已实施（2026-09-18）；16-M2 波次调度读模型与 execute-wave 派发计划已实施（2026-09-18，commit ed76830） |
| 决策级度量面板（周期时长、门禁首过率、评审发现密度） | F6、§4.3、roadmap 10 | 已立项为阶段 17：17-M1 跨 change 聚合面板已实施（2026-09-18，`harness_efficiency.py --changes-root`） |

## 验收条件

- 四个工作包各自的聚焦测试全绿，且 Python 既有测试无回归。
- 所有新命令面均为纯新增选项，既有命令行为与持久化 schema 零变更。
- 断路器与 quirk 建议只派生不持久化，不引入第二真相源。
- skill 文档同步新命令面（仅命令清单级，不复制实现细节）。

## 非目标

- 不实现 DAG 波次并行与度量面板（见后续登记）。
- 不改动 TS core/CLI 任何文件。
- 不扩展 ledger、findings、fixback、build-profile 的持久化 schema（finding 可选 scenarioRefs 除外，且保持向后兼容）。
- 不改变既有门禁的 fail-closed 语义；断路器是新增阻断点而非替换既有检查。
