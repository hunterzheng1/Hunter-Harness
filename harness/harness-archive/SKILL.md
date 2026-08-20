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
  - 无 CI：`execute` 在候选收据缺失时自动尝试本地认证，只复用身份一致且完整的 `unitTestFull` ledger 证据，并在产品内容未变化时把提交前验证安全重绑定到当前 HEAD；认证不会执行测试。只有需要单独诊断认证结果时才手工运行 `certify-local`。
  - `release-candidate` 要求候选验证通过；正常本地完成或结束未完成变更使用 `--intent record-only`，固定 `releaseEligible=false`，但仍生成 ZIP 并上传平台。

## Inputs

- `$ARGUMENTS`：变更名（可选）；必须由 `harness_change.py resolve` 解析 contract/state 双层目录，禁止按 mtime 或固定旧路径猜测。

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow

先用 `harness_change.py resolve [--change] --json` 解析 change；多个 active change 未显式选择时返回 `CHANGE_SELECTION_REQUIRED`，禁止按 Glob/mtime 自动选择。常规路径只运行一次 `harness_archive.py execute`。该命令一次性完成状态采集、自动门禁和 finalize，并复用同一份预检结果。调用者不得再串行运行 `auto-gate`、`status` 和 `finalize`，避免重复扫描、重复事件和幽灵 change 目录。

### Phase 0：读取规则和上下文

1. 读取本文件。
2. 用 `harness_change.py resolve [--change] --json` 解析 `$ARGUMENTS`；多个 active change 时让用户选择。
3. 按共享读取协议刷新一次状态快照。首次 Plan 已记录的 `changeBase` 必须保持不变，归档阶段不得把当前 HEAD 写回为基线。
4. 常规路径不预读全部参考资料。仅在 `execute` 返回阻断或需要解释结果时，读取 `reference.md` 和对应协议章节。

### Phase 1：确认归档对象（扫描未归档变更）

使用 resolver 返回的 active changes 展示变更概要；同时读取 `plannedPhases`、已完成阶段和用户表达的生命周期结局。Git remote 与平台连接不是归档前置条件，不在这里额外探测。

- 发现多个未归档变更 → 让用户选择或终止

### Phase 2：确定归档结局

根据用户当前指令确定一次归档结局：

- 明确要求发布候选：`--intent release-candidate --closure completed`。
- 正常完成但不要求发布：`--intent record-only --closure completed`。
- 主动停止或被其他方案替代：`--intent record-only --closure abandoned|superseded --closure-reason "<中文原因>"`。

信息已经明确时，不重复询问。信息不足且会改变结局时，才用中文提供「正常完成」「发布候选」「主动废弃」「被其他方案替代」「取消」。无 upstream 不阻止保存。

### Phase 3：执行归档

