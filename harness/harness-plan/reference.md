---
description: harness-plan 的需求提取模板、任务拆分规则、测试场景4维度详细格式。仅在执行规划需要参考详细格式时读取。
---

# harness-plan

## Worktree 决策文件模板

阶段 4 设计审批包确认后必须生成 `.harness/changes/<change-name>/meta/worktree.json`。这是后续 `/harness-run` 是否创建/切换 worktree 的唯一机器可读依据。

### 使用 Worktree

```json
{
  "requested": true,
  "created": false,
  "agent": "<active-adapter>",
  "worktreeRoot": ".worktrees",
  "branchPrefix": "harness/",
  "path": ".worktrees/<change-name>",
  "branch": "harness/<change-name>",
  "decisionBy": "user",
  "decisionAt": "YYYY-MM-DD HH:mm",
  "ownerSkill": "harness-run"
}
```

### 不使用 Worktree

```json
{
  "requested": false,
  "created": false,
  "path": null,
  "branch": null,
  "decisionBy": "user",
  "decisionAt": "YYYY-MM-DD HH:mm",
  "ownerSkill": null
}
```

### 决策事件 note 示例

`path` 与 `branch` 必须来自 `harness_runtime.py adapter`/`meta/runtime.json`。所有 agent 共享统一路径 `.worktrees/<change-name>` 与统一分支前缀 `harness/`；`agent` 字段仅作创建者元数据，不再决定路径。

`用户选择使用 Worktree；决策文件为 meta/worktree.json；requested=true, created=false；创建责任为 harness-run。`

## 参考 — 详细格式

## 阶段 1：需求接收

接收用户输入（文字描述或文档路径），提取关键信息：
- 功能范围（要做什么、不做什么）
- 业务规则（校验逻辑、权限约束）
- 数据模型变更（新表、新字段）
- 接口变更（新增/修改的端点）

如果需求不明确（如"做一个指标管理功能"），列出具体疑问向用户澄清——不要猜测后直接设计。

### 影响面检查

方案汇总后（阶段 4 末尾），主动列出可能受影响但用户未提及的点，让用户一次性确认：

```markdown
### 影响面检查

基于代码探索，以下点可能受本次变更影响但尚未讨论：

| # | 影响点 | 说明 | 需要处理？ |
|:--:|--------|------|:----------:|
| 1 | 请求参数变更 | 数据契约删除字段后，前端请求格式变化 | 是/否 |
| 2 | 数据库迁移 | 字段删除前需迁移历史数据 | 是/否 |
| 3 | 其他模块引用 | 其他业务模块引用了该字段 | 是/否 |
| 4 | 前端兼容性 | 旧前端传已删除字段会报错 | 是/否 |
```

> 这一检查的目的是减少设计文档生成后的迭代轮次——提前发现用户可能提出的修改。

## 阶段 3：代码探索（只读）输出格式

```markdown
## 设计概要 — <功能名>

### 涉及模块
- 接口层: xxx-server/.../xxx/
- 业务层: 同上
- 新增表: xxx
- 修改表: xxx (新增 N 字段)

### 接口变更
| 方法 | 路径 | 类型 |
|------|------|:----:|
| GET | /xxx | 新增 |
| POST | /xxx | 修改 |

### 关键决策
- 决策1: 说明
- 决策2: 说明
```

## 阶段 4：设计审批与文档落盘 ⚠️ 用户审核

基于代码探索和需求澄清的结果，撰写设计文档并展示给用户审核。

> **本阶段是强制检查点。** 先展示设计审批包，收到确认并追加 decision 事件后，才能落盘 `status: approved` 的设计文档并进入阶段 6（任务拆分）。设计方向正确后再细化任务，避免基于错误理解拆分无效任务。

**用户确认后必须立即追加 decision 事件**，然后按路径分流落盘：

| 路径 | 审批内容去哪 | 设计文档 |
|------|------------|---------|
| **v2**（默认） | `meta/plan-evidence-input.json` 的 `approval.content` + `approver_id` | `plans/<change-name>-design.md`，由 finalize 从审批内容派生——**不要手写**，手写的会被派生渲染覆盖 |
| **legacy** | 直接写文档 | `.harness/changes/<change-name>/spec/<change-name>-design.md`（不存在则不得进入阶段 6） |

