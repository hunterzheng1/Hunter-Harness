# CBM Forge Phase 1B `/harness-plan` + `/harness-run` + `/harness-test` 流程复盘

> 日期：2026-07-20
> 执行范围：需求拆分、并行性判断、首个正式 Change 的完整 Plan、Run checkpoint、失败 Test、最小修复与完整复测
> 样本项目：CBM Forge
> 正式 Change：`phase1b-domain-contracts`
> Hunter-Harness 基线：`aaabce9`，CLI `0.2.19`，workflow `0.2.13`
> 结论：**REVISE（产品修复与动态复测成功；安装完整性、多 Change 并发、worktree test-guard、失败关门、场景追踪和端口租约合同仍需收口）**

## 1. 结论先行

本轮 `/harness-plan` 成功完成了两个目标：

1. 将 Phase 1B 拆为三个有明确依赖关系的正式 Change：
   `phase1b-domain-contracts` → `phase1b-bulk-reconcile-preview` → `phase1b-integration-acceptance`；
2. 仅为首个 Change 生成并原子发布完整 Plan，得到 6 份正式产物、48 条测试场景、唯一 `phase.end` 和稳定产物哈希。

随后 `/harness-run` 在 `.codex/worktrees/phase1b-domain-contracts` 完成 migration 004、ORM、Pydantic/JSON Schema、部署契约、测试和文档实现，并在用户确认后创建 checkpoint commit `10f81f2`。可执行的非数据库验证通过；真实 PostgreSQL migration/API/约束验证按安全边界留给 `/harness-test`，Run 以 `WARN` 关闭。

随后 `/harness-test` 在仓库锁定的 PostGIS/pgvector 环境中发现 004 migration 的真实 P0 缺陷：SQLAlchemy 把 SQL 字符串中的 `:superseded` 当成 bind parameter。用户批准最小修复后，第二轮 Run 将字面量拆为 `':' || 'superseded'`；第二轮 Test 得到 backend 195 passed、API 8/8、COM-C01～C16 全部通过，并完成真实 dump/restore 与权限/并发探针。产品结果已经闭环，仍以 WARN 记录慢批次、第三方 warning、忽略 fixture 与 Harness 运行时异常。

本轮也验证了上一轮复盘推动的几项改进确实有效：runtime doctor、Codex-aware worktree、Plan 原子 finalizer 和幂等 finalize 都一次工作正常。相比 2026-07-19 的 Plan，结束阶段已经不再依赖手工拼接完整性脚本才能关门。

但仍发现两项需要优先处理的问题：

1. **安装元数据与实际脚本内容不一致。** CBM Forge 的 context index 声明 Codex workflow bundle 为 `0.2.13`，但 21 个同名共享脚本中仍有 2 个与该版本 Hunter-Harness 主线内容不一致；其中旧 `harness_events.py` 仍允许缺少 `name` 的 verification 写入，而当前主线同版本脚本已经严格拒绝。
2. **“同一时间最多一个未归档 Change”与“并行 Change 必须显式传 `--change`”同时存在。** 用户直接询问能否并行时，Harness 没有给出一个机器可判定的受支持并发模式。本轮只能结合历史证据丢失事故，人工选择“正式 Change 串行、单个 Change 内部并行”。

因此，本轮产品规划结果可以保留，但不能仅凭 `registry_version=0.2.13` 判断安装已完整同步；在多 active Change 获得事务隔离和统一定位合同前，也不应把多个正式 Change 并行作为默认能力。

## 2. 证据边界

本复盘只记录本次实际执行、当前源码检查和现有历史事故可以支持的结论。

主要证据：

- CBM Forge Change：`E:\MyProject\CBM Forge\.harness\changes\phase1b-domain-contracts`
- 事件流：`events.ndjson`；Plan 只有 1 条 `phase.end`，Run/Test 各 attempt 均保留独立 run ID
- Plan finalization receipt：`meta/plan-finalization.json`
- 最终产物哈希：`sha256:545c0f4c23e716c09de4e60c62070f53514e61cd15b3db68b2596bf979efd0c0`
- 风险策略：`meta/gate-policy.json`
- 状态快照：`meta/state-snapshot.json`
- 知识指针：`meta/knowledge-context.json`
- 安装元数据：`E:\MyProject\CBM Forge\.harness\context-index.json`
- 安装脚本：`E:\MyProject\CBM Forge\.agents\skills\scripts`
- Hunter-Harness 当前源码与测试；不把发布缓存或版本字符串单独当作内容事实。
- Run checkpoint：`10f81f2`（分支 `codex/phase1b-domain-contracts`）
- 修复 checkpoint：`0eff88e`（仅本地 commit，未 push/merge）
- Run task status：`evidence/run-task-status.md`
- verification ledger：`evidence/verification-ledger.json`
- test tracking：`evidence/test-tracking.json`
- 首轮失败报告：`reports/test/test-report-20260720-1112.md`
- 修复复测报告：`reports/test/test-report-20260720-1219.md`
- 动态兼容证据：`runtime/api-test-results.json`、`runtime/db-compat-results.json`

与既有复盘的边界：

- [2026-07-18 Plan 到 Submit 复盘](./2026-07-18-cbm-forge-plan-to-submit-retrospective.md) 已详细记录并行 Change 的证据丢失事故；本文只讨论本轮 Plan 对该历史风险的处理是否清晰。
- [2026-07-19 受控部署持续复盘](./2026-07-19-cbm-forge-phase1-controlled-deployment-harness-retrospective.md) 已记录旧版 Plan 的 runtime、finalizer、worktree、风险分类和知识输出问题；本文区分“已验证修复”“仍然复现”和“新发现”。
- 本轮已执行两轮 Run/Test、创建两个 checkpoint commit，并完成一次固定 range Review；没有执行 harness-submit、Push、Merge 或 Archive，不推断这些阶段的新结果。

## 3. 本轮结果

| 项目 | 实际结果 | 判断 |
|---|---|---|
| 正式 Change 拆分 | 3 个，形成单向依赖链 | 边界清晰 |
| 正式 Change 并发 | 本轮不并行；只保持 1 个 active Change | 在当前合同下是安全选择 |
| Change 内部并发 | 第二个 Change 可按后端、地学、前端三簇并行，中心文件由协调者独占 | 可实施，但留到对应 Run 规划 |
| 首个 Change 产物 | design、plan、detail、scenarios、gate-policy、worktree 共 6 份 | 完整 |
| 测试场景 | 48 条：单元 16、接口 8、数据兼容 16、集成 8 | 覆盖充分 |
| worktree | `.codex/worktrees/phase1b-domain-contracts`，分支 `codex/phase1b-domain-contracts` | 适配正确 |
| finalizer | 首次成功；重复执行返回幂等，哈希不变 | 改进有效 |
| 事件终态 | 1 条成功 `phase.end` | 正常 |

### 3.1 Run 追加结果

| 项目 | 实际结果 | 判断 |
|---|---|---|
| TDD RED | 缺少 `app.schemas.phase1b`，测试收集明确失败 | 有效 RED |
| targeted backend | 69 passed，20 skipped | 通过；5 个破坏性 migration 场景显式等待隔离 DB 授权 |
| backend 非 DB 回归 | 149 passed，35 skipped | 通过 |
| backend full | 150 passed，35 skipped，37 个 PostgreSQL fixture setup errors | 环境 WARN；均为连接拒绝，无产品断言失败 |
| Geo | 17 passed | 通过 |
| frontend | 57 passed，production build 成功 | 通过 |
| Alembic | 001→004 离线事务 SQL 渲染成功 | 静态通过；未执行数据库迁移 |
| OpenAPI | 当前 22 paths 与冻结 1A 集合一致 | 未提前暴露 1B 路由 |
| checkpoint | `10f81f2` | 用户批准后提交；未 push/merge |
| Run gate | WARN | PostgreSQL/API/dbCompatibility 待 `/harness-test` |

### 3.2 Test、修复与复测追加结果

| 项目 | 实际结果 | 判断 |
|---|---|---|
| 首轮 Test | backend 188 passed / 4 failed，API 7 PASS / 1 BLOCKED | 真实发现 004 bind parameter P0 缺陷 |
| 最小修复 | `':superseded'` → `':' || 'superseded'` | SQL 结果不变，SQLAlchemy bind 集合变为空 |
| 修复后 backend | 195 passed / 32 skipped / 0 failed | 全量通过 |
| 修复后 API | API-C01～C08 8/8 | 003 readiness=503，004 readiness=200 |
| 数据兼容 | COM-C01～C16 全部通过 | 包含重复升级、回退、并发、权限和真实 dump/restore |
| Geo / frontend | 17 passed；57 passed + build | 通过 |
| 产品 diff | migration 单行字面量拆分 | 范围最小 |
| 修复 checkpoint | `0eff88e` | 用户确认后仅本地 commit；未 push/merge |
| Test 结论 | WARN，产品失败 0 | 慢批次、第三方 warning、fixture 与 Harness 状态问题不压成产品 FAIL |

## 4. 已验证有效的改进

### 4.1 Runtime doctor 已成为可靠入口

`harness_runtime.py doctor` 正确解析出：

- Python 3.11 的绝对可执行路径；
- Windows PowerShell 5.1；
- `jsonRoundTrip=true`、`utf8NoBom=true`、`argvArrays=true`；
- Codex 的 worktree root 与 `codex/` 分支前缀。

