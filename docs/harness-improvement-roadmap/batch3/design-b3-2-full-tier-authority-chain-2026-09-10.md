# B3-2 设计：full 档阶段与验证的权威链（合并 B3-1/B3-3）

> 日期：2026-09-10
> 状态：**待裁决**（§5 三项需用户定稿后实施）
> 输入：`collected/t5-full-tier-2026-09-10.md` §4（B3-2/B3-3 实证）、
> batch3 设计 §2 apiTest 探针结果（B3-1 实证）、
> `design-wi1-tier-mode-single-authority-2026-09-10.md`（前置权威统一）。
> 代码观察基线：`1ba462b`（2026-09-10 main）。

## 0. 问题陈述

WI-1 统一了**档位权威**（tier 由 mode 派生，单一来源），但 T5' 补测实证
full 档声明对流程编排的实际效力仍断裂在三处：

1. **B3-2（阶段集权威断裂）**：tier=full 已写入 v2 快照与工作副本，但
   阶段集（plannedPhases/defaultPhases）与验证集（requiredValidations/
   ByPhase/DAG）停留在 bootstrap 时的 standard 快照——execute 关门
   derivedToPhase=submit，review 被跳过；handoff execute→review 报
   TRANSITION_ILLEGAL。
2. **B3-3（验证集不随档位重算）**：apiTest 是 full 档 requiredValidations
   成员，但 requiredValidationsByPhase 在 bootstrap（standard）时构建，
   不含 apiTest——DEGRADED/NOT_RUN 的 apiTest 条目在阶段关门链上
   无验收点，「记了没人查」。
3. **B3-1（NOT_APPLICABLE 不被 close 认）**：`validate_ledger_entry_v2`
   对 NOT_RUN 条目只认 `DEGRADED:` 前缀证据，不读 applicability 字段
   ——NOT_APPLICABLE 记账被迫伪装成降级。

三者同属一个主题：**档位声明之后，阶段集与验证集的派生没有单一权威**。
分开修会各自打补丁，合并设计才能定清「谁在什么时机以什么输入重算什么」。

## 1. 现状机制（代码级）

### 1.1 档位与阶段集的两条链

```
Python classify（bootstrap-plan 时）
  └─ classify_risk() → tier=standard（起步档，post-run 信号未跑）
  └─ gate_policy_document() 写 meta/gate-policy.json：
     tier/defaultPhases/requiredValidations/ByPhase/DAG = standard 快照
     plannedPhases = 不写（null）

TS evidence-pack（publish 时）
  └─ classifyPlan() → mode=assurance（信号推断）
  └─ readGatePolicySnapshot()：读工作副本，plannedPhases 非字符串数组
     → 整体 undefined（T5' 实证：bootstrap 后 plannedPhases=null）
  └─ gatePolicyOverlay：tier=mode 派生（独立于 snapshot）✓
     required_gate_dag / required_validations_by_phase：仅当 snapshot
     存在且带字段时透传 → T5' 未透传（snapshot undefined）
  └─ plan finalize → meta/plan-profile.json（v2 快照）：
     planned_phases=五阶段（phase_set 由 profile 派生）✓
     tier=full ✓，但缺 gate 字段 → _unpack_v2_gate_policy 判不完整

Python gate（close 时）
  └─ load_change_gate_policy()：v2 优先，不完整 → 回退工作副本
  └─ _phase_plan()：读回退副本的 plannedPhases（null）→ 再退
     defaultPhases（standard 四阶段）
  └─ _allowed_next_phases(execute) → [submit]（review 不在计划）
```

### 1.2 验证集的构建与消费

- 构建：`_apply_required_gate_contract()`（harness_gate.py:1318）按
  tier 的 requiredValidations + capabilityGates 展开，经
  `validationPhases` 映射（apiTest→execute）构建 by_phase 与 DAG。
  **只在 classify/bootstrap 时跑一次，tier 变化不触发重算**。
