# WI-1 设计：tier/mode 单一权威（B2-5 结构性修复）

> 日期：2026-09-10
>
> 状态：**设计草案，待用户裁决**。本文是 batch3 设计
> （`design-evidence-driven-delivery-2026-09-09.md` §2 WI-1）的展开，
> 不构成实施授权。
>
> 输入：batch3 设计 §2 WI-1 边界、B2-5 试点发现（T6' 实证
> requiredRetained 静默覆盖）、快车道 B2-5 止血告警（61178f4）。
> 代码观察基线：`f228374`（快车道合入后 main）。

## 0. 待裁决项（实施前需用户定稿）

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | 权威方向：CLI profile mode 推导 tier 写回 gate-policy（方案 A） vs Python classify 读 plan-profile（方案 B） | **方案 A（CLI 派生写回）** | 见 §3.1——发布链路（evidence-pack）先于执行链路（gate begin）运行是既有事实顺序，A 顺着数据流消除双轨，B 要 Python 解析 TS 哈希绑定的 v2 包装体（`_unpack_v2_gate_policy` 已存在但只取四个门禁字段，mode 不在内） |
| 2 | 共享信号表放哪：harness/contracts/ 新 JSON vs packages/contracts/src/ 新 TS 常量 | **harness/contracts/risk-signals.json（Python 侧权威位置，TS 经 sync 生成** | 见 §3.2——marker 表的原始权威在 Python（harness_gate.py:1518），TS 是移植方（risk-signal-inference.ts 注释自认）；JSON 放 Python 权威位置 + sync 生成 TS，与 workflow-data-harness 的既有 sync 链路同构 |
| 3 | 历史在途 change 的 gate-policy 是否回写 | **不回写（读时兼容）** | batch3 设计 §2 WI-1 边界已定；回写会让 P1-1 写保护（classify 拒写已发布 change）复杂化 |
| 4 | tier→mode 映射表是否进共享 JSON | **进（tier_mode_map 键）** | 映射与信号表同属「双端必须一致」的分类契约，分开存放会再造一个漂移面 |

## 1. 现状：双轨的精确形状

### 1.1 两套独立裁决

| | Python（执行链路） | TS（发布链路） |
|---|---|---|
| 入口 | `harness_gate.py classify`（classify_risk，:1421） | `classifyPlan`（core/plan-classification） |
| 档位词表 | tier: fast/standard/full | mode: quick/standard/assurance |
| 信号表 | full_markers（:1518-1526）+ CONTRACT_SCHEMA_PATHS（:1409） | FULL_MARKERS（risk-signal-inference.ts:28）+ ASSURANCE_SIGNALS（stable.ts:34） |
| 落盘 | meta/gate-policy.json（tier、stageDecisions、requiredGateDag） | meta/plan-profile.json（mode、required_phases，哈希绑定进 trusted） |
| 消费方 | gate begin/close、archive（review-required-on-full-tier）、task、context 摘要 | finalize 三层质量门、evidence-pack 阶段取舍 |

### 1.2 信号表已对齐但裁决不互通

- marker 表逐字面对齐（TS 注释自认移植自 harness_gate.py:1468-1476）；
  但 Python 侧信号是 kebab-case（`artifact-protocol`），TS 侧是
  snake_case（`artifact_protocol`）——**词形不同，靠人肉对齐**。
- Python 的 full_markers 7 项 ⊂ TS 的 ASSURANCE_SIGNALS 11 项
  （TS 多出 breaking_contract、irreversible_operation、payment、
  permission；Python 的 permission 是 auth 的 marker 子串而非独立信号）。
- Python 有 CONTRACT_SCHEMA_PATHS 升档路径（8 个契约脚本路径精确匹配
  → contract-schema 信号），TS **没有**——改 harness_gate.py 本身
  （本 WI 就要改）在发布链路推断不出任何 assurance 信号。
- TS 有 docs_only/narrow_fix → quick 的正向低风险证据，Python 的
  fast 档判定（全 .md/.txt/.rst 或 docs/ 前缀）语义相同但独立实现。