本轮没有再出现“裸 `python` 不在 PATH”或把 Codex worktree 写成 Claude 路径的问题。后续技能应继续复用 doctor 产出的绝对 argv，不再自行探测。

### 4.2 Plan finalizer 已解决原子关门问题

`harness_plan_finalize.py finalize` 本轮完成了：

1. staging 文件集合、frontmatter、JSON 和相对引用校验；
2. 正式产物的冲突保护与原子发布；
3. receipt 写入；
4. 唯一 `phase.end` 追加与 execution log 渲染；
5. 同一 staging、run ID、attempt 的幂等重放。

这正面关闭了上一轮“Plan 没有专用 finalizer、必须在 phase.end 前后手工检查两次”的问题。该能力应保留为 Plan 唯一成功出口。

### 4.3 首次状态快照不再误报“所有段都已变化”

当前实现首次捕获时返回：

```text
baselineCreated=true
changedSegments=[]
```

这比旧版把所有 segment 列为 changed 更准确。虽然 `unresolvedSegments` 的语义仍需优化，但“首次观察不等于发生变化”的核心修复已经生效。

## 5. 需要优化的问题

### 5.1 P0：bundle 版本与已安装脚本内容不能相互证明

**类型：确认的事实一致性问题；根因尚未完全定位。**

CBM Forge 的 `.harness/context-index.json` 声明：

```text
codex.registry_version = 0.2.13
```

但将 `.agents/skills/scripts/*.py` 与 Hunter-Harness `aaabce9` 的 `harness/scripts/*.py` 按文件名比较后：

```text
同名共享脚本：21
内容一致：19
内容不一致：2
不一致文件：harness_events.py、harness_archive.py
```

其中 `harness_events.py` 的行为差异已经实际影响本轮：第一次 verification 漏传 `--name`，安装脚本只打印：

```text
warning: verification missing --name or --status
```

随后仍把事件追加到 `events.ndjson`。Hunter-Harness 当前主线脚本已经声明 verification 必须同时包含 `name/status`，默认严格模式应以非零退出拒绝该事件。

这里有两个需要分开的事实：

- 漏传 `--name` 是执行者错误；
- 安装元数据显示最新、实际却仍执行旧的宽松合同，是 Harness 的安装可信度问题。

目前不能仅凭现有证据判断根因是缓存复用、局部文件保护、旧投影残留还是同步事务未闭合，因此不在本文臆测具体实现原因。

**影响：**

- `registry_version` 和 `bundle_hash` 不能证明每个已安装文件都属于该 bundle；
- 新旧脚本可在同一安装中混用，事件、归档等核心合同表现不一致；
- sync 即使报告元数据已更新，后续 skill 仍可能按旧逻辑运行；
- 版本驱动的故障判断、支持和回归复现失去可靠基础。

**建议：**

1. 发布 bundle 生成不可变的逐文件 manifest：相对路径、SHA-256、大小、mode、adapter transformation ID。
2. install/update/sync 在临时目录完成全部投影，逐文件校验通过后再原子切换；任何文件失败都不能先更新 context index 的版本和 bundle hash。
3. context index 增加 `installedContentHash`、`verifiedAt`、`verificationStatus` 和 mismatch 明细；版本相同但内容不一致必须返回 stale/degraded。
4. 对 `harness_events.py`、`harness_archive.py`、gate、ledger、finalizer 等信任根脚本设置强校验；不一致时阶段应 fail closed，而不是只提示可继续。
5. 若允许用户本地修改 adapter working copy，必须显式标记 `localOverride`，并把“受支持 bundle”与“本地漂移”分开显示，不能仍宣称纯 `0.2.13`。

**验收：**准备一个标记为 `0.2.13`、但只残留两份旧脚本的 fixture；sync 必须完整替换或明确失败，且失败时不得更新 context index。成功后逐文件 manifest、已安装内容和元数据三方一致。

### 5.2 P0：正式 Change 的并发能力没有唯一合同

**类型：设计合同冲突；历史 P0 风险仍约束当前决策。**

当前文档同时存在两种表述：

- `harness-plan/reference.md`：同一时间最多一个未归档变更；
- `harness-knowledge-query/SKILL.md`：并行 Change 查询必须传 `--change`，并使用 Change-scoped 指针。

后者说明部分子系统设计为支持多个 active Change，前者和后续自动定位逻辑又以单 active 为前提。结合 2026-07-18 已确认的并行 Change 证据丢失事故，用户询问“是否可以并行”时，agent 只能自己拼出安全边界。

本轮采用的决策是：

- 三个正式 Change 串行；
- 同一时间只保留一个 active Harness Change；
- 只在单个 Change 内按文件所有权拆簇并行。

这是合理的风险控制，但它应由 Harness 的机器合同明确给出，而不是依赖历史记忆和 agent 判断。

**建议：**

1. 在 effective config 中声明唯一并发模式：
   - `single-active`：默认安全模式，第二个 active Change 的 init/plan/run 直接阻断；
   - `isolated-multi-active`：只有 state、events、ledger、worktree、submit transaction 和 archive ownership 全部按 Change 隔离时才可启用。
2. multi-active 模式下，所有会解析 Change 的命令强制 `--change`；不得再扫描并猜测唯一目录。
3. preflight 输出 `concurrencyMode`、当前 active 列表、共享状态冲突和允许的并行层级。
4. 增加轻量 `portfolio/decompose` 模式：先生成 Change 依赖图和并行边界，用户确认后才初始化第一个正式 Change，避免为“讨论怎么拆”提前制造 active Change。

**验收：**两个 active Change 的 fixture 中，single-active 必须在第二个 Change 初始化前阻断；isolated-multi-active 必须证明事件、知识指针、ledger、提交事务和归档互不覆盖。

### 5.3 P1：custom agent 预检把目录约定当成宿主能力

**类型：确认的适配器能力误判。**

本轮 Codex 宿主实际提供 `harness-explorer` agent type，但：

```text
harness_preflight.py check-agents
→ usable=false
→ reasonCode=CUSTOM_AGENTS_UNSUPPORTED
```

当前 `_resolve_agents_root` 只要看到 skills root 位于 `.agents/skills` 或 `.cursor/skills`，就直接返回“不支持 custom agents”。这只能表达“没有 Claude 风格的本地 agent definition 目录”，不能证明当前宿主没有可调用的隔离 agent role。

技能要求收到该结果后不得 retry，本轮因此正确降级为主会话 CodeGraph 探索，但失去了原计划的上下文隔离。

Run 阶段再次提供了同类证据。`harness_preflight.py check-agents --agent harness-reviewer` 返回：

```text
runtimeSupported=true
definitionValid=false
usable=false
reasonCode=AGENT_DEFINITION_NOT_FOUND
```

与此同时，Codex 宿主实际暴露了 `harness-reviewer` role。也就是说，preflight 已能承认 runtime 支持，却仍把本地 `.agents/agents/harness-reviewer.md` 缺失当成最终不可用结论。Plan 的 explorer 与 Run 的 reviewer 两个阶段都因此降级，说明这不是单一 agent definition 的偶发缺漏，而是 host capability 与本地 definition 合同没有接通。

**建议：**

- 将 `definitionPresent`、`hostCallable`、`toolContractValid` 拆成三个独立字段；
- runtime doctor 接受宿主注入的 capability manifest，或由 adapter 在安装时声明可调用 agent roles；
- 本地 `.md` definition 只是某些宿主的实现方式，不应等同于 custom-agent 能力本身；
- `CUSTOM_AGENTS_UNSUPPORTED` 只在宿主明确声明不支持时返回，未知状态应为 `UNKNOWN`，而不是确定否定。

**验收：**Codex Desktop 提供 `harness-explorer` role、但没有 `.agents/agents/*.md` 时，preflight 返回 `hostCallable=true`；纯 CLI 且无 agent API 时才返回 unsupported。

### 5.4 P1：Plan 风险分类器已支持 capability，但流程没有把设计语义接进去

**类型：确认的流程接线缺口；上一轮问题仍存在。**

当前 `harness_gate.py` 已能从设计/计划 frontmatter 的 `capabilities` 读取 `api/container/database/deployment` 等标签，并据此扩展 required gate DAG。但本轮流程存在两个断点：

1. `harness-plan` 在 Change 初始化后、设计文档生成前立即执行 `classify --stage plan`；
2. `harness-plan` 的必需 frontmatter 模板没有 `capabilities` 字段，finalizer 也不要求设计与 gate policy 一致。

结果是：本轮设计明确包含 Alembic migration、数据库约束、ORM、Pydantic 与 JSON Schema，最终 `gate-policy.json` 仍然是：

```json
{
  "capabilities": [],
  "signals": [],
  "requiredValidationsByPhase": {
    "run": ["compile", "unitTest"],
    "test": ["unitTestFull", "apiTest"]
  }
}
```

至少 `database` capability 和 `dbCompatibility` 验证没有进入策略。是否还应标记 `api`，应由 Harness 明确定义“HTTP/OpenAPI 合同”与“Pydantic/JSON Schema 数据合同”的边界，而不是继续靠关键词猜测。

**建议：**

