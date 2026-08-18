---
name: harness-test
description: "测试执行：读取场景表，执行单元测试+API接口测试+数据兼容验证，输出测试报告。仅当用户显式调用 /harness-test 时使用；不得在 run 结束后自动接续执行。"
disable-model-invocation: true
argument-hint: "变更名或留空自动检测"
effort: medium
allowed-tools: [Read, Glob, Grep, Write, Edit, Agent, Bash(powershell.exe:*)]
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
  - Bash(node *)
  - Bash(codegraph *)
---

# harness-test — 测试执行

## Purpose

读取测试场景表，逐条执行单元测试和接口测试，验证代码变更的正确性，输出测试报告。

## When to Use

仅当用户显式调用 `/harness-test` 时执行（已设 `disable-model-invocation`）。run 阶段结束后**不自动**进入本阶段；用户口头提到"跑测试"而未调用本 skill 时，先确认是否走 Harness 测试阶段。

**单阶段原则**：test 关门后必须停止并交还用户，仅提示 `plannedPhases` 中的真实下一阶段；禁止自动接续执行。

使用场景：
- 完成 `/harness-run` 编码后，验证单元测试 + 接口测试 + 数据兼容
- 修改公共模块 / 数据访问 / sql / 权限认证 / 接口层 / 数据契约 后需要真实接口验证
- run 阶段 ledger 可复用时，跳过单元测试重跑，只补接口测试

前置依赖：
- `.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md` 存在（测试真相源）
- `/harness-run` 已完成，或 ledger 中有可复用的 unitTest 结果
- 必须读取 `.harness/changes/<change-name>/meta/worktree.json`：`requested=true` 且 worktree 已创建 → 在 worktree 目录中执行测试；`requested=true` 但 worktree 不存在 → 停止，提示先修复 `harness-run`，不得静默回到主目录

跳过场景：
- 仅改了注释 / 格式化等非行为性清理，且 ledger `postTestClassification=NON_BEHAVIORAL_CLEANUP`，可复用已有 apiTest 结果，不必重跑

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow

测试跟踪由 `harness_gate.py begin/close` 统一协调 test guard；不得额外手工执行 guard close。任一失败都必须使用 gate 返回的结构化状态，不得以自然语言覆盖失败状态。所有 change/state 路径必须使用 `harness_change.py resolve` 或 context 返回的 `executionRoot`，不得固定拼接 `.harness/changes/**`；split-v1 默认位于 `.harness/state/changes/**`。

兼容实现中的底层命令名是 `harness_test_guard.py begin` 与 `harness_test_guard.py close`，两者只允许由 gate 内部调用；写在这里用于能力审计，不构成模型执行步骤。

并行服务测试先运行 `harness_change.py lease-port --change <id> --run-id <run-id> --range <start-end> --json`，再把返回端口传给 `harness_service.py ensure --leased-port <port> --lease-owner <run-id>`。`serviceStart` 的 command/health/overlay 可用 `{leasedPort}` 占位符；用户自启进程仍只进入 Service Gate，禁止 kill。测试清理的 `finally` 中运行 `harness_change.py release-port --change <id> --run-id <run-id> --json`，避免租约池耗尽。

### Phase -1：资源安全门（任何测试命令之前）

测试默认使用 `safe` 资源档位，禁止直接执行会把整套测试放进同一长生命周期的裸命令。所有本地测试命令必须由 `harness/scripts/harness_test_runner.py` 托管：

```text
python harness/scripts/harness_test_runner.py exec --profile safe --timeout-seconds <秒> -- <测试命令及参数>
```

对于 Python `unittest` 测试库，必须使用逐模块隔离模式，不得执行裸 `python -m unittest discover ...`：

```text
python harness/scripts/harness_test_runner.py unittest --profile safe --tests-dir <测试目录>
```

资源档位是硬合同：

- `safe`：默认；普通测试模块串行执行，每个模块使用全新进程。
- `system`：只执行服务生命周期、集成等资源密集型模块。
- `full`：先执行普通模块，再执行资源密集型模块；仍保持逐模块串行。
- `system` / `full` 只有在用户明确要求资源密集型测试、传入 `--confirm-resource-intensive`，或受控 CI 设置 `CI=true` / `HARNESS_ALLOW_RESOURCE_INTENSIVE_TESTS=1` 时才允许执行。

