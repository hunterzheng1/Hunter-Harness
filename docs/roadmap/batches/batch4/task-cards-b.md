# 批 B 任务卡适配说明（WI-O5.4，2026-09-19）

批 B 执行 T4/T5/T6 × A/B/C × 5 reps = 45 实现 run + 45 盲评。本文档记录任务卡相对
batch0/batch3 原始定义的适配点与理由；权威的任务卡全文以
`collected/_runner/batch_b_runner.py` 内嵌的 `TASK_BODY`/`HIDDEN_CHECKS` 为准（每次 run 的
`collected/<run>/prompt.txt` 是逐字存档）。

## 适配总理由

D1 冻结基线 `3f5a6ac`（审核基线 0.2.81 全量投影内容字节快照），批 A/B 所有克隆统一钉在该
SHA。原始任务卡（batch0 T4/T6、batch3 T5'）分别钉在 `898c8ed`、`0b2ab3a` 与「T3 中间态」，
与冻结基线冲突，必须适配为在 `3f5a6ac` 上自包含。

## T4（跨模块变更）— 重构为自包含

原卡（batch0/tasks/T4-cross-module.md）需求是「把 T3 的 lastActivityAt 字段透传到 TS 侧」，
依赖 T3 产物，在 `3f5a6ac` 上无锚点；且基线上 TS 侧（`sync.ts`）把 status 输出当 `unknown`
透传、无类型定义可改。

适配后需求（保留「Python→TS 契约透传」的跨模块本质）：

1. Python 侧 `harness_change.py status --json` 顶层增加 `generatedAt`（ISO-8601 UTC，该次调用
   生成时刻）；人类可读输出不变。
2. TS 侧 `sync.ts` 把 `changePayload` 从 unknown 改为结构化解析（`ChangeStatusPayload` 类型
   守卫，保持 snake_case 线上契约），收据 details 显式透传 `generatedAt`/`summary`；旧版
   payload（无该字段）兼容不报错。
3. 双侧测试：Python 断言格式与偏差 <60s；TS 断言透传与向后兼容。

隐藏核查新增：连续两次调用值不同（防常量造假）、向后兼容实测、命名契约审查、items 零变化
对照、package.json/lock 零 diff。

## T5（高风险变更）— 沿用 T5'，两处适配

batch3 T5'（reviewCadence 字段演进）核实可复用：`reviewCadence` 在 `3f5a6ac` 代码中不存在
（仅文档提及）。适配点：

1. 原「bundle 投影同步」要求改写为「`node scripts/sync-harness.mjs` 冒烟成功退出」——基线上
   `packages/workflow-data-harness/harness/bundles/` 是 sync 生成物（gitignored），仓库内无
   待同步副本；sync-harness.mjs 存在于基线。
2. 明确 parity 测试运行方式：`npx vitest run --project integration
   packages/cli/test/tier-mode-parity.test.ts`（基线 `packages/cli/test/**` 属 integration
   project，fast project 排除之——冒烟实测确认，14/14 通过、5.7s、离线可跑）。

保留：apiTest 不可用时的 `DEGRADED: env-no-api` 显式记账要求与全部隐藏核查（损坏 JSON 失败
路径、旧 fixture 逐字节一致、非法取值拒绝、不删旧字段/无版本协商）。

## T6（中断恢复）— 操作化为两段会话

原卡要求「在 execute 阶段关门检查前 kill 进程」，无头自动化无法可靠观测该时点。操作化：

- **载体任务**：批 A 的 T3（`lastActivityAt`，在 `3f5a6ac` 自包含）。
- **phase1**：正常执行 T3，到达语义中断点（实现+回归测试落盘且聚焦测试通过；B/C 组为
  execute 验证已过、gate close/finish/归档未做）后输出 `INTERRUPT-POINT` 标记并干净退出。
  超时强杀同样计为有效中断（`interruptMode=killed`）。若 phase1 未停即完成全任务
  （`no-interrupt`），该格从 T6 效率统计剔除、留档备查。
- **phase2**：同克隆新会话，要求勘察现场（git status/diff + harness 状态命令）、不重跑已通过
  验证、不重复副作用、完成验收与收尾。
- 隐藏核查沿用 T3 全部（乱序 events 等）+ 恢复专项：无重复 phase.end/账本记录、无状态伪造
  （时间戳单调且与 mtime 相容）。

## 批 B 方法学修正（批 A 试点结论，2026-09-19 用户确认）

1. **强制工作流**：B/C 组任务卡明文要求五阶段流程（plan→execute→review→submit→archive）；
   C 组显式要求调用 `/harness-plan`（契约邻接文件禁用 `/harness-task` 轻闭环）。批 A 缺口：
   C 组 9/9 未激活工作流（1.1.0 skill 门控「仅显式调用时触发」+ 任务卡无显式要求）。
2. **回执验收核查**：盲评隐藏清单新增 HR 项——B/C 组核查 `.harness/changes/` 或
   `.harness/archive/` 下回执齐全度（events.ndjson 非空、账本、执行记录），产出
   `workflowCompliance: full|partial|none|faked|na` 字段；A 组反向核查（出现即 faked）。
3. **禁止自行提交**：任何组不得 git commit/push/tag，唯一例外是 B/C 流程脚本内部提交；
   补丁采集改为 `git add -N . && git diff <BASE>`（兼容流程提交与新增文件）。
4. **n≥5/格**：每格 5 reps（rep-major 交错；前 3 reps 与批 A 规模对齐，可先出中期读数）。
5. **仪式写作代理**：`harness_run_metrics.py` 新增 `artifactWrites`（写向 `.harness/` 的
   Write/Edit span 计数+内容字节数），替代不可行的逐 run 人工登记。
6. **口径变更**：setup（克隆+投影/init+npm ci）单列 `setupSeconds`，不计入
   `wallClockSeconds`（批 A setup 为秒级含在挂钟内；批 B 含 npm ci，实测 ~3-9s 缓存命中）。
   跨组同任务 setup 条件一致（T4/T5 全组 npm ci）。
7. **信封解析**：`raw_decode` 从首个 `{` 解析 stdout 最外层 JSON（批 A 整文件 loads 失败率
   100%），`numTurns` 入库。

## 运行参数

- 宿主 CLI 2.154.0，`--permission-mode bypassPermissions --output-format json`，模型统一
  `custom:deepseek-v4.1-flash`（D5）。
- 预算：T4 120+10min，T5 180+10min，T6 phase1 75+10min / phase2 45+10min；评审 30min。
- 顺序串行、跨 run 冷却 45s、痕迹窗口 ±15s settle。