1. 设计审批包显式展示 capabilities，并将用户确认后的标签写入 design frontmatter 或独立 `plan-manifest.json`。
2. 初始 classify 只作为 provisional；approved design 落盘后必须 reclassify。
3. finalizer 重新计算或验证 gate policy，发现 capability/gate drift 时拒绝发布。
4. capability 词表增加清晰定义和互斥示例，尤其区分 API、数据 schema、数据库迁移、部署和制品。

**验收：**包含 Alembic migration 的 design 即使代码尚未修改，也必须产生 `database` capability 和 `dbCompatibility` 节点；删除 capability 或使用陈旧 gate policy 时 finalizer fail closed。

### 5.5 P1：临时 Change 重命名后，目录名与追踪身份发生分叉

**类型：确认的生命周期缺口。**

为了在知识查询前保留事件，本轮先初始化临时名称：

```text
phase1b-roadmap-decomposition
```

用户批准拆分后，正式名称改为：

```text
phase1b-domain-contracts
```

目录、计划文件名、frontmatter、gate policy 和 worktree 都已使用正式名称，但仍有旧身份残留：

- `meta/knowledge-context.json.changeId = phase1b-roadmap-decomposition`
- 所有事件的 `run_id = plan-20260720-phase1b-decomposition`
- `meta/plan-finalization.json.runId` 仍为旧分解语义

run ID 保留原始 attempt 并非天然错误，但当前没有稳定 Change UUID、rename event 或 alias 合同来解释这种差异；知识指针中的 `changeId` 与目录名直接冲突，则会影响后续归属判断。

**建议：**

- 优先使用 `portfolio/decompose` 模式，批准前不初始化正式 Change；
- 若必须重命名，提供原子 `harness_change.py rename`，在同一事务内更新目录、指针、worktree 决策和可变元数据；
- 事件不应被重写；增加稳定 `change_uuid`、`change.rename` 事件和 `renamedFrom` aliases，使旧 run ID 可审计但不会成为当前 Change 身份；
- finalizer 校验目录名、frontmatter、knowledge pointer、receipt 和 runtime capsule 的当前 Change 身份一致。

**验收：**重命名后所有“当前身份”字段解析为同一 Change；旧名称只出现在 rename event/alias 中，知识查询、Run 和 Archive 均能沿稳定 UUID 关联原始事件。

### 5.6 P1：首次快照的 `unresolvedSegments` 仍会诱导无效刷新

**类型：设计语义不清。**

首次 capture 已正确返回 `changedSegments=[]`，但同时返回：

```text
unresolvedSegments=[change, code, knowledge, map, profile, rules]
```

这些 segment 当时已经成功计算 fingerprint，并列出了实际文件。`unresolved` 在字面上容易被理解为“缺失、无法解析或必须刷新”，与技能的“只有变化或缺失才定向刷新”规则冲突。

本轮没有据此重跑全量 sync，而是直接读取当前 context index、知识包、CodeGraph 和源码。重命名后第二次 capture 才返回 `changedSegments=[change]`、`unresolvedSegments=[]`。这次额外 capture 既来自 rename，也意外消除了首次基线的歧义。

**建议：**

- 使用 `comparisonAvailable=false` 或 `baselineStatus=created` 表达“没有上一快照可比较”；
- 已成功读取并计算 fingerprint 的 segment 不应叫 unresolved；
- `unresolvedSegments` 只保留真实缺文件、读取失败、hash 失败等情况，并附 `unresolvedReasons`；
- 项目级 profile/rules/map/knowledge baseline 可跨 Change 复用，change/code 仍保持 Change-scoped。

**验收：**新 Change 在项目元数据齐全时首次 capture 返回 `baselineCreated=true`、`changedSegments=[]`、`unresolvedSegments=[]`、`comparisonAvailable=false`；只有真实缺失项进入 unresolved。

### 5.7 P2：知识查询默认输出仍偏大，状态混合降低决策密度

**类型：上一轮可用性问题再次复现。**

本轮查询成功生成了稳定 context pack，这是正向能力；但 10 条命中中只有：

```text
active=1, candidate=4, stale=2, superseded=3
```

完整 JSON stdout 仍携带较大的 `sourceFiles` 和历史条目详情。真正影响 Plan 的信息只是 context pack 路径、状态计数、少数当前决策与需要复核的冲突项。

**建议：**默认 stdout 返回 compact summary；完整 matches 原子写入文件。排序优先 active、当前路径重叠和高置信决策，stale/superseded 默认只给计数与明确引用，使用 `--verbose` 才展开。

### 5.8 P2：缺少不依赖 staging 的正式只读验证入口

**类型：工具易用性机会，同时包含执行者失误。**

finalizer 已成功，且幂等重放证明 receipt 与 staging 一致。为了额外核对事件数、唯一 phase.end 和 JSON，本轮又手工写了一段 PowerShell 校验；第一次使用默认 `Get-Content` 读取中文 NDJSON，出现乱码和 `ConvertFrom-Json` 错误。由于 PowerShell 非终止错误仍可让进程返回 0，脚本甚至打印了误导性的成功摘要。

这段错误命令不是 Harness 提供的，不能算作 finalizer 缺陷；但它说明阶段结束后的审计仍缺少一个支持的、非变更式入口。目前 finalizer 的幂等验证还要求原 staging 保留，而本轮 `runtime/plan-staging` 也确实继续存在。

**建议：**

- 增加 `harness_plan_finalize.py verify --change-dir ... --json`，只根据正式产物、receipt 和事件流验证，不要求 staging；
- 返回唯一 phase.end、产物 hash、frontmatter、gate-policy/identity 一致性和错误码；任何解析错误必须非零退出；
- 明确 staging 的保留/清理策略，verify 成功后可由专用命令安全清理，不让 agent 自己删除；
- Windows 回归覆盖中文 NDJSON、PowerShell 5.1 和非终止错误场景。

### 5.9 P2：审批协议硬编码宿主工具名

**类型：适配器可移植性问题。**

Plan 文档多处要求使用 `AskUserQuestion`，但本轮 Codex Default 模式没有该工具；最终使用普通阻断式用户确认，审批顺序和证据均正确。

协议真正需要的是“展示完整审批包并等待明确答复”，不是某个宿主的工具名。建议 canonical skill 使用宿主无关术语 `blocking user confirmation`，adapter 再映射到 AskUserQuestion、request_user_input 或普通对话。finalizer 只校验 approval receipt/decision 的顺序和内容，不校验交互工具品牌。

### 5.10 P0：test-guard 在主工作区与 worktree 之间产生最终门禁假阳性

**类型：确认的安全门禁缺陷。**

本轮 `harness_gate begin` 在 worktree 创建前运行，自动生成的 `test-guard-snapshot.json` 固定了：

```text
projectRoot = E:\MyProject\CBM Forge
baseline test files = 46
```

随后按 Plan 要求创建 `.codex/worktrees/phase1b-domain-contracts`。以真实执行 worktree 调用 test guard 时出现以下序列：

1. `begin --project <worktree>` → `SNAPSHOT_INVALID`；
2. 6 个新增/修改测试通过 `record` 成功写入 worktree-scoped manifest；
3. `close --project <worktree>` → `SNAPSHOT_INVALID`；
4. 最终 `harness_gate close --project <main>` 却返回：

```text
testGuard.ok = true
testGuard.code = CLOSED
files = []
recordedCount = 0
unchangedPreexisting = 46
```

也就是说，同一轮 Run 的显式 worktree close 已证明 snapshot 无效，最终 gate 又在主工作区把“看不到 worktree 改动”解释成“测试完全未变化”，并成功释放 lease。虽然本轮所有测试已由 manifest 记录并实际提交，但 gate 的最终结论是错误的；若 agent 没有额外核对，这会掩盖未登记、被删除或被篡改的测试。

**影响：**

- worktree 是 Plan 明确要求的隔离边界，test guard 却绑定到 main root；
- 最终 gate 可以在错误执行根上成功，形成 fail-open；
- `recordedCount=0` 与 manifest 中 6 个 touched tests 不一致却未触发错误；
- Run 的可信结束依赖 agent 额外发现矛盾，自动门禁本身不能证明测试完整性。

**建议：**

1. gate begin 在 worktree 决策为 requested 时，必须先创建/验证 worktree，再捕获 test snapshot。
2. phase runtime capsule 持久化 `executionRoot`、repository identity、base commit 和 worktree path；gate close 必须使用同一 execution root，禁止退回 main root。
3. snapshot 升级为可验证的 v2：以 repository identity + base tree + logical relative paths 表达，并提供“尚未编辑前 main→worktree”的专用 rehome；现有 manifest rehome 不能替代 snapshot rehome。
4. close 交叉校验 snapshot、manifest 和 git diff：manifest 有 current-change entries 而 `recordedCount=0` 时必须 fail closed。
5. 同一 run 中出现过 `SNAPSHOT_INVALID` 后，除非有显式、可审计的 repair receipt，最终 gate 不得返回 test guard success。

**验收：**Plan 要求 worktree、gate 从 main 发起的 fixture 中，最终 snapshot 必须绑定到 worktree；修改 6 个测试后 close 返回同样 6 个，任何 root mismatch 都阻断 phase close。

### 5.11 P1：harness-run 的 worktree 命令模板参数顺序不可执行

**类型：确认的文档/命令合同错误。**

Run reference 给出的创建模板等价于：

```text
git worktree add -- <path> -b <branch>
```