### 1.3 双轨汇合点与静默覆盖（B2-5 实证）

数据流：`classify`（0.5，写 gate-policy.json 工作副本）→
`configure-plan`（0.6，改写同一文件的 plannedPhases）→
`evidence-pack`（读 gate-policy.json 快照 + classifyPlan 独立推导
mode）→ `finalize`（发布 plan-profile.json）→ `gate begin/close`
（`load_change_gate_policy`：v2 plan-profile 优先、工作副本回退）。

静默覆盖链：configure-plan 省略 review（合法——review 对 standard
tier 是 conditionalStage）→ evidence-pack 的 classifyPlan 从
affected_paths 推出 assurance 信号（如 `permission` 子串命中）→
required_phases 含 review → `requiredRetained` 静默把 review 加回
（快车道已加告警，代码标注 stopgap）→ **gate-policy.json 工作副本
的 stageDecisions.review.required=false 与 plan-profile 的
required_phases 含 review 并存**——两份「权威」互相矛盾，消费方
按到达顺序取用。

### 1.4 词表映射现状（无权威定义）

| tier | mode | 语义对齐度 |
|---|---|---|
| fast | quick | 阶段集一致（plan/execute/archive）；信号判定独立实现 |
| standard | standard | 同名；Python requiredValidations（compile/unitTest/unitTestFull）与 TS required_validations（deterministic_check/semantic_consistency）是**两套验证词表**，本 WI 不合并（见 §5 边界） |
| full | assurance | 阶段集差异：full 含 submit，assurance 不含（optional）；apiTest 只在 Python 侧 required |

## 2. 目标与非目标

**目标**：
1. 同一 change 在两条链路得到**一致**的档位裁决——三元组
   （信号集、tier/mode、required_phases/plannedPhases）由单一推导产生。
2. marker 表、tier↔mode 映射合并为共享数据文件，双端加载，消除移植
   漂移面（含 kebab/snake 词形转换）。
3. 静默覆盖变为显式：requiredRetained 场景下两份文件不再矛盾
   （止血告警升级为结构性消除）。

**非目标（边界，沿 batch3 设计）**：
- 不改变信号语义：marker 表内容冻结（delete 仍是 assurance 信号），
  只搬运不增删。
- 不合并验证词表（compile/unitTest vs deterministic_check 是两个
  层面的概念——执行验证 vs 质量门，合并是另一个工作项的规模）。
- 不回写历史 change 的 gate-policy（读时兼容）。
- 不动 P1-1 写保护语义（classify 拒写已发布 change 的行为保留）。

## 3. 设计

### 3.1 单一裁决点：evidence-pack 构建时由 mode 推导 tier 写回（方案 A）

**推导位置**：`plan-evidence-pack.ts` 在 `classifyPlan` 产出 profile
后、写 staged artifacts 前，新增一步 mode→tier 推导：

```
profile = classifyPlan(...)            // 既有：mode 裁决（不变）
tier = TIER_MODE_MAP[profile.mode]     // 新增：共享 JSON 的 tier_mode_map
```

**写回目标**：`machine.gate_policy`（staged artifacts 里的
gate-policy.json，v2 发布快照）新增 `tier` 字段（现在 overlay 只在
gateSnapshot 存在时透传 classify 的 tier——改为**始终**由 mode 推导
写入，source 标 `mode-derived:<mode>`）。

**工作副本同步**：evidence-pack 落盘 staged artifacts 时，同步把
`tier`/`source` 写进 `meta/gate-policy.json` 工作副本（仅当该文件
存在且未发布——已发布走 P1-1 拒写路径的读时兼容，见 §3.4）。

**为什么不是方案 B（Python 读 plan-profile）**：
- `_unpack_v2_gate_policy` 只解包四个门禁字段，mode 不在内；扩它
  要 Python 理解 trusted 哈希绑定结构，跨语言解析面扩大。