- 消费：`validate_ledger_for_phase_close()`（harness_gate.py:730）按
  `effective_workflow_policy()` overlay 后的当前 phase required 列表
  逐条校验 ledger 条目。T5' 实证：execute 关门 validated 只列三项
  （standard 快照的 by_phase），apiTest 不在其中。

### 1.3 NOT_RUN 条目的合法形态

`validate_ledger_entry_v2()`（harness_gate.py:688）：
- `status=OK`：通过。
- `status=NOT_RUN` + evidence 以 `DEGRADED: <reason>` 开头：degraded_ok，
  phase_status=OK 下走 CLOSED_DEGRADED 路径。
- `status=NOT_RUN` + `applicability: NOT_APPLICABLE`（带 reason）：
  **不认**——missing 含 "status=NOT_RUN requires evidence starting
  with 'DEGRADED:'"，VALIDATION_NOT_OK 挡下（B3-1 探针实证）。
- record 侧（harness_ledger.py:2707-2836）：`--applicability
  NOT_APPLICABLE --applicability-reason` 落盘完整嵌套条目，v2 必填
  字段齐全——**记账侧完备，验收侧不认**。

## 2. 设计目标

1. **单一重算点**：tier 定档后（publish 派生或 override），阶段集与
   验证集由同一份 tier 政策（workflow-policy riskTiers）确定性重算，
   不存在「tier=full 但阶段集是 standard」的中间态。
2. **v2 快照完整性**：plan-profile.json 的 gate_policy content 满足
   `_unpack_v2_gate_policy` 四字段要求（mode/planned_phases/
   required_gate_dag/required_validations_by_phase），gate 侧不再
   因快照不完整回退到陈旧工作副本。
3. **apiTest 有验收点**：full 档的每个 requiredValidations 成员在
   阶段关门链上恰有一个验收位置。
4. **NOT_APPLICABLE 是一等公民**：声明验证不适用（带 scope reason）
   是比 DEGRADED 更强的合法形态，close 直接收敛，不被迫伪装。

## 3. 方案

### 3.1 核心决策：evidence-pack 派生时全量重算 gate 字段（方案 A）

tier 派生点（plan-evidence-pack.ts:1228-1255）从「只派生 tier/source」
扩展为「按 effectiveTier 重算全套档位派生字段」：

```
effectiveTier = overrideTier ?? MODE_TIER_MAP[profile.mode]
tierPolicy = RISK_TIERS[effectiveTier]          // 新增共享契约字段
gatePolicyOverlay = {
  tier, source,
  default_phases: tierPolicy.defaultPhases,      // 重算
  required_validations: tierPolicy.requiredValidations,
  required_validations_by_phase: <按 validationPhases 映射重算>,
  required_gate_dag: <按依赖表重算>,
  phase_set_source
}
```

依据：
- evidence-pack 已是 tier 单一派生点（WI-1），阶段集/验证集的重算
  放同一点，**档位声明与流程编排的权威在同一个命令里闭合**。
- 重算输入（riskTiers/validationPhases/依赖表）全部来自
  workflow-policy.json + risk-signals.json 共享契约——TS 侧经 sync
  生成常量（沿用 WI-1 的 generateRiskSignalsContract 管线，扩展
  RISK_TIERS/VALIDATION_PHASES/VALIDATION_DEPENDENCIES 三个导出）。
- capabilityGates 展开保留在 Python classify（bootstrap 时）——
  capabilities 是 classify 的输入，evidence-pack 侧无此信息；
  overlay 重算时**合并**而非覆盖：DAG 节点取 tier 验证集 ∪
  snapshot 的 capability 验证集。

**不选方案 B（Python 侧 close 时重算）**：close 是验收点不是派生点，
在验收点重算会让「计划说五阶段、关门时才发现要五阶段」的时序错位
继续存在；且 close 无 mode 信息（tier 在 v2 快照里，但快照可能不完整
——鸡生蛋）。

**不选方案 C（configure-plan 强制全阶段）**：把 full 档语义硬编码到
操作规程，档位政策与阶段计划脱钩，upgradeTriggers 的条件阶段语义
（fast/standard 的 conditionalStages）无法表达。

