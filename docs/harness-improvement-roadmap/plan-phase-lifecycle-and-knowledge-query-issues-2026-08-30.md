# Plan 阶段生命周期与知识查询问题报告与优化建议

> 来源：sales-insight-agent 项目 change `demo-datasource`（KLERP 一期阶段 2 数据源接入）harness-plan 全流程实测
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.10（npm 缓存实测）

## 修复状态（2026-08-30，hunter-harness 0.4.11 / core 0.1.7 / workflow-harness 0.4.10 + hunter-platform 配套）

| 条目 | 状态 | 修复点 |
|---|---|---|
| P0-1 知识查询全 0 但回执 ready | ✅ 已修（两端） | CLI：新增 `knowledge status`（fence 代数/job 状态计数/条目数/最近活动），区分「job 没跑/失败/结果为空」；ingest skill 增加查询回读验证（ready 不再是空头收据）；plan 阶段 1 查询结果落事件。平台：finalize 只在无知识候选时置 ready，有候选置 indexing，job commit/fail 桥翻转为 ready/failed；`/knowledge/projection-status` 返回 pipeline 状态。生产库存量数据的修复动作：重跑一次归档上传即可触发翻转 |
| P0-2 plan 缺 phase.end | ✅ 已修 | `close_transition` 自动补齐事件对（`PHASE_END_AUTO_PAIRED`，复用 start 的 run_id/attempt，幂等自愈）；gate close 先行写入的流程不双写。doctor/平台超时告警两项建议未做（见下行） |
| P0-2 建议 2/3（doctor 检查 + 平台超时告警） | ⏳ 未做 | 结构性缺口已由自动配对消除，告警属锦上添花，待需要时单独立项 |
| P1-1 classify 覆盖已发布 change | ✅ 已修 | 已发布 change（meta/plan-profile.json 存在）默认拒写并提示；`--force` 显式重算 |
| P1-2 review-record 草稿契约 | ✅ 已修 | `plan review-record --print-template` 合法骨架 + reference.md 完整契约（键集/severity 枚举/identity 规则） |
| P2 legacyBootstrap 语义 | ✅ 已修 | plan SKILL 0.5 行内注明（首阶段无凭证的正常标记） |
| E-1 --out 双重拼接 | ✅ 已修 | 已含 change-dir 前缀的相对路径按 cwd 解析；越出项目目录拒绝（SCENARIO_RECEIPT_OUT_OF_PROJECT） |
| E-2 集成测试静默 0 执行 | ✅ 已修 | ledger record 检出选择器 + Tests run: 0 → `ZERO_TESTS_WITH_SELECTOR` 警告；pitfalls-java 收录该坑（base + overlay 两份） |
| E-3 必填字段逐个报错 | ✅ 已修 | events append 一次性列出全部缺失字段 |
| E-4 --change/--change-dir 不统一 | ✅ 已修 | gate/context/events/ledger 双向互为别名 |
| E-5 verification target 晚发现 | ✅ 已修 | gate begin（execute）提前校验 execution_level↔targets 覆盖，WARN `VERIFICATION_TARGETS_UNDECLARED` 附待补清单 |
| E-8 MSYS 路径转换 | ✅ 已修（文档） | execute SKILL 注明 `--note` 不得以 `/` 开头或 `MSYS_NO_PATHCONV=1` |

---

## TL;DR

v2 证据包链路本身已达到「一次通过」：`evidence-pack` / `finalize` 各 1 次通过，`review-record` 仅因草稿契约无文档试错 2 次（报错定位精准，见 P1-2）。但本次暴露三类新问题：

1. **plan 生命周期缺 `phase.end`** → 平台 Run 监控计时不停（连续两个 change 复现，属结构性缺口而非偶发遗漏）；
2. **`classify` 是写操作但形态像只读查询** → 收尾时误跑导致已发布 change 的工作副本 `plannedPhases` 被覆盖；
3. **知识查询全量返回 0 条，而归档 ingest 回执宣称 `knowledgeStatus=ready`** → 平台侧 ingest→index 链路嫌疑，CLI 无自查手段。

问题 1、2 已在本地补救；问题 3 需要平台排查。

> **2026-08-30 追加**：同一 change 的 execute 阶段问题见文末「追加：execute 阶段实测问题」。其中 E-1（`scenario-receipt-template --out` 路径双重拼接）、E-2（集成测试静默 0 执行）建议优先修。