Runner 强制同项目单实例、低调度优先级、逐命令超时、正常结束和异常结束的进程树清理。`HARNESS_TEST_MAX_WORKERS` 默认且最高为 `2`，只能调低，不能调高；技术栈自身的并发参数也必须收敛到该值。Windows detached-service 模块在执行前先做 nested-breakaway 能力探测，受限沙箱不支持时立即返回 `DETACHED_PROCESS_CAPABILITY_UNAVAILABLE`，不得让每个服务用例逐一超时。出现该错误、`TEST_RUN_ALREADY_ACTIVE`、`PROCESS_TREE_ISOLATION_UNAVAILABLE` 或 `TEST_COMMAND_TIMEOUT` 必须停止，不得绕过 Runner 重跑裸命令。完整约束见 `checklist.md`「0.0-A 资源安全档位」。

动态数据库/Redis/令牌字段必须先由 `harness_environment.py prepare` 生成 secret-free receipt，再用 `exec --environment-receipt <file> --required-environment-field <NAME>` 闭包注入；缺失或指纹变化在启动测试前返回 `VERIFICATION_ENVIRONMENT_INCOMPLETE`。复杂 JSON、Docker template 或含引号参数不得跨多层 `-Command` 传递，改用 `exec --argv-file <utf8-json> --runtime-receipt <file>`；参数文件记录 PowerShell edition/version，运行回执只存 argv hash。`harness_service.py ensure` 属于正式持久服务模式，禁止从 bounded runner 内启动；命中时返回 `PERSISTENT_SERVICE_MODE_REQUIRED`。

预计超过交互窗口的正式验证使用 `harness_runtime.py run-start`，随后通过
`run-status` / `run-log --cursor` 重连；不得把调用方存活当作验证存活条件。环境 acquire
必须显式选择 `change-session`（同 change + 内容指纹复用）或 `ephemeral`（每次重置）。
验证 DAG 的并行度由 `resourceLocks` 决定，未分类重任务默认串行。完整合同见
`../protocols/execution-session-protocol.md`。

### Phase 0：环境准备（主会话执行，需要交互确认）

先 `harness_context.py prepare --project . --change <id> --phase test --executor <tool> --json`（`--project` 必填，漏了直接 argparse 报错），再 `harness_context.py begin --project . --change <id> --phase test --executor <tool> --json` 校验最新 run→test receipt 的 artifact/hash/HEAD；然后 **`harness_gate.py begin --phase test --change <id>`**（禁止手工 phase.start / 手写 ledger）。执行各项强制环境检查 + **命令执行模式 preflight (0.1)**；只有首选执行器不可用时，才执行 fallback 执行器探测。

验证写入**仅**允许 `harness_ledger.py record` / `can-reuse`；禁止 Write/Edit `verification-ledger.json`。测试跟踪：gate begin → 执行（可选 `harness_test_guard.py mark stale-test-repair`）→ 单次 `harness_gate.py close`。`--to-phase` 取实际阶段计划的后继；Fixback 返回 run，普通流程可直接进入 Review、Submit 或 Archive。Fixback 只失效与改动文件相交的验证目标。

- **Read `checklist.md`** — 各项检查详情 + 0.1 preflight + Playwright 探测 + 避坑规则指引
- **失败处理**：任一项检查失败 → 终止流程并报告原因，用户确认修复后才能继续
- 通过后进入 Phase 1

### Phase 0.1：命令执行模式 preflight（⚠️ 必须在编译/启动服务/生成 runner 之前执行）

`/harness-test` 高度依赖 PowerShell 与接口测试执行器。如果当前会话处于 Auto mode / 安全分类器降级 / PowerShell 被拒，会反复失败并错误降级到 Playwright MCP 逐条接口，造成长时间阻塞。**必须先做 4 项执行模式检查**（PowerShell 基础命令、执行器运行时可用性、构建工具可用性、安全分类器），将通过的 `executorPath` 写入 `.harness/changes/<change-name>/runtime/preflight.json`。

任一硬停情况（安全分类器不可用 / Auto mode 拦截 / PowerShell 被拒 / 执行器或构建工具不可执行）→ 原文输出"❌ 命令执行模式不可用..."，不得继续编译/启动服务/生成执行器，不得盲目降级到 Playwright MCP。用户确认切换权限模式后**必须重新执行 0.1**，重试 ≤ 1 次。详见 `reference.md`「命令执行模式 preflight」。