### 3.2 readGatePolicySnapshot 放宽 plannedPhases 门（B3-2 修复第一层）

现状：plannedPhases 非数组 → snapshot 整体 undefined → DAG/by_phase
不透传。但 bootstrap 后（configure-plan 前）plannedPhases 本来就是
null——**这不是损坏，是未配置**。

修改（plan-evidence-pack.ts:796-799）：
- plannedPhases 缺失/null → snapshot 仍返回（plannedPhases=undefined），
  document 原样带 DAG/by_phase 字段供 overlay 合并。
- plannedPhases 存在但非字符串数组 / 含未知阶段名 → 维持现状
  （整体 undefined，fail-safe）。

配合 3.1：overlay 的阶段集来自 tier 重算（不依赖 snapshot 的
plannedPhases），snapshot 的 plannedPhases 只用于 0.6 接缝的
optional/omission 计算（现状语义不变）。

### 3.3 v2 快照四字段补全（B3-2 修复第二层）

3.1+3.2 后 overlay 自带 required_gate_dag/required_validations_by_phase
→ plan finalize 写入的 v2 快照满足 `_unpack_v2_gate_policy` 完整性
→ gate 侧 `load_change_gate_policy` v2 优先命中，不再回退。

`_unpack_v2_gate_policy`（harness_paths.py:234）不改——四字段校验
保持严格，快照不完整的回退路径保留为防御层。

### 3.4 工作副本同步扩展（B3-2 修复第三层）

WI-1 已实现 tier/source 的发布时工作副本同步
（plan-evidence-pack.ts 工作副本同步块）。扩展为同步全套档位派生
字段：defaultPhases/requiredValidations/requiredValidationsByPhase/
requiredGateDag。已发布 change 不回写（P1-1 语义不变）。

### 3.5 apiTest 验收阶段归属（B3-3）

`validationPhases` 映射 apiTest→execute（现状）。3.1 重算后 full 档
by_phase.execute 含 apiTest → execute 关门时 `validate_ledger_for_
phase_close` 逐条校验（含 DEGRADED/NOT_APPLICABLE 形态判定）——
**apiTest 的验收点自然落在 execute 关门**，无需新机制。

边界：apiTest 若映射到 review（前置条件语义）会引入「review 关门
查 execute 的验证」的跨阶段耦合，且 review 阶段的 requiredValidations
为空（workflow-policy 无 review 键）——维持 execute 归属，依赖表
apiTest→(unitTest) 已保证顺序。

### 3.6 NOT_APPLICABLE 合法形态（B3-1）

`validate_ledger_entry_v2`（harness_gate.py:688）扩展：

```python
def is_not_applicable_entry(entry) -> bool:
    """NOT_RUN + applicability.NOT_APPLICABLE（带非空 reason）。"""
    if entry.get("status") != "NOT_RUN":
        return False
    applicability = entry.get("applicability")
    if not isinstance(applicability, dict):
        return False
    return (
        applicability.get("applicability") == "NOT_APPLICABLE"
        and isinstance(applicability.get("reason"), str)
        and applicability["reason"].strip()
    )
```

- `status` 字段校验：`value != "OK" and not degraded and not
  not_applicable` 时才报 missing。
- close 语义：NOT_APPLICABLE 与 DEGRADED 同走 CLOSED_DEGRADED
  （phase ≤ WARN）——两者都是「诚实声明未跑」，区别只在理由强度
  （不适用 vs 承认没跑）。**不引入新的 close code**，审计轨迹里
  applicability 嵌套字段已留痕区分。
- `validate_metrics` 的 dbCompatibility NOT_APPLICABLE 形态
  （harness_ledger.py:1457-1470）是 metrics 层的既有先例，本设计
  把同语义提升到条目层。
- record 侧不动（已完备）。

### 3.7 B2-5 stopgap 告警移除

