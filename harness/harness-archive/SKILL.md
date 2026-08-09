---
name: harness-archive
description: "归档所有变更产出（计划/测试报告/审查/SQL/API文档）到 .harness/archive/，含归档元数据。仅当用户显式调用 /harness-archive 时使用；不得被其他阶段 skill 自动接续触发。"
disable-model-invocation: true
argument-hint: "变更名或留空自动检测"
effort: medium
allowed-tools: [Bash(powershell.exe:*), Read, Write, Edit, Glob, Grep]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(cp *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
---

# harness-archive — 变更归档

## Purpose

把变更事实安全封存、生成确定性 ZIP，并在已连接 Hunter Platform 时上传保存。归档结局、发布资格、Git 远端和平台上传分别建模，互不冒充前置条件。

## When to Use

仅当用户显式调用 `/harness-archive` 时执行。submit/merge 完成后**不自动**进入本阶段；用户口头说"归档/收尾"而未调用本 skill 时，先确认。

前置只看本次 `plannedPhases` 与用户选择的生命周期结局。Submit、Test 或 Review 未在计划中时记录为“未执行”，不得临时补跑；无 Git、无 upstream、仅本地 commit 都允许归档和平台上传，只是不能声明为发布候选。

自动调用边界：

- 归档涉及移动/删除原变更目录，**禁止被其他 skill 自动调用**；只接受用户显式 `/harness-archive` 调用。
- `harness_archive.py auto-gate` 只影响**本次显式调用内**是否需要归档确认对话：实际计划中的最后阶段已终态、archive-boundary/content snapshot 存在且保存门禁满足时可跳过确认。auto-gate 不构成跨阶段自动触发的授权。

## 前置条件

- **最终产品身份**：Git 项目优先使用 Submit 最终收据/当前 HEAD；提交前验证而内容未变化时由 `certify-local` 自动重绑定 commit。非 Git 项目使用确定性内容清单与产品树散列，并记录 `sourceControl=none`。
- **正常完成**按 `plannedPhases` 检查已规划阶段；被省略阶段记录 `NOT_RUN` / `NOT_APPLICABLE`。**结束未完成变更**只要求足以识别和安全封存变更的最小设计、事件与内容清单，不要求补齐测试、评审或提交。
- 所有 events、ledger、reports、receipts 和 upload state 都通过 state layout 解析器读取；split-v1 的权威状态位于 `.harness/state/changes/<change>`，禁止复制到旧目录。
- **产品候选验证**：
  - 有远端 CI：保留 `product-candidate-ci.json` 兼容证据；归档会把有效的 legacy schema v1 证据迁移为 `remote-claimed` 的 schema v2 `product-candidate-verification.json`，不会冒充 `remote-attested`。
  - `remote-attested` 必须同时带远端运行 URL 与 `verification.attestationDigest`；只有 URL、旧 JSON 哈希或 ledger 哈希只能达到 `remote-claimed`。
  - 无 CI：先运行 `harness_archive.py certify-local --change-dir ... --project . --json`，只复用身份一致且完整的 `unitTestFull` ledger 证据，不重复执行测试。
  - `release-candidate` 要求候选验证通过；正常本地完成或结束未完成变更使用 `--intent record-only`，固定 `releaseEligible=false`，但仍生成 ZIP 并上传平台。

## Inputs

- `$ARGUMENTS`：变更名（可选）；必须由 `harness_change.py resolve` 解析 contract/state 双层目录，禁止按 mtime 或固定旧路径猜测。

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow

先用 `harness_change.py resolve [--change] --json` 解析 change；多个 active change 未显式选择时返回 `CHANGE_SELECTION_REQUIRED`，禁止按 Glob/mtime 自动选择。`harness_archive.py finalize` 内部负责且仅负责一次 `harness_gate.py begin` 与 `harness_gate.py close`。调用者禁止重复调用阶段门禁，避免重复事件和幽灵 change 目录。

### Phase 0：读取规则和上下文

1. 读取本文件。
2. 按需读取 `reference.md`（归档流程、manifest、summary-data、final-summary 渲染、目录结构与最终状态规则）。
3. 读取共用约束：
   - `../protocols/archive-report-protocol.md`
   - `../protocols/state-layout-protocol.md`
   - `../protocols/powershell-protocol.md`
   - `../protocols/sensitive-info-protocol.md`
   - `../protocols/evidence-based-reporting-protocol.md`
   - `../protocols/report-pipeline-protocol.md`
4. 用 `harness_change.py resolve [--change] --json` 解析 `$ARGUMENTS`；多个 active change 时让用户选择。

### Phase 1：确认归档对象（扫描未归档变更）

使用 resolver 返回的 active changes 展示变更概要；同时读取 `plannedPhases`、已完成阶段、Git 能力、平台连接和待上传 ZIP 状态。

- **Read `checklist.md`** — 归档前检查项
- 发现多个未归档变更 → 让用户选择或终止

### Phase 2：确认归档 / 自动门禁

先运行 `harness_archive.py auto-gate --change-dir "<executionRoot>" --intent <intent> --json`。

- `autoArchiveAllowed=true`：记录 gate receipt，直接进入 Phase 3；无需 AskQuestion。
- 否则用中文提供：①正常完成并归档（本地验证、不可发布）；②作为发布候选归档；③结束未完成变更；④取消。选择③后继续选择“主动废弃”或“被其他方案替代”，并填写中文原因。不要把无 upstream 显示为阻止保存。

- **Read `reference.md`** — 确认对话框的内容格式

### Phase 3：执行归档

1. 对“发布候选”使用 `--intent release-candidate --closure completed`；对正常本地完成使用 `--intent record-only --closure completed`；主动废弃或被替代分别使用 `--intent record-only --closure abandoned|superseded --closure-reason "<中文原因>"`。先运行 `status`；有可复用全量 ledger 时可运行 `certify-local`，不得重复测试。
2. `meta/archive-meta.md` **由 `harness_archive.py finalize` 自动生成**（与 summary-data `finalStatus` 同源）；**禁止 agent 手写**该文件，手写视为数据丢失。维护者结论写入 events（decision/issue）即可，finalize 会汇总到 summary / archive-meta。
3. 运行 `harness_archive.py finalize --change-dir "<executionRoot>" --archive-root ".harness/archive" --intent <...> --closure <...> [--closure-reason "..."] --json`；读 JSON（cleanup、事件、移动、collect、render、validate、manifest、archive-meta、ZIP、上传与服务端知识状态）。finalize 内部只负责一次 `phase.start` / `phase.end`，调用者不得重复追加。**本地不执行知识 ingest**；服务端在 ZIP 持久保存并解包后 ingest。失败时保留原目录、ZIP 和回执。
   - **归档包上传**：始终先生成一个确定性 ZIP；有远程凭据时再调用 `npx hunter-harness archive upload`。ZIP 仅包含 `summary-data.json`、`spec/**/*.md`、`plans/**/*.md`、`archive-meta.md`、`change-context.json` 和稳定 manifest；明确排除 logs、review/test 报告、HTML、缓存、备份、凭据和临时文件。
   - **失败可恢复**：无论远端凭据是否齐全，都先生成 ZIP 与 `<change-key>.upload.json`；上传或服务端 ingest 失败不破坏本地归档。待上传 ZIP 与逐 change 回执保留在 `.harness/state/local/archive-packages/`，可枚举独立重试。只有 CLI 核验 package hash 且服务端同时返回 `archive_status=durable`、`knowledge_status=ready` 后，才清理对应 ZIP 与回执；`indexing` 记为 pending，不记为失败。
   - **监控终态（C3）**：auto-upload 之后自动 `events-sync`，用归档前 change 路径派生的 `run_id` + 原 `change_key` 上报；失败只记 warning。

- **Read `reference.md`** — finalize 输出字段、archive-meta 格式、CONDITIONAL_OK 规则
- **Read `templates/summary-data-template.json`** — summary-data 数据结构
- **Read `templates/render-summary.mjs`** — final-summary 渲染脚本（finalize 内嵌调用）

### Phase 4：验证与提示

验证归档目录完整 → 提示用户归档完成。

- **Read `checklist.md`** — 归档后验证项

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 每条规则的详细判定、模板见 `reference.md` 对应章节；归档报告协议见 `../protocols/archive-report-protocol.md`，Shell 执行安全见 `../protocols/powershell-protocol.md`，敏感信息见 `../protocols/sensitive-info-protocol.md`，证据化报告见 `../protocols/evidence-based-reporting-protocol.md`，状态目录见 `../protocols/state-layout-protocol.md`。

### 一、同一时间最多 1 个未归档变更

扫描排除 `.harness/archive/`；多个未归档变更 → 让用户选择或终止，不批量归档。

### 二、归档前确认或自动门禁

`auto-gate` 只有在实际计划最后阶段终态、边界快照存在且 `status.archivable=true` 时才允许无确认执行。未满足时按 Phase 2 的四个中文选项确认；用户取消则不执行移动。

### 三、文件移动只用内置工具或 PowerShell

移动用 Read+Write+验证 或 PowerShell；**禁止 Bash mv/cp/rm**。移动失败时不删除原目录，报错退出让用户手动处理。

### 四、数据化归档门禁（先数据后渲染）

必须通过 `harness_archive.py finalize` 生成权威 `reports/final/summary-data.json` 并完成 validate；`final-summary.html` 为可选展示投影（默认渲染；渲染失败只记 warning、不回滚归档；`finalize --no-html` 可完全跳过本地 HTML）。**禁止模型临场写 500+ 行 HTML**。统计数字只能来自 summary-data、events、ledger 或 manifest。详见 `../protocols/report-pipeline-protocol.md`、`../protocols/archive-report-protocol.md`、`reference.md`。

### 五、manifest/checksum 必须存在

归档前后生成 `evidence/archive-manifest-before.json` / `archive-manifest-after.json`（path/size/sha256），before/after 不一致时**不得删除原目录**。复杂 PowerShell 写入 `scripts/*.ps1` 后 `-File` 执行，禁止内联 `$` / `$_` / `@{}`。详见 `reference.md`。

### 六、归档前确认四项

- 生命周期结局与中文原因已确认；正常完成、主动废弃、被其他方案替代不得混写
- Git 项目记录当前 HEAD 与 upstream 状态；无 upstream 只影响发布资格，不阻止保存。非 Git 项目记录内容身份
- Test/Review 只按 `plannedPhases` 核对；未规划或提前结束时如实标记未执行
- 平台连接与 Git remote 分开检查；无 Git remote 仍生成 ZIP，并在平台已连接时上传

### 七、verification-ledger 汇总状态

归档前读 `evidence/verification-ledger.json`，提取各阶段 status、postTestClassification、复用关系，供 final-summary 真实展示状态演进。若 ledger 有 `postTestClassification`，final-summary 必须展示该分类及对应的复用/重测决策。

### 八、final-summary 不得伪造且必须展示状态演进

无测试报告 → 显示"未运行测试 / 静态验证"，不得 100% 通过率；无 review → "📝ADVISORY：未运行 review"。状态用 ✅OK / 🟡WARN / 🔁REUSED / 🔁RETESTED / 📝ADVISORY / 🧹NON_BEHAVIORAL_CLEANUP，复用前一阶段结果显示 🔁REUSED，**不得伪装成重新执行，不得无脑全绿**。

**final-summary 是可再生展示投影，非硬产物**：`summary-data.json` 是最终报告的唯一权威数据源，必须产出并通过 validate/adequacy。HTML 渲染默认执行（Node 渲染器失败时自动 Python fallback），但渲染失败只记 warning，**不再回滚归档**；`finalize --no-html` 可完全跳过本地 HTML（配置远端平台时由平台按 summary-data.json 渲染）。

### 九、CONDITIONAL_OK 最终状态

API 测试 `USER_SKIPPED` 或 DB 兼容 `BLOCKED_BY_DBA` 时，最终状态必须是 `CONDITIONAL_OK`，不能显示纯 `OK`。

### 十、未提交测试文件归档

未提交但用于验证的测试文件必须归档到 `backups/uncommitted-tests/` 并在 final-summary 中展示。

### 十一、归档事件单一所有权

finalize 内部负责且仅负责一次 `phase.start` / `phase.end`，并在移动后继续向归档目录中的同一事件流追加。调用者不得在 finalize 前后重复追加阶段边界，否则会造成重复阶段或在原 changes 路径生成幽灵目录。归档后 events.ndjson 与自动渲染的 execution-log.md 一起位于 archive。

### 十二、Shell 安全 / 敏感信息 / 证据化报告

git 命令通过 `powershell.exe -Command "..."` 执行；archive-meta.md 和 final-summary.html 不得含明文 token/密码/密钥；归档报告必须区分 ✅真实成功 / 🟡跳过·静态验证 / ❌失败。

### 十三、归档完整性与发布资格分离

`archiveIntegrity` 表示归档内容是否完整；`candidateVerification` 表示候选验证证据及保证级别；`releaseEligible` 只有两者均满足发布策略时才为 true。`record-only` 允许保留证据不足的历史事实，但绝不等价于 CI 绿灯或可发布。

## Output Format

> 归档元数据格式见 `reference.md` 的 archive-meta 模板；最终报告由 `templates/summary-data-template.json` 数据结构 + `templates/render-summary.mjs` 固定脚本渲染。

产出文件：

- `.harness/archive/YYYY-MM-DD-<change-name>/meta/archive-meta.md` — 归档元数据
- `.harness/archive/YYYY-MM-DD-<change-name>/events.ndjson` — 结构化事件层（新流程推荐；旧 archive 可缺失）
- `.harness/archive/YYYY-MM-DD-<change-name>/reports/final/summary-data.json` — 最终报告数据源
- `.harness/archive/YYYY-MM-DD-<change-name>/reports/final/final-summary.html` — 可选展示投影，由 `render-summary.mjs` 渲染（Node 失败时 Python fallback）；渲染失败降级 warning，`--no-html` 可跳过
- `.harness/archive/YYYY-MM-DD-<change-name>/evidence/archive-manifest-before.json` / `archive-manifest-after.json` — 归档前后 manifest/checksum

## 渐进披露

- **Read `checklist.md`** 仅在 Phase 1 归档前检查和 Phase 4 验证时 — 含归档前检查项和归档后验证项
- **Read `reference.md`** 仅在 Phase 0/2/3 时 — 含归档流程、archive-meta 格式、summary-data 字段说明、final-summary 渲染规则、目录结构与最终状态规则
- **Read `reference.md`** 仅在 Phase 3 finalize 时 — summary-data、final-summary 校验与 archive-meta 补写
- **Read `templates/summary-data-template.json`** 仅在 Phase 3 生成 `summary-data.json` 时 — 含最终报告数据结构
- **Read `templates/render-summary.mjs`** 仅在 Phase 3 渲染 `final-summary.html` 时 — 固定 HTML 渲染脚本

## 交互白名单

仅当 `auto-gate` 未满足时，允许归档确认（Phase 2 blocking user confirmation）；拒绝 → 终止，不执行任何移动。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`archive`