Git 将 `--` 后的 `-b` 视为位置参数，命令直接打印 usage 并失败。本轮实际可用命令是：

```text
git worktree add -b <branch> -- <path>
```

这不是环境差异，而是稳定可复现的 argv 顺序错误。worktree 是高风险 Change 的必经入口，模板错误会在代码尚未开始前制造一次无意义失败，也容易诱导 agent 自行改写命令并偏离审计模板。

**建议：**修正文档和所有 adapter 模板；不要以 shell 字符串保存，直接提供经过单元测试的 argv 数组：`["git","worktree","add","-b",branch,"--",path]`。

### 5.12 P1：linked worktree 无法解析主项目的 build profile

**类型：确认的配置作用域缺口。**

CBM Forge 的 `.harness/config/build-profile.json` 位于主项目且被 Git 忽略，因此新 linked worktree 中没有该文件。test guard 只从传入 `--project <worktree>` 下读取 profile，回退默认路径不包含 `backend/tests/**/*.py`，导致第一次登记合法测试时返回：

```text
TEST_PATH_NOT_ALLOWED
backend/tests/unit/test_phase1b_contracts.py
```

本轮只能在 worktree 中补一个未跟踪的最小 `.harness/config/build-profile.json` 才能继续 `record`。这说明 canonical state 已支持放在主项目的 Change 目录，build profile 却仍按物理 worktree 根孤立解析，作用域模型不一致。

**建议：**

- `harness_paths` 统一解析 repository common root 与 execution root；项目级 profile/rules 从 common root 读取，代码和测试从 execution root 读取；
- runtime doctor 将 resolved profile path/hash 写入 capsule，后续 guard/ledger 复用，不再各自猜路径；
- 若允许 worktree override，应显式分层 `project profile + worktree override`，并记录合并 hash，不能要求 agent 临时复制配置。

### 5.13 P1：数据库迁移任务没有明确的阶段所有权

**类型：Plan 与 Run/Test 阶段合同冲突。**

本 Change 的任务 6 明确要求执行 fresh、003→004、非法 legacy、downgrade guard、dump/restore 和数据库不变量测试；但 `harness-run` 又明确禁止自动执行 migration，动态数据库验证应留给 `/harness-test`。任务表没有 `ownerPhase` 或 `runBoundary`，导致 Run 无法机器判断：

- 是“任务 6 未完成，所以 Run 失败”；
- 还是“测试代码已实现，动态执行依法移交 Test，所以 Run 可 WARN 结束”。

本轮选择后者，并把 5 个破坏性 migration 场景做成必须同时提供 `PHASE1B_TEST_ADMIN_URL` 与 `PHASE1B_ALLOW_DATABASE_TESTS=1` 才运行的隔离测试。这个处理安全，但依赖 agent 解释，不是计划合同自动导出的结果。

**建议：**

1. Plan 任务增加 `ownerPhase`、`implementationDoneWhen`、`verificationPhase` 和 `requiresExplicitAuthority`。
2. migration 类任务拆为“生成/静态验证 migration（Run）”与“隔离数据库执行/恢复（Test）”。
3. Run gate 自动生成 Test handoff，列出环境变量、隔离要求、未运行场景和 WARN 原因；不把预期的 Test 阶段工作混成 Run 未完成。
4. final summary 区分 `code complete`、`verification pending` 与 `blocked`，避免把安全移交误写为实现失败。

### 5.14 P0：Test gate 无法以真实 FAIL 状态关门

**类型：确认的失败态生命周期缺陷。**

本轮 `/harness-test` 在仓库锁定的 PostGIS/pgvector 环境中真实复现 004 migration 产品缺陷，并如实将 ledger 写为：

```text
unitTestFull = FAIL（188 passed, 4 failed, 35 skipped）
apiTest = FAIL（报告维度为 PARTIAL：7 PASS, 1 BLOCKED）
dbCompatibility = FAIL
```

随后执行 `harness_gate.py close --phase test --status FAIL`，gate 仍以成功态规则校验 required validations，返回：

```text
MISSING_FIELDS
unitTestFull: status=OK
apiTest: status=OK
natural-language override is not permitted
```

这使 Harness 无法同时满足三个合理要求：保留真实失败账本、记录正式 `phase.end=FAIL`、释放 phase lease。若执行者为了关门把 ledger 改成 OK，会污染证据；若完全不处理，失败的 Test lease 会继续阻塞后续修复。本轮没有伪造结果，而是追加明确 issue/`phase.end=FAIL`，再使用受支持的 `harness_change.py release` 精确释放 lease，但这只是可审计的人工降级，不应成为标准流程。

**建议：**

1. `close --status FAIL` 校验“required validation 已记录、字段完整、输入身份有效”，但允许其状态为 `FAIL/NOT_RUN`；只有 `close --status OK` 才强制 required validations 全部 OK。
2. 将 phase outcome 与 promotion gate 分离：失败阶段可以正常结束并释放 lease，但不得推进到需要成功前置条件的 Review/Submit。
3. API 报告五态与 ledger 三态增加明确映射字段，例如 `status=fail, resultClass=PARTIAL`，避免 PARTIAL 被压平后丢失语义。
4. gate close 失败时提供原子 `abort/finalize-failure` 命令，负责写 `phase.end=FAIL`、保留失败证据并释放 lease，不要求 agent 手工拼接事件。

**验收：**ledger 中 `unitTestFull=FAIL`、`apiTest=FAIL/resultClass=PARTIAL` 时，`close --status FAIL` 成功写唯一 `phase.end=FAIL` 并释放 lease；同一账本执行 `close --status OK` 必须失败。

### 5.15 P1：场景表与可执行测试缺少机器可验证的绑定

**类型：确认的覆盖率可追溯性缺口。**

Plan 批准的场景表包含 16 个数据兼容场景和 8 个集成场景，并明确列出重复升级、dump/restore、并发 current、stale 传播、角色权限等要求。Run 的 ledger 曾把数据库测试描述为“5 destructive migration scenarios are implemented”，同时把 `dbCompatibility.coverage` 记为 `full`；但 Test 阶段逐条核对后发现：

- migration 文件只有少量聚合测试，COM-C05 重复 upgrade 与 COM-C08 dump/restore 没有独立可执行证据；
- constraint 文件只有 3 个真实数据库测试，无法分别证明 COM-C09～C16；
- gate policy 的 `capabilities=[]`，Test 只强制 `unitTestFull` 和 `apiTest`，即使数据库场景缺失也没有专属门禁节点；
- 场景 ID 没有写入 pytest marker、JUnit property 或 runner result，报告只能人工推断“某测试大概覆盖哪些场景”。

产品 004 缺陷会阻塞大量动态场景，但它不解释“场景从未绑定到测试实现”这一独立问题。当前 `coverage=full` 只表示命令范围，不证明计划场景完整覆盖。

**建议：**

1. Plan finalizer 输出机器可读 `scenario-manifest.json`，每个场景有 ID、优先级、owner phase、capability 和 required evidence kind。
2. Run/Test 要求测试通过 marker/parameter/JUnit property 显式回报 scenario ID；一个聚合测试可绑定多个 ID，但必须逐 ID 给出断言结果。
3. gate close 做集合校验：`requiredScenarioIds - executedOrExplicitlyBlockedIds` 必须为空；BLOCKED 还需结构化 blocker 与前置场景。
4. `coverage` 拆为 command coverage 与 scenario coverage，禁止仅凭执行 full pytest 就宣称 `dbCompatibility=full`。
5. migration/dump/concurrency/permission 等 capability 必须从 approved design 进入 gate DAG，而不是只靠通用 unit/API 节点。

**验收：**删除 COM-C08 的实现但仍运行全量 pytest 时，Test gate 返回 `SCENARIO_EVIDENCE_MISSING: COM-C08`；只有真实执行或按策略记录结构化 BLOCKED 才能结束为 WARN/FAIL，不能宣称完整覆盖。

修复后复测进一步证实了该缺口：即使 backend full 已经达到 `195 passed`、API 已经 `8/8`，现有测试仍不能逐 ID 证明 COM-C09～C16。为了不把“命令通过”误报成“场景通过”，本轮额外编写一次性 PostgreSQL runner，逐项执行 owner/value、双事务 current、零/双引用、跨项目、stale、lifecycle 与 app-role 权限断言；COM-C05 和 COM-C08 也必须分别追加 no-op 状态对比和容器内 dump/restore 哈希对比。最终证据完整，但靠的是 agent 人工补洞，不是 Harness 自动发现缺口。

### 5.16 P1：端口租约以 Change 聚合校验，多个 run/服务后无法释放

**类型：确认的资源生命周期缺陷。**

两轮 Test 为同一 Change 分别租用了 PostgreSQL 与 Redis 端口，registry 最终包含 4 条合法记录：上一轮 55432/55433、本轮 55434/55435；每个 Redis 租约按当前使用方式采用 `<run-id>-redis` owner。`release_port()` 的实现先按 `changeId` 收集全部租约，再执行：

```python
if any(str(item.get("runId")) != run_id for item in owned):
    return PORT_LEASE_OWNER_MISMATCH
```

因此，只要同一 Change 存在两个不同 run ID，传入任一真实 owner 都一定会被另一条租约否决；无法逐 run、逐 port 清理。本轮对当前 run、当前 `-redis` run 和 registry 报告的旧 run 都做了精确释放尝试，全部返回同一 mismatch。错误 payload 只展示 `owned[0]`，还会让执行者误以为传入的 run ID 与显示 holder 不同，掩盖“集合中另有不同 owner”的真实原因。

