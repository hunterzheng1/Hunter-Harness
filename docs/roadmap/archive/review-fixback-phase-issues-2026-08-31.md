# Review 与 Fixback 阶段问题报告与优化建议（demo-datasource 实测）

> 来源：sales-insight-agent 项目 change `demo-datasource`（KLERP 一期阶段 2）的 `/harness-review` + `/harness-execute --fixback` 全流程实测
> 日期：2026-08-31（会话跨越 2026-08-30 深夜）
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.10（npm 缓存实测）
> 关联：`plan-phase-lifecycle-and-knowledge-query-issues-2026-08-30.md`（plan + execute 问题）

## 修复状态（2026-08-31，workflow-harness 0.4.11）

| 条目 | 状态 | 修复点 |
|---|---|---|
| R-1 close 结构化前置无文档 | ✅ 已在 0.4.6 修复，实测环境为陈旧缓存 | scaffold 链与 SKILL 文档已于 0.4.6 落地（write-findings/scaffold/write-dispositions），REVIEW_OUTPUTS_INCOMPLETE 的 recoveryAction 已指向 scaffold。实测环境跑的是 workflow 0.4.3 npm 缓存（0.4.4~0.4.7 从未发布）。在线时 latestWorkflowCacheIsStale 会自动刷新 |
| R-2 LEASE_ABSENT | ✅ 已在 0.4.5 修复，同上 | 0.4.3 的 close 是「释放在前」，中途失败留下无租约中间态；0.4.5 起释放移至末位 + 幂等续跑。实测症状（失败后租约消失 + 续跑不触发 PHASE_CLOSE_RESUMED）与 0.4.3 行为精确吻合 |
| R-3 交接未落盘但报 CLOSED | ✅ 已在 0.4.6 修复，同上 | plain close 自动派生交接（review→submit）是 0.4.6 特性；0.4.3 无此行为 |
| R-4/R-5 事件字段契约试错 | ✅ 已修 | EVENT_FIELD_NOT_ALLOWED 一次列出全部不接受字段；harness-review SKILL 补 decision 事件完整示例命令（decision 不收 --name/--status；issue 必须 --severity） |
| F-1 mvn spawn WinError 2 | ✅ 已修 | `harness_process.resolve_windows_executable`：无扩展名命令经 shutil.which/PATHEXT 解析（mvn→mvn.cmd）；run-start 与 detached worker 两路都走 |
| F-2 run-start 缺 product-identity 白跑 | ✅ 已修 | fixback-* 会话缺省时从 OPEN 批次 baseProductIdentity 自动注入（回执含 productIdentitySource）；无 OPEN 批次当场拒绝 FIXBACK_PRODUCT_IDENTITY_REQUIRED |
| F-3 evidence-template --out 双重拼接 | ✅ 已修 | 与 ledger E-1 同规则：已含 change-dir 前缀的相对路径按 cwd 解析 |
| F-4 fixback close 派错后继 | ✅ 已修 | fixback 回环（trigger=review-fixback）的 execute 关门派生 review 的计划后继（submit），主路径与续跑路径同规则 |
| F-5 session 不随批次关闭 | ✅ 已修 | close_batch 同步把 fixback-session 置 CLOSED（nextStep=done） |
| F-6 fixback 步骤序列无文档 | ✅ 已修 | execute SKILL 补全步骤序列（launch→RED→证据→修复→GREEN→resolve→dispositions→收据→close batch→gate close） |

---

## TL;DR

两阶段业务目标全部达成（review 总体 YELLOW 0 RED；fixback 批次 7 项 code 全部 RESOLVED、3 项 manual/workflow 处置完毕、RED/GREEN 证据闭环），但过程各踩了 5+ 个工具坑。共性模式：**多处关键契约只在报错时逐字段暴露**（事件字段、结构化 findings/dispositions 前置、产品身份），文档与报错不同步。修复优先级建议：R-3（交接落盘丢失）> R-2（租约神秘消失）> F-4（fixback close 派错下一阶段）> 其余体验项。

---

## 一、Review 阶段问题

### 🔴 R-1：close 的结构化 findings/dispositions 硬前置，SKILL.md 只字未提

