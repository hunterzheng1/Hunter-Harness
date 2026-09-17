# 12-M3 T0 前置冻结提案（接线前置决策）

> 状态：提案待 owner 签字（2026-08-08 起草本）。
> 依据 12-M3 的硬性前置：以下 5 项决策冻结前不得开始生产接线（"不得从旧 Python finalizer、已有 monitor read adapter 或 branch snapshot 猜测这些字段"）。
> 每项给出：现状证据 → 冻结提案 → 备选与风险。owner 批准后可按文末工作项直接施工。

---

## T0-1 root / identity authority（根与身份权威）

**问题**：FS 发布的 project root、target root、journal root 谁是权威？run/change 身份从哪来？

**现状证据**：
- durable-publication 的 intent 身份为 `plan_publication:<manifest_hash.slice(7)>`（module.ts:140），rollback 为 `rollback:<manifest_hash>`；journal 以 `(project_id, change_key, publication_intent_id)` 为身份键。
- legacy finalizer 以 `<change_dir>`（`.harness/changes/<change_key>/`）为写根，staging 目录随 run 隔离。
- 平台侧 `remote-sync` 已有 workspace root 模式（`remote-sync-workspaces`）。

**冻结提案**：
- **change 目录权威**：`.harness/changes/<change_key>/` 为唯一写根；八个 current target 全部落在其下（与现状一致）。
- **journal 落盘**：`meta/publication-journal.json`（intent/receipt 追加式，单文件有界滚动），位于同一 change 目录；project root 不持有独立 journal，避免双权威。
- **project_id 来源**：从 `.harness/project.json`（既有绑定文件）读取，禁止从 git remote/目录名猜测；缺失即 `PLAN_PROJECT_IDENTITY_UNAVAILABLE` fail closed。

**备选与风险**：journal 放项目级 `.harness/journals/` 可集中恢复，但引入跨 change 锁；拒绝——单 change 单 journal 与现有 staging 隔离一致。

## T0-2 八个 current target 与 legacy `plan-finalization.json` 的迁移策略

**问题**：v2 八 target 与 legacy 六文件/receipt 的目录差异与迁移路径。

**现状证据**：
- v2 八 target（plan-artifacts/publication/module.ts:228-235）：`plans/<ck>-design.md`、`plans/<ck>-plan.md`、`plans/<ck>-test-scenarios.md`、`plans/<ck>-implementation-detail.md`、`meta/gate-policy.json`、`meta/worktree.json`、`meta/implementation-checkpoints.json`、`meta/scenario-manifest.json`。
- legacy finalizer 输出：同八文件（design 在 staging 曾落 `spec/`，commit 后归 `plans/`）+ `meta/plan-finalization.json` + `meta/change-context.json`。
- 差异仅两点：staging 期 design 的临时目录名、以及 v2 不再写 `plan-finalization.json`（receipt 由 journal 持有）。

**冻结提案**：
- **目录零迁移**：v2 写根与 legacy commit 后布局完全一致（`plans/` + `meta/`），旧文件原样保留可读；不存在目录迁移工作。
- **`plan-finalization.json` 双写过渡**：第一个 v2 发布周期内继续由 finalization-transaction 投影写出 legacy receipt 文件（只读兼容投影，非权威），消费者全部迁往 journal 后删除（阶段 14 验收项）。
- **`change-context.json` 保持 legacy 生产**，v2 不接管，避免双写。

**备选与风险**：不双写 receipt 会破坏现有 checklist/平台对 `plan-finalization.json` 的读取——双写是唯一安全过渡，删除需消费者清单全部确认。

## T0-3 FS commit 与 `artifact_published`/`phase_ended` 的原子性

**问题**：八文件落盘与两个事件写入如何形成同一权威事务（含 outbox/reconcile）？

**现状证据**：
- durable-publication 已有 intent→commit→receipt 三段式与 generation fence（`expected_baseline`/`target_generation` 校验，module.ts:288-300）。
- legacy finalizer 已有 staging→原子 rename 的 commit 习惯（staging 目录整体 rename）。
- 平台 monitor read adapter 只读已验证的 PlanEventBundle（12-M2），不依赖写路径。