容器已按精确名称停止并 `--rm` 删除，旧 PID 不存在，55432～55435 均无监听；本轮遵守规则没有直接编辑 `.harness/state`/runtime registry，只能等待 4 小时 TTL 清理。这会造成后续 Test 不断向上占用新端口，范围有限时可演变为 `PORT_RANGE_EXHAUSTED`。

**建议：**

1. `release-port` 增加 `--port` 或按 `(changeId, runId)` 只删除匹配子集，不得因同 Change 的其他 owner 存在而整体失败。
2. 多服务同一 Test run 应支持同一 owner 多端口，或显式返回 lease ID 并按 lease ID 释放；不要要求用伪 run suffix 表达服务。
3. cleanup 提供 `release-all --change --run-id-prefix` 时必须返回将删除的精确 lease 列表，并校验 PID/TTL；不可静默清理其他活跃 run。
4. mismatch payload 返回全部 conflicting owners/ports，而不是只显示第一条。
5. phase finalize 可检查本 run 的未释放端口并原子清理；失败时进入 WARN/FAIL 证据而非遗留隐式状态。

**验收：**同一 Change 下 run A 租 55432/55433、run B 租 55434/55435；释放 run B 只删除 55434/55435，run A 保持；随后释放 run A 后 registry 为空。每一步都可幂等重放。

### 5.17 P2：部署后的 Skill 仍引用未随包提供的共享说明文件

**类型：确认的文档打包完整性问题。**

安装后的 `harness-run/SKILL.md` 明确要求阅读 `[[shared/worktree-gate.md|worktree-gate]]`，但 `.agents/skills` 中不存在该文件；`README.md` 同时说明这些 `@include shared/...` 应在部署前展开为自包含单文件。也就是说，当前安装既没有完成内联，也没有把共享源文件一并发布。执行者只能依赖 `reference.md` 中的零散 worktree 规则继续，无法确认缺失段落是否包含额外门禁。

**建议：**bundle build 对所有 include/wiki link 做闭包校验：要么构建时展开并移除运行时引用，要么发布目标文件；post-install verify 对悬空引用 fail closed，并把缺失路径列入逐文件 manifest mismatch。

**验收：**安装包中任一 SKILL 引用不存在的 `shared/*.md` 时 deploy/sync 非零退出；成功安装后对所有必读引用做路径闭包扫描为 0 缺失。

### 5.18 P1：隔离 reviewer 没有有界等待与可恢复降级合同

**类型：本轮 Review 确认的编排韧性缺口。**

`harness-review` 按要求启动宿主提供的隔离 `harness-reviewer`，并传入固定 base/head、正式设计、场景表和最新测试报告。主审已经完成 20 文件固定 range 读取后，隔离 reviewer 仍长时间处于 running；连续 10～30 秒 wait、两次要求“停止扩展并立即返回当前最佳结论”和显式 interrupt/followup 后仍没有返回部分结果，最终只能中止。Review 报告与 fixback 依靠主审证据完成，phase 如实以 WARN 关闭，没有把隔离审查伪装为成功。

当前 skill 规定“委派隔离 reviewer”，但没有声明最大 wall-clock、heartbeat、partial-result、cancel acknowledgment 或 fallback 条件。只要子 agent 卡在工具调用或上下文扩展，主流程就只能人工猜测何时中止；如果 phase lease 同时存在，还会放大为无法关门或长时间占用并发槽。

**建议：**

1. reviewer dispatch 返回 `reviewTaskId/deadline/heartbeatAt`，默认设置明确的 wall-clock budget；超过 deadline 自动发 cancel 并返回 `TIMED_OUT`。
2. reviewer 每完成一个维度就持久化结构化 partial findings；超时后主 agent 可消费已完成维度，而不是全有或全无。
3. skill 明确降级矩阵：`completed=OK`、`partial=WARN`、`no-result=WARN + local fixed-range review`、`local evidence unavailable=FAIL`。
4. gate close 记录 delegated reviewer 的 start/end/status/cancelReason，不应只依赖自然语言 note。
5. interrupt/followup 必须有 acknowledgment；被取消 agent 不得继续占用 active slot。

**验收：**模拟 reviewer 永不返回时，达到 deadline 后 5 秒内自动释放 agent slot，Review 仍可用固定 diff 本地完成并以 WARN 关门；events 中包含 timeout、cancel 和 fallback，且不会产生伪造的 reviewer conclusion。

### 5.19 P1：CodeGraph 索引未与 feature worktree execution identity 对齐

**类型：本轮 Review 确认的源码身份缺口。**

Review gate 返回的 execution root 是 `.codex/worktrees/phase1b-domain-contracts`，固定 head 为 `0eff88e`；但按 skill 强制优先调用 CodeGraph 时，工具明确提示索引来自主工作区 `E:\MyProject\CBM Forge`，feature worktree 新增/修改符号可能缺失。主审只能降级为 `git diff <base>..<head>` 与精确源码读取，并把原因写入 report/events。

当前问题不是“CodeGraph 不好用”，而是它的结果没有携带可被 gate 强校验的 repository/worktree/head identity。若工具不主动警告或 agent 忽略警告，review 可能基于旧 main 源码给 feature diff 出结论；这与本轮已经发现的 stateRoot/executionRoot 分离风险属于同一类身份问题。

**建议：**

1. `codegraph_explore` 响应强制返回 `repositoryId/indexRoot/indexedHead/indexedAt/dirtyState`；reviewer 把它与 gate capsule 的 execution root/head 比较。
2. 支持 linked worktree overlay：共享主索引，只对 `base..head` 新增/修改文件构建增量符号层；结果明确列出 overlay files。
3. identity 不一致时 fail closed 为 `CODEGRAPH_IDENTITY_MISMATCH`，自动切换到固定 diff 精确读取，并禁止把旧索引源码当作 verbatim evidence。
4. Review report 模板增加 `sourceIdentity`，区分 CodeGraph、git object、on-disk worktree 三种来源。

**验收：**主 worktree 在 A、feature worktree 在 B 且新增符号时，CodeGraph 要么返回 B+overlay 的正确源码，要么结构化拒绝并触发 fixed-range fallback；不得静默返回 A 的同名旧符号。

### 5.20 P0：legacy test manifest 在 checkpoint commit 后阻断标准 fixback

**类型：本轮 Review fixback 再次独立确认的跨 commit 生命周期缺陷。**

`phase1b-domain-contracts` 在 checkpoint commit 后进入 Review fixback。`harness_test_guard.py begin` 对 49 个测试返回 `SNAPSHOT_REUSED`，但修改已登记的 `backend/tests/unit/test_phase1b_contracts.py` 后执行 `record --reason test-updated`，立即返回无文件明细的 `MANIFEST_INVALID`。检查原生 manifest 可见：上一轮创建的测试仍记录 `trackedBefore=false`；checkpoint commit 后这些文件已自然变为 tracked。legacy validator 在允许目标文件刷新 hash 之前，先要求 manifest 中所有条目的 `trackedBefore == tracked_now`，因此标准的“commit → review → fixback → record”流程必然失效。

本轮遵守规则，没有直接修改 `.harness/state` 或覆盖证据文件，而是把失败写入 events，并继续保留真实 RED/GREEN 命令证据。这能避免污染审计链，但意味着后续 `test_guard close` 仍可能因为工具自身的旧 manifest 而失败。该现象与 2026-07-19 retrospective 中的同类问题一致；Phase1B 在另一个 Change、另一个 checkpoint 上复现，说明不是单次 staged 状态或人工顺序错误。

**建议：**

1. v1 manifest 在检测到 checkpoint 后自动原子迁移到 schema v2，`trackedBefore` 只保留为审计事实，不再作为后续 record 的合法性条件。
2. `begin` 创建 attempt identity；新 attempt 自动归档上一 attempt manifest，并从当前 snapshot 建立 `currentAttemptTouched` 空集合。
3. `record` 只允许目标文件 hash 漂移，同时把其他失效条目逐项返回为 `path/reason/repairCommand`，禁止只报笼统 `MANIFEST_INVALID`。
4. `close/stage` 只约束本 attempt 触达文件；已提交历史测试保留在 append-only audit，不再要求进入本次 cached diff。

**验收：** checkpoint commit 后修改已登记测试，`begin → record(test-updated) → close` 全部成功；manifest 保留“首次创建时未跟踪”和“当前已跟踪”两个事实，且不需要 agent 手工旋转或改写 state。

本轮 `/harness-test` 又把该问题推进到最终门禁：`record(test-updated)`、`record(stale-test-repair)`、直接 `close` 与 `harness_gate close --status WARN` 全部因同一 manifest 返回 `MANIFEST_INVALID`，而全量产品验证实际为 backend 203 passed、API 8/8、COM-C01～C20 全通过。`harness_ledger.py record` 能写入最新 inputsHash，但 `diff-hash` 仍以 `TEST_TRACKING_HASH_DRIFT` 失败、顶层 diffHash 为 null。说明此缺陷不仅阻断 Review fixback 的审计记录，还会让一个产品全绿的 Test phase 被迫 FAIL；没有受支持的同 worktree checkpoint 迁移命令可以恢复。

