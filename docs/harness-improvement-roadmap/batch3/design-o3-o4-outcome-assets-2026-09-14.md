# O3/O4 实际成果摘要与异步资产闭环 — 设计文档（WI-E 批次）

> 状态：**E1 已实施（2026-09-14）**；用户当日确认 §0 四项建议值全部采纳。
> 红测 9 例先行 → 实现 → `test_harness_task` 68/68、doc-contract 8/8、
> 全量回归 1627 绿。E2/E3 待另出详细设计后实施。
> 本文落实任务书 `review-remediation-execution-2026-09-12.md`
> §10（O3 摘要内容 / O4 异步处理与持久性），对应实施顺序表工作包 **E**。
> 范围大且跨 Python/TS 两侧，建议按 §1 拆为三个 WI 分批实施，先经用户裁决。

## 0. 待裁决决策点（每项附建议值）

| # | 决策点 | 选项 | 建议值 |
|---|--------|------|--------|
| 1 | WI 拆分 | A. E1 成果摘要 → E2 资产元数据+消费追踪 → E3 资产队列续跑，三个独立批次　B. 一个大批次 | **A**（E2/E3 依赖 E1 的产物；分开回归归因清晰，与 WI-3.3/3.4 分开实施的先例一致） |
| 2 | 成果摘要载体 | A. task.json 加 outcome 字段　B. 独立 `meta/outcome.json` | **B**（task.json 是 begin 时的协调事实，outcome 是 finish 产物，生命周期不同分开演化；schema 独立版本化） |
| 3 | 摘要事实来源 | A. 事实字段（diff/commit/verifications/closure）全部自动派生，模型只补动机/取舍/残余风险/未验证项（finish 新参数承载）　B. 全由模型填写 | **A**（O3 明示「事实由实际 diff、测试及操作回执派生；模型补充动机、取舍与原因」；与 archive-report-protocol「数字不得手写」同哲学） |
| 4 | 资产队列实现侧 | A. Python 侧新建 asset-outbox（复用 archive-outbox v2 的租约/退避/journal 模式，与 finish 同进程原子入队）　B. 调 TS archive-outbox | **A**（TS outbox 绑定 archive 上传语义，不是通用资产队列；跨语言调用成本高。「不创建功能重复的队列」指不同造第二个归档上传队列——资产队列是不同职能，复用其设计模式而非代码） |

## 1. WI 拆分建议

| WI | 范围 | 依赖 |
|----|------|------|
| **E1 实际成果摘要** | `meta/outcome.json` schema + finish 写入 + 三处 goal 复制反模式消除 + 模型输入参数 | 无（独立） |
| **E2 资产元数据+消费追踪** | knowledge candidate schema v2（适用版本/验证状态/替代关系/失效条件）+ 被检索/被采用/被验证三态回执 | E1（摘要成为候选新来源） |
| **E3 资产队列续跑** | Python asset-outbox（租约/退避/容量/journal）+ 启动/维护 drain 钩子 + 远端上传接线 | E2（消费 E2 的资产记录） |

## 2. E1 实际成果摘要 — 详细设计

### 2.1 现状反模式（勘察实证）

`harness_task.py` finish 三处 emit 的 summary 块全部
`"完成内容": task.get("goal")`（恢复路径 / --no-commit / 正常路径），
且只出现在 stdout JSON，不落盘。task.json 终态（status/closureReason/
finishedAt/commit）无成果叙述字段。

### 2.2 `meta/outcome.json`（schemaVersion 1）

finish 成功收口时（含 completed / abandoned / superseded 三态）原子写入：

```json
{
  "schemaVersion": 1,
  "changeId": "...",
  "closure": "completed | abandoned | superseded",
  "goal": "<begin 声明的目标，原样引用——只读事实>",
  "outcome": {
    "summary": "<模型填：实际完成的行为叙述；abandoned/superseded 时填中止状态说明>",
    "motivation": "<模型填：关键取舍与原因；无法证实的解释标注 [推测]>",
    "residualRisks": ["<模型填>"],
    "nextSteps": ["<模型填：必要下一步；无则空数组>"],
    "unverifiedItems": ["<模型填：声明过但未验证的项>"]
  },
  "facts": {
    "commit": "<completed 时的提交 hash；否则 null>",
    "changedFiles": ["<classify 最终产品 diff 文件集，派生>"],
    "verifications": [{"name": "...", "status": "pass|fail", "exitCode": 0}],
    "closureReason": "<abandoned/superseded 时的原因>",
    "finishedAt": "<ISO>"
  },
  "capturedAt": "<ISO>"
}
```

派生约束（与 archive-report-protocol 一致）：
- `facts` 全部由 finish 既有数据派生（classify product_paths / verifications /
  closureReason / commit），**模型不可写**；