**设计文档路径规则**：禁止保存到 `docs/superpowers/specs/` 作为正式产物；`/harness-plan` 不运行时调用 Superpowers。同一 change 不得同时存在 `plans/` 与 `spec/` 两份设计——v2 发布的那份才受完整性门禁保护。

### 设计文档模板（legacy 路径手写时使用；v2 由 finalize 派生，此模板仅作内容清单参考）

```markdown
---
change-name: <change-name>
created: YYYY-MM-DD HH:mm
status: approved
source: harness-plan
---

# <功能名> 设计文档

> 日期：YYYY-MM-DD
> 状态：待审核
> 范围：<简述改动范围>

---

## 1. 背景与动机

<为什么做这个改动？现有代码有什么问题或缺失？这个改动解决什么痛点？>

<如果涉及差距分析，用表格对比现状与目标：>

| 维度 | 现状 | 目标 | 差距级别 |
|------|------|------|---------|
| ... | ... | ... | 🔴/🟡/🟠 |

---

## 2. 方案概述

<选定方案的核心思路，2-3句话概括>

---

## 3. 详细设计

<按改动涉及的维度分节展示，每节包含：>
- 具体做法
- 配置变更
- 关键设计决策及原因

---

## 4. 变更清单

| 类别 | 文件路径 | 说明 |
|------|---------|------|
| 新增 | `exact/path/to/file` | ... |
| 修改 | `exact/path/to/file` | ... |

---

## 5. 验证方式

<如何测试这些改动？列出关键验证步骤>
```

### 设计文档自审

写完设计文档后，用以下清单自检：
- □ 无"TBD"/"TODO"/未完成章节
- □ 各节之间无矛盾
- □ 范围聚焦，无不相关内容
- □ 无歧义需求（可被两种方式解读的，已选一种并明确说明）

## 阶段 6：任务拆分

将设计拆分为可追踪的任务，标注涉及文件和依赖关系。任务拆分执行 `protocols.md` 的 `implementation-planning-protocol`：plan 简表保持精炼，implementation-detail 按复杂度自适应展开。

### 产物结构

```
.harness/changes/<change-name>/plans/
├── <change-name>-design.md                  # 设计（v2 由 finalize 派生）
├── <change-name>-plan.md                    # harness 简洁任务表，run 默认读取
├── <change-name>-implementation-detail.md   # 原生自适应详细执行参考，run 补充读取
└── <change-name>-test-scenarios.md          # 测试场景表
```

> **v2 路径下这四份都是派生产物**：唯一手写的是 `meta/plan-evidence-input.json`。
> 阶段 6 的任务拆分结果直接填进它的 `structured_input.tasks`，阶段 7 的场景填 `structured_input.scenarios`——
> 同一份内容不要先写成 Markdown 再誊进 JSON，finalize 会用派生渲染覆盖手写的 Markdown。
> 下面的 Markdown 格式说明用于**理解字段语义**与 legacy 路径手写。

### 计划文件 frontmatter（必须）

```yaml
---
change-name: <change-name>
plan-name: <change-name>
created: YYYY-MM-DD HH:mm
source-spec: ../spec/<change-name>-design.md
implementation-detail: ./<change-name>-implementation-detail.md
test-scenarios: ./<change-name>-test-scenarios.md
status: approved
---
```

### 简洁任务表格式（`<change-name>-plan.md`）

```markdown
| # | 任务 | 涉及文件 | 依赖 |
|:--:|------|----------|:----:|
| 1 | 新建枚举类 | 2 个枚举 | - |
| 2 | 扩展错误码 | 错误码定义文件 | - |
| 3 | 编写数据库迁移脚本 | 1 个迁移脚本 | - |
| 4 | 新建数据模型 | 2 个数据模型 | 3 |
| ... | ... | ... | ... |
```

## 阶段 7：测试场景表 4 维度格式

场景表覆盖 **4 个维度**：