### 5.21 P1：gate 的 `--project` 同时承担 execution hint，参数名与事实根语义冲突

**类型：本轮 Test 确认的 CLI 身份可用性问题。**

`harness_gate.py begin` 内部始终通过 `resolve_main_project_root()` 找 canonical project/change，却把 `args.project` 赋给 `execution_hint`，再解析为 execution root。也就是说，CLI 名为 `--project` 的参数实际上要求传 feature worktree；传主项目会合法启动到 main execution root，并因 snapshot 的 projectRoot 是 worktree 而返回 `SNAPSHOT_INVALID`。本轮第一次正是如此，改传 worktree 后同一 gate 正常返回 `executionRoot=.codex/worktrees/phase1b-domain-contracts`。

该参数不是普通的“文档措辞不准”：主项目路径本身完全合法，命令不会在参数层拒绝，只有较晚的 test guard 才以不直观的 snapshot 错误暴露身份错配；state capture 同样可在 main 上成功生成 HEAD=base 的错误代码指纹。

**建议：** 把参数拆成显式 `--main-project` 与 `--execution-root`；通常只暴露 `--execution-root`，canonical root 从 repository common dir 自动解析。gate begin 在 claim lease 前对 worktree metadata、git common identity、execution HEAD 与 phase capsule 做一致性校验；发现 main/feature 选择错误时返回 `EXECUTION_ROOT_MISMATCH`，不要降级成 snapshot invalid。

**验收：** canonical change 在 main、代码在 feature worktree 时，传 main 作为 execution root 会在 claim/guard 前返回含 expected/actual 的专用错误；传 feature worktree 后 capsule、state capture、test guard 和 ledger 全部绑定同一 root/head。

### 5.22 P2：API batch 聚合耗时被伪装为单场景请求耗时

**类型：本轮 Test 确认的性能证据建模问题。**

Python API runner 先一次运行 22 个 TestClient 测试，再把该 pytest 批次耗时除以 4，分别写给 API-C01～C04。本轮批次总耗时约 158 秒，于是四个场景各得到 `durationMs=39588`；harness 规则据此把四个场景全部标为 `TIMEOUT_RISK`。这些值既不是单个 HTTP 请求，也不是各场景独立执行时间，无法用于定位慢接口，还会把批处理成本重复计算四次。

**建议：** 结果 schema 区分 `batchDurationMs`、`scenarioDurationMs` 与 `requestDurationMs`；聚合合同套件场景只记录 batch reference/coveredTests，不允许均摊生成伪请求耗时。超时规则分别针对 runner wall-clock 与真实请求耗时，报告明确标注是哪一层越界。

**验收：** 22 个测试耗时 160 秒但单请求均小于 2 秒时，只产生一个 batch-level slow warning；API-C01～C04 不出现四个伪造的 40 秒请求，也不重复计时。

### 5.23 P2：Test cleanup 缺少宿主策略可接受的受控删除入口

**类型：本轮 Test 确认的宿主集成摩擦，不直接归因于产品。**

本轮按安全规则先解析并验证 `backend/.pytest_data` 位于 feature worktree，再用 PowerShell `Remove-Item -LiteralPath <verified> -Recurse -Force` 清理 81 个 gitignored fixture 文件；宿主命令策略仍在创建进程前拒绝。容器可通过精确名称 `docker stop` + `docker rm` 清理，端口也确认无监听，但本地 fixture 只能保留并降级 WARN。

**建议：** harness-test 提供受控 cleanup helper：输入 execution root 与 profile 声明的 cleanup roots，内部执行 realpath containment、拒绝 symlink/reparse escape、列出精确计数后删除，并输出结构化 receipt。宿主只需允许该固定 helper，而不是放行任意递归删除命令。

**验收：** 对 profile 声明的 `.pytest_data` 可安全清理并返回 removed files/bytes；目标越出 execution root、命中 reparse escape 或未在 allowlist 时 fail closed，且不删除任何内容。

### 5.24 已修复：legacy test manifest 的 checkpoint 生命周期与历史暂存范围

5.20 的 P0 已在本轮直接修复并回灌 CBM Forge。TDD 回归构造 4 个最初未跟踪的测试，先 `record(tdd-created)`，再 checkpoint commit，随后只修改其中 3 个；旧实现稳定 RED 为 `MANIFEST_INVALID`。修复后同一用例证明：

1. v1 validator 只接受安全的 `trackedBefore=false → tracked_now=true` 转换，并同步归一化 ignored/tracked 当前状态；`true → false` 等反向漂移仍拒绝。
2. `close` 按 reason 批量 `record`，多份测试同时变化不再互相形成未授权 hash drift。
3. `stage` 只选择未跟踪条目或相对 `HEAD` 仍有差异的 tracked 条目；第 4 个已提交且未变化的历史测试保留在 manifest，但不进入 cached diff。
4. `harness-submit` 已把检查对象从“manifest 全路径”改为 guard 响应 `files`，避免工具修好后 skill 继续按旧合同误阻断。

定向验证为 `test_harness_test_guard + test_harness_doc_contract + test_harness_deploy` 共 63 tests 全通过。修复经 workflow bundle 生成和 CLI refresh 回灌后，CBM Forge 原 manifest 使用官方 `record` 原子恢复，无手改 state/evidence；`close` 返回 3 个 Phase 1B 测试、46 个既有测试未变，`diff-hash` 恢复为 `sha256:38c94b...e6100`，最终 test gate 在新 bundle identity 下以 `PHASE_CLOSED/OK` 关闭并释放 lease。

该修复解决的是当前 v1 change 的可恢复最小闭环，不等于完整 attempt 模型已经实现。manifest 仍是累积 ownership 集合，`begin` 的旧 snapshot 也仍可跨 phase 复用；后续仍应按 5.20 建议把 change ownership 与 attempt mutation snapshot 显式分层。

### 5.25 P1：低层 deploy install 与产品级 bundle identity 刷新不是同一事务

**类型：本轮修复部署时确认的工具分层陷阱。**

首次用 `harness_deploy.py build/install` 把修复后的 Codex adapter 复制到 CBM Forge，源、build output 与目标脚本 hash 完全一致；但 gate 随即返回 `BUNDLE_IDENTITY_INVALID: installed build marker hash drifted`。原因是低层 install 只替换 adapter 文件并生成自己的 backup，不更新 `.harness/state/local/installed-harness-bundle.json`、`.harness/context-index.json` 和 workflow bundle manifest。随后 CLI refresh 又把直接安装生成的 10 个 Codex `SKILL.md` 识别为 `LOCAL_MODIFICATION`，因为产品级 workflow projection 还包含 adapter adaptation，与裸 deploy output 并非同一字节层。

本轮恢复方式是运行 `npm run sync:harness` 生成四 adapter 的正式 workflow bundles/manifests，再通过 `hunter-harness refresh --force-managed` 只覆盖可信 managed targets 并原子更新 identity；最终 dry-run 为 342 unchanged、0 conflicts。直接 install 产生的差异全部来自本轮操作，不涉及用户自定义文件。

**建议：**

1. `harness_deploy.py install` 若目标项目存在产品级 installed bundle state，应默认拒绝并提示使用 `hunter-harness refresh`，或显式进入一个能同时更新 files、manifest、context-index 的事务。
2. build output 标注 projection stage（raw/adapted/workflow-packaged）；禁止把 raw Codex bundle 直接与 adapted installed bundle 混用。
3. gate 错误加入 expected/actual marker、manifest hash 与推荐修复命令，而不只返回“refresh required”。
4. `harness-sync` 提供“本地源码修复回灌”单命令：sync source → generate manifests → dry-run → trusted refresh → post-refresh dry-run，确保 finally 清理 runtime。

**验收：** 对已由 CLI 管理的项目执行低层 install 时，不会留下“脚本已更新但 identity 仍旧”的半状态；要么事务整体成功并立即通过 gate identity，要么目标与 state 均保持原样。

### 5.26 P1：worktree profile 投影不完整，且 `repository` scope 与复用协议词汇不一致

**类型：本轮 Submit 确认的最终门禁假失效。**

feature worktree 的 `.harness/config/build-profile.json` 只有 `testTracking`，canonical main profile 才有 `commands.unitTestFull` 与 `verificationInputs.unitTestFull`。因此 submit 在真实 execution root 调 `harness_profile resolve` 时返回 `command 'unitTestFull' not found in profile`；改用 main project 又会在错误源码根展开 inputs。临时把同一 profile 投影到 worktree 后，第二个问题继续出现：Test 记录把全量结果写为 `scope=repository`，但 ledger 的 broad scope 只接受 `module/module-am/full`，所以真实的 203 passed / 32 skipped 被判 `MISSING_FIELDS`。

本轮没有重跑测试，而是用正式 `record` 把 14:09 已真实执行的同一结果归一为 `scope=module + coverage=full`，并从 worktree profile 展开完整依赖闭包；随后 `can-reuse` 返回 `REUSED`。这不是放宽证据，而是修正两套 Harness 自己生成的元数据词汇冲突。

**建议：** profile 分成 common contract 与 execution-root expansion 两层；worktree link 必须投影全部 command/verificationInputs，或 resolver 从 git common root 读 profile、在 execution root 展开 glob。profile schema 与 ledger scope 共用同一 enum，禁止 profile 产出 ledger 不接受的 `repository`。

