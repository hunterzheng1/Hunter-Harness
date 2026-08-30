# Review / Fixback 阶段问题报告

> 来源：sales-insight-agent 项目 `demo-skeleton` review + fixback 阶段实测
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.7
> 关联：[plan v2 证据包问题报告](./plan-v2-evidence-pack-issues-2026-08-30.md)

## TL;DR

review 阶段能走通，但两处硬伤：① execute 关门后没有自动写上下文交接，review 门禁报 `CONTEXT_HANDOFF_REQUIRED`，要手工补 `context close`；② 结构化评审记录（review-findings/fixback-dispositions）的 schema 只能靠两轮报错试错摸出来，没有像 `scenario-receipt-template` 那样的模板生成器。fixback 重选链路在主目录模式下直接不可用。

---

## 🔴 P0-1：execute 关门后上下文交接断链

**现象**

1. execute 阶段 `gate close` 成功（PHASE_CLOSED · OK）
2. review 阶段 `gate begin` → `CONTEXT_HANDOFF_REQUIRED`（expectedPhase=execute, requestedPhase=review）
3. 手工 `harness_context.py close --from-phase execute --to-phase review` 记录 transition
4. 再 `begin --phase review` → 仍失败；再跑一次 begin → 成功

**分析**：gate close 写 `phase.end` 但不更新 `runtime/current-context.json`（仍停在 execute + 旧 receiptHash），transitions.ndjson 也不会自动追加。阶段间交接依赖两次手工命令，且第二次 begin 才生效（第一次返回 expectedPhase 不匹配但不报错）。

**建议**

- `gate close` 成功时自动写 transition + 更新 current-context（或 close 输出明确提示「请运行 context close --from-phase X --to-phase Y」）
- `context begin` 在校验失败时给出 recoveryAction（如「缺少 from→to transition，请运行 …」）

## 🔴 P0-2：review 结构化 sidecar 没有模板生成器

**现象**

review 关门要求 `review-findings.json` + `fixback-dispositions.json` 两个 sidecar，schema 全靠报错试错：

- 第一轮：`REVIEW_OUTPUTS_INCOMPLETE`（只告诉你缺文件）
- 第二轮：缺 `runId`、`findings[].path`、`findings[].fixbackAction`、severity 必须 ∈ OK/RED/YELLOW、sidecar 必须匹配当前 runId
- 第三轮：`findings[].line` 必填且为 int、`fixbackAction` ∈ code/manual/workflow、disposition ∈ ACCEPTED_RISK/DEFERRED/FIXED/…

**对比**：ledger 的 `scenario-receipt-template` 有模板生成命令，体验好得多。

**建议**：新增 `harness_review.py scaffold --change-dir <dir> --run-id <rid>`，按当前评审轮次生成两份 sidecar 骨架（或 gate close 在缺文件时直接给生成命令）。

## 🔴 P0-3：fixback 重选链路在主目录模式不可用

**现象**

1. `/harness-execute --fixback` → `harness_fixback.py launch-review` 返回 `FIXBACK_RESELECT_UNAVAILABLE`（"当前没有可安全重选的评审后继分支"），recoveryAction 只有一句套话
2. 尝试手工回租：review→execute 的 `context close` 要求租约；`claim` review 阶段时撞上已持有的 execute 租约（LEASE_CONFLICT）；反向 claim 又让 close 报 CONTEXT_LEASE_REQUIRED——**双向死锁**

**结果**：只能内联完成修复（Y1 是一处 try/catch + 一条测试），fixback 的正式链路没有走通。

**建议**

- `launch-review` 在主目录模式（worktree.requested=false）应支持重选：review 已关门且有 OPEN disposition 时，允许 execute 重入
- 租约冲突时给明确的解锁命令，而不是让使用者在 claim/close 之间猜

## 🟡 P1：decision 事件的原因码规则与 skill 文档不一致

- SKILL.md 说"记一条 decision，用 REVIEW_DELEGATED 或相应原因码说明"
- 但 `harness_events.py append --type decision --note "REVIEW_DELEGATED：…"` 被校验器拒（`EVENT_REVIEW_REASON_IN_BODY`：原因码只能进结构化字段）
- **建议**：append 支持 `--reason-code` 参数，或 skill 文档改为只写中文说明

## 复现环境

- hunter-harness 0.4.7（npx），Node v24.14.0，Windows（Git Bash）
- change `demo-skeleton`（assurance 档，plannedPhases 含 review）
- review 委派：pi-subagents 只读评审 + 主会话核验