```markdown
## 测试场景 — <功能名>
> 生成日期：YYYY-MM-DD | 对应需求：xxx.md | 对应计划：xxx-plan.md

### 一、单元测试场景

#### 1.1 <类名.方法名>

| ID | 优先级 | 分类 | 场景描述 | 输入 | 预期 | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 | 可执行测试 ID | 测试文件 | 测试标题 |
|:--:|:------:|:----:|----------|------|------|----------|----------|----------|------|------------|----------------|----------|----------|
| UT-001 | P0 | 正常 | ... | ... | ... | affected | ≤10s | 1 worker / ≤512MB | 30s | inputsHash + command | service::happy-path | tests/service.test.ts | returns expected result |
| UT-002 | P0 | 异常 | ... | ... | 抛 xxxException | affected | ≤10s | 1 worker / ≤512MB | 30s | inputsHash + command | service::invalid-input | tests/service.test.ts | rejects invalid input |
| UT-003 | P1 | 边界 | ... | ... | ... | module | ≤60s | ≤50% CPU / ≤1GB | 120s | ledger identity | service::boundary | tests/service.test.ts | handles boundary |

### 二、接口测试场景

#### 2.1 POST /xxx

| ID | 优先级 | 分类 | 场景描述 | 关键字段 | HTTP | code | message | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 | 可执行测试 ID | 测试文件 | 测试标题 |
|:--:|:------:|:----:|----------|----------|:----:|:----:|--------|----------|----------|----------|------|------------|----------------|----------|----------|
| API-001 | P0 | 正常 | ... | ... | 200 | 0 | 成功 | module | ≤60s | 1 service / ≤1GB | 120s | environmentHash + ledger | api::success | tests/api.spec.ts | creates resource |
| API-002 | P1 | 校验 | ... | ... | 200 | xxx | ... | affected | ≤20s | 1 service / ≤1GB | 60s | environmentHash + ledger | api::validation | tests/api.spec.ts | rejects invalid body |

### 三、数据兼容场景

| ID | 优先级 | 分类 | 场景描述 | 操作 | 数据特征 | 预期 | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 | 可执行测试 ID | 测试文件 | 测试标题 |
|:--:|:------:|:----:|----------|:----:|----------|------|----------|----------|----------|------|------------|----------------|----------|----------|
| COM-001 | P1 | 旧数据 | ... | ... | ... | ... | module | ≤60s | isolated DB / ≤1GB | 120s | dbSchemaHash + ledger | db::legacy-row | tests/db-compat.spec.ts | reads legacy row |

### 四、集成场景

| ID | 优先级 | 分类 | 场景描述 | 前置条件 | 步骤 | 预期 | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 | 可执行测试 ID | 测试文件 | 测试标题 |
|:--:|:------:|:----:|----------|----------|------|------|----------|----------|----------|------|------------|----------------|----------|----------|
| INT-001 | P0 | 端到端 | ... | ... | N 步操作 | ... | candidate | ≤10m | ≤50% CPU / ≤2GB | 15m | verification identity | e2e::workflow | tests/workflow.e2e.ts | completes workflow |
```

新计划必须显式使用 `ID`、`优先级`、`可执行测试 ID`、`测试文件`、`测试标题` 列；每个 P0/P1 场景都必须填写稳定的三元测试身份，缺任一字段时 plan finalize 返回 `PLAN_SCENARIO_EXECUTABLE_MAPPING_MISSING`。`P0/P1` 都要求结构化 runner receipt + ledger 证据，`P2` 才是 advisory。解析器兼容旧的 `#`、`分类`、`场景描述` 表头，旧表缺优先级时保守按 `P1` 处理。执行层级固定为 `affected`（快速反馈）、`module`（变更模块门禁）、`candidate`（产品候选）。禁止所有场景默认跑全仓库；无法给出预算或超时时必须说明原因，并拆分或隔离高成本场景。只有 command、inputs/toolchain/environment 身份一致，且 declared/selected/collected/executed/passed 闭环完整的成功 ledger 证据可以复用。

## 产物保存规则（跨阶段：阶段0.5/4/6/8）

1. **自动确定变更名**：基于需求描述自动生成变更名（kebab-case），无需用户确认

   变更名命名规则：
   - **kebab-case**（小写字母，单词间连字符）
   - 从需求/功能描述中提取核心关键词
   - 示例：`contribution-module`、`fix-duplicate-submit`
   - 变更名一旦确定即为最终值，后续所有 skill 自动引用

   > **与 Worktree 的关系**：阶段 4 用户确认是否使用 worktree；变更名已在阶段 0.5 生成，后续 worktree 直接复用该名称。

