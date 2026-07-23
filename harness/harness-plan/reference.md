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

**用户确认后必须立即写入** `.harness/changes/<change-name>/spec/<change-name>-design.md`。如果此文件不存在，harness-plan 不得进入阶段 6。

**设计文档路径规则**：设计文档必须保存到 `.harness/changes/<change-name>/spec/<change-name>-design.md`。禁止保存到 `docs/superpowers/specs/` 作为正式产物；`/harness-plan` 不运行时调用 Superpowers。

### 设计文档模板

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

推荐结构：

```
.harness/changes/<change-name>/plans/
├── <change-name>-plan.md                    # harness 简洁任务表，run 默认读取
├── <change-name>-implementation-detail.md   # 原生自适应详细执行参考，run 补充读取
└── <change-name>-test-scenarios.md          # 测试场景表
```

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

| # | 分类 | 场景描述 | 输入 | 预期 | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 |
|:--:|:----:|----------|------|------|----------|----------|----------|------|------------|
| UT-001 | 正常 | ... | ... | ... | affected | ≤10s | 1 worker / ≤512MB | 30s | inputsHash + command |
| UT-002 | 异常 | ... | ... | 抛 xxxException | affected | ≤10s | 1 worker / ≤512MB | 30s | inputsHash + command |
| UT-003 | 边界 | ... | ... | ... | module | ≤60s | ≤50% CPU / ≤1GB | 120s | ledger identity |

### 二、接口测试场景

#### 2.1 POST /xxx

| # | 分类 | 场景描述 | 关键字段 | HTTP | code | message | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 |
|:--:|:----:|----------|----------|:----:|:----:|--------|----------|----------|----------|------|------------|
| API-001 | 正常 | ... | ... | 200 | 0 | 成功 | module | ≤60s | 1 service / ≤1GB | 120s | environmentHash + ledger |
| API-002 | 校验 | ... | ... | 200 | xxx | ... | affected | ≤20s | 1 service / ≤1GB | 60s | environmentHash + ledger |

### 三、数据兼容场景

| # | 分类 | 场景描述 | 操作 | 数据特征 | 预期 | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 |
|:--:|:----:|----------|:----:|----------|------|----------|----------|----------|------|------------|
| COM-001 | 旧数据 | ... | ... | ... | ... | module | ≤60s | isolated DB / ≤1GB | 120s | dbSchemaHash + ledger |

### 四、集成场景

| # | 分类 | 场景描述 | 前置条件 | 步骤 | 预期 | 执行层级 | 预计时长 | 资源预算 | 超时 | 可复用证据 |
|:--:|:----:|----------|----------|------|------|----------|----------|----------|------|------------|
| INT-001 | 端到端 | ... | ... | N 步操作 | ... | candidate | ≤10m | ≤50% CPU / ≤2GB | 15m | verification identity |
```

执行层级固定为 `affected`（快速反馈）、`module`（变更模块门禁）、`candidate`（产品候选）。禁止所有场景默认跑全仓库；无法给出预算或超时时必须说明原因，并拆分或隔离高成本场景。只有 command、inputs/toolchain/environment 身份一致的成功 ledger 证据可以复用。

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

3. **保存设计文档**：将阶段 4 已确认的设计文档保存到：
   - `.harness/changes/<change-name>/spec/<change-name>-design.md`

   设计文档 frontmatter 格式：
   ```yaml
   ---
   change-name: <change-name>
   created: YYYY-MM-DD HH:mm
   status: approved
   source: harness-plan
   ---
   ```

   > 如果 frontmatter 缺失，后续 run/test/review/submit/archive 不得依赖模型猜测 change-name。

4. **初始化结构化事件**：确定 change-name 后，立即运行 `harness_events.py append --type phase.start`。脚本负责建立父目录和 `events.ndjson`；执行日志在 `phase.end` 时由完整事件流渲染，任何阶段都不得直接用 Write/Edit 维护该投影。

5. **保存计划文件**：计划文件包含 YAML frontmatter（含 change-name），保存到：
   - `.harness/changes/<change-name>/plans/<change-name>-plan.md`（简洁任务表）
   - `.harness/changes/<change-name>/plans/<change-name>-implementation-detail.md`（自适应详细执行参考）
   - `.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md`（测试场景表）

   计划文件 frontmatter 格式：
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

> **缺任一文件 → ❌FAIL，不得宣称 plan 完成。**

| 文件 | 必须存在 |
|------|:---:|
| `.harness/changes/<change>/spec/<change>-design.md` | ✅ |
| `.harness/changes/<change>/plans/<change>-plan.md` | ✅ |
| `.harness/changes/<change>/plans/<change>-implementation-detail.md` | ✅ |
| `.harness/changes/<change>/plans/<change>-test-scenarios.md` | ✅ |
| `.harness/changes/<change>/meta/worktree.json` | ✅ |
| `.harness/changes/<change>/logs/execution-log.md` | ✅ |
| `.harness/changes/<change>/events.ndjson` | ✅ |

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