3.1-3.4 落地后，requiredRetained 静默覆盖窗口收敛为「configure-plan
省略 + tier 重算保留」且 overlay 显式重算——stopgap 告警
（「configure-plan 省略的 review 因 assurance 信号被保留」）的
触发条件消失，按批次 3 设计的既定条件移除（标注
`// B2-5 stopgap: WI-1 落地后移除` 的代码）。

## 4. 实施步骤

| # | 内容 | 文件 | 验证 |
|---|---|---|---|
| 1 | 共享契约扩展：risk-signals.json 增 riskTiers/validationPhases/validationDependencies 投影字段；sync 生成 TS 常量（RISK_TIERS/VALIDATION_PHASES/VALIDATION_DEPENDENCIES） | risk-signals.json、sync-harness.mjs、generated/risk-signals.ts | 契约测试：生成物与 JSON 源一致 |
| 2 | evidence-pack 全量重算 gate overlay（3.1）+ snapshot 放宽（3.2）+ 工作副本同步扩展（3.4） | plan-evidence-pack.ts | 单测：full 档 overlay 含五阶段+四验证+DAG；standard 不变；override 透传 |
| 3 | NOT_APPLICABLE 合法形态（3.6） | harness_gate.py | 单测：NOT_APPLICABLE 条目 close 通过；缺 reason 拒绝；OK 伪装仍拒 |
| 4 | 跨语言一致性：tier-mode-parity 测试扩展——同一 affected_paths 下 overlay 重算结果与 Python `_apply_required_gate_contract` 输出三元组（阶段集/验证集/by_phase）一致 | tier-mode-parity.test.ts | 双端契约测试绿 |
| 5 | 文档：reference.md「两套分类模型的边界」更新为单一权威链描述；B2-5 stopgap 移除（3.7） | reference.md、plan-evidence-pack.ts | sync+bundle 重建 |
| 6 | 试点复验：pilot clone 重跑 T5' 场景（bootstrap→publish→close execute），验证 derivedToPhase=review 且 apiTest 在 validated 列表 | .pilot/ | 五阶段无需 configure-plan 干预 |

步骤 1-2 是 B3-2 主体；3 独立可先行（B3-1 不依赖 1-2）；4 是防漂移
契约；6 是收口门槛。

## 5. 待裁决项

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | NOT_APPLICABLE 的 close 语义：并入 CLOSED_DEGRADED vs 新增 CLOSED_NOT_APPLICABLE | **并入 CLOSED_DEGRADED** | 两者都是「诚实未跑」；新增 code 动 archive/fixback 的消费面（_ledger_api_tests、fixback 的 public-contract 集合等），收益只有审计区分度——而 applicability 嵌套字段已提供区分度 |
| 2 | overlay 重算是否覆盖 capabilityGates 展开的验证（bootstrap 时 capabilities 可能加验证进 by_phase） | **合并（∪）** | capability 触发的验证（如 remote-attestation）是 classify 输入的正当来源；覆盖会静默丢能力门禁。合并规则：tier 验证集 ∪ snapshot capability 验证集，DAG 依赖表取并 |
| 3 | 历史在途 change（v2 快照不完整 + 工作副本 standard）是否回写修复 | **不回写**（读时兼容） | 与 WI-1 边界一致：历史 change 的 gate-policy 不回写；B3-2 修复只对新 publish 生效。在途 change 用 configure-plan 显式声明（T5' 已验证的恢复路径） |

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| overlay 重算与 Python classify 输出漂移（双端两套重算逻辑） | 步骤 4 契约测试冻结三元组一致；重算输入全部来自共享契约（步骤 1），无常量字面量 |
| 快照放宽（3.2）放过真损坏的 plannedPhases | 只放宽「缺失/null」；存在但畸形仍 fail-safe 整体拒绝 |
| NOT_APPLICABLE 被滥用为跳过验证的后门 | reason 必填 + 条目层留痕 + close 语义仍是 DEGRADED 级（phase ≤ WARN，非 OK）；滥用面与 DEGRADED 相同，不新增 |
| 工作副本同步扩展写坏已发布 change | 同步条件维持「working 存在 && !published」（WI-1 语义）；单测覆盖 published-not-rewritten |