---

## 🔴 P0-1：知识查询全量 0 条，但 ingest 回执宣称 ready（平台侧嫌疑）

**现象**

- `npx hunter-harness knowledge query "<任意查询>" --json` 对一切查询返回 `count=0`：不仅是长句需求原文，短词 `demo-skeleton`、`数据源`、`KLERP 智能问数` 全部为 0
- 回执 `index_generation` 恒为 `knowledge_generation:1`，`status=succeeded`、`result_ids=[]`

**反证（知识应当存在）**

- 阶段 1 change `demo-skeleton` 的归档已成功上传：`.harness/state/local/archive-packages/demo-skeleton.remote.json` 记录 `archiveStatus=durable`、`knowledgeStatus=ready`（`arc_c06d3376af3e46278684622c3e050f6d`）
- 归档包含真实知识候选：`candidates/knowledge.json`（如 review Y1 pitfall 条目），且 `plans/**/*.md` 属于允许入库的核心内容

**结论**

不是查询词构造问题（短词同为 0）。归档→ingest 收据链路自认为成功，但查询面为空。嫌疑点（平台侧）：

- ingest 写入与 query 读取的索引/代数不一致（generation 卡在 1，疑似从未重建）
- ingest 只登记未真正建索引
- project 维度隔离错位（query 与 ingest 走的 project 上下文不同）

**建议**

1. 平台侧排查 `arc_c06d3376…` 的 ingest 落库与索引重建链路
2. CLI 增加 `knowledge status`：显示当前 generation、条目数、最近 ingest 时间——现在查询面没有任何自查手段，只能盲猜
3. `harness-knowledge-ingest` 的验收标准目前只核对上传回执的 `knowledgeStatus=ready`，**应追加一次 query 回读验证**（用已知关键词查询 count≥1 才算 ready），否则「知识已入库」是空头收据
4. plan skill 阶段 1 应强制把知识查询结果（哪怕 0 条）写入事件——demo-skeleton 的 events 里连知识查询记录都没有，该环节可能从未真正生效却无从追溯

## 🔴 P0-2：plan 生命周期缺 `phase.end` → 平台 Run 监控计时不停

**现象**

- plan 发布成功（`PLAN_FINALIZED`）且 `harness_context.py close` 完成后，平台页面 plan 阶段仍在计时
- 根因：`events.ndjson` 只有 `phase.start`（bootstrap-plan 写入）和若干 `command`，**没有 `phase.end`**；平台计时由 events-sync 上报的 phase.start/end 事件对驱动，缺 end 即永不停表

**这不是偶发遗漏，是结构性缺口**

- demo-skeleton 的归档 events 同样只有 `phase.start | plan`、无 `phase.end | plan`——连续两个 change 复现
- plan v2 收尾链路 `evidence-pack → review-record → finalize → context close` **没有任何一步自动写或校验 phase.end**；`close` 写的是 `runtime/transitions.ndjson` 转换收据，不是事件
- skill 文档只在「执行日志」章节泛泛要求「阶段结束必须写 --status OK」，阶段 8 的强制检查表里没有 phase.end 一项

**已验证的补救**

```bash
python harness_events.py append --type phase.end --run-id <plan-run-id> --attempt 1 --status OK --note "..."
npx hunter-harness events-sync --json   # cursor acked_lines 5→6，平台计时停止
```

**建议**

1. `plan finalize` 成功或 `context close` 时自动补写/校验 phase.start-end 配对（缺 end 时告警或代写）
2. `doctor` 增加「未配对 phase.start」检查
3. 平台 Run 监控加「phase.start 无配对 phase.end 超时告警」，比静默计时更健壮
4. skill 阶段 8 完整性检查表加入 phase.end 行

## 🟡 P1-1：`classify` 是写操作，对已发布 change 覆盖工作副本无防呆

**现象**

- 收尾验证时执行 `harness_gate.py classify --change <cn> --stage plan --json` 想**读**状态，实际**重写**了 `meta/gate-policy.json` 工作副本：configure-plan 写入的 `plannedPhases=[plan,execute,review,submit,archive]` 被清掉，`stageDecisions.review` 回到 `not-triggered`
- 正是 reference.md 自己警告的「发布后改写工作副本本身就是异常」——但 classify 返回的是一份状态 JSON，形态上完全是只读查询的样子，没有任何防呆
- 事后重跑 `configure-plan` 恢复，与 v2 权威 `plan-profile.json` 重新一致