1. 不要为归档预先补跑测试或手工修 ledger。候选收据缺失时，`execute` 会先尝试复用身份一致的全量 ledger 完成本地认证；无法认证时保留结构化原因，`record-only` 仍按事实归档，`release-candidate` 则由发布门禁决定是否阻断。
2. 运行一次 `harness_archive.py execute --change-dir "<executionRoot>" --archive-root ".harness/archive" --intent <...> --closure <...> [--closure-reason "..."] --json`。`execute` 只采集一次状态，并把准备耗时、正式归档耗时和唯一阶段轮次写入事件。调用者不得在它前后再运行 `auto-gate`、`status`、`finalize` 或手工追加 archive 阶段边界。
3. `meta/archive-meta.md` 与 `reports/final/summary-data.json` 均由脚本生成。禁止手写、补字段或手工修改 ledger 以绕过门禁。
4. `execute` 失败时，先按 `reasonCode` 处理，不要盲目重跑：
   - `ARCHIVE_BASE_EQUALS_FEATURE_TIP`：正常完成不允许空范围归档。仅可选择受控认领既有提交范围、改为未完成封存，或取消。
   - 受控认领既有范围：先展示 base、tip 和产品文件清单；获得用户明确确认后运行 `adopt-existing-range --base <base> --tip <tip> --reason "<中文原因>" --confirm-existing-range --json`，再重跑一次 `execute`。禁止直接编辑 snapshot 或 ledger。
   - `abandoned` / `superseded`：允许没有产品增量，但必须保存中文原因，并固定 `releaseEligible=false`。
   - 其他阻断：读取 `reference.md` 中对应错误的恢复说明；原变更目录必须保留。

   **本地不执行知识 ingest**；服务端在 ZIP 持久保存并解包后 ingest。失败时保留原目录、ZIP 和回执。
   - **归档包上传**：始终先生成一个确定性 ZIP；有远程凭据时再调用 `npx hunter-harness archive upload`。ZIP 仅包含 `summary-data.json`、`spec/**/*.md`、`plans/**/*.md`、`archive-meta.md`、`change-context.json` 和稳定 manifest；明确排除 logs、review/test 报告、HTML、缓存、备份、凭据和临时文件。
   - **失败可恢复**：无论远端凭据是否齐全，都先生成 ZIP 与 `<change-key>.upload.json`；上传或服务端 ingest 失败不破坏本地归档。待上传 ZIP 与逐 change 回执保留在 `.harness/state/local/archive-packages/`，可枚举独立重试。只有 CLI 核验 package hash 且服务端同时返回 `archive_status=durable`、`knowledge_status=ready` 后，才清理对应 ZIP 与回执；`indexing` 记为 pending，不记为失败。
   - **监控终态（C3）**：auto-upload 之后自动 `events-sync`，用归档前 change 路径派生的 `run_id` + 原 `change_key` 上报；失败只记 warning。

- **Read `reference.md`** — 仅在阻断恢复或需要解释输出字段时读取
- **Read `templates/summary-data-template.json`** — 仅在排查 summary 校验失败时读取

### Phase 4：验证与提示

以 `execute` 返回的 manifest、ZIP、上传回执和 `finalStatus` 为权威结果。只有返回字段缺失或不一致时，才读取 `checklist.md` 做人工诊断。不要为了重复确认成功结果再次扫描整个目录。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 每条规则的详细判定、模板见 `reference.md` 对应章节；归档报告协议见 `../protocols/archive-report-protocol.md`，Shell 执行安全见 `../protocols/powershell-protocol.md`，敏感信息见 `../protocols/sensitive-info-protocol.md`，证据化报告见 `../protocols/evidence-based-reporting-protocol.md`，状态目录见 `../protocols/state-layout-protocol.md`。

### 一、同一时间最多 1 个未归档变更

扫描排除 `.harness/archive/`；多个未归档变更 → 让用户选择或终止，不批量归档。

### 二、归档前确认或自动门禁

`execute` 内部运行自动门禁。实际计划最后阶段已终态、边界快照存在且 `status.archivable=true` 时直接执行；未满足时返回阻断且不移动原目录。用户取消后不得重跑。

### 二·A、两个常见阻断的正规出路（不要自己拼 python -c）

| 阻断 | 出路 |
|------|------|
| `SENSITIVE_EVIDENCE_UNQUARANTINED`（默认只告警，`HUNTER_HARNESS_SENSITIVE_SCAN=block` 时才阻断） | `python <skills-root>/scripts/harness_runtime.py quarantine-evidence --project . --change-dir ".harness/changes/<cn>" --file "<相对 change-dir 的路径>" --reason "<为什么是敏感证据>" --json`（`--file` 可重复）。私有根默认已与项目同盘、且在项目根之外——**不要**手工指定项目内的路径，归档的密钥扫描会以 `SECRET_SCAN_PRIVATE_PATH_IN_COPY_ROOT` 拒绝 |
| `DIFF_ZERO_WITH_NONEMPTY_COMMIT`（提交范围非空但 filesChanged=0） | 契约缺 `ownership.productPaths`，全部改动被判为 `foreignPaths`。用 `python <skills-root>/scripts/harness_change.py declare-ownership --change <cn> --product-path "<目录前缀或精确文件>" --json` 按计划的实际改动范围声明（可重复；只收精确路径，不支持通配）。**不要**手改 `change-context.json` |