**验收：** main 保存 profile、feature 保存代码时，`resolve/can-reuse/record` 均在 feature 文件集上工作；profile 任一 scope 值都能通过 ledger schema，203-test 证据无需复制 profile 或重跑即可复用。

### 5.27 已修复（canonical source）：legacy ledger 在远端 push 后无法写入最终哈希

**类型：本轮 Submit 确认的 P0 发布后事务阻断。**

integration transaction 已把 `bdb303e` 推到 `origin/master`，journal 也记录 `REMOTE_CONFIRMED`，但 `_finalize_remote_push()` 无条件调用只接受 Ledger v3 identity 的 `record_integration_hashes()`。Phase1B 是受协议明确兼容的 legacy-colocated change，ledger 没有 `schemaVersion/repositoryId/baseCommit/currentHead/diffHash/ownershipHash`；因此 push step 变成 `LEDGER_SYNC_PENDING / LEDGER_IDENTITY_INVALID`，cleanup 被拒绝。远端已成功，重复 push 又必须幂等恢复，不能靠手改 ledger。

canonical source 已按 TDD 修复：`record_integration_hashes(change_dir=...)` 以 change contract 决定身份规则；v2/split change 继续强制完整 v3 identity，legacy change 只允许 changeName 对齐后原子追加三个一致的最终哈希。原“未提供 change_dir 的 legacy ledger 必须拒绝”测试保留，新回归先以 `unexpected keyword change_dir` RED，再转 GREEN；`IntegrationFinalHashTests` 3/3、cleanup 精确删除与“远端已推送后恢复 ledger sync”两个 transaction 回归均通过。用修复后的 canonical helper 重入原 journal 后，push attempt 2 只确认远端、不重复推送，ledger sync 与 cleanup 全部 DONE。

**剩余：** 当前 CBM adapter 在 transaction 期间没有热替换，以避免 bundle identity 漂移；canonical 修复仍需正常 bundle sync/发布后才成为所有项目的默认行为。

### 5.28 P1：远端探针失败被折叠成 `TARGET_MOVED ... found None`

**类型：本轮 Submit 确认的诊断与重试问题。**

第一次 merge attempt 中，helper 的 `git ls-remote origin master` 返回非零后被 `GitRunner.text()` 折叠为 `None`，随后报告 `TARGET_MOVED: expected 6457e72, found None`。同一时刻和下一次重试的原生命令都返回远端仍为 `6457e72`，第二次 merge 正常生成 `bdb303e`。也就是说，瞬时网络/进程失败与“远端分支不存在或真的移动”被混成同一业务错误，journal 没有 stderr/exitCode，执行者必须额外探测才能确认是否可安全重试。

**建议：** remote probe 返回 typed result（exitCode/stdoutHash/redactedStderr/category）；只有 exit=0 且 hash 与 expected 不同才是 `TARGET_MOVED`，网络/认证/进程失败应为 `REMOTE_PROBE_FAILED` 并允许有界重试。`None` 不得进入“found head”字段。

### 5.29 P1：默认 JSON 输出过大，长测试输出反复导致 Codex 会话崩溃

**类型：本轮 Submit 多次复现的宿主稳定性问题。**

`record/can-reuse` 会把约 150 个 `inputsFiles` 全量回显；integration 的每一步又重复输出完整 journal、全部 evidence identity 和历史 step。再叠加整文件 unittest verbose 输出，本轮 Codex 多次崩溃，用户只能反复要求从断点继续。事务 journal 使状态没有丢失，但默认输出策略仍把“可恢复”变成高频宿主重启。

**建议：** CLI 默认只输出 `code/transactionId/step/head/counts/journalPath`，详细 inputs/journal 写文件并用 `--verbose` 显式读取；`can-reuse` 默认返回 inputs count/hash，不回显全路径。长测试提供结果文件与 heartbeat，终端只输出最终计数。Codex adapter 应把单步输出预算作为能力约束，而不是依赖宿主截断。

### 5.30 P2：Windows worktree remove 的“注册已删、目录残留”不是原子结果

**类型：本轮 Submit 再次确认的 cleanup 状态表达缺口。**

`git worktree remove --force` 返回非零 `Directory not empty`，但 Git 注册已删除；直接按退出码重试会把“未注册残留目录”误当仍注册 worktree。本轮先重新检查 registration，再按 skill 已记录的精确目录 + 空目录 robocopy 镜像兜底，最终删除残留并删除 feature branch。说明文档已有正确人工流程，但 transaction/CLI 尚未把这个常见 Windows 半成功状态结构化。

**建议：** cleanup helper 在 Git 非零后重新检查 registration 与目标目录，返回 `REGISTRATION_REMOVED_RESIDUAL_PRESENT`，再走 allowlisted residual cleaner；receipt 分别记录 registration、disk path、branch 三个结果，重入时逐项 REUSED。

## 6. 不应归因给 Harness 的执行者错误

为了避免把所有摩擦都包装成产品缺陷，本轮以下问题明确记为 agent 执行失误：

1. **知识脚本路径判断错误。** `harness-knowledge-query/SKILL.md` 已明确说明 `<ingest-skill-dir>` 是同级 `harness-knowledge-ingest/`；CBM Forge 安装中也确实存在 `.agents/skills/harness-knowledge-ingest/scripts/harness_knowledge.py`。本轮误查 query 自身目录后转而使用 Hunter-Harness 源项目脚本，是不必要的绕路，不应报成 adapter 漏装。
2. **第一次 verification 漏传 `--name`。** 这是调用参数错误。Harness 的问题仅在于已安装旧脚本仍允许非法事件落盘，以及安装元数据未暴露这种漂移。
3. **手工 PowerShell 审计未先设置 UTF-8 和 `$ErrorActionPreference='Stop'`。** 这是自定义校验脚本错误；finalizer 本身没有失败。优化方向是减少这种临时脚本需求，而不是把该命令失败算作 Harness 阶段失败。
4. **两次动态探针的 DSN/dialect 首次配置错误。** 一次使用项目未安装的 `postgresql+psycopg`，一次把 SQLAlchemy URL 直接传给 `psycopg2.connect`；两者都在产品 SQL 前失败，按环境错误修正后单次重试通过，不应写成 Harness 或产品缺陷。
5. **本轮 Test 首次 state capture 与 gate begin 传入了主项目而非 feature worktree。** 这是执行参数错误，已立即纠正；Harness 的可优化点仅是 `--project` 的真实语义容易诱发该错误，以及命令未在 claim 前给出专用 identity mismatch。
6. **0.1 preflight 首次假定了错误的 uv 绝对路径。** 项目 runtime 元数据已有正确路径，本应直接读取；随后用 `Get-Command uv` 在允许的一次重试内通过。该首错不应计为 Harness 或产品失败。

## 7. 推荐改造顺序

| 优先级 | 改造 | 目标 |
|---|---|---|
| P0 | bundle 逐文件 manifest + 原子安装/同步 + post-install verify | 版本、hash 与实际执行内容一致 |
| P0 | 明确 single-active / isolated-multi-active 并发模式 | 不再靠 agent 猜测正式 Change 是否可并行 |
| P0 | gate/test-guard 统一 worktree execution root + snapshot/manifest/diff 交叉校验 | 消除最终门禁假阳性 |
| P0 | 失败态 gate close / finalize-failure | 真实保留 FAIL 账本并原子结束阶段、释放 lease |
| P1 | 宿主注入的 agent capability manifest | 正确使用 Codex 已提供的隔离 agent role |
| P1 | 修正并测试 worktree argv 模板 | 确保高风险 Change 隔离入口可执行 |
| P1 | project common root 与 worktree execution root 的 profile 分层 | test guard/ledger 无需复制忽略配置 |
| P1 | approved design capability → reclassify → finalizer 校验 | migration 等设计语义进入 gate DAG |
| P1 | Plan task phase ownership与 migration Test handoff | Run/Test 完成语义可机器判断 |
| P1 | scenario manifest + 测试 ID/JUnit/ledger 绑定 | 让批准场景与可执行证据逐条闭环 |
| P1 | 端口 lease ID / 按 run 子集释放 + phase cleanup | 多服务、多轮 Test 后端口可精确回收 |
| P1 | portfolio/decompose + 稳定 Change UUID/rename transaction | 消除临时名称与正式身份分叉 |
| P1 | 状态快照 comparison/unresolved 三态语义 | 避免新 Change 触发无效全量刷新 |
| P1 | gate CLI 显式拆分 canonical project 与 execution root | 避免合法 main 路径静默绑定到错误代码身份 |
| P1 | common profile 与 execution-root expansion 分层 + scope enum 统一 | submit 可在 worktree 正确复用完整门禁 |
| P1 | integration final hash 按 contract gate ledger identity | legacy push 后也能原子写 ledger 并安全 cleanup |
| P1 | remote probe typed error + 有界重试 | 网络失败不再伪装成 target moved |
| P1 | CLI compact output + 详细结果文件 | 降低 Codex 崩溃并保留可恢复证据 |
| P2 | compact knowledge output | 降低上下文与终端噪声 |
| P2 | Plan `verify` + staging lifecycle | 结束审计不再依赖临时 PowerShell |
| P2 | 宿主无关审批抽象 | 保持审批语义，减少 adapter 特判 |
| P2 | skill include/link 闭包校验 | 安装后的必读说明不存在悬空引用 |
| P2 | API batch/request 分层耗时 schema | 慢批次不伪装成多个慢 HTTP 请求 |
| P2 | allowlisted cleanup helper + receipt | 在宿主安全策略下可收尾 gitignored fixture |