- 方案 A 的 tier 写回走既有 staged artifacts 管线（哈希绑定、
  finalize 校验），零新解析面。
- gate 侧消费 tier 的地方（archive 的
  review-required-on-full-tier、task 的 --tier floor、context 摘要）
  全部读 gate-policy.json 或其 v2 快照——方案 A 直接喂到消费点。

### 3.2 共享信号表：harness/contracts/risk-signals.json

```json
{
  "schemaVersion": 1,
  "fullMarkers": {
    "auth": ["auth", "token", "credential", "permission"],
    "security": ["security", "secret", "crypto"],
    "migration": ["migration", "migrate", "/sql/", ".sql"],
    "concurrency": ["concurr", "lock", "lease", "transaction"],
    "artifact-protocol": ["artifact", "protocol", "manifest", "baseline"],
    "shared-state": ["shared", "state/", "workflow-policy"],
    "delete": ["delete", "purge", "archive"]
  },
  "assuranceSignals": ["artifact-protocol", "auth", "breaking-contract",
    "concurrency", "delete", "irreversible-operation", "migration",
    "payment", "permission", "security", "shared-state"],
  "standardSignals": ["api-change", "cross-file", "production-code",
    "user-visible-behavior"],
  "quickSignals": ["docs-only", "narrow-fix"],
  "tierModeMap": {
    "fast": "quick",
    "standard": "standard",
    "full": "assurance"
  },
  "contractSchemaPaths": ["harness/scripts/harness_archive.py", "..."]
}
```

- **键名统一 kebab-case**（Python 侧现形）；TS 加载时经
  `camelCase`/`snake_case` 转换函数映射到 `PlanRiskSignal` 枚举
  （转换表生成一次，编译期类型检查）。
- Python：`harness_gate.py` 的 full_markers 字面量改为加载本文件
  （模块级缓存）；CONTRACT_SCHEMA_PATHS 同步迁入（Python 源码注释
  保留「权威来源是这里」的指针改指向 JSON）。
- TS：`risk-signal-inference.ts` 的 FULL_MARKERS、`stable.ts` 的
  ASSURANCE/STANDARD/QUICK_SIGNALS 改为从生成的 TS 常量导入
  （`packages/contracts/src/generated/risk-signals.ts`，由
  `scripts/sync-harness.mjs` 从 JSON 生成——与 workflow-data-harness
  的 sync 链路同构，进 pretest 流程）。
- **词形对齐注意**：Python `permission` 是 auth 的 marker（子串），
  TS `permission` 是独立 assurance 信号——JSON 里
  `fullMarkers.auth` 含 "permission" 子串 + `assuranceSignals` 含
  "permission" 信号，两处语义不同但同名，文档注释必须显式区分。

### 3.3 契约测试：双端三元组一致

新增跨语言契约测试（形态：TS 测试调 Python，与
`plan-evidence-pack.e2e.test.ts` 的 stubGitExec 同构）：

1. **信号集一致**：同一 affected_paths 输入（含 auth/migration/
   docs-only/contract-schema 四类代表路径）下，
   `inferRiskSignals`（TS）与 `classify_risk --stage post-run`
   （Python，scratch change + git status 构造）的信号集
   （词形归一后）一致。
2. **档位一致**：上述信号集下 classifyPlan 的 mode 与
   classify_risk 的 tier 满足 tierModeMap。
3. **required_phases 一致**：mode 的 required_phases（TS）与
   tier 的 defaultPhases（Python workflow-policy）在
   plan/execute/review/archive 四个关键阶段上一致
   （package/apidoc/submit/merge 是 conditional/optional，不比对）。

测试落点：`packages/cli/test/tier-mode-parity.test.ts`
（integration profile——需要 Python 可用，与现有 e2e 同环境）。

### 3.4 读时兼容与迁移

- **已发布 change**（meta/plan-profile.json 存在）：gate 读 v2 快照
  （现状不变）；快照无 tier 字段时 `_unpack_v2_gate_policy` 的
  `content.get("tier")` 返回 None——archive 等消费方把 None 当
  unknown 处理（现状已如此，:3152 `or "unknown"`）。