**现象**

- review 报告（md）+ fixback（md）写完后跑 `gate close`，被拒：`REVIEW_OUTPUTS_INCOMPLETE`，缺 `reports/review/review-findings.json` 与 `reports/review/fixback-dispositions.json`
- harness-review SKILL.md 只要求「报告 + fixback 落盘」，从未提到这两份 JSON 是 close 的硬前置，也没提到 `harness_review.py scaffold → write-findings → scaffold → write-dispositions` 这条骨架生成链
- 阶段 1 demo-skeleton 的事件里能看到同一错误反复出现 6 次（`gate.blocked 评审的结构化发现或处置记录缺失`）——当时也是撞出来的

**建议**

1. SKILL.md 的 review 工作流补一节「结构化发现与处置（close 硬前置）」，给出 scaffold/write-findings/write-dispositions 的命令序列
2. 或更彻底：`gate close` 在报告 md 存在时自动生成 findings 骨架让执行者补字段，而不是直接拒

### 🔴 R-2：close 时租约「神秘消失」（LEASE_ABSENT），两个阶段复现

**现象**

- review 与 fixback-execute 的 `gate close` 都报 `LEASE_ABSENT`（"租约从未建立或已被释放"），尽管 `gate begin` 确实跑过且 phase.start 在 events 里
- 恢复路径（recoveryAction 指引）有效：`harness_change.py claim --change <cn> --phase <phase> --run-id <原 run-id>` 重取后 close 成功
- 注意：execute 主阶段的 close 没有此问题；出问题的是 review 与 fixback 这两轮——疑似中间失败路径（REVIEW_OUTPUTS_INCOMPLETE 的首次 close / fixback 的 prepare 重试）把租约提前释放了

**建议**

1. 排查 close 校验失败路径是否误释放租约（校验失败 ≠ 应当释放）
2. recoveryAction 文案已很准确（值得肯定），但 close 自己按「原 run-id 自动重取租约」的能力（文档声称支持）实际没生效，需对齐

### 🔴 R-3：review 的 `gate close` 交接没落盘但报 CLOSED

**现象**

- review close 成功后 `closeStatus: CLOSED`、`phase.end` 已写、租约已放，但 `runtime/transitions.ndjson` 里**没有** review→submit 交接收据，`current-context.json` 仍停在 review
- 对照：execute 的 close 正常写了 execute→review 交接（contextHandoff.ok=true）
- 用 `harness_context.py close --from-phase review --to-phase submit` 手工补写才完成——而 SKILL.md 明确说「不得再次调用 context close」，此时执行者没有合规出路

**建议**

1. closeTransaction 应记录 handoff 步骤结果（成功/失败/原因），失败时 closeStatus 不得为 CLOSED
2. 「phase.end 已写 + 租约已放 + 交接未完成」的恢复路径（文档声称 `PHASE_CLOSE_RESUMED` 支持）实测未触发——重跑 close 返回的是 LEASE_ABSENT

### 🟡 R-4：decision 事件的评审字段契约三连报错

依次撞：`EVENT_FIELD_NOT_ALLOWED`（decision 不接受 --name）→ 不接受 --status → `EVENT_REVIEW_REASON_IN_BODY`（原因码要结构化字段）→ `EVENT_REVIEW_REASON_INVALID`（委派评审必须带 --executor-agent）。四连试错才写成功。

**建议**：必填/互斥字段一次校验合并报错；SKILL.md「执行日志」段落给出 review decision 事件的完整示例命令。

### 🟡 R-5：issue 事件需要 `--severity`（报错才知道）

同 R-4 模式。建议同上：合并校验 + 文档示例。

---

## 二、Fixback 阶段问题

### 🔴 F-1：`harness_runtime.py run-start` 无法 spawn `mvn`（WinError 2）

**现象**：`run-start ... -- mvn -f backend -q test ...` → `LAUNCHER_FAILED: [WinError 2] 系统找不到指定的文件`。原因是 Windows 上 `mvn` 实为 `mvn.cmd`，launcher 不走 shell 无法解析 .cmd。改用全路径 `C:\...\mvn.cmd` 后正常。

