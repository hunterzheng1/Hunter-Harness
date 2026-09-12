# WI-3.1 设计：局部失效——返工只失效受影响的验证与评审结论

> 日期：2026-09-12
>
> 状态：**已裁决（2026-09-12）**。本文是 `design-evidence-driven-delivery-2026-09-09.md`
> §2 WI-3 子项 1 的展开。用户确认 §0 五项建议值全部采纳，按 §4 顺序实施。
>
> 输入：提案 `product-optimization-proposal-2026-09.md` §4.7（「返工只失效受影响的
> 测试和评审结论。改变公共接口、共享配置或整体设计时相应扩大范围」）；
> 代码勘察基线：`b048fa4`（2026-09-12 推送前 main）。

## 0. 待裁决项（实施前需用户定稿）

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | finding 跨轮身份：stable id 去 runId 化（sidecar 契约 v2）vs 保留现 id、另建跨轮映射文件 | **去 runId 化** | 携带/继承的一切前提是「同一问题跨轮同 id」；现 id = sha256(runId\|dimension\|path\|line\|title)（harness_review.py:94-103）跨轮必变，外挂映射文件会成为第二份需保持一致的状态。旧 sidecar 读时兼容（按 schemaVersion 分流） |
| 2 | 携带粒度：finding 级（path+锚点）vs dimension 级 | **finding 级，dimension 级作降级** | finding 已带 path+line，粒度天然够细；锚点不可计算时（如文件整体重写）fail-closed 放大到 dimension/run |
| 3 | 影响扩大触发面：复用 risk-signals.json（WI-1 单一权威）的 shared-state/contract-schema 信号 vs 独立清单 | **复用 risk-signals.json** | WI-1 已把信号表收敛为双端共享契约，另立清单即制造新的双轨 |
| 4 | 验证侧 close 主链是否补读条目级 `invalidation` 标志 | **补读（报错精准化）** | 行为上失效条目本就被整本 diffHash 兜底拦住（harness_gate.py:844-876），补读只把「LEDGER_IDENTITY_MISMATCH」细化为「EVIDENCE_INVALIDATED + 哪个条目 + 哪个批次」，不改变放行/拒绝集合 |
| 5 | 评审循环预算（提案 §4.7 同节另一条）是否并入本项 | **不并入** | 预算控制是独立策略面，并入会模糊本项的失效语义交付物；需要时单独立项 |

## 1. 现状事实（勘察基线 `b048fa4`）

### 1.1 验证证据侧：局部失效已存在，粒度达标

- fixback 唯一失效写入口 `invalidate_affected_evidence()`（harness_fixback.py:699）：
  按 `changedFiles ∩ entry.inputsFiles` 集合交集，条目级打
  `reusable=False` + `invalidation` 子对象（code/batchId/changedFiles/invalidatedAt）。
- 失效是纯投影字段：重录即复活（harness_ledger.py:2793-2797 抹除
  `reusable`/`invalidation`）。
- 复用身份与 commit 无关（harness_ledger.py:2272 注释明示），内容+上下文哈希不变
  即可复用。

**结论：验证侧无需新机制，本项只做报错精准化（裁决项 4）。**

### 1.2 评审侧：整 run 粒度失效，无携带概念

- finding id 内含 runId（harness_review.py:94-103）→ 跨轮同一问题 id 必不同。
- dispositions 强制 `runId == findings.runId`（harness_review.py:241-244），
  设计意图是防跨轮重放，副作用是**已处置结论无法跨轮继承**。
- fixback 批次关闭要求修复后 productIdentity 的**全新 review 回执**
  （harness_fixback.py:1717-1723）→ 任一 finding 的代码修复都触发全 dimension 重评审。
- sidecar 无文件哈希/commit 绑定（harness_review.py:291-351 的 `status()` 无任何
  stale 判定字段）。

### 1.3 失效事实的承载面

事件闭集无失效类型（harness_events.py:42-60）；失效事实散落于 ledger 条目字段、
`runtime/invalidations/fixback-<batchId>.json` 回执、
`evidence/verification-invalidations.ndjson` 占位三处，efficiency 汇总已消费
`invalidationReasons`（harness_efficiency.py:416）。

## 2. 目标与非目标

**目标**：fixback/返工后，评审结论按 finding 粒度失效与携带——未受影响文件的
finding 连同其 disposition 跨轮继承，受影响范围才重评审；影响扩大信号命中时
fail-closed 放大。

**非目标**：
- 评审 agent 的输入构造（给它看哪个 diff 子集）——属 WI-3.4 增量评审；本项只在
  sidecar 中记录携带事实，WI-3.4 消费之。
- 受影响测试选择（evidence selection 已存在于 harness_task/harness_ledger）。
- CI 证据导入（WI-3.2）、并行写入冲突检测（WI-3.3）。

## 3. 设计

### 3.1 finding 稳定身份（契约 v2）