2. **创建产出目录**：用 Write 工具创建以下目录结构（Write 会自动创建中间目录）：
   ```
   .harness/changes/<change-name>/meta/
   .harness/changes/<change-name>/logs/
   .harness/changes/<change-name>/spec/
   .harness/changes/<change-name>/plans/
   .harness/changes/<change-name>/evidence/
   .harness/changes/<change-name>/reports/
   .harness/changes/<change-name>/sqls/
   .harness/changes/<change-name>/scripts/
   .harness/changes/<change-name>/runtime/
   .harness/changes/<change-name>/backups/
   ```

3. **保存设计文档**：
   - **v2**：不手写文档；把审批内容填进 `meta/plan-evidence-input.json` 的 `approval.content`，
     `plans/<change-name>-design.md` 由 finalize 派生（frontmatter 也由渲染器写）
   - **legacy**：保存到 `.harness/changes/<change-name>/spec/<change-name>-design.md`

   legacy 设计文档 frontmatter 格式：
   ```yaml
   ---
   change-name: <change-name>
   created: YYYY-MM-DD HH:mm
   status: approved
   source: harness-plan
   ---
   ```

   > 如果 frontmatter 缺失，后续 run/test/review/submit/archive 不得依赖模型猜测 change-name。

4. **初始化结构化事件**：由阶段 0.5 的 `harness_context.py bootstrap-plan` 一次完成——它生成合规的 `<plan-run-id>`（`plan_<uuid>` 形状，必须小写字母开头：v2 identity 规则，裸 UUID 有 10/16 概率数字开头被拒）、`<attempt>`（首次为 `1`）并追加 `phase.start`，重跑复用同一身份不重复写事件。finalizer 必须复用引导返回的 `runId`/`attempt`，否则 verify 会按生命周期身份 fail-closed。同一次 plan 尝试内不得改变身份。执行日志在 `phase.end` 时由完整事件流渲染，任何阶段都不得直接用 Write/Edit 维护该投影。

5. **保存计划文件**：
   - **v2**：不手写；任务填 `structured_input.tasks`、场景填 `structured_input.scenarios`，
     `plans/` 下四份 Markdown 全部由 finalize 派生
   - **legacy**：手写并保存到（含 YAML frontmatter，含 change-name）
     - `.harness/changes/<change-name>/plans/<change-name>-plan.md`（简洁任务表）
     - `.harness/changes/<change-name>/plans/<change-name>-implementation-detail.md`（自适应详细执行参考）
     - `.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md`（测试场景表）

   legacy 计划文件 frontmatter 格式：
   ```yaml
   ---
   change-name: <change-name>
   plan-name: <change-name>
   created: YYYY-MM-DD HH:mm
   source-spec: ../spec/<change-name>-design.md
   implementation-detail: ./<change-name>-implementation-detail.md
   test-scenarios: ./<change-name>-test-scenarios.md
   status: approved
   ---
   ```

   > 如果 frontmatter 缺失，后续 run 不得依赖模型猜测 change-name 或关联文件路径。

6. **等待用户确认后**，提示下一步：运行 `/harness-run`

   > 后续 skill（run/test/review）启动时，会扫描 `.harness/changes/*/plans/`（排除 `.harness/archive/*/`）自动定位变更名目录，无需手动指定路径。同一时间最多一个未归档变更。

## 阶段 8：结束前产物完整性检查 ⚠️ 强制

> **缺任一文件 → ❌FAIL，不得宣称 plan 完成。先认清走的是 v2 还是 legacy——两条路径的必需文件集不同，拿 legacy 的表去查 v2 会得出假失败。**