**建议**

1. classify 对已 finalize 的 change 拒绝重写（或要求显式 `--force`）
2. 拆一个只读 `status` 子命令承载「读当前门禁状态」的需求
3. 工作副本与 v2 包装体的 drift 检测（reference 已定义 drift 语义）应在 `doctor`/`sync` 中主动报告，而不是等下游撞见

## 🟡 P1-2：`plan review-record` 草稿契约无文档，只能靠报错试

**现象**

- reference.md 的示例草稿是 `{ "reviewer_identity": ..., "findings": [] }`，没有写 findings 元素的键集
- 实际校验器要求 findings 元素键集精确为 `finding_id / category / severity / source_refs / message_zh / suggested_location`，且 `severity ∈ {advisory, blocking}`——本次试错 2 次才通过
- 报错本身很好（`field_path` + `problems[]` 逐条列出缺键/多键/枚举取值），但契约应该进文档而不是靠报错反推

**建议**

1. reference.md「阶段 8 v2 路径」补齐评审草稿完整契约（含 severity 枚举与 category 约定）
2. `plan review-record --print-template` 提供合法骨架（与 evidence-pack 的模板不变量对齐）

## 🟢 做得好的（请保留）

- evidence-pack / finalize / review-record 的 `field_path` + `problems[]` 精确定位：本次除 review 草稿外 **0 次二分定位**，0.4.8 修的校验定位在实战中完全生效
- `--print-template` 骨架一次通过 evidence-pack（回归不变量守住了）
- `risk_signals` 自动推断准确：从 `affected_paths` 的 `db/views/*.sql` 正确推断出 `migration` 信号并与手填取并集
- `configure-plan`、`context close`、`events-sync` 全部幂等顺畅；events-sync cursor 增量上报（acked_lines 5→6）可靠
- 发布后修订路径（evidence-pack 重跑 + expected_baseline）文档清晰，本次未用到但已具备

## 🟢 P2 观察项

- `bootstrap-plan` 输出含 `legacyBootstrap: true`，语义未文档化——是提示项目结构需要迁移，还是内部兼容标记？建议说明或从输出移除
- 阶段 1 demo-skeleton 归档 events 中无知识查询记录（见 P0-1 建议 4）
- 平台 Run 监控的计时语义建议以事件对为准并显式展示「等待 phase.end」状态，而不是无限计时

## 复现环境

- hunter-harness 0.4.10（npx 缓存），Node v24.14.0，Python 3.11.15，Windows（Git Bash）
- 项目：sales-insight-agent，change `demo-datasource`，master @ b26468a
- 关键操作序列：`bootstrap-plan` → `configure-plan` → `evidence-pack`（1 次通过）→ `review-record`（2 次契约试错）→ `finalize`（1 次通过）→ `context close` →【误操作】`classify`（覆盖工作副本）→ `configure-plan` 恢复 → 补写 `phase.end` → `events-sync`（cursor 5→6）

---

# 追加：execute 阶段实测问题（2026-08-30，change `demo-datasource`）

> 来源：同一 change 的 `/harness-execute` 全流程（prepare → begin → gate begin → TDD → ledger → 报告 → gate close）
> 总体评价：execute 链路本身顺畅（gate close 幂等、自动写 phase.end 并同步平台、`derivedToPhase` 正确），以下按严重度排列。

## 🔴 E-1：`ledger scenario-receipt-template --out` 相对路径被双重拼接

**现象**

```bash
python harness_ledger.py scenario-receipt-template --change-dir .harness/changes/demo-datasource \
  --out .harness/changes/demo-datasource/evidence/scenario-receipt-unit.json ...
# 实际写到：.harness/changes/demo-datasource/.harness/changes/demo-datasource/evidence/scenario-receipt-unit.json
```

`--out` 的相对路径被拼到 `--change-dir` 之下，产生嵌套幽灵目录。返回体 `path` 字段如实显示了错误路径，但执行者不细看不会发现。

**建议**：`--out` 相对路径统一相对 cwd 解析（CLI 惯例），或相对 change-dir 但在文档写明；同时在写文件前校验目标路径仍位于项目内且不含重复 change-dir 段。