- **在途 change**（只有工作副本）：工作副本无 tier 时维持现状
  （classify 下次运行会写入 mode-derived tier）。
- **发布后重跑 evidence-pack**：tier 随 staged artifacts 重新派生，
  与 mode 永远一致（这是方案 A 的结构性保证）。
- **classify 的 tier_override**（--tier full 人工升档）：保留。
  override 后 gate-policy 记 override tier；evidence-pack 侧
  mode_override（buildPlanProfile 已支持）对应使用——两端 override
  入口在契约测试中各覆盖一例。

### 3.5 requiredRetained 的结构性消除

方案 A 落地后，configure-plan 省略 review 的场景：
- classifyPlan 推出 assurance → required_phases 含 review →
  requiredRetained 告警（stopgap 保留）→ **staged gate-policy 的
  tier=full + stageDecisions 由 tier_mode_map 反推**——工作副本
  在 evidence-pack 落盘时被同步为一致状态（review.required=true，
  reason=signal:security 等）。
- 即：**矛盾窗口从「永久并存」收窄到「configure-plan 之后、
  evidence-pack 之前的窗口期」**，且窗口期有 stopgap 告警。
- stopgap 告警的移除条件：WI-2（T5 补测）验证 full 档完整流程
  走通后，连同 `// B2-5 stopgap` 注释一起删除。

## 4. 实施顺序

```
1. harness/contracts/risk-signals.json（共享数据文件，内容冻结自现状）
2. Python 侧改造（harness_gate.py 加载 JSON；行为不变，现有测试全绿）
3. sync 生成 TS 常量 + TS 侧改造（risk-signal-inference/stable 导入；
   行为不变，现有测试全绿）
4. evidence-pack mode→tier 写回（staged + 工作副本同步）
5. tier-mode-parity 契约测试（§3.3 三项）
6. 文档：reference.md 双轨描述改单一权威；batch3 设计 WI-1 状态更新
```

每步独立提交；步骤 2/3 是纯重构（行为不变），步骤 4 是行为变更
（gate-policy 新增 tier 来源），步骤 5 是验收门槛。

## 5. 风险与回退

| 风险 | 缓解 |
|---|---|
| JSON 加载失败（文件缺失/坏 JSON） | Python/TS 双端 fail-closed：Python 回退内置字面量副本（与 JSON 同步维护，契约测试校验一致）；TS 生成物进 git，构建期校验 |
| sync 链路断裂（改 JSON 忘跑 sync） | pretest 已含 sync:harness；契约测试第 1 项（信号集一致）会捕获漂移 |
| 词形转换错位（kebab/snake） | 转换表生成 + 编译期类型检查；契约测试用四类代表路径覆盖 |
| tier 写回与 tier_override 冲突 | override 优先级高于 mode-derived（gate-policy 记 tierOverride 字段，evidence-pack 读到 override 时透传不覆盖） |
| 在途 change 窗口期行为变化 | 窗口期语义与现状完全一致（stopgap 告警 + requiredRetained 保留）；T5 补测（WI-2）专测此场景 |
| 契约测试依赖 Python 环境 | integration profile 已有 Python 依赖先例（archive e2e）；CI 环境与本地同构 |

## 6. 验收门槛（对齐 batch3 设计 §4）

| 门槛 | 口径 |
|---|---|
| 双端契约测试 | §3.3 三元组一致（信号集/档位/required_phases），四类代表路径 + override 各一例 |
| 试点 clone 无静默覆盖 | configure-plan 砍 review + assurance 信号场景：evidence-pack 后工作副本与 v2 快照的 review 裁决一致（不再矛盾并存） |
| 行为不变验证 | 步骤 2/3 后全量测试绿（Python 1521 + TS 2259 基线） |
| stopgap 保留 | B2-5 告警不删（移除条件见 §3.5，WI-2 验证后） |