### 二·A·1、发布内容预检与服务端 422

`status`（`execute` 的预检）会用**与服务端同源的规则**（`packages/core` 的
`scanSensitiveFiles`）扫描**真正会进 ZIP 的那批文件**——`reports/final/summary-data.json`、
`spec/**.md`、`plans/**.md`、`candidates/knowledge.json`、`meta/archive-meta.md`、
`meta/change-context.json`。`runtime/` 是过程草稿，从不入包，也不进这道扫描。

结果在 `checks.publication_content_scan`：

- `blocked=false` → 上传不会因内容被拒
- `blocked=true` → **服务端会以 HTTP 422 `archive contains sensitive content` 拒收**。
  归档不阻断（服务端策略不归本地裁决），但必须在此时处理，别等跑完全流程才发现
- `reasonCode=PUBLICATION_CONTENT_SCAN_UNAVAILABLE` → CLI 不可用，预检没跑；归档继续，
  上传仍可能 422

每条 finding 都带 `rule_id / path / line / column / overridable / recovery_action`。

**处置：**

| 命中类型 | 出路 |
|---|---|
| `overridable=true`（medium/low，如 `HH_INTERNAL_ADDRESS` 内网地址、`HH_WINDOWS_ABSOLUTE_PATH`） | 若确属设计固有内容，在源文件该行附近加行内标注：`<!-- hunter-harness-ignore: <RULE_ID> reason=<简短理由> -->`，然后 `republish` 重建重传 |
| `overridable=false`（high，如私钥、真实 token） | **不提供豁免。** 必须真正脱敏后重新打包 |

> ⚠️ 行内标注是**申报**，不是绕过：它把"这是设计决策"写进文档本身，可审计、可追溯。
> **不要**为了过扫描去删改设计文档的事实内容——那是篡改证据。
>
> ⚠️ 已知限制：`hunter-harness-ignore` 在本地扫描器上确认生效；**服务端是否认这条标注尚未验证**
> （归档上传端点只收裸 ZIP，没有独立的豁免申报通道）。若加了标注仍被 422 拒收，
> 剩余动作是在平台侧对该规则/内容加白，本地无法自解。

### 二·B、归档补传（上传失败或历史归档缺条目）

归档上传成功后 ZIP 与回执会被清理，旧版本产生的归档从未入 outbox——所以
`harness-push --scope archive` 找不到可复用的包属于正常状态，不是故障。补传从已封存的
归档目录重建确定性包：

```powershell
python <skills-root>/scripts/harness_archive.py republish --change <change-key> --dry-run --json   # 只看包内容
python <skills-root>/scripts/harness_archive.py republish --change <change-key> --json             # 重建并上传
```

脚本在 `<skills-root>/scripts/` 共享，**不在 `harness-archive/scripts/`**（见 read-protocol 第 0 条）。

在项目根内任意目录直接跑即可，**不需要** `--project`。

归档目录是封存的（after-manifest 覆盖其每个字节），因此 `republish` **不写回**归档目录：
缺失的 `candidates/knowledge.json` 只在内存中按已归档 summary 生成并放进包里。平台的知识
条目只来自这个包；`--scope all` 走的是 branch_file 通道，不进知识管道。

**服务端一个 change key 只存一个不可变包**，所以补传只适用于「从未成功上传」与「字节完全一致的
重试」。已 durable 的 change 会在本地就判出结果：字节一致 → `ARCHIVE_ALREADY_PUBLISHED`
（exit 0，不重传）；字节不同 → `ARCHIVE_REMOTE_IMMUTABLE_CONFLICT`（exit 1，**不发起上传**）。
**已发布归档无法从客户端补知识条目**——注入候选必然改变字节，服务端拒绝替换；要补需要平台侧
提供重新索引或归档版本化能力。
只想重试**同一个包**（例如知识索引失败）时用 `--retry-retained`：它上传盘上留存的原包字节，
不重建。**重建得不到已发布的字节**——包 manifest 绑定归档自己的提交，封存目录与 harness 本身
也都会前进；`--no-knowledge-injection` 只是不注入候选，不等于能复现旧包。
留存包与远端字节不同（即那是一次失败尝试的残留）时，`--retry-retained` 同样在本地判出
`ARCHIVE_REMOTE_IMMUTABLE_CONFLICT` 并拒绝上传。

