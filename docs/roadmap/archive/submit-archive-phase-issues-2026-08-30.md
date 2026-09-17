# Submit / Archive 阶段问题报告

> 来源：sales-insight-agent 项目 `demo-skeleton` submit + archive 阶段实测
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.7
> 关联：[plan v2 问题报告](./plan-v2-evidence-pack-issues-2026-08-30.md) · [execute 租约问题](./execute-phase-gate-close-lease-issue-2026-08-30.md) · [review/fixback 问题](./review-fixback-phase-issues-2026-08-30.md)

## 修复状态（2026-08-30，workflow-harness 0.4.7）

| 条目 | 状态 | 修复点 |
|---|---|---|
| P0-1 阶段交接手工 choreography | ✅ 已修 | 新增 `harness_context.py handoff --to-phase <p>` 组合命令：补租约（prepare 幂等）→写收据→begin 确认一步完成；收据已存在时只补 begin 确认；来源阶段未关门报 `HANDOFF_SOURCE_NOT_CLOSED` 拒绝截胡。gate begin 的 `CONTEXT_HANDOFF_REQUIRED`/`CONTEXT_BEGIN_REQUIRED` recoveryAction 指向该命令；harness-submit SKILL 明确「不要再 claim 阶段租约」。0.4.6 的 close 自动派生已从根上消除新断链，本命令服务历史断链 |
| P1-1 阻断报错不带出路 | ✅ 已修 | 三个报错均带 nextAction：`PROJECT_RELEASE_POLICY_BLOCKED`/`LOCAL_RELEASE_NOT_AUTHORIZED` → 新增 `harness_change.py allow-local-release --change <cn>`（幂等写策略位，保留既有 gate-policy 内容）；`DIFF_ZERO_WITH_NONEMPTY_COMMIT` → declare-ownership 命令模板；`SENSITIVE_EVIDENCE_UNQUARANTINED` → 展开为含全部 `--file` 的完整 quarantine 命令 |
| P1-2 recovery_token 误伤 + 串行暴露 | ✅ 已修 | `_sensitive_candidates` 豁免 harness 自生成的 `recovery_token` 字段（用户真实 token/password 赋值不受影响，有测试）；串行暴露随之消失。扫描本身本就一次返回全部 unresolvedFailures，串行是重试产生新日志所致 |

---

## TL;DR

submit 本体顺利（验证复用 REUSED、commit+push 一次过），但**阶段间交接仍需手工补 context close + claim + release 三连**。archive 被三个可预期的门禁各拦一次：`DIFF_ZERO_WITH_NONEMPTY_COMMIT`、`PROJECT_RELEASE_POLICY_BLOCKED`、`SENSITIVE_EVIDENCE_UNQUARANTINED`（×2，串行暴露）。三个都有正规出路，但**报错信息没有告诉使用者出路在哪**。

---

## 🔴 P0-1：阶段交接仍需手工 choreography（review→submit 又犯一次）

submit 的 `gate begin` 报 `CONTEXT_HANDOFF_REQUIRED` 后，必须手工执行：

```
context close --from-phase review --to-phase submit   # 失败：CONTEXT_LEASE_REQUIRED
change claim --phase review --run-id <rid>             # 重取租约
context prepare --phase review                         # 生成 context-lease.json
context close --from-phase review --to-phase submit    # 这次才成功
context begin --phase submit
change release --phase review --run-id <rid>           # 释放租约
gate begin --phase submit                              # 成功
```

六条命令才能开始 submit。与 review/fixback 报告中的 P0-1/P0-3 同根：**租约、交接、门禁三个状态机没有统一编排**。

**建议**：`gate begin` 发现交接缺失时，内部按序自动补（或给出一条 `harness_context.py handoff --to <phase>` 组合命令），而不是让使用者在三个工具间试错。

## 🟡 P1-1：archive 三个阻断报错均不带出路

| 阻断 | 当时的出路（翻了 skill 文档/源码才知道） | 建议 |
|---|---|---|
| `DIFF_ZERO_WITH_NONEMPTY_COMMIT` | `declare-ownership --product-path backend/` | 报错 `nextAction` 直接给命令 |
| `PROJECT_RELEASE_POLICY_BLOCKED` | 手工编辑 gate-policy.json 加 `candidateVerification.allowLocalRelease=true` | 提供 `harness_change.py allow-local-release --change <cn>` 命令 |
| `SENSITIVE_EVIDENCE_UNQUARANTINED` | `quarantine-evidence --file <path>` | 报错里给 quarantine 命令模板（含 path） |

## 🟡 P1-2：密钥扫描误伤 harness 自己生成的 recovery_token

- `meta/publication-journals/plan_finalize*.json` 里的 `recovery_token` 字段被 `PLAINTEXT_SENSITIVE_ASSIGNMENT` 拦截
- 这是 harness 自己生成的系统字段，不是用户秘密——**扫描器应豁免自己的文件或该字段**
- 且两个发布日志（首版 + 修订版）**串行暴露**（修一个、跑一轮、再报下一个），应一次列出全部 unresolvedFailures

## 🟢 做得好的

- `certify-local` 自动重绑定到最终 commit（`7bd8570`），不用重跑测试
- 两次上传（archive_push + managed_snapshot_push）分离建模，回执字段清晰（durable/ready/ready + submitted 10）
- 阻断时 `original_preserved=true`，原变更目录不动

## 复现环境

- hunter-harness 0.4.7（npx），Windows（Git Bash）
- change `demo-skeleton`，record-only + completed，远端 Codeup + 平台已连接