- `outcome.*` 由模型经 finish 新参数提供；缺省时字段为 null/空数组——
  **空白不凑数**（O3 明示），不拿 goal 回填 summary；
- `goal` 原样引用 begin 声明，与 outcome.summary 分字段——目标与最终
  结果不同的任务天然可表达（验收要求场景）。

### 2.3 finish CLI 新参数（模型输入通道）

```
harness_task.py finish ... \
  [--outcome-summary "<实际完成的行为>"] \
  [--outcome-motivation "<取舍与原因>"] \
  [--outcome-risk "<残余风险>"] (可重复) \
  [--outcome-next "<下一步>"] (可重复) \
  [--outcome-unverified "<未验证项>"] (可重复)
```

- 全部可选；不带则 outcome 对应字段 null/空数组（空白不凑数）；
- completed 且 `--outcome-summary` 缺失 → 成功但输出 warning
  `OUTCOME_SUMMARY_MISSING`（不阻塞——O3 未要求硬门禁，与 review
  advisory 同哲学；反复缺失可由门禁观测后续收紧）。

### 2.4 反模式消除

三处 emit 的 summary 块改为从 `meta/outcome.json` 读（写完后读回）：
- `完成内容` = outcome.summary ?? "（未填写成果摘要——见 outcome.json）"；
- 验证结果/残余风险/代码位置字段改读 facts，不再硬编码固定文案；
- stdout summary 是 outcome.json 的**派生展示**，不是权威——权威只有
  outcome.json（与 O6「同一事实一个权威写入方」对齐）。

### 2.5 红测矩阵（E1）

| 场景 | 断言 |
|------|------|
| completed + 全部 outcome 参数 | outcome.json 五字段齐；facts 派生值与 classify/verifications 一致 |
| completed 无 --outcome-summary | 成功 + warning OUTCOME_SUMMARY_MISSING；summary=null（不回填 goal） |
| abandoned + closure-reason | outcome.summary 可为 null；facts.closureReason 正确；goal 原样保留且与 summary 分字段 |
| 目标与结果不同 | goal="做 X"，summary="只完成了 X 的一半" → 两字段独立 |
| 部分完成/工作区交付（--no-commit） | outcome.json 正常写入，facts.commit=null |
| 未验证项 | --outcome-unverified 传入 → 数组保留 |
| stdout summary 派生 | emit 的完成内容来自 outcome.json（改 outcome 参数 → emit 变） |
| 幂等重跑 finish | 同参重跑 outcome.json 内容一致（capturedAt 除外）或拒绝——按现有 finish 幂等语义对齐 |
| 磁盘写入失败 | outcome.json 写失败 → finish 报错不静默（O4 §10.2 要求：磁盘写入失败显示未保存） |

## 3. E2 资产元数据+消费追踪 — 轮廓（另出详细设计）

- knowledge candidate schema v1→v2 增量字段：`applicableVersions`
  （适用版本范围）、`validationStatus`（unverified|verified|invalidated）、
  `supersedes`/`supersededBy`（替代关系）、`expiresWhen`（失效条件）；
- 消费三态：retrieved/adopted/verified-effective 回执（建议挂 events
  或资产状态字段，本地可追踪）；
- 验收要求（O3/O4 明示）：后续任务实际消费至少一条资产并记录适用/
  不适用结果——需要消费侧接线点（begin 时检索提示？）。

## 4. E3 资产队列续跑 — 轮廓（另出详细设计）

- Python asset-outbox：`.harness/state/local/asset-outbox/`；
  record = 幂等键（content hash）+ 租约（capability hash）+ 退避
  （base/max 对齐 v2 默认值）+ transition journal + 死信；
- 容量策略：条数/字节配额（v2 只有 MAX_ATTEMPTS，需补）；
- 无常驻宿主：显式维护命令 `harness_assets.py drain` + 可选「下次启动
  续跑」钩子（参照 12-m3 reconcile 先例）；不承诺后台执行；
- 远端上传接线：与 plan-event outbox 遗留待办（fs-event-outbox-port.ts
  头部注释）合并裁决；**无远端环境时本地+契约测试先行，远端闭环保持
  待验证不改「全部完成」**（任务书 §10.2 末条硬约束）；
- 必测矩阵（任务书 §10.2 列明）：离线交付/队列重启/重复消费/领取后
  崩溃/远端成功但本地回执失败/容量不足/冲突知识/敏感内容排除/跨项目隔离。

## 5. 影响面（E1 部分）

| 文件 | 变更 |
|------|------|
| `harness/scripts/harness_task.py` | finish 写 outcome.json + 新参数 + 三处 emit 改派生 |
| `harness/scripts/tests/test_harness_task.py` | E1 红测约 9 例 |
| `harness/harness-task/SKILL.md`/`reference.md` | 成果摘要参数与语义 |
| 设计文档 | 本文（裁决后状态推进） |
