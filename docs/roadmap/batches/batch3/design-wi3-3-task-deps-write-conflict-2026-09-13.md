# WI-3.3 设计：任务依赖与并行写入冲突检测

> 日期：2026-09-13
>
> 状态：**已实施（2026-09-14）**。裁决 2026-09-13 用户确认 §0 四项建议值
> 全部采纳；红测 19 例先行 → 实现 → `test_harness_task` 59/59、
> doc-contract 8/8、全量回归绿。本文是
> `design-evidence-driven-delivery-2026-09-09.md` §2 WI-3
> 子项 3 的展开，对应任务书 `review-remediation-execution-2026-09-12.md` §9.1
> （O2 编排与冲突，批次 D 前半）。
>
> 代码勘察基线：`remediation/2026-09-12-review` 分支 `c4a08bc`（R4/R5 提交后）。

## 0. 待裁决项（实施前需用户定稿）

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | 冲突处置语义：begin 拒绝（fail-fast）vs 串行等待队列 | **begin 拒绝 + 精准报错** | harness 无常驻调度器，等待队列需要轮询/唤醒基础设施（超本项体量）；「被阻止」已满足任务书「相交范围被阻止或串行」的析取项；串行由用户 finish 后重试达成，隔离工作区（git worktree 天然不同目录）不受检测影响 |
| 2 | 声明粒度：change 级 vs change 内多 task 级 | **change 级** | 现状 per-change 单 open task（task.json 单例，`harness_task.py:63`），task 级声明无可附着载体；dependsOn 引用 changeId 即等价引用其 open task；未来若支持 change 内多工作项，schema 可加 `items[]` 扩展而不破坏 v2 |
| 3 | writeScope 与 ownership.productPaths 的关系 | **writeScope=begin 意图声明（调度用）；productPaths=finish 实际推导（记账用）；声明了 writeScope 的任务 finish 时实际 diff 越界即拒绝** | 两者时点与用途不同：冲突检测必须在调度前，记账必须按实际；未声明 writeScope 的任务保持现状（finish 吸纳外来路径），零回归 |
| 4 | 未声明 writeScope 的 open 任务参与冲突检测吗 | **不参与（双方均声明才检测），但新 begin 若声明 scope 而既有 open 任务无声明，结果里带 `unscopedOpenChanges` 提示** | 保守回退会阻塞一切存量工作流（所有既有任务都无 scope）；提示字段保留可见性，不制造隐性通过 |
| 5 | 依赖失败传播：依赖目标 abandoned 时下游可否带确认强行 begin | **不可强行，只能先重开/替换依赖** | 任务书要求「依赖阻塞与失败传播」明确定义；开口子（--force）会腐蚀依赖语义，需要时走「abandon 下游并重新 begin 到新依赖」的显式路径 |
| 6 | WI-3.4（增量评审）是否并入本批 | **不并入，单独设计与实施** | 两 WI 修改面独立（task vs review/fixback），任务书允许「修改边界独立时并行」，但串行更利于各自回归与归因 |

## 1. 现状事实（勘察基线 `c4a08bc`）

### 1.1 任务载体：per-change 单例，跨 change 无协调

- 任务声明：`meta/task.json`（`harness_task.py:63`），schemaVersion=1，字段
  goal/acceptance/executor/status/dirtyBaseline；**无 scope/依赖字段**。
- per-change 唯一 open task：`find_open_task_start` 只认最近一个未关闭 start
  （`harness_task.py:312-331`）；终态拒绝重复 begin（`:389-400`）。
- **跨 change 无任何协调**：begin/status 只解析 `--change` 指定目录，无
  `.harness/changes/*` 扫描；多个 change 可同时 open，机制上不阻止、无上限。
- 已有锁均不适用：runtime 资源锁按调用方声明锁名（`harness_runtime.py:1178-1256`），
  service `ServiceMutationLock` per-change（`harness_service.py:168-248`）。

### 1.2 范围概念：只有 finish 事后推导，无调度前声明

- `ownership.productPaths` 由 finish 从实际 diff 推导并写入 change-context.json
  （`harness_task.py:1701-1729` → `harness_change.py:1165-1230`）；
  外来路径被**吸纳**进 ownership，不拒绝。
- begin 只记 `dirtyBaseline`（`harness_task.py:455-461`）供 finish 外来脏污检测
  （`detect_foreign_dirt`，`:269-284`）——检测的是「别人弄脏我的工作区」，
  不是「我越过声明边界」。

### 1.3 归档/门禁消费面

- `compute_ownership_diff`（`harness_ledger.py:1634`）按 ownership 把 diff 分
  owned/foreign，门禁与归档消费；本项不改该语义。

## 2. 目标与非目标

**目标**：

1. begin 可声明 `writeScope`（写入范围路径列表）与 `dependsOn`（依赖 changeId
   列表），落入 task.json schemaVersion=2。