| 文件 | v2 | legacy |
|------|:---:|:---:|
| `.harness/changes/<change>/meta/plan-evidence-input.json` | ✅ | — |
| `.harness/changes/<change>/plans/<change>-design.md` | ✅（派生） | — |
| `.harness/changes/<change>/spec/<change>-design.md` | — | ✅ |
| `.harness/changes/<change>/plans/<change>-plan.md` | ✅（派生） | ✅ |
| `.harness/changes/<change>/plans/<change>-implementation-detail.md` | ✅（派生） | ✅ |
| `.harness/changes/<change>/plans/<change>-test-scenarios.md` | ✅（派生） | ✅ |
| `.harness/changes/<change>/meta/gate-policy.json` | ✅ | ✅ |
| `.harness/changes/<change>/meta/worktree.json` | ✅ | ✅ |
| `.harness/changes/<change>/meta/implementation-checkpoints.json` | ✅ | ✅ |
| `.harness/changes/<change>/meta/scenario-manifest.json` | ✅ | ✅ |
| `.harness/changes/<change>/meta/publication-journals/<op>.json`（committed） | ✅ | — |
| `.harness/changes/<change>/meta/plan-events.ndjson` | ✅ | — |
| `.harness/changes/<change>/meta/plan-finalization.json` | — | ✅ |
| `.harness/changes/<change>/logs/execution-log.md` | — | ✅ |
| `.harness/changes/<change>/events.ndjson` | ✅ | ✅ |

legacy 的 `plan-finalization.json.files` 必须完整列出 design、plan、implementation-detail、test-scenarios、gate-policy、worktree 六项标准输入。`verify` 对缺项、重复项、越界路径以及 symlink/junction/reparse point 一律 fail-closed；不得通过删减收据文件集后重算哈希来绕过完整性检查。

### 阶段 8 v2 路径（结构化证据包流程，新 change 优先）

阶段 8 v2 标准三步流（证据包自举，阶段 14 起可用）：

```bash
# 1) 规划自然产出 → 证据包（结构化身份/哈希全由冻结模块推导）
npx hunter-harness plan evidence-pack --input .harness/changes/<cn>/meta/plan-evidence-input.json \
  --output .harness/changes/<cn>/meta/plan-evidence.json
# 2) 证据包 → 质量门 + 原子发布 + 事件 outbox
npx hunter-harness plan finalize --input .harness/changes/<cn>/meta/plan-evidence.json
```

**自然输入文件**（`meta/plan-evidence-input.json`，权威定义 `packages/cli/src/commands/plan-evidence-pack.ts` 的 `EvidencePackInputFile`）由规划阶段逐步沉淀，各字段定稿时点不得倒置。

> 📋 **先取骨架，别猜结构**：CLI 自带模板输出，不需要去找 TS 接口或翻 npx 缓存——
> ```bash
> npx hunter-harness plan evidence-pack --print-template > .harness/changes/<cn>/meta/plan-evidence-input.json
> ```
> **骨架一个字不改就能通过 `evidence-pack`**（回归测试冻结这条不变量），所以可以先跑一次确认链路通，再逐项替换。
> 注意这只保证结构合法：`finalize` 还要求 `change_key` 与 `run_id` 是本次真实身份，占位值过不了发布。
> 自由文本字段用 `<...>` 占位，替换完 grep 一次 `<` 自检有无遗漏。`--print-template` 不读写任何文件，只打到 stdout。

**带不了 `<>` 的占位字段**（受枚举/哈希/命名约束，grep `<` 查不出来，必须逐个确认）：

| 字段 | 模板占位值 | 换成什么 |
|------|-----------|---------|
| `change_key` | `replace-with-change-name` | 真实 change-name（kebab-case：`^[a-z0-9]+(-[a-z0-9]+)*$`） |
| `context.run_id` | `plan_replace-with-your-plan-run-id` | 阶段 0.5 生成、`phase.start` 已用的**同一个** plan-run-id |
| `evidence_sources[].content_hash` | `sha256:deadbeef…` | 证据源内容的真实 sha256（校验器显式拒绝全 0） |
| `risk_signals` | `["production_code"]` | classify 实际返回的信号 |

**容易踩的硬约束**（违反时命令会给 `field_path`，不必再猜）：