**建议**：launcher 在 Windows 上对无扩展名命令自动尝试 `.cmd/.exe/.bat` 后缀（CreateProcess 语义），或报错信息直接给出该提示。

### 🟡 F-2：`run-start` 缺 `--product-identity` 时不报错，证据到 register 才拒

`run-start` 不带 product-identity 正常跑完；`register-evidence` 才报 `FIXBACK_EVIDENCE_UNREGISTERED / session.productIdentity: expected=... actual=None`。白跑一轮测试会话。

**建议**：fixback 批次 OPEN 期间，`run-start --verification fixback-*` 应强制要求或自动注入 `--product-identity`（批次里有 `baseProductIdentity` 可用）。

### 🟡 F-3：`evidence-template --out` 复现路径双重拼接

与 plan 阶段 E-1 相同（`.harness/changes/<cn>/.harness/changes/<cn>/...`），fixback 链路全部 `--out` 参数都有此问题。应在公共路径解析处一次修掉。

### 🟡 F-4：fixback 的 `gate close` 派生下一阶段为 `review(auto)`——方向错误

**现象**：fixback 从 review 回环到 execute，修复完成后 `gate close --phase execute` 自动派生 `execute→review`（plannedPhases 后继），但 review **已经完成**——正确方向是回 submit。当前 transitions 链变成了 `…→review→execute→review`，交接语义混乱。

**建议**：fixback 批次的 close 应读取批次的 `sourceReviewRunId` 判断来源是 review，后继派生为 review 的后继（submit）；或 SKILL.md 明确 fixback 收尾必须显式 `--to-phase submit`。

### 🟡 F-5：`fixback-session.json` 在批次 CLOSED 后仍为 ACTIVE

批次关闭（`closedAt` 有值、receipts 齐、issues 全 RESOLVED），但 `runtime/fixback-session.json` 的 `status` 仍 `ACTIVE`、`nextStep` 仍 `resolve-issues`。重复 `launch-review` 因此报 `CONTEXT_PREPARATION_ACTIVE`（幂等保护本身是对的，但根源是会话没随批次关闭）。

**建议**：batch close 时同步把 fixback-session 置 CLOSED。

### 🟡 F-6：fixback 的完整步骤序列只在 launch 输出里，文档缺失

SKILL.md 对 fixback 只说「调用一次 launch-review」和 `FIXBACK_NOTHING_TO_APPLY`，但中间实际需要：托管会话 RED（run-start+evidence-template+register-evidence）→ 修复 → 托管会话 GREEN → 逐 issue resolve → write-dispositions → affected 验证会话 → review 收据 → close（带 final-product-identity）。共约 10 步，全靠 launch 返回体的 `nextAction` 指引边做边发现。

**建议**：SKILL.md 或 `harness_fixback.py` 补一份 fixback 操作清单（可做成 `status` 子命令输出当前步骤进度）。

### 🟢 正向观察

- `resolve-issue` 把 RED/GREEN 证据绑定到同一 productIdentity + 托管会话（session/commandHash/resultDigest），防手改证据的设计很好
- 各错误基本都有 `recoveryAction`，且内容准确可用（R-2 的恢复路径照做即通）
- review 的委派评审决策事件结构化字段（execution-mode / reason-code）设计合理，只是缺文档（见 R-4）
- fixback close 自动失效了受影响的 ledger 条目（integrationTest invalidated），提醒复跑——闭环意识正确

## 复现环境

- hunter-harness 0.4.10（npx 缓存），Node v24.14.0，Python 3.11.15，Windows（Git Bash + PowerShell 5.1/7.6）
- 项目：sales-insight-agent，change `demo-datasource`
- 关键操作序列：review（委派 reviewer → 报告/fixback md → close 被拒 → scaffold/write-findings/write-dispositions → claim 租约 → close 成功但交接缺失 → context close 补交接）→ fixback（launch-review ×2 → RED 会话（mvn spawn 失败 → mvn.cmd 全路径）→ register 被拒（缺 product-identity）→ 重跑 RED → 修复 → GREEN → resolve ×7 → dispositions → affected 会话 → review 收据 → close ×2（幂等）→ ledger 刷新 → claim + gate close）