## 🔴 E-2：集成测试「静默 0 执行」——exit 0 + Tests run: 0，无告警

**现象**

- pom 在 surefire `<configuration>` 里写死 `<excludedGroups>mysql</excludedGroups>` 后，命令行 `-Dgroups=mysql -DexcludedGroups=` 的**空值覆盖不生效**（插件级配置压过用户属性），`@Tag(mysql)` 测试全部被排除
- 结果是 `Tests run: 0, Failures: 0` + **exit 0**——如果只看退出码，这是一次“全绿”的假阳性
- 修复方式：pom 改用 `${excludedGroups}` 属性占位，命令行空值才能生效（已在产品侧修复并记入测试报告）

**建议（harness 侧）**

1. `harness_test_runner.py exec` 或 ledger record 在结果解析时发现 `Tests run: 0` 且命令含 `-Dgroups=`/`-Dtest=` 选择器 → 至少 WARN（选择器存在却 0 命中，大概率是过滤配置问题）
2. `harness-test/pitfalls-java.md` 收录此坑：surefire 插件级 excludedGroups 与命令行覆盖的优先级规则
3. plan 阶段生成验证命令（场景表 `-Dgroups=mysql -DexcludedGroups=`）时，若项目 pom 无对应属性占位，应提示配置前置条件

## 🟡 E-3：`harness_events.py append --type verification` 必填字段逐个报错

- 先报 `--name` 缺失，补上后再报 `--status` 缺失，两次往返
- **建议**：入口一次性校验全部必填字段并合并报错（对齐 `PLAN_EVIDENCE_INPUT_INVALID` 的 `problems[]` 风格）

## 🟡 E-4：`--change` 与 `--change-dir` 参数名跨脚本不统一

- `harness_gate.py begin/close` 用 `--change`；`harness_events.py append`、`harness_ledger.py record` 用 `--change-dir`；`harness_context.py` 又是 `--change`
- 每次切换脚本都要查一次 usage，实测踩到一次（`gate begin --change-dir` 报 unrecognized）
- **建议**：统一接受两个别名（argparse `add_argument("--change", "--change-dir", dest="change")` 成本极低），或至少全部接受 `--change-dir`

## 🟡 E-5：plan 场景表引用未声明的 verification target 时不预警

- 场景表验证命令包含集成测试（`-Dgroups=mysql`），但 `build-profile.json` 的 `verificationGraph.targets` 只有 compile/unitTest/unitTestFull；ledger record `--verification integrationTest` 时才报错 `unsupported verification`
- 报错文案本身很好（指出声明位置），但发现时点太晚
- **建议**：`plan finalize` 或 `gate begin`（execute）时校验：场景表涉及的 execution_level/verification 是否都有对应 target 声明，缺失时提前列出待补清单

## 🟢 E-6：execute 的 `gate close` 正确处理了 phase.end —— 反证 plan 链路缺口

- execute 关门时 close 内部自动写 `phase.end` + 平台事件同步（`acked_lines` 10 条），无需手工补写
- 这证实 P0-2 的修复方向：把同一套逻辑接到 plan 的 close/finalize 路径即可

## 🟢 E-7：其他正向观察

- `harness_test_runner.py exec` 全程稳定（锁、超时、进程树清理无异常），资源档位语义清晰
- `gate begin` 对 `-Dtest=` 探针测试与正式测试的区分没有干扰
- 平台 Run 监控在 execute 阶段计时正确（对照 P0-2：execute 事件对完整）

## 🟢 E-8：展示层小问题

- `gate begin --note "/harness-execute 触发..."` 在 Git Bash 下被 MSYS 路径转换改写成 `C:/Program Files/Git/harness-execute 触发...`（事件 note 里可见）。工具侧可提示 note 避免 `/` 开头，或文档注明 `MSYS_NO_PATHCONV=1`

## execute 复现环境

- 同上文（hunter-harness 0.4.10 / Node 24.14 / Windows Git Bash）
- 关键操作序列：`context prepare/begin` → `gate begin` → `state capture` → 基线 compile → RED（编译失败证据）→ GREEN（UT 20/20）→ 集成 10/10（含 E-2 修复）→ guard record（tdd-created）→ ledger 四条 → 测试报告 → `gate close`（derivedToPhase=review）