### Phase 0.2：fallback 执行器探测（仅在首选执行器不可用时执行）

只有 0.1 通过但首选接口测试执行器不可用时才执行 0.2。如果 0.1 已确认执行器在 PowerShell 中可用，直接选择 **接口测试执行器**（Node runner 为一种实现，可按项目替换），不得继续探测或使用 Playwright MCP。

严格优先级（不得颠倒）：接口测试执行器（默认首选，Node runner 为一种实现，可按项目替换为其他 HTTP 客户端）> PowerShell batch `.ps1`（首选不可用时降级）> Playwright MCP `browser_evaluate`（仅当 1+2 都不可用或用户明确选择）> curl + UTF-8 JSON body file（最后兜底）> 禁止直接用 curl 内联发送含中文 JSON body。

> ⚠️ Playwright MCP `browser_evaluate` 不得替代执行器。执行器在 PowerShell 可用时，**禁止**使用 Playwright MCP 逐条执行接口测试——认证凭证是独立凭证，应读认证凭证缓存，由执行器直连本地 baseURL 发起请求。详见 `reference.md`「fallback 执行器探测」。

### Phase 1-2：测试执行（默认主会话执行）

**Phase 1 前先检查 verification-ledger**：先执行 `harness_preflight.py check --project . --json`；profile 缺失或因清单、锁文件、源码根、技术栈变化而陈旧时立即执行一次 `detect --project . --json`。随后通过 state layout 解析后的路径调用 `harness_ledger.py can-reuse --project . --profile-input <key> --command <profile 解析出的规范命令>`；可复用时不得重跑。不得手工读取实现源码来猜账本参数。按返回的 `executionNeed` 使用中文：`first-run`=“尚未执行，需要首次运行”，`rerun`=“证据已失效，需要重新运行”，`evidence-incomplete`=“已有记录不完整，需要重新验证”，`reuse`=“现有证据可复用”；禁止把首次执行统一描述成“强制重跑”。

**默认在主会话执行**（不委派 subagent）：
- 单元测试：可复用则跳过重跑；否则按技术栈执行测试命令
- 接口测试：**强制批量执行器**，一次跑完全部场景，主会话只读 JSON

### Phase 3：覆盖率总结 + 关门检查（主会话执行）

读取测试报告，生成覆盖率总结，**执行关门检查**，包含：单元测试通过/失败/跳过计数、接口测试逐条结果+汇总+耗时、数据兼容验证汇总、败因分类（代码 Bug vs 测试脚本 vs 预存问题）、请求执行器及降级原因、关门检查 10 项（见「关键规则·十」）。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 每条规则的详细判定、模板、表格见 `reference.md` 对应章节；Shell 执行安全见 `../protocols/powershell-protocol.md`，证据化报告见 `../protocols/evidence-based-reporting-protocol.md`，敏感信息见 `../protocols/sensitive-info-protocol.md`，ledger 见 `../protocols/ledger-protocol.md`，状态目录见 `../protocols/state-layout-protocol.md`，结构化报告事件见 `../protocols/report-pipeline-protocol.md`。

### 一、接口测试工具优先级

强制优先级：**接口测试执行器**（默认首选，Node runner 为一种实现，可按项目替换为其他 HTTP 客户端）> PowerShell batch `.ps1`（首选不可用时降级）> Playwright MCP `browser_evaluate`（仅 1+2 不可用或用户明确选择）> curl + UTF-8 JSON body file（最后兜底，须通过 PowerShell 调用）。**禁止裸 `node`、禁止用 Bash 执行 node**（`disallowed-tools` 已禁 `Bash(node *)`）；执行器在 PowerShell 可用时**不得**用 Playwright MCP 逐条执行。详见 `reference.md`「接口测试工具优先级」。

### 二、批量测试执行 + Runner 三阶段

0.1 通过后生成 `.harness/changes/<change-name>/runtime/api-test-runner.mjs`（按技术栈选择实现，Node runner 为一种实现，可按项目替换），通过**一次命令**（PowerShell + 执行器绝对路径）执行全部场景，输出 `api-test-results.json`，主会话只读 JSON。执行器必须按 **setup / test / cleanup** 三阶段：setup 失败时依赖场景标 🟡 BLOCKED，**不得用 null ID 继续请求**。绝对路径从 `runtime/preflight.json` 的 `executorPath` 读取，禁止 hardcode。详见 `reference.md`「批量测试执行器」「执行器三阶段模板」。

