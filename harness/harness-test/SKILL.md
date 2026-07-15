---
name: harness-test
description: "测试执行：读取场景表，执行单元测试+API接口测试+数据兼容验证，输出测试报告。当用户说'跑测试/验证/跑用例/接口测试/单元测试'时使用"
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

当用户明确要求运行测试时触发。典型触发语："跑测试""验证""跑用例""接口测试""单元测试"。属于自动调用型 skill（未设 `disable-model-invocation`），默认经 `/harness-test` 显式调用。

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

### Phase 0：环境准备（主会话执行，需要交互确认）

执行 各项强制环境检查 + **命令执行模式 preflight (0.1)**；只有首选执行器不可用时，才执行 fallback 执行器探测。

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

**Phase 1 前先读 verification-ledger**：读取 `.harness/changes/<change-name>/evidence/verification-ledger.json`，判断是否可复用 run 阶段的 unitTest（见「关键规则·四」）。

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

Phase 1 前先读 `.harness/changes/<change-name>/evidence/verification-ledger.json`，并用 `harness_ledger.py diff-hash --repo . --base <baseCommit> --change-dir ".harness/changes/<change-name>" --json` 重算真实指纹：run 的 unitTest 满足（diffHash 一致 + module/profile 一致 + scope 一致或更严格 + run 后无行为性修改 + run 跑了全量测试）则复用，否则按 **profile key resolve** 执行测试命令（`python <skills-root>/scripts/harness_profile.py resolve --project . --key unitTest|unitTestFull --json`，**不复制示例 `-pl` 命令**）。Phase 1/2 完成后必须写回 ledger：执行增量测试类 → 记 `unitTest`（scope=incremental）；执行 profile 模块全量命令 → 记 `unitTestFull`（scope=module，可供 submit 复用）；接口测试 → 记 `apiTest`。详见 `checklist.md`「单元测试复用」、`../protocols/ledger-protocol.md`。

### 五、命令与请求超时治理

所有命令必须有「预期时长 + 超时上限」，超过预期必须输出一次状态行，**不得静默等待**。`durationMs > 10000` → 🟡 SLOW，`> 30000` → ❌ TIMEOUT_RISK。详见 `reference.md`「命令与请求超时治理」。

### 五-A、陈旧测试安全修复

若测试编译或执行明确指向已移除/改名 API 的陈旧测试，且当前生产代码、已批准计划或可验证历史能唯一确定新契约，可仅修改测试并立即重跑该测试与目标测试，然后记录：

```text
python <skills-root>/scripts/harness_test_guard.py record --project . --change-dir ".harness/changes/<change-name>" --files "<精确测试文件路径，逗号分隔>" --reason stale-test-repair --json
```

普通新增/更新测试使用 `tdd-created` / `test-updated`。存在业务歧义或修复会触及生产代码时，记录 `BLOCKED_PREEXISTING` 并停止复用该验证，不得猜测或绕过。

**禁止临时排除测试**：禁止 `.bak`/改名、移出测试目录、删除、禁用注解、构建 exclude、`skipTests`/`maven.test.skip` 充当测试通过证据；服务启动可在单元测试已独立通过后使用 `-Dmaven.test.skip=true` 避免重复编译测试，但不得据此声明测试通过。所有本轮新增、更新或安全修复且被忽略的测试必须写入 test-tracking manifest；仅执行、未修改的只读 ignored test 不获得 force-track 授权。

### 六、服务启动 + 生命周期管理

启动等待状态机：0–30s 每 2s 探测、30–120s 每 5s 探测、>120s 读日志判定；遇启动失败特征立即停。**Service Gate**：`harness_service.py ensure` 返回 `action=needs-user-decision`（用户自启服务占端口）时 **才** AskUserQuestion；AI 托管服务或端口空闲则自动继续，不询问。服务指纹（`moduleInputsHash`，来自 CLI `--files` ∪ `serviceStart.inputFiles`）+ `startCommandHash` + `profile` + `overlayPath` + 进程身份任一变化即 restart；**空输入被拒绝**，不生成可复用空指纹。测试结束默认清理 AI 启动的服务。详见 `reference.md`「服务决策门」。

### 七、运行时配置叠加（不动 tracked 配置）

禁止默认 Edit tracked 应用配置文件。默认运行时配置叠加（ASCII 绝对路径）；改 tracked 配置 → 默认拒绝，记 `decision` 事件（不 AskUserQuestion，报告 🟡 WARN）。详见 `reference.md`。

### 八、Token 缓存与复用

先读 `.harness/changes/<change-name>/runtime/credential-cache.json`（认证凭证缓存，按项目认证机制；token/SSO 为常见实现），本地轻量接口验证通过则复用，失败才走远程认证。接口测试执行器用 request context / 原生 HTTP 客户端直连本地 baseURL，**不得依赖浏览器当前页面 origin**。同一次流程内凭证刷新计数 > 1 → 🟡 WARN。**不得在报告/日志/对话总结中输出明文凭证**。详见 `reference.md`「认证凭证缓存与复用」。

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

本 skill **仅允许**以下 AskUserQuestion；其余默认值 + `decision` 事件：

1. **Service Gate**：仅当 `harness_service.py ensure` 返回 `needs-user-decision`（用户进程占端口）时询问处理方式

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`test` · 事件：phase/command/verification/decision/issue/artifact
