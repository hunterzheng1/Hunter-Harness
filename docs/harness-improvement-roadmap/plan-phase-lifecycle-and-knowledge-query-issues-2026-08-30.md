# Plan 阶段生命周期与知识查询问题报告与优化建议

> 来源：sales-insight-agent 项目 change `demo-datasource`（KLERP 一期阶段 2 数据源接入）harness-plan 全流程实测
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.10（npm 缓存实测）

## TL;DR

v2 证据包链路本身已达到「一次通过」：`evidence-pack` / `finalize` 各 1 次通过，`review-record` 仅因草稿契约无文档试错 2 次（报错定位精准，见 P1-2）。但本次暴露三类新问题：

1. **plan 生命周期缺 `phase.end`** → 平台 Run 监控计时不停（连续两个 change 复现，属结构性缺口而非偶发遗漏）；
2. **`classify` 是写操作但形态像只读查询** → 收尾时误跑导致已发布 change 的工作副本 `plannedPhases` 被覆盖；
3. **知识查询全量返回 0 条，而归档 ingest 回执宣称 `knowledgeStatus=ready`** → 平台侧 ingest→index 链路嫌疑，CLI 无自查手段。

问题 1、2 已在本地补救；问题 3 需要平台排查。

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
