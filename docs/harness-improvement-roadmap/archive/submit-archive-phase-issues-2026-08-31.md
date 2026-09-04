# Submit 与 Archive 阶段问题报告与优化建议（demo-datasource 实测）

> 来源：sales-insight-agent 项目 change `demo-datasource` 的 `/harness-submit` + `/harness-archive` 全流程实测
> 日期：2026-08-31
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.10（npm 缓存实测）
> 关联：`plan-phase-lifecycle-and-knowledge-query-issues-2026-08-30.md`、`review-fixback-phase-issues-2026-08-31.md`
>
> 说明：本报告刻意区分「工具问题」与「执行者跳读文档」——submit/archive 的两个门禁阻断的出路
> 其实已写在 harness-submit/harness-archive SKILL.md 的二·A 表里，执行者未预读才撞上。
> 这类条目仅保留「报错内联出路」的体验改进建议，不算文档缺失。

## 修复状态（2026-08-31，hunter-harness 0.4.12 / workflow-harness 0.4.12）

| 条目 | 状态 | 修复点 |
|---|---|---|
| S-1 恢复指引与实际路径不符 | ✅ 已修 | close 的 handoff 撞 CONTEXT_LEASE_REQUIRED 时自动 prepare 重建租约并重试交接（`leaseRepaired: true`）；主路径与续跑路径同规则。recoveryAction 补 handoff 命令兑底 |
| S-2 --json 输出混入横幅 | ✅ 部分为既有 + 已补 | 横幅自 0.4.5 起就在 stderr；实测「混入」是 `2>&1` 合并时 stderr 不缓冲先写所致。submit SKILL 已注明管道 jq 不要合并流 |
| S-3 fixback close 派错后继 | ✅ 已在 0.4.11 修复 | 同 F-4：fixback 回环的 execute 关门现派生 submit（本次实测环境的缓存先于该修复） |
| S-4 record 不带 profile-input 身份不全 | ✅ 已修 | record 检出 target 已声明但未带 --profile-input 时输出 `PROFILE_INPUT_MISSING` 警告 |
| A-1 ownership 接线断裂 | ✅ 已修 | plan finalize 自动从 structured_input.ownership（回退 affected_paths）归并目录前缀写入 change-context.json 的 ownership.productPaths；已声明的不动 |
| A-2 record-only 被授权门禁阻断 | ✅ 部分为既有 + 已补 | record-only 的阻断豁免在 0.4.3 起就存在（转警告）；但警告原文透传授权要求，读起来像阻断指引——已改为明确「record-only 不要求发布授权」 |
| A-3 blockers 不带 recoveryAction | ✅ 已修 | blockers 透传 issue 的 nextAction 为 recoveryAction（对齐二·A 表） |
| A-4 knowledgeStatus 滞留 indexing | ✅ 平台侧已修（0.4.11 配套） | hunter-platform 9507538：job commit/fail 桥翻转状态 + projection-status 自查。滞留意味着 extraction job 未完成——需部署新版平台后跑 `knowledge status` 看 job 停在哪 |
| A-4b 候选 source_refs 伪来源拒整包（追加，2026-08-31 夜） | ✅ 已修（0.4.13） | 42 条候选中 1 条 `quality/#L1`（目录+行号）被服务端 ARCHIVE_CANDIDATE_SOURCE_UNBOUND 整包拒绝。`harness_knowledge_candidates` 新增同源结构校验：非法 path 的候选整条跳过（stderr 留痕），path 缺失回退 `archive:<id>`；`write-findings` 对目录路径 finding 提前输出 warnings |

---

## TL;DR

submit 推送成功（56c537c → origin/master）、archive durable（arc_1f86f8d2…）+ 受管快照 6 项上传成功，目标全部达成。但 close 的恢复指引错误（S-1）、`--json` 输出混入横幅（S-2）属必修项；ownership 从 plan 到 archive 的接线断裂（A-1）是跨阶段契约缺口。

---

## 一、Submit 阶段

### 🔴 S-1：`gate close` 的 recoveryAction 与实际恢复路径不符

**现象**

- submit close 报 `PHASE_HANDOFF_PENDING` / `contextHandoff.code=CONTEXT_LEASE_REQUIRED`，`localCloseComplete=true`
- recoveryAction 原文：「租约仍持有，无需重新 claim——**原样重跑同一 close 命令即可幂等续跑**（phase.end 已落会跳过，handoff 会重试）」
- **原样重跑两次，仍报同样的 CONTEXT_LEASE_REQUIRED**——幂等续跑没有发生
- 真正出路：`harness_context.py handoff --to-phase archive`（自动补租约→写收据）后 close 成功

**建议**

1. 修复 close 的 handoff 重试路径（lease 缺失时自动补，而不是只说"会重试"）
2. 或修正 recoveryAction 文案指向 `handoff` 命令（submit skill 步骤 0 已把 handoff 作为 begin 断链的正规出路，close 断链应同一待遇）

### 🔴 S-2：`harness_gate.py close --json` 输出混入非 JSON 横幅

**现象**：close 成功时 stdout 第一行为 `PHASE_CLOSED · phase=submit · status=OK · next=archive(auto)`，其后才是 JSON。`--json` 输出无法直接管道给 `jq`/json.load。fixback 的 execute close、submit close 两次复现。