**冻结提案**：
- **顺序**：staging 全量渲染 → 原子 rename 到 change 目录 → journal 追加 committed receipt → **outbox 追加两个事件**（`artifact_published`、`phase_ended`，同 journal 文件内的 outbox 段）→ publisher 消费 outbox 写 RunStore 成功后标记 acked。
- **reconcile**：进程启动时扫描 journal：receipt committed 但 outbox 未 acked → 重放 publisher；rename 成功但 receipt 未写 → 以 FS 为准补写 receipt；rename 失败 → staging 清除，无半成品。
- **顺序不可交换**：事件永不先于 receipt acked 落 RunStore（monitor 读到的事件必须能反查到已提交 receipt）。

**备选与风险**：把事件直接写 RunStore（同事务）跨了 FS 与 DB 两个存储，无真正原子性，reconcile 更复杂；outbox 模式与平台既有 remote-content-upload 的 GC 证据链同构，选它。

## T0-4 `run_id` / `change_key` / `branch_name` / `attempt` 的拥有者

**问题**：事件与发布身份中四个标识各由谁签发？

**现状证据**：
- Plan 事件已有 `run_id/change_key/branch_name/attempt` 字段（12-M2 bundle 校验混合 run/change 即 fail closed）。
- legacy `harness_plan_finalize.py` 从 change-context 读 `change_key`，run_id/attempt 由 CLI run 状态机维护。

**冻结提案**：
- `change_key`：**change-context.json**（既有，harness-plan 第 1 阶段创建）为唯一拥有者。
- `run_id` / `attempt`：**CLI run 状态机**（现有）为唯一拥有者；finalizer 通过入参接收，禁止自行生成或从 journal 推断。
- `branch_name`：**change-context.json**（与 change_key 同源）；若与 git 当前分支不一致，以 change-context 为准并记录 warn（不阻断——分支切换是合法工作流）。

**备选与风险**：从 git 读 branch 看似权威，但 detached HEAD/worktree 场景歧义大；change-context 已在第 1 阶段写入，保持单源。

## T0-5 missing event / ambiguous FS / pending receipt 的公开恢复语义

**问题**：三类异常各自的公开（对 skill/平台可见）恢复行为。

**冻结提案**：
- **missing event**（journal 有 receipt、RunStore 无对应事件）：publisher reconcile 重放；平台 monitor 展示以 RunStore 为准，缺事件不视为发布失败（发布真相源是 journal receipt）。
- **ambiguous FS**（staging 与 commit 目录同时存在且 manifest 不同）：fail closed——拒绝自动选择，报 `PLAN_PUBLICATION_AMBIGUOUS_FS`，附两个 manifest hash，人工删除其一后重试。
- **pending receipt**（journal 有 intent 无 receipt 超过 lease）：不自动回滚；下次 finalize 以新 intent 覆盖（intent 幂等键为 manifest hash），并在 receipt 记录 `superseded_intent` 引用。平台不展示 intent，只展示 receipt。

**备选与风险**：pending 自动回滚会误杀"进程崩溃在 commit 后 receipt 前"的合法状态——reconcile 补 receipt 才是正确恢复（见 T0-3）。

---

## 冻结后可施工的工作项（按依赖序）

1. **FS publisher**：staging 渲染 → 原子 rename → journal 三段式（T0-1/2/3）。
2. **PlanEvent publisher**：outbox 消费 → RunStore 写入 + ack（T0-3/4）。
3. **PlanStageVerifierPort 生产实现**：files/expected hash 复核 + gate-policy 静态门（semantic/adversarial evaluator 调度按其模块现有 inline 路径接入，delegated 调度与 fallback 监控单列）。
4. **finalizer 切换**：`harness_plan_finalize.py` 六文件输入 → v2 八 target 兼容投影 + legacy receipt 双写（T0-2），Python 状态机入参传递 run_id/attempt（T0-4）。
5. **skill 指针化**：harness-plan SKILL/checklist/reference 从 prompt 内联改为消费已验证 receipt/产物身份（阶段 11 遗留项，同批收口）。
6. **阶段 14**：旧 Plan 目录验收、双写 receipt 删除、真实流程 e2e。

## 明确不做

- 不改 08-12 各纯 Module 的任何冻结语义（它们已经 adversarial review 关闭）。
- 不为赶工放宽任何 fail-closed 行为；语义检查不稳定时按 12 文档既定策略降级为建议项。