- `structured_input.scenarios` **至少 3 条**——八维度缺项由命令补 `not_applicable`，但场景总数不能少于 3
- `intent.acceptance_examples` 2~5 条，`approval.content.acceptance_examples` 3~7 条 → 取 3 条同时满足
- `key_alternatives` / `invariants` / `failure_behaviors` / `compatibility_boundaries` 各至少 1 条
- `intent.in_scope`/`out_of_scope` 与 `approval.content` 同名字段必须**集合相等**
- tasks 只写 `task_id/objective/affected_paths/owner_phase`，六个 refs 数组由命令接线；多写 `cluster`/`title` 这类键会因精确键集被拒
- scenarios 只写 `scenario_id/title/acceptance/coverage_dimension/execution_level/evidence_requirements/risk_level`（+可选 `verification_command`）；`priority`/`test_file` 这类计划表列不属于本输入
- `machine.worktree_policy` ∈ `project_default | required | forbidden`（没有 `none`）

> **结构错了怎么读报错**：命令在边界返回 `code:"PLAN_EVIDENCE_INPUT_INVALID"`（`stage:"boundary"`），
> `field_path` 指向第一处问题，`problems[]` 逐条给 `missing_keys`/`unexpected_keys`/`message`。
> 按 `problems` 改完重跑即可——**不需要**去反编译 `dist/bin.js` 或翻 npx 缓存找校验器。

| 字段 | 内容 | 定稿阶段 |
|------|------|:---:|
| `change_key` / `risk_signals` | change 标识 + classify 风险信号（与 `harness_gate.py classify` 一致） | 0.5/0.6 |
| `intent` | source_input/goal/user_visible_outcome/in_scope/out_of_scope/constraints/acceptance_examples(2~5 条) | 2 |
| `evidence_sources` | 代码图/文件证据源（source_kind/source_id/version/content_hash + refs 列表） | 3 |
| `approval.content` | 审批包内容（recommended_design/invariants/failure_behaviors/risks/acceptance_examples(≥3) 等） | 4 |
| `approval.approver_id` / `decided_at` | **阶段 4 真实 blocking confirmation 的确认者与时间，不得伪造** | 4 |
| `structured_input.tasks` | task_id/objective/affected_paths/depends_on/owner_phase（refs 由命令接线，不写） | 5 |
| `structured_input.scenarios` | scenario_id/title/acceptance/coverage_dimension/execution_level/risk_level（八维度全覆盖，缺维度由命令记 not_applicable） | 7 |
| `structured_input.approved_scopes` | 批准边界文本列表（scope_ref 由命令按文本哈希派生） | 4 |
| `machine` | capabilities/worktree_policy | 6 |
| `context` | project_id/run_id/branch_name/attempt（复用 plan-run-id 与 attempt） | 0.5 |
| `expected_baseline` | 首次发布 `{state:"absent", manifest_hash:null, generation:0}` | 8 |

> **场景契约与门禁的对接**（曾经的已知缺口，现已打通）
>
> v2 派生的 `meta/scenario-manifest.json` 是 artifact 包装体，键名与门禁消费的不同。消费端
> （`harness_gate` 的 C9、`harness_ledger` 的三处）统一调 `harness_plan_finalize.unpack_v2_scenario_manifest`
> 解成 legacy 形状再判定：`scenario_id→id`、`owner_phase→ownerPhase`、`required_evidence_kind→requiredEvidenceKind`
> 、可执行三元 `executable_test_id/test_file/test_title→executableTestId/testFile/testTitle`。
> `required_evidence_kind` 由 `priority` 派生（P0/P1→`ledger`，P2→`advisory`），写在 artifact 里，
> 消费侧不重推。
>
> 因此自然输入的 `scenarios` **必须**带 `priority`（P0/P1/P2）与 `owner_phase`。缺任一项，
> 门禁**逐场景**校验后报 `SCENARIO_MANIFEST_V2_UNSUPPORTED` 并列出 `missingFields`，绝不静默放行
> ——逐场景而不是取键的并集：并集只要有一条场景带了 `priority` 就算通过，其余缺字段的会静默
> 落进非必需集，"必需场景"随之缩水。
>
> 可执行三元是**可选**的，但要么整组给全、要么整组省略。ledger 场景全部带齐 → manifest 声明
> `schemaVersion 2`，关门可绑结构化执行收据；否则降为 1。