- 新 `findingId = sha256(dimension|path|line|title)[:16]`；runId 降为字段：
  `firstSeenRunId` / `lastSeenRunId`。
- sidecar 加 `schemaVersion: 2`；读路径按版本分流：v1 sidecar 视为「整 run 粒度」
  旧语义（本 change 内行为不变），不迁移历史文件。
- 新增 `anchors`：`{path, contextHash}`——contextHash = finding 行 ±2 行规范化文本
  的 sha256（去行尾空白）。锚点不可计算（文件删除/整体重写）时记
  `anchors.unresolvable: true`。

### 3.2 fixback 携带判定（新函数，落 harness_review.py 或 harness_fixback.py）

输入：上轮 findings + 本轮 `changedFiles`（fixback resolver 已有）。逐 finding：

1. `finding.path ∈ changedFiles` → **invalidated**（原因 `PATH_CHANGED`）。
2. `path ∉ changedFiles` 且 `contextHash` 重算一致 → **carriedOver**
   （provenance：`carriedFromRunId`）。
3. 锚点不一致/不可算 → **invalidated**（`ANCHOR_DRIFT` / `ANCHOR_UNRESOLVABLE`）。
4. **影响扩大**（fail-closed，先于逐 finding 判定）：changedFiles 命中
   risk-signals.json 的 shared-state / contract-schema 信号 → 关联 dimension 整组
   invalidated（`BLAST_RADIUS_EXPANDED`），并在回执记录命中信号。

### 3.3 disposition 继承

- disposition 绑定稳定 findingId。新轮 review 关门校验（harness_gate.py:2669-2738）
  放宽为：finding 属 carriedOver 集合 → 接受 `inheritedFromRunId` 的处置；
  属本轮新发现或 invalidated 重生 → 仍要求本轮 runId 的处置。
- `validate_dispositions`（harness_review.py:224-264）的跨轮重放防护保留：
  携带集合由 §3.2 判定函数输出签名（findingsHash），不接受手工声明。

### 3.4 验证侧报错精准化（裁决项 4，小改）

`validate_ledger_for_phase_close`（harness_gate.py:758-970）在逐 required
validation 检查处补读最新条目的 `invalidation` 标志：命中 → 报
`EVIDENCE_INVALIDATED`（detail 带条目 verification、invalidation.code、batchId），
替代整本 diffHash 兜底的笼统报错。不改变通过/拒绝语义。

### 3.5 可见性

- fixback 回执 `runtime/invalidations/fixback-<batchId>.json` 增加评审侧计数：
  `reviewFindings: {carriedOver, invalidated, expanded}` + 命中信号列表。
- `harness_efficiency.py` 汇总口径不变，仅消费新字段（缺省兼容旧回执）。
- 不新增事件类型（事件闭集变更面大，且现有字段+回执已足够）。

## 4. 实施顺序（裁决后）

```
① finding 稳定 id + schemaVersion 2 + anchors（harness_review.py，含读时兼容）
② §3.2 携带判定函数 + fixback 接线（harness_fixback.py resolver/close_batch）
③ disposition 继承 + close 校验放宽（harness_review.py + harness_gate.py）
④ 验证侧报错精准化（harness_gate.py，裁决项 4）
⑤ 回执/efficiency 计数 + reference 文档更新 + 契约投影同步
⑥ 试点复验：一次带 fixback 的 full 档流程
```

依赖：无前置阻断项（risk-signals.json 已是 WI-1 落地形态）。
TS 侧若有 sidecar 消费方需在步骤 ③ 同步契约（实施时先排查再动手）。

## 5. 试点门槛

| 门槛 | 目标 | 口径 |
|---|---|---|
| 单测 | 锚点计算、携带/失效判定三分支、影响扩大触发、v1 读时兼容、disposition 继承与伪造防护 | 新增用例全绿 + 现有 review/fixback 套件不回归 |
| 试点复验 | 带 fixback 的 full 档流程：第二轮 review 的 carriedOver 计数 > 0 且人工抽查携带项零错误携带 | 抽查 = 携带 finding 所在文件确实与 changedFiles 无交集 |
| 无静默放宽 | 影响扩大信号命中时必须整 dimension 失效（fail-closed 用例） | 单测 + 试点各覆盖一次 |

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| 错误携带：finding 实际受影响但锚点未检出 | 锚点含上下文哈希；shared-state/contract-schema 命中即整 dimension 失效；试点门槛含人工抽查 |
| 契约 v2 破坏在途 change 的旧 sidecar | 读时兼容分流（v1 保持整 run 语义）；不迁移历史文件 |
| 携带集合被手工声明绕过 | 携带集合只能由判定函数输出并带 findingsHash 签名，close 校验验签 |
| 与 WI-3.4 范围交叠 | 本项只产出失效/携带的账本语义与 sidecar 事实；评审输入构造留给 WI-3.4 |