## 8. 最小回归测试集

| ID | 场景 | 预期 |
|---|---|---|
| HR-P1B-PLAN-001 | context index 标记最新版本，但 2 个安装脚本仍为旧内容 | sync 不得成功更新元数据；报告精确 mismatch |
| HR-P1B-PLAN-002 | verification 缺少 `name` | 默认严格模式非零退出，事件文件不变化 |
| HR-P1B-PLAN-003 | single-active 模式已有一个 active Change | 第二个正式 Change 初始化被阻断，并给出 portfolio 建议 |
| HR-P1B-PLAN-004 | isolated-multi-active 下两个 Change 并行写事件/知识/ledger | 两者路径、锁、identity 和归档完全隔离 |
| HR-P1B-PLAN-005 | Codex host 提供 `harness-explorer`，无本地 agent definition 文件 | preflight 返回 hostCallable，不误报 unsupported |
| HR-P1B-PLAN-006 | approved design 含 Alembic migration capability | final policy 包含 database + dbCompatibility |
| HR-P1B-PLAN-007 | 临时 Change 在审批后重命名 | 当前身份一致，旧名称只保留在 rename audit/alias |
| HR-P1B-PLAN-008 | 项目元数据齐全，新 Change 首次 capture | changed/unresolved 均为空，comparisonAvailable=false |
| HR-P1B-PLAN-009 | 删除 staging 后执行 Plan verify | 仍能依据正式产物、receipt 和 events 成功验证 |
| HR-P1B-PLAN-010 | 中文 NDJSON 含非法 JSON 行 | verify 非零退出，不打印成功摘要 |
| HR-P1B-RUN-011 | gate begin 在 main 捕获 snapshot，随后创建 linked worktree 并修改 6 个测试 | snapshot 自动绑定/迁移到 worktree；close 返回 6 个 touched tests |
| HR-P1B-RUN-012 | worktree close 已返回 `SNAPSHOT_INVALID`，再从 main 调 gate close | phase close 必须失败，不得返回 `CLOSED/recordedCount=0` |
| HR-P1B-RUN-013 | 执行 worktree 创建模板 | argv 为 `git worktree add -b <branch> -- <path>` 且真实命令成功 |
| HR-P1B-RUN-014 | build profile 只存在于 Git common root，执行根为 linked worktree | test guard 正确允许 `backend/tests/**/*.py`，不要求复制 profile |
| HR-P1B-RUN-015 | Codex 提供 reviewer role，但无本地 `.agents/agents/*.md` | preflight 返回 hostCallable；definition 缺失不覆盖宿主能力 |
| HR-P1B-RUN-016 | Plan 含 migration 生成与隔离 DB 验证 | Run 只要求静态实现并生成 Test handoff；Test 承担动态 migration/restore |
| HR-P1B-TEST-017 | unitTestFull/apiTest 真实失败，调用 `close --status FAIL` | 写唯一 `phase.end=FAIL`、保留失败 ledger、释放 lease；不要求 status=OK |
| HR-P1B-TEST-018 | 同一失败 ledger 调用 `close --status OK` | 非零退出且不推进后续成功态 gate |
| HR-P1B-TEST-019 | 场景表要求 COM-C01～C16，但删除 COM-C08 实现后运行 full pytest | 返回 `SCENARIO_EVIDENCE_MISSING: COM-C08`，不得以 command coverage=full 代替场景覆盖 |
| HR-P1B-TEST-020 | 同一 Change 下两个 run、每个 run 各租 PostgreSQL/Redis 端口 | 可按 run 或 lease ID 精确释放自己的端口，其他 run 不受影响，最终 registry 可清空 |
| HR-P1B-INSTALL-021 | 发布后的 SKILL 引用缺失 `shared/worktree-gate.md` | deploy/sync 非零退出并报告悬空引用；成功 bundle 引用闭包完整 |
| HR-P1B-REVIEW-022 | 隔离 reviewer 卡住且不响应 stop/followup | deadline 后自动 cancel、释放 slot、保留 partial result；主审 fallback 以 WARN 可审计关门 |
| HR-P1B-REVIEW-023 | CodeGraph 索引 head/root 与 Review execution root/head 不同 | 返回结构化 identity mismatch；使用 feature overlay 或固定 range 精确读取，不得引用旧 main 源码 |
| HR-P1B-RUN-024 | checkpoint commit 后修改此前 `trackedBefore=false` 的已登记测试，另有一个已提交且未变化的历史测试 | `record/close` 安全归一化 checkpoint 状态并刷新全部目标 hash；`stage` 只返回当前有差异的文件，不因 tracked 状态或 clean 历史条目失败 |
| HR-P1B-TEST-025 | canonical change 在 main、代码在 linked worktree，gate `--project` 误传 main | claim 前返回 `EXECUTION_ROOT_MISMATCH` 与 expected/actual；不生成 main capsule/snapshot |
| HR-P1B-TEST-026 | API 合同 batch 22 tests/160s，单请求均小于 2s | 仅 batch-level slow；四个聚合场景不均摊出伪 `durationMs>30s` |
| HR-P1B-TEST-027 | worktree 内 allowlisted `.pytest_data` 含 81 个文件 | cleanup helper containment 校验后删除并产出 receipt；越界/reparse 目标拒绝且零删除 |
| HR-P1B-SUBMIT-028 | main 有完整 profile、feature 仅有 worktree link，unitTestFull 已在 feature 执行 | resolver 在 feature 展开 common profile；`can-reuse=REUSED`，不因缺 key/scope 词汇重跑 |
| HR-P1B-SUBMIT-029 | legacy ledger + 远端已确认 merge commit | 原子写入三个一致 final hash，push 重入不重复推送，cleanup 可继续；v2 ledger 仍强制完整 identity |
| HR-P1B-SUBMIT-030 | `ls-remote` 网络失败但远端 head 未移动 | 返回 `REMOTE_PROBE_FAILED` 与 redacted 诊断；不得返回 `TARGET_MOVED found None` |
| HR-P1B-SUBMIT-031 | profile 闭包包含 150 个文件，integration journal 含多步历史 | 默认输出保持有界并给详细文件路径；Codex 不因全量 JSON 回显崩溃 |
| HR-P1B-SUBMIT-032 | Windows worktree remove 已删注册但目录非空 | 返回可重入半成功状态，精确清理残留后删除 branch；不误判为仍注册 |

## 9. 最终判断

本轮 `/harness-plan` 的业务拆分和正式产物是成功的，`/harness-run` 也完成了可审计 checkpoint，尤其 runtime doctor、Codex worktree 决策与原子 finalizer 已证明上一轮改造方向有效。无需为了复盘再虚构更多问题。

当前最需要解决的不是继续增加 Plan 文档，而是让三个事实形成闭环：

1. **安装元数据等于实际执行内容；**
2. **设计 capability 等于最终 gate policy；**
3. **并发模式等于所有下游状态和提交工具真正支持的能力。**

在这三点闭合前，推荐继续采用本轮的安全边界：一次只推进一个正式 Change；需要并行时，只在单个 Change 内按清晰文件所有权拆簇，并由协调者独占共享热点。

Run 又增加了第四个必须闭合的事实：**最终 gate 使用的 execution root 必须等于真实代码与测试所在的 worktree。** 当前 test guard 可以先在 worktree 明确失败、再在 main 上以“零改动”成功关门，这是本轮优先级最高的新问题。

Test 阶段再增加两个必须闭合的事实：**失败是可正常结束、可审计的阶段结果，不应被成功态关门规则卡死；计划场景的“已覆盖”必须能追溯到逐 ID 的执行证据，不能由一次 full pytest 命令替代。**

修复后复测证明 Harness 可以承载“先真实失败、再最小修复、最后全量通过”的审计链，但也增加第五个资源事实：**端口租约的释放粒度必须与租用粒度一致。** 当前 registry 能记录同一 Change 的多个 run/服务，却只能按 Change 聚合后做全同 owner 校验，导致合法租约无法由任何 owner 释放。这个问题应在扩大 Test 并发或连续执行更多 Change 前修复。

本轮随后已关闭其中一个关键 P0：legacy v1 manifest 的 checkpoint 后 `record/close/stage` 生命周期已按 5.24 修复并在 CBM Forge 原 Change 上验证。尚未关闭的是更完整的 ownership/attempt 分层模型，以及本复盘列出的 execution-root、失败态关门、端口租约和部署事务等问题。

Submit 最终又补齐了第六个身份事实：**profile、ledger 与 integration finalization 必须共同按 change contract 和 execution root 决定语义。** 本轮业务提交与远端结果没有丢失，正是因为 journal、保护 ref、幂等 push 和精确 cleanup 能恢复；但 worktree profile 缺键、scope 词汇冲突以及 legacy ledger 被无条件要求 v3 identity，仍让一条产品全绿的标准 Submit 在三个元数据边界上中断。5.27 的 canonical 修复已关闭其中最危险的“远端已推送却无法收尾”路径，剩余 profile projection、typed remote probe 和 compact output 应在下一轮 bundle 发布前补齐。