### 三、请求体与测试数据

请求体必须从数据契约 / 接口定义 / 真实样例生成，**禁止临场猜字段、禁止先跑失败接口再补**。测试数据用唯一前缀 `TEST_<change-name>_<timestamp>_<random>`；唯一约束字段必须随机或避让，避免冲突导致大面积 BLOCKED。详见 `reference.md`「请求体生成」「测试数据治理」。

### 四、单元测试复用 + 写入 ledger

Phase 1 前用 `harness_ledger.py diff-hash` 和 `can-reuse` 重算真实指纹。验证目标必须使用 profile key 的单一入口：`--project . --profile-input unitTest|unitTestFull --command <规范命令>`；声明 `--profile-input` 后不得同时传入另一套 `--files`。`record` 与 `can-reuse` 必须消费同一 profile target，由 CLI 推导 scope、coverage、规范命令与输入闭包。`npx vitest run` 与 `vitest run` 等包装差异由账本规范化，`safe runner` 等说明只能写 `--runner-command` 元数据。可复用则跳过；否则执行同一 profile 命令并只登记一条结果。增量测试记 `unitTest`，模块全量记 `unitTestFull`，API/浏览器分别记录。详见 `checklist.md` 与 ledger protocol。

报告必须分开呈现“产品测试”与“工具维护”。`ownership.productPaths` 决定产品结论；`.cursor/.agents/.claude/.codebuddy` 的 Harness 投影、context-index 与安装状态变化只进入“工具维护”，不得单独把产品结果降为 WARN。已知升级使用明确文案“Harness 已从 <旧版本> 更新到 <新版本>”，不得写“无关漂移”。场景统计分别列出：已执行、待手工验收、已豁免、说明性、NOT_APPLICABLE；“未验证”必须只等于仍要求执行但尚未完成的场景数。

### 五、命令与请求超时治理

所有命令必须通过资源安全 Runner 设置「预期时长 + 超时上限」，超过预期必须输出一次状态行，**不得静默等待**。测试模块超时或退出时必须清理其进程树；`durationMs > 10000` → 🟡 SLOW，`> 30000` → ❌ TIMEOUT_RISK。详见 `reference.md`「命令与请求超时治理」。

### 五-A、陈旧测试安全修复

若测试编译或执行明确指向已移除/改名 API 的陈旧测试，且当前生产代码、已批准计划或可验证历史能唯一确定新契约，可仅修改测试并立即重跑该测试与目标测试，然后记录：

```text
python <skills-root>/scripts/harness_test_guard.py record --project . --change-dir ".harness/changes/<change-name>" --files "<精确测试文件路径，逗号分隔>" --reason stale-test-repair --json
```

普通新增/更新测试使用 `tdd-created` / `test-updated`。存在业务歧义或修复会触及生产代码时，记录 `BLOCKED_PREEXISTING` 并停止复用该验证，不得猜测或绕过。

**禁止临时排除测试**：禁止 `.bak`/改名、移出测试目录、删除、禁用注解、构建 exclude、`skipTests`/`maven.test.skip` 充当测试通过证据；服务启动可在单元测试已独立通过后使用 `-Dmaven.test.skip=true` 避免重复编译测试，但不得据此声明测试通过。所有本轮新增、更新或安全修复且被忽略的测试必须写入 test-tracking manifest；仅执行、未修改的只读 ignored test 不获得 force-track 授权。

### 六、服务启动 + 生命周期管理

启动等待状态机：0–30s 每 2s 探测、30–120s 每 5s 探测、>120s 读日志判定；遇启动失败特征立即停。**Service Gate**：`harness_service.py ensure` 返回 `action=needs-user-decision`（用户自启服务占端口）时 **才** blocking user confirmation；AI 托管服务或端口空闲则自动继续，不询问。服务指纹（`moduleInputsHash`，来自 CLI `--files` ∪ `serviceStart.inputFiles`）+ `startCommandHash` + `profile` + `overlayPath` + 进程身份任一变化即 restart；**空输入被拒绝**，不生成可复用空指纹。测试结束默认清理 AI 启动的服务。详见 `reference.md`「服务决策门」。