2. begin 前检测：与同工作区其他 open 任务的 writeScope 相交（相同文件、
   父子路径）→ 拒绝；dependsOn 目标缺失/未完成/成环 → 拒绝。
3. finish 时声明了 writeScope 的任务实际 diff 越界 → 拒绝提交并指明越界路径。
4. 以上全部有红测先行。

**非目标**：

- 串行等待队列/自动唤醒、跨 worktree 检测、DAG 可视化。
- 增量评审输入构建（WI-3.4）、共享配置/接口信号的「冲突扩大」（属评审范围
  扩大语义，WI-3.4 复用 risk-signals）。
- 合并结果验证（任务书 9.1 末条）：harness 不执行合并，由归档 before/after
  清单与门禁兜底，本项不新增机制。

## 3. 设计

### 3.1 task.json schemaVersion=2（向后兼容）

新增可选字段：

```json
{
  "schemaVersion": 2,
  "writeScope": ["packages/core/src", "docs/api.md"],
  "dependsOn": ["change-a", "change-b"]
}
```

- v1（无字段）读取不受影响；v1 任务补声明需 abandon 后重新 begin（声明是
  begin 时事实，不允许运行中改范围——改范围=新协调）。
- begin CLI：`--write-scope <path>`（可重复）、`--depends-on <changeId>`（可重复）。
- 路径规范化为 POSIX 相对路径，去尾斜杠；空串/绝对路径/越出仓库
  （`..`）→ `TASK_SCOPE_INVALID`。

### 3.2 冲突检测（begin 主链，写入前）

`detect_scope_conflicts(change_dir, write_scope)`：

1. 扫描 `.harness/changes/*/meta/task.json`，取 status=="open" 且非自身的任务。
2. 双方均有非空 writeScope 才比对；路径相交规则：
   - 相同：`a == b`
   - 父子：`a` 是 `b` 的前缀目录（`b == a + "/" + ...`），双向判定
   - 文件 vs 目录统一按前缀规则处理（`docs/api.md` 与 `docs/` 相交）
3. 相交 → `TASK_SCOPE_CONFLICT`，错误详情列出冲突方 changeId 与相交路径对；
   对方任务 executor/createdAt 一并返回便于协调。
4. 既有 open 任务无 writeScope → 不阻塞，记入 `unscopedOpenChanges` 提示字段。

### 3.3 依赖校验（begin 主链，冲突检测后）

`validate_task_dependencies(project_root, depends_on, self_change)`：

- 目标 change 目录或 task.json 不存在 → `TASK_DEPENDENCY_MISSING`。
- 目标 task.status != "completed" → `TASK_DEPENDENCY_UNMET`（带目标状态；
  abandoned 同样阻塞，裁决项 5）。
- 环检测：沿依赖图 DFS（各目标任务继续读其 dependsOn），回到自身 →
  `TASK_DEPENDENCY_CYCLE`，报环路径。

### 3.4 越界停止（finish 主链）

- 任务声明了非空 writeScope：finish 计算实际产品 diff 后，
  `dirty ∩ ¬scope` 非空 → `TASK_SCOPE_VIOLATION`，列出越界路径，提示
  「还原越界改动，或 abandon 后以更大范围重新 begin」。**不吸纳、不提交**。
- 未声明 writeScope：维持现状吸纳逻辑，零行为变化。

### 3.5 重启安全

begin 幂等（已有 open 复用原文档）天然满足「重启后不重复分派」：重复 begin
不新建任务、不重复冲突检测副作用（检测是只读的）。

## 4. 红测清单（对应任务书 9.1 必测）

| 必测项 | 测试 |
|---|---|
| 独立任务可并行 | 两 change 声明不相交 scope，先后 begin 均成功 |
| 相交范围被阻止 | 相同文件 / 父子路径（双向）→ TASK_SCOPE_CONFLICT |
| 依赖阻塞 | 依赖目标 open → UNMET；completed 后放行 |
| 依赖缺失 | dependsOn 指向不存在 change → MISSING |
| 依赖成环 | A→B→A → CYCLE，报环路径 |
| 失败传播 | 依赖目标 abandoned → UNMET（裁决项 5） |
| 越界停止 | 声明 scope 后 diff 越界 → finish 拒绝且未提交 |
| 未声明兼容 | 无 scope 任务 begin/finish 行为与现状一致 |
| 无声明不阻塞 | 新声明任务 vs 存量无声明 open 任务：放行+提示字段 |
| 重启不重复分派 | begin 幂等复用，重复 begin 不产生第二任务 |

## 5. 实施步骤

1. 红测：`tests/test_harness_task.py` 新增 `ScopeConflictTests`、
   `TaskDependencyTests`、`ScopeViolationFinishTests`（复用 HarnessTaskFixture）。
2. 实现：harness_task.py —— schema v2 读写、CLI 参数、3.2/3.3/3.4 三处主链钩子。
3. 回归：`tests.test_harness_task` 全量 + 交叉（change/archive/gate 冒烟）。
4. 提交后接 WI-3.4 设计。