- **证据包**（`plan-evidence.json`）是命令推导的产物（trusted/publication/context/baseline），不得手改；任何字段变化必须改自然输入后重跑 evidence-pack。
- **成功语义**：finalize exit 0 且 `code:"PLAN_FINALIZED"`。落盘事实 = 八 target（plans/*.md ×4 + meta/*.json ×4）+ `meta/publication-journals/<op>.json`（状态 committed）+ `meta/plan-events.ndjson`（artifact_published/phase_ended）。确定性门失败 exit 1 且 `code:"PLAN_FINALIZE_DETERMINISTIC_FAILED"` 附 findings——此时必须回到对应阶段修正规划内容，**不得**手改证据包或 staged 内容绕过。
- **验证**：journal `state==="committed"` + 八 target 存在 + plan-events.ndjson 含两类终态事件；不得手工补写任何一项。
- **legacy 收据**：过渡期（阶段 14 前）v2 路径不写 `plan-finalization.json`；消费方若仍读 legacy receipt，由兼容投影单独提供，不得反向要求 v2 双写。
- **回退**：v2 自然输入不完整（如缺真实审批记录）时才允许走 Python finalizer（legacy 路径）；同一次发布不得两条路径混用。

### 发布后修订计划（republish）

计划发布后又要改产物，是**正常且高频**的情况——用户看完计划补一个回归场景、修正一条任务、调整验收标准。这时不要与哈希守卫搏斗：

```bash
python <skills-root>/scripts/harness_plan_finalize.py republish \
  --change-dir ".harness/changes/<cn>" --staging-dir ".harness/changes/<cn>/runtime/plan-staging" \
  --change <cn> --run-id "plan_$(uuidgen)" --reason "<为什么要改>" --json
```

它一次性完成整套动作：校验 staging → 分配新 attempt（自动取已用最大值 +1）→ 追加 `phase.start` → 替换收据 → 重新派生 `scenario-manifest.json` 与 `implementation-checkpoints.json` → 写 `phase.end`。收据里保留 `supersedes`（被取代的 hash/runId/attempt）与 `amendReason`，修订全程可审计。

| 约束 | 说明 |
|------|------|
| `--reason` 必填 | 修订已发布计划必须留下理由，否则 `PLAN_AMEND_REASON_REQUIRED` |
| `--run-id` 必须全新 | 复用旧 run-id 报 `PLAN_AMEND_RUN_ID_IN_USE`（attempt 与 run-id 一一绑定） |
| 首次发布不能用它 | 无收据时报 `PLAN_NOT_FINALIZED`，首次发布走 `finalize` |
| 内容没变则空操作 | 返回 `idempotent:true`，不写事件、不消耗 attempt |

⚠️ **绝对不要手改 `meta/scenario-manifest.json`**。它是 finalizer 从 `test-scenarios.md` 派生的产物，手改会造成真实漂移：`verify` 报 `ARTIFACT_HASH_DRIFT`，run 阶段 `validate_plan_handoff` 也会记 WARN。`republish` 会重新派生它，这才是唯一正确入口。

> 直接重跑 `finalize` 会报 `PLAN_FINALIZATION_HASH_CONFLICT`——这是守卫在防止发布后产物被悄悄改动，不是 bug。报错信息里已经给出 `republish` 命令行。

### Plan 结束行为规则

- **禁止询问执行模式**：Subagent-Driven / Inline Execution 属于 /harness-run 阶段
- 最终输出只提示产出物路径和下一步 `/harness-run`
- `docs/superpowers/` 不得作为最终产物路径出现在输出中

## C2 升级口：跨 provider 评审（显式、非默认）

阶段 7.5 默认只做主会话对抗自审或宿主原生隔离任务，不自动启动第二个 CLI/provider。高风险构建确需跨 provider 二次确认时，由用户显式要求并提供可用宿主能力；该升级不属于正常 harness-plan 路径，也不得因外部工具不可用而 retry。

### 安全线

- 外部评审必须只读，输入只包含已脱敏的设计/计划/场景表
- 不继承未确认的生产凭证、写权限或危险沙箱设置
- 一次失败即返回主会话，不自动安装 CLI、不自动登录、不循环 resume
- 报告必须标注 provider、执行模式和证据边界