### 三、文件移动只用内置工具或 PowerShell

移动用 Read+Write+验证 或 PowerShell；**禁止 Bash mv/cp/rm**。移动失败时不删除原目录，报错退出让用户手动处理。

### 四、数据化归档门禁

必须通过 `harness_archive.py finalize` 生成权威 `reports/final/summary-data.json` 并完成 validate。平台监控直接读取该数据；本地不再生成重复的 HTML 报告。统计数字只能来自 summary-data、events、ledger 或 manifest。详见 `../protocols/report-pipeline-protocol.md`、`../protocols/archive-report-protocol.md`、`reference.md`。

### 五、manifest/checksum 必须存在

归档前后生成 `evidence/archive-manifest-before.json` / `archive-manifest-after.json`（path/size/sha256），before/after 不一致时**不得删除原目录**。复杂 PowerShell 写入 `scripts/*.ps1` 后 `-File` 执行，禁止内联 `$` / `$_` / `@{}`。详见 `reference.md`。

### 六、归档前确认四项

- 生命周期结局与中文原因已确认；正常完成、主动废弃、被其他方案替代不得混写
- Git 项目记录当前 HEAD 与 upstream 状态；无 upstream 只影响发布资格，不阻止保存。非 Git 项目记录内容身份
- Test/Review 只按 `plannedPhases` 核对；未规划或提前结束时如实标记未执行
- 平台连接与 Git remote 分开检查；无 Git remote 仍生成 ZIP，并在平台已连接时上传

### 七、verification-ledger 汇总状态

归档前读 `evidence/verification-ledger.json`，提取各阶段 status、postTestClassification、复用关系，供 summary-data 真实记录状态演进。若 ledger 有 `postTestClassification`，summary-data 必须记录该分类及对应的复用/重测决策。

门禁策略未声明 `database` 能力，且 `requiredValidations` / `requiredValidationsByPhase` 也未要求 `dbCompatibility` 时，数据库兼容性投影固定为 `NOT_APPLICABLE`，原因来自能力配置。不得要求纯前端、文档或无数据库项目伪造数据库证据。

### 八、summary-data 不得伪造且必须记录状态演进

无测试报告 → 显示"未运行测试 / 静态验证"，不得 100% 通过率；无 review → "📝ADVISORY：未运行 review"。状态用 ✅OK / 🟡WARN / 🔁REUSED / 🔁RETESTED / 📝ADVISORY / 🧹NON_BEHAVIORAL_CLEANUP，复用前一阶段结果显示 🔁REUSED，**不得伪装成重新执行，不得无脑全绿**。

`summary-data.json` 是最终报告的唯一权威数据源，必须产出并通过 validate/adequacy。平台按该文件展示归档结果，本地不维护第二份展示文件。

### 九、CONDITIONAL_OK 最终状态

API 测试 `USER_SKIPPED` 或 DB 兼容 `BLOCKED_BY_DBA` 时，最终状态必须是 `CONDITIONAL_OK`，不能显示纯 `OK`。

### 十、未提交测试文件归档

未提交但用于验证的测试文件必须归档到 `backups/uncommitted-tests/`，并在 summary-data 中记录。

### 十一、归档事件单一所有权

`execute` 在一次性预检通过后负责且仅负责一次正式 `phase.start` / `phase.end`。准备阶段单独使用 `phase.prepare.start/end`，不计为归档重跑。调用者不得重复追加阶段边界。归档后 events.ndjson 与自动渲染的 execution-log.md 一起位于 archive。

### 十二、Shell 安全 / 敏感信息 / 证据化报告