### 七、运行时配置叠加（不动 tracked 配置）

禁止默认 Edit tracked 应用配置文件。默认运行时配置叠加（ASCII 绝对路径）；改 tracked 配置 → 默认拒绝，记 `decision` 事件（不 blocking user confirmation，报告 🟡 WARN）。详见 `reference.md`。

### 八、Token 缓存与复用

先读 `.harness/changes/<change-name>/runtime/credential-cache.json`（认证凭证缓存，按项目认证机制；token/SSO 为常见实现），本地轻量接口验证通过则复用，失败才走远程认证。接口测试执行器用 request context / 原生 HTTP 客户端直连本地 baseURL，**不得依赖浏览器当前页面 origin**。同一次流程内凭证刷新计数 > 1 → 🟡 WARN。**不得在报告/日志/对话总结中输出明文凭证**。详见 `reference.md`「认证凭证缓存与复用」。

> ⛔ **验证码 = 硬停，不是待解的技术问题。** 登录响应出现 `验证码` / `captcha` / `blockPuzzle` / `slider` / `geetest` 等特征时，**禁止**编写或运行任何求解代码（图像匹配、OCR、打码平台、反编译服务端找容差均在禁止之列）。立即记 `apiTest=BLOCKED`，请用户手工把凭证写入 `runtime/credential-cache.json` 或临时关闭测试环境验证码，并提示 `.harness/config/harness-test-config.md` 的认证方式已过期。详见 `pitfalls.md` 规则 31。

### 九、测试报告状态规则

整体 ✅OK / 🟡WARN / ❌FAIL 三态；API 维度使用 `OK` / `PARTIAL` / `BLOCKED` / `NOT_RUN` / `FAIL` 五态。**不得把「5 PASS + 9 BLOCKED + 1 FAIL」写成 `apiTest=NOT_RUN`**，正确为 `apiTest=PARTIAL`。P0 场景 BLOCKED 不得仍 OK。详见 `reference.md`「结果分级规则」。

### 十、关门检查（结束前强制执行）

输出最终总结前必须执行 10 项：`git status --porcelain` / `git diff --stat` / `git diff --check`（失败→❌FAIL，必须 PowerShell-only）/ 明文敏感信息 / runtime 不提交 / 服务生命周期收尾 / 测试数据清理 / 执行器表完整 / 慢请求或超时 / 未清理+fallback+慢请求→至少 🟡WARN。详见 `checklist.md`「关门检查」、`reference.md`「关门检查」。

### 十一、请求执行器 fallback 输出 + 性能统计

报告必须区分四种执行器（接口测试执行器 / PowerShell batch / Playwright MCP browser_evaluate / curl），**不得笼统写"Playwright"**，不得把 "Playwright API 执行器" 与 "Playwright MCP browser_evaluate" 混写。报告必须含请求耗时统计表。详见 `reference.md`「请求执行器 fallback 输出」「输出格式」。

## Output Format

> 详细报告格式见 `reference.md` 的「输出格式」模板。

测试报告保存到 `.harness/changes/<change-name>/reports/test/test-report-YYYYMMDD-HHmm.md`（时间戳区分多次运行），同时在控制台输出摘要。

## 渐进披露

- **Read `checklist.md`** 仅在 Phase 0 环境准备时 — 含 各项强制检查、0.1 命令执行模式 preflight、服务生命周期清单
- **Read `reference.md`** 仅在执行接口测试时 — 含 API 测试执行方法、已知良好测试配置、运行时配置叠加、setup/test/cleanup 执行器模板、双格式错误码兼容
- **Read `pitfalls.md`** 仅在遇到测试失败时 — 含所有踩坑规则（30 条，含 Bash 执行执行器 / 运行时配置叠加 / 唯一字段冲突 / 服务生命周期等）

## 交互白名单

本 skill **仅允许**以下 blocking user confirmation；其余默认值 + `decision` 事件：

1. **Service Gate**：仅当 `harness_service.py ensure` 返回 `needs-user-decision`（用户进程占端口）时询问处理方式
2. **资源密集型测试确认**：仅当发布/验收确实需要 `system` 或 `full` 档位，且用户尚未明确授权时询问；获得授权后传入 `--confirm-resource-intensive`

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`test` · 事件：phase/command/verification/decision/issue/artifact