**建议**：`--json` 模式下横幅走 stderr，或干脆去掉。

### 🟡 S-3：fixback close 派生 `execute→review`（方向错误）导致 submit 起手断链

fixback 完成后 close 把交接写成 execute→review（review 已完成），submit 起手 `HANDOFF_REQUIRED`，且 `handoff --to-phase submit` 被拒（TRANSITION_ILLEGAL：execute 的合法后继只有 review/execute），只能两段跳 `execute→review→submit`。与 review-fixback 报告的 F-4 同源，此处记录其在 submit 侧的实际代价。

### 🟡 S-4：`ledger record` 不带 `--profile-input` 时产出身份不全的条目

fixback 后手工 `record --verification unitTestFull`（未带 `--profile-input`）成功落账，但 `can-reuse` 报 `MISSING_FIELDS / insufficient-evidence`，不可复用——只能重跑一次全量再带 `--profile-input` 重新登记。

**建议**：record 在 build-profile 存在对应 target 而未传 `--profile-input` 时告警「该条目身份不完整，将无法被 can-reuse 复用」。

## 二、Archive 阶段

### 🔴 A-1：ownership.productPaths 从 plan 到 archive 的接线断裂

**现象**

- plan v2 的 `structured_input.tasks[].affected_paths` 明确定义了 21 个改动文件
- 但归档 `execute` 报 `DIFF_ZERO_WITH_NONEMPTY_COMMIT`（提交范围非空但 filesChanged=0）——ownership 为空，全部改动被判 foreignPaths
- 补跑 9 条 `harness_change.py declare-ownership` 后通过
- harness-plan SKILL.md 的关键规则写了「finalize 前对照任务表补齐 ownership.productPaths」，但 v2 finalize **没有**从 affected_paths 自动派生，plan 工作流里也没有 declare-ownership 步骤——规则靠人肉执行，必漏

**建议**

1. `plan finalize` 从 `affected_paths` 自动派生 `ownership.productPaths`（目录前缀归并），写入 change-context.json
2. 或 plan 阶段 8 完整性检查加一项：ownership.productPaths 非空校验

### 🟡 A-2：`record-only` 归档被发布授权门禁阻断（设计商榷）

**现象**：`--intent record-only` 仍触发 `PROJECT_RELEASE_POLICY_BLOCKED`（要求 `allow-local-release` 授权）。harness-archive 自己强调「归档结局、发布资格、Git 远端和平台上传分别建模，互不冒充前置条件」——record-only 要求发布授权与此原则矛盾。

**建议**：record-only + closure=completed/abandoned 路径豁免发布授权；或至少把该门禁移出 `archiveIntegrity` 的阻断集合。

### 🟡 A-3：阻断报错的 issues[] 不带 recoveryAction

`ARCHIVE_REPORT_ADEQUACY_FAILED` 的 message 只有「请按 blockers 中的中文建议处理后重试」，issues[] 只有 code + 一句话。出路命令（declare-ownership / allow-local-release）要去翻 SKILL.md 二·A 表。**建议**：issues[] 每条带可直接执行的 recoveryAction（对齐二·A 表内容）。

### 🟡 A-4：`knowledgeStatus=indexing` 未转 ready + 知识查询仍为 0

归档包上传 durable（含 42 条知识候选），但服务端 `knowledgeStatus` 停留 `indexing`，`knowledge query` 任意查询仍 0 条、`index_generation` 恒为 1。与 plan 阶段报告的 P0-1（ingest 回执 ready 但查询全空）叠加，进一步指向**平台侧 ingest→index 链路未实际工作**。ZIP 已按协议留存（`.harness/state/local/archive-packages/`），可 `--retry-retained` 重试。

**建议**：平台侧排查索引任务调度；CLI 增加 `knowledge status` 自查手段（同 P0-1 建议）。

### 🟢 正向观察

- `execute` 一次性完成预检+归档，ZIP 内容边界（8 文件）与敏感扫描、知识候选生成（42 条）全自动
- `managed_snapshot_push` 成功上传 6 项受管内容，与归档 ZIP 双通道语义清晰
- 阻断后重跑幂等（declare-ownership / allow-local-release 均可重复执行无副作用）
- `certify-local` 在 commit 后自动把候选重绑定到最终 commit，无需重跑测试

## 复现环境

- hunter-harness 0.4.10（npx 缓存），Node v24.14.0，Python 3.11.15，Windows（Git Bash）
- 项目：sales-insight-agent，change `demo-datasource`，提交 56c537c（master→origin/master）
- 关键操作序列：prepare/begin（HANDOFF_REQUIRED → 两段 handoff 修复）→ gate begin → diff-hash → can-reuse（MISSING_FIELDS）→ 重跑全量+带 profile-input 重登记 → reuse=true → certify-local → 精确暂存 24 文件 → 用户确认 → commit -F → push → certify-local 重绑定 → close（PHASE_HANDOFF_PENDING ×2 → handoff 补租约 → PHASE_CLOSED）→ archive execute（DIFF_ZERO + RELEASE_POLICY 阻断 → declare-ownership ×9 + allow-local-release → 成功 durable）