git 命令通过 `powershell.exe -Command "..."` 执行；archive-meta.md 和 summary-data.json 不得含明文 token、密码或密钥；归档报告必须区分 ✅真实成功 / 🟡跳过·静态验证 / ❌失败。

### 十三、归档完整性与发布资格分离

`archiveIntegrity` 表示归档内容是否完整；`candidateVerification` 表示候选验证证据及保证级别；`releaseEligible` 只有两者均满足发布策略时才为 true。`record-only` 允许保留证据不足的历史事实，但绝不等价于 CI 绿灯或可发布。

## Output Format

> 归档元数据格式见 `reference.md` 的 archive-meta 模板；最终报告使用 `templates/summary-data-template.json` 定义的数据结构。

产出文件：

- `.harness/archive/YYYY-MM-DD-<change-name>/meta/archive-meta.md` — 归档元数据
- `.harness/archive/YYYY-MM-DD-<change-name>/events.ndjson` — 结构化事件层（新流程推荐；旧 archive 可缺失）
- `.harness/archive/YYYY-MM-DD-<change-name>/reports/final/summary-data.json` — 最终报告数据源
- `.harness/archive/YYYY-MM-DD-<change-name>/evidence/archive-manifest-before.json` / `archive-manifest-after.json` — 归档前后 manifest/checksum
- `.harness/state/local/archive-packages/<change-name>.remote.json` — 远端上传回执（`archiveId`/`archiveStatus`/`knowledgeStatus`/`uploadStatus`/`fileCount`）

### 结束报告必须回显两条上传结果 ⚠️

归档会做**两次**独立上传，二者成败无关，必须分别如实回显：

| 上传 | 载什么 | 结果在哪 |
|------|--------|---------|
| `steps.archive_push` | 归档 ZIP（核心产物） | `archiveId`/`archiveStatus`/`uploadStatus`/`knowledgeStatus`，同时落盘 `state/local/archive-packages/<cn>.remote.json` |
| `steps.managed_snapshot_push` | **归档交付物（每个变更目录的 `plans/`、`spec/`、`docs/` 全部，`reports/` 只取 `final/` 定稿）、`.harness/codebase` 架构地图、`.harness/rules`、`.harness/project.yaml`、指令入口** | `ok`/`reasonCode`/`exitCode`/`cliCode`/`detail` |

走 `harness-push`（remote-sync，产生分支快照）而非 legacy `push`（proposal 管道）。
归档目录下的 `runtime/`、`meta/`、`evidence/`、`logs/`、`fixback/`、`.publication-staging/`
等过程文件不上传；`reports/review/` 与 `reports/test/` 同样是过程产物，不上传——
这条边界与归档 ZIP 的包内容边界一致。交付物目录里的 `*.log`、`*.tmp`、凭证与 `.env*`
也仍被安全规则拦下。

```
远端归档：arc_3ff325bb…（archiveStatus=durable，uploadStatus=ready，knowledgeStatus=ready，8 文件）
受管快照：❌ MANAGED_SNAPSHOT_UPLOAD_FAILED（exitCode=1，detail=…）→ 归档 plan/spec/report 与规则/架构地图未上平台，需 npx hunter-harness harness-push --scope config,rules,architecture,instructions,branch_files --yes --non-interactive 重试
```

**第二条尤其不能省**：它是 best-effort，失败不阻断归档，于是最容易被淹没成一句警告——而平台上"分支文件里没有 plan/spec"正是它失败的后果。成功时也要写明 `submitted` 数量；`ok=false` 时必须带上 `reasonCode` 与 `detail`，不得省略或写成"已完成"。

## 渐进披露

- **Read `checklist.md`** 仅在 `execute` 返回结果缺失或 manifest 不一致时
- **Read `reference.md`** 仅在阻断恢复、受控范围认领或解释最终状态时
- **Read `templates/summary-data-template.json`** 仅在 summary 校验失败时

## 交互白名单

仅当生命周期结局不明确，或需要受控认领既有提交范围时，允许阻断式确认。拒绝后终止，不执行任何移动。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`archive`
