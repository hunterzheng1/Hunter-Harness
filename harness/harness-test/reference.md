---
description: harness-test 的 API 测试执行细节、批量 runner、token 缓存、测试数据治理、报告模板和关门检查。仅在执行接口测试需要参考详细操作时读取。
---

# harness-test 参考 — API 测试详情

## 命令执行模式 preflight（0.1）

`/harness-test` 高度依赖 PowerShell 与接口测试执行器。在编译/启动服务/生成执行器 **之前**
必须执行 4 项执行模式检查：

| 检查项 | 命令 | 预期 |
|---|---|---|
| PowerShell 基础命令 | `powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion"` | exitCode=0 |
| 执行器运行时（如 Node） | `powershell.exe -NoProfile -Command "& 'C:\nvm4w\nodejs\node.exe' --version"` | exitCode=0 |
| 构建工具（如 Maven） | `powershell.exe -NoProfile -Command "mvn -version"` | exitCode=0 |
| 安全分类器 | 任一 PowerShell 命令是否返回"安全分类器暂时不可用"/"Auto mode 拦截" | 不应出现 |

将通过的 `executorPath` 等元数据写入 `.harness/changes/<change-name>/runtime/preflight.json`，
供后续接口测试执行器启动命令读取。

**触发硬停**（任一情况）：

- "安全分类器暂时不可用"
- Auto mode 导致 PowerShell 命令不可执行
- PowerShell 被拒
- PowerShell 可用但执行器 / 构建工具不可执行

**硬停输出**（不得意译，不得继续编译/启动服务/生成执行器，不得长时间等待，不得盲目降级到 Playwright MCP）：

```
❌ 命令执行模式不可用：PowerShell/接口测试执行器无法稳定执行。
请切换 Claude Code 权限模式，例如 bypassPermissions / 非 Auto mode，
或用允许命令执行的方式启动 Claude Code。
不要继续进入接口测试，避免长时间等待和错误 fallback。
```

重复重试 ≤ 1 次。

## fallback 执行器探测

### 探测流程

Phase 0.1 必须先确认 PowerShell / 执行器 / 构建工具 可用。

如果首选接口测试执行器可用，**不执行 fallback 探测**，直接使用接口测试执行器。
只有首选执行器不可用时，才按顺序探测 PowerShell batch、Playwright MCP、curl fallback。

**fallback 探测项**：

1. PowerShell batch runner (`.ps1`) 是否可用
2. Claude Code 是否暴露 Playwright MCP 工具（检查工具列表中是否有 `mcp__plugin_playwright_playwright__*`）
3. 如果可以执行命令，检查 `claude mcp list` 中是否有 playwright
4. `@playwright/mcp` 是否可启动
5. 当前 skill 的 `allowed-tools` 是否允许 Playwright 相关工具
6. curl fallback 是否只能使用 UTF-8 JSON body file，禁止中文 JSON 内联

### 输出格式

```markdown
### fallback 执行器可用性
| 项 | 结果 | 证据 |
|---|---|---|
| 接口测试执行器 | ✅使用 / ❌不可用 | ... |
| PowerShell batch runner | 未使用 / ✅fallback / ❌不可用 | ... |
| Playwright MCP browser_evaluate | 未使用 / ✅fallback / ❌不可用 | ... |
| curl + UTF-8 JSON body file | 未使用 / ✅fallback / ❌不可用 | ... |
| 最终决策 | 接口测试执行器 / PowerShell batch / Playwright MCP browser_evaluate / curl fallback | ... |
```

如果 fallback 不可用，必须写明原因，不得静默改用 curl。

## 接口测试工具优先级

**优先级**（从高到低）：

| 优先级 | 工具 | 适用场景 | 说明 |
|:------:|------|---------|------|
| 1 | **PowerShell + 接口测试执行器 (`.mjs`，Node runner 为一种实现)** | 默认且首选 | PowerShell + 执行器绝对路径执行，统一 baseURL/headers/凭证，结构化输出+耗时统计；可按项目替换为其他 HTTP 客户端 |
| 2 | **PowerShell batch runner (`.ps1`)** | 首选不可用时降级 | UTF-8 编码正确，可脚本化批量执行 |
| 3 | **Playwright MCP `browser_evaluate` + `fetch`** | 1+2 不可用时 fallback | UTF-8 编码正确，但每场景单独调用 MCP，**不得替代执行器** |
| 4 | **curl + UTF-8 JSON body file** | 最后兜底 | 必须先将 JSON body 写入 UTF-8 文件，再通过 PowerShell（`curl.exe` 或 `Invoke-RestMethod`，经 `Bash(powershell.exe:*)` 通道）发送；`disallowed-tools` 已禁 `Bash(curl *)`，不得用 Bash 直接 curl |
| ❌ | curl 内联含中文 JSON | **禁止** | Windows 下 GBK 编码导致 UTF-8 解析失败 |
| ❌ | Bash 裸 `node ...` | **禁止** | Bash 在中文路径项目下被 hook 拒绝；且 Node 在 Bash 中常不在 PATH |

> **Windows 环境避免用 curl 发送含中文的请求体**（GBK 编码导致 UTF-8 解析失败）。
> **如果执行器在 PowerShell 可用，禁止使用 Playwright MCP 逐条执行接口测试。**

## 已知良好测试配置（known-good-test-profile，按项目固化）

本项目默认使用 **local-dev profile + 本地数据库 + 远程缓存 + 远程 SDK 网关 + 远程认证服务**（按技术栈；Java Spring Boot 为例）。

```yaml
known-good-test-profile:
  name: <配置名，如 local-dev-remote-sdk>
  module: <模块/服务（按项目）>
  profile: <运行时 profile（按技术栈，如 Spring Boot 的 springProfile）>
  port: <端口>
  contextPath: <上下文路径>
  healthUrl: <健康检查 URL>

  database:
    primary: <主库连接（按项目）>
    cache: <缓存连接（按项目）>

  remote:
    gateway: <网关 URL（如适用）>
    sdkUrl: <外部 SDK URL（如适用）>
    authLoginUrl: <认证服务登录 URL（如 SSO）>

  overlay:
    pathStrategy: ascii-temp
    directory: C:/temp/harness-test-overlay
    fileName: application-harness-test.yml

  service:
    askBeforeReusingExisting: true
    askBeforeRestartingUserService: true
    stopAfterTest: true
    restoreOriginalService: false
```

默认不假设本地网关存在。

## 运行时配置叠加（不动 tracked 配置）

不要直接 Edit tracked 应用配置文件（如 `application-local-dev.yml`）。默认生成 ASCII 绝对路径运行时配置叠加：

```text
C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml
```

内容按已知良好测试配置渲染（按项目；Java Spring Boot 为例）：

```yaml
# 按项目填入需要覆盖的配置项，示例：
<external-service>:
  sdk:
    url: <外部 SDK URL>
spring:
  cloud:
    nacos:
      discovery:
        register-enabled: false   # 避免本地服务注册到线上
```

唯一默认启动命令（按技术栈，Java Spring Boot 为例）：

```powershell
powershell.exe -NoProfile -Command "mvn spring-boot:run -pl <module> -Dspring-boot.run.profiles=<profile> -Dspring-boot.run.jvmArguments='-Dspring.config.additional-location=file:C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml'"
```

不得默认使用 `.harness/changes/<change>/runtime/application-harness-test.yml` 相对路径作为 JVM `additional-location`。如必须修改 tracked 配置文件，先 AskUserQuestion，最终报告至少 🟡 WARN。

## 服务决策门（Service Decision Gate）与服务生命周期管理

运行时文件：

| 文件 | 内容 |
|---|---|
| `service.pid` | AI 启动/重启后的进程 PID |
| `service-start-command.txt` | 实际执行的 PowerShell 启动命令（脱敏） |
| `service-start.log` | 应用启动 stdout/stderr |
| `runtime/service-session.json` | pid、moduleInputsHash、moduleInputsFiles、profile、startCommandHash、overlayPath、command、startedBy、startedAt |

serviceState：`AI_STARTED` / `AI_RESTARTED_FROM_USER_SERVICE` / `USER_STARTED` / `REUSED_EXISTING` / `NOT_STARTED`。

> **Task 3 §5.1/§5.2**：`build-profile.json` 的 `serviceStart.inputFiles`（glob 列表，相对 project 展开）是服务指纹的来源；`harness_service.py ensure` 取 CLI `--files` ∪ `serviceStart.inputFiles` 计算依赖闭包。**空输入被拒绝**（exit 非 0，`service inputs are empty`），**不得生成可复用的空指纹**。通用项目 detect 无法猜 module 源，`inputFiles` 默认空数组，须人工配置。

发现已有应用服务时，先展示服务决策门，再问：

```text
1. 直接复用当前服务
2. 重启服务，使用已知良好测试配置
3. 跳过接口测试，只执行单元测试
4. 停止测试
```

只有 `service-session.json` 与当前**同时**满足以下条件才允许自动复用（§5.3）：`moduleInputsHash` 一致、`startCommandHash` 一致、`profile` 一致、`overlayPath` 一致、进程身份（pid 存活 + create time 与 `startedAt` 匹配）可确认。任一变化 -> AI 自动 restart；身份无法确认 -> `needs-user-decision`；非 AI 用户进程**永不自动 kill**。否则必须询问。

若用户选择重启已有服务，必须提示：测试结束后关闭新测试服务，不会恢复原服务。

最终报告必须包含 originalServicePid、originalServiceStopped、testServicePid、testServiceStopped、restoredOriginalService、finalPortState。

### 重入沿用

同一变更的 harness-test 重入时，若环境未变（PG/端口/执行器与上次一致）、上次已确认执行器方案、且源码未改服务启动逻辑，可沿用上次服务决策不重复询问，执行日志记 `重入沿用+环境未变`。不适用情形（fingerprint 不匹配、环境已变、USER_STARTED、源码改启动逻辑）仍须询问/重启。详见 checklist.md「0.10.x 重入沿用」。

## 启动等待状态机

| 阶段 | 探测频率 | 行为 |
|---|---|---|
| 0–30s | 每 2s 一次（端口 + healthUrl） | 命中即继续 |
| 30–120s | 每 5s 一次 | 命中即继续 |
| 超过 120s | 读取最近 200 行 `service-start.log` | 异常即停 |

立即失败的异常关键字（按技术栈识别，如 Java Spring Boot 的 `BindException` / `Could not resolve placeholder` /
`Connection refused during bean init` / `BeanCreationException` /
`Failed to start bean` / `BUILD FAILURE`）。

每等待 >10s 必须输出一次状态行：

```
服务启动中：elapsed=20s, port=not listening, lastLog="..."
```

## 批量测试执行器（强制 setup / test / cleanup 三阶段）

> ⚠️ **强制单次执行**：执行器必须一次性跑完所有场景并输出 JSON，主会话不再逐条调用 Playwright MCP。只有首选执行器失败才降级为 PowerShell batch / 多次 `browser_evaluate`。

### 文件位置

- 脚本：`.harness/changes/<change-name>/runtime/api-test-runner.mjs`
- 结果：`.harness/changes/<change-name>/runtime/api-test-results.json`
- 均在 `.harness/changes/<change>/runtime/` 下，不提交到 git

### 执行方式（一次命令，PowerShell + 执行器绝对路径）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& 'C:\nvm4w\nodejs\node.exe' '.harness/changes/<change-name>/runtime/api-test-runner.mjs'"
```

- 绝对路径默认 `C:\nvm4w\nodejs\node.exe`（Node runner 为一种实现，可按项目替换）；不同环境从 `preflight.json` 的 `executorPath` 读取
- 禁止裸 `node ...`，禁止用 Bash 执行 node
- 失败 ≤ 1 次重试，仍失败必须提示用户切换权限模式或手动执行执行器

执行器内部按 setup → test → cleanup 三阶段，失败时不会用 null ID 继续请求。
主会话只 Read `api-test-results.json` 生成摘要，不再调用 MCP。

### 执行器三阶段模板（setup / test / cleanup）

```javascript
// api-test-runner.mjs — 批量接口测试执行器（PowerShell + 执行器绝对路径执行；Node runner 为一种实现，可按项目替换）
import { request } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';

const BASE_URL = 'http://127.0.0.1:<port>';              // 直连本地 baseURL
const CONTEXT_PATH = '<context-path>';
const HEADERS = {
  'Content-Type': 'application/json; charset=UTF-8',
  'tenant-id': '1'   // 如项目适用，从配置读取
};
const RESULTS_FILE = '.harness/changes/<change-name>/runtime/api-test-results.json';
const CREDENTIAL_CACHE = '.harness/changes/<change-name>/runtime/credential-cache.json';

// ===== Payload schema（从数据契约/接口定义/真实样例生成，禁止临场猜）=====
// 关键字段从项目的数据契约（如 VO/DTO/接口定义）读取，必填字段逐一核对
// 详见 .harness/changes/<change>/plans/<change>-test-scenarios.md

const setupState = {
  resourceId: null,
  errors: []
};

// ===== 凭证复用：先本地轻量接口验证，失败才走远程认证服务 =====
let credentialRefreshCount = 0;
async function resolveCredential(role) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(CREDENTIAL_CACHE, 'utf8')); } catch {}
  const entry = cache.credentials?.[role];
  if (entry?.token) {
    const ctx = await request.newContext({ baseURL: BASE_URL });
    const probe = await ctx.get(`${CONTEXT_PATH}/meta`, {   // 本地轻量健康接口
      headers: { ...HEADERS, Authorization: `Bearer ${entry.token}` },
      timeout: 5000
    });
    if (probe.ok()) return entry.token;
  }
  if (credentialRefreshCount >= 1) {
    throw new Error('凭证重取超过 1 次，请检查认证服务/账号配置');
  }
  credentialRefreshCount++;
  return await loginViaAuthService(role);   // 写回 cache
}

// ===== setup：创建前置数据 =====
async function setup(token) {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  // 唯一前缀，避免冲突
  const prefix = `TEST_<change-name>_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  // 唯一约束字段必须随机或避让，避免冲突导致 BLOCKED
  const uniqueField = 900000 + Math.floor(Math.random() * 9999);
  try {
    const resp = await ctx.post(`${CONTEXT_PATH}/<resource>/create`, {
      headers: { ...HEADERS, Authorization: `Bearer ${token}` },
      data: JSON.stringify({
        // payload 字段从数据契约/接口定义/真实样例生成，禁止临场猜
        code: `${prefix}_res1`,
        name: `${prefix}_资源`,
        uniqueField   // 唯一约束字段，随机或避让
      }),
      timeout: 10000
    });
    const json = await resp.json();
    if (json.code === 0 || json.code === '0') {
      setupState.resourceId = json.data?.id;
    } else {
      setupState.errors.push({ step: 'createResource', code: json.code, message: json.message });
    }
  } catch (e) {
    setupState.errors.push({ step: 'createResource', error: e.message });
  }
}

// ===== test：依赖判定 → BLOCKED 不发请求 =====
const results = [];
async function runOne(scenario, token) {
  // 依赖检查
  if (scenario.requires?.resourceId && !setupState.resourceId) {
    results.push({ scenario: scenario.id, status: 0, passed: false, state: 'BLOCKED',
                   reason: 'setup.createResource failed' });
    return;
  }
  const start = Date.now();
  try {
    const ctx = await request.newContext({ baseURL: BASE_URL });
    const url = scenario.url.replace('{resourceId}', setupState.resourceId ?? '');
    const resp = await ctx.fetch(url, {
      method: scenario.method,
      headers: { ...HEADERS, ...scenario.headers, Authorization: `Bearer ${token}` },
      data: scenario.body ? JSON.stringify(scenario.body(setupState)) : undefined,
      timeout: scenario.timeout || 10000
    });
    const data = await resp.json();
    const durationMs = Date.now() - start;
    results.push({
      scenario: scenario.id, method: scenario.method, url,
      status: resp.status(), code: data.code, message: data.message || data.msg,
      durationMs,
      state: checkPassed(scenario, resp.status(), data) ? 'PASS' : 'FAIL',
      passed: checkPassed(scenario, resp.status(), data)
    });
  } catch (err) {
    results.push({
      scenario: scenario.id, method: scenario.method, url: scenario.url,
      status: 0, code: 'ERROR', message: err.message,
      durationMs: Date.now() - start,
      state: 'FAIL', passed: false
    });
  }
}

// ===== cleanup：尽力清理 =====
async function cleanup(token) {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  let cleaned = 0, leftover = 0;
  const errors = [];
  if (setupState.resourceId) {
    try {
      const resp = await ctx.delete(`${CONTEXT_PATH}/<resource>/${setupState.resourceId}`, {
        headers: { ...HEADERS, Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      if (resp.ok()) cleaned++; else { leftover++; errors.push({ id: setupState.resourceId, status: resp.status() }); }
    } catch (e) {
      leftover++; errors.push({ id: setupState.resourceId, error: e.message });
    }
  }
  return { cleaned, leftover, errors };
}

// ===== 主流程 =====
const token = await resolveCredential('admin');
await setup(token);
for (const scenario of scenarios) {
  await runOne(scenario, token);
}
const cleanupResult = await cleanup(token);

const summary = {
  runner: 'api-test-executor',
  scenariosTotal: results.length,
  passed: results.filter(r => r.state === 'PASS').length,
  failed: results.filter(r => r.state === 'FAIL').length,
  blocked: results.filter(r => r.state === 'BLOCKED').length,
  skipped: results.filter(r => r.state === 'SKIPPED').length,
  setupErrors: setupState.errors,
  cleanupResult,
  credentialRefreshCount,
  startedAt: '<ISO>', finishedAt: '<ISO>', durationMs: 0
};
writeFileSync(RESULTS_FILE, JSON.stringify({ results, summary }, null, 2));
console.log(`\n结果已写入 ${RESULTS_FILE}`);
```

> **关键点**：
> - `setup` / `test` / `cleanup` 三阶段，依赖未满足时标 `BLOCKED`，**不发起请求**
> - 执行器用 `request.newContext({ baseURL })` 或原生 HTTP 客户端 **直连本地 baseURL**
> - 凭证从本地 cache 读 + 本地轻量接口验证，**完全不依赖浏览器当前页面 origin**
> - 同一次执行内 `credentialRefreshCount` 不得 > 1
> - payload 从数据契约/接口定义/真实样例生成，并在脚本注释中标注字段来源

### 执行器降级方案（PowerShell batch runner .ps1）

```powershell
# api-test-runner.ps1 — PowerShell 批量接口测试
$baseUrl = "http://127.0.0.1:<port>"
$headers = @{
  "Content-Type" = "application/json; charset=UTF-8"
  "tenant-id" = "1"   # 如项目适用
}

$results = @()
foreach ($scenario in $scenarios) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $body = $scenario.body | ConvertTo-Json -Depth 10 -Compress
    $resp = Invoke-RestMethod -Uri "$baseUrl$($scenario.url)" -Method $scenario.method -Headers $headers -Body $body -ContentType "application/json; charset=UTF-8"
    $sw.Stop()
    $results += [PSCustomObject]@{
      scenario = $scenario.id
      method = $scenario.method
      url = $scenario.url
      status = 200
      code = $resp.code
      message = $resp.message
      durationMs = $sw.ElapsedMilliseconds
      passed = $true
    }
  } catch {
    $sw.Stop()
    $results += [PSCustomObject]@{
      scenario = $scenario.id
      method = $scenario.method
      url = $scenario.url
      status = $_.Exception.Response.StatusCode.value__
      code = "ERROR"
      message = $_.Exception.Message
      durationMs = $sw.ElapsedMilliseconds
      passed = $false
    }
  }
}

$results | ConvertTo-Json -Depth 4
```

## 命令与请求超时治理

所有命令必须有"预期时长 + 超时上限"，超过预期时长**必须输出一次当前状态**：

| 命令类型 | 预期 | 超时 | 超时行为 |
|----------|:----:|:----:|----------|
| PowerShell preflight (0.1) | 1–2s | **5s** | 失败立即停 0.1 |
| 接口测试执行器（普通） | 30s | **60s** | 抛错继续报告，不再重试 |
| 接口测试执行器（复杂场景） | 60s | **120s** | 同上 |
| 凭证获取（认证服务） | 5–10s | **15s** | 计 1 次重取；超过 1 次 → 🟡 WARN |
| 单个 HTTP GET | < 1s | **8s** | durationMs > 10s → 🟡 SLOW |
| 单个 HTTP POST/PUT | < 2s | **10s** | durationMs > 10s → 🟡 SLOW |
| health probe | < 1s | **3s** | 计入启动状态机 |
| 构建工具编译（如 Maven compile） | 10–60s | **180s** | 输出最后 30 行日志后停 |
| 测试命令（如 Maven test） | 60–180s | **300s** | 输出失败用例后停 |
| service start | 30–60s | **120s** | 4.1 启动状态机收敛 |

**反馈规则**：
- 等待 > 10s 必须输出一次状态行（启动等待、执行器、构建工具均适用）
- 不得静默等待
- `durationMs > 10000` → 🟡 SLOW
- `durationMs > 30000` → ❌ TIMEOUT_RISK
- 请求慢不得忽略，必须说明是服务、网络、认证还是工具调用开销

## 认证凭证缓存与复用

### 缓存文件

`.harness/changes/<change-name>/runtime/credential-cache.json`（不提交到 git）

### 缓存结构

```json
{
  "baseUrl": "http://127.0.0.1:<port>",
  "profile": "<profile>",
  "credentials": {
    "admin": {
      "username": "admin",
      "role": "<角色，如 SUPER_ADMIN>",
      "token": "<raw token only in runtime file>",
      "tokenHash": "<sha256 prefix>",
      "createdAt": "2026-06-22T10:00:00+08:00",
      "lastValidatedAt": "2026-06-22T10:15:00+08:00",
      "expiresAt": null
    },
    "normal_user": {
      "username": "user1",
      "role": "<角色，如 NORMAL>",
      "token": "<raw token only in runtime file>",
      "tokenHash": "<sha256 prefix>",
      "createdAt": "2026-06-22T10:00:00+08:00",
      "lastValidatedAt": "2026-06-22T10:15:00+08:00",
      "expiresAt": null
    }
  }
}
```

### 凭证使用策略

1. 先读取 `credential-cache.json`
2. 如果已有目标角色凭证，先用**本地轻量接口**验证（如 `GET /meta`，直连本地 baseURL）
3. 验证通过（200 + code=0）则复用，**不重新登录、不访问远程认证服务**
4. 验证失败（401 / 凭证过期 / login required）→ 才访问远程认证服务（如 SSO）重新获取并写回 cache
5. 同一上下文中，前面已获取过凭证时必须优先复用
6. **接口测试执行器必须使用 request context 或原生 HTTP 客户端直接请求本地 baseURL，不得依赖浏览器当前页面 origin**
7. **不得因浏览器当前页面 origin 在认证服务就重新获取凭证**——凭证是独立凭证，与浏览器停留页面无关
8. **禁止低效流程**：先在远程认证服务页面获取凭证 → 导航到 localhost → 再重新获取凭证。正确流程是直接用本地 baseURL + 已缓存凭证验证，缓存失效才走认证服务
9. **不得在报告、execution-log、对话总结中输出明文凭证**

> 凭证脱敏与持久化处理遵循 `../protocols/sensitive-info-protocol.md`。

**输出示例（正确）**：
```
凭证策略：
- admin 凭证: ✅ 复用缓存（本地轻量接口验证通过），lastValidatedAt=2026-06-22T10:15:00+08:00
- normal 凭证: 🔄 缓存失效，已通过认证服务刷新
Admin 凭证获取成功：<CREDENTIAL_REDACTED>，hash=sha256:abcd1234
```

**输出示例（错误）**：
```
Admin 凭证获取成功：aedcf3b8c9d2e1f4...
```

## 测试数据治理

### 测试数据命名

接口测试创建数据必须使用唯一前缀：

```
TEST_<change-name>_<timestamp>_<short-random>
```

示例：`TEST_fix-pagination_20260622_a3f2`

所有测试数据编码、名称等必须带此前缀。

### 测试数据冲突预防

存在唯一约束的字段（按项目识别）：

1. 使用随机值（如 `900000 + random`）
2. 先查询已有值后避让
3. 使用唯一隔离值

**不得**因唯一约束字段与本地预存数据冲突导致大面积 BLOCKED。

### 请求体生成（禁止临场猜字段）

生成执行器前必须建立 payload schema：

1. 读取对应数据契约 / DTO / 接口定义（如 `<XxxSaveReqVO>` / `<XxxQueryReqVO>`）
2. 读取接口层方法（参数注解、校验注解，如 Controller 方法）
3. 读取已有测试 / Postman / 真实请求样例
4. 在执行器注释或 JSON 中记录字段来源（如 "from <数据契约名>"）

### 测试数据记录

测试报告必须包含测试数据表：

```markdown
## 测试数据
| 类型 | ID | Code | 用途 | 是否需要清理 |
|------|----|------|------|:----------:|
| 资源 | 123 | TEST_fix-pagination_20260622_a3f2_res1 | 分页查询测试 | ✅ 已清理 |
| 资源 | 456 | TEST_fix-pagination_20260622_a3f2_res2 | 分页查询测试 | 🟡 接口不支持删除 |
```

### 清理策略

- 如果接口支持删除、禁用或回滚 → 测试结束后清理
- 不能清理 → 记录遗留数据和原因
- 不得反复试错创建冲突数据

## 响应验证

- HTTP 状态码 与预期对比
- `code` 字段 与预期对比（**自动兼容两种格式**：下划线 `1_003_002_009` 和数字 `1003002009`）
- `message` 关键词匹配（模糊匹配即可）

## 数据兼容测试

如果场景表有「数据兼容场景」：查询已有数据，验证新字段返回 null 或默认值，不报错。

## 覆盖标注诚实性规则

场景状态标注规则：

- ✅ 仅当断言实际执行**且**场景声明的前置条件/数据真实构造。
- 🟡（推断）：未构造场景条件、以相邻场景或同接口行为推断时使用，必须注明推断依据。
- 用同一请求重复调用来"覆盖"不同异常场景 → 一律 🟡。
- 报告汇总行的通过数只统计 ✅。

## 输出格式（测试报告模板）

测试完成后，将报告保存到 `.harness/changes/<change-name>/reports/test/test-report-YYYYMMDD-HHmm.md`（时间戳格式：日期+时分），同时在控制台输出摘要。

```markdown
## 测试报告 — <功能名>

### 请求执行器
- 接口测试执行器:                ✅ 使用 / ❌ 不可用，原因：...
- PowerShell batch runner (.ps1):  未使用 / 🟡 fallback，原因：...
- Playwright MCP browser_evaluate: 未使用 / 🟡 fallback，原因：...
- curl:                            未使用 / 🟡 fallback，原因：...

### 服务生命周期
| 项 | 值 |
|---|---|
| serviceState | AI_STARTED / USER_STARTED / REUSED_EXISTING / NOT_STARTED |
| pid | 12345 |
| startCommand | <脱敏的 PowerShell 启动命令> |
| stopAfterTest | true / false |
| stopped | ✅ / ❌ / N/A |

### 凭证策略
- admin 凭证: ✅ 复用缓存（本地验证通过） / 🔄 缓存失效已刷新（认证服务）
- normal 凭证: ✅ 复用缓存 / 🔄 已刷新
- credentialRefreshCount: 0 / 1（>1 → 🟡 WARN）

### 单元测试
> ✅ 复用 harness-run 单元测试结果：Tests run: N, Failures: 0, Errors: 0
> （diffHash=<...>, module=<...>, profile=<...>, scope=<...>）
> 或：🔄 已重跑（原因：diffHash 变化 / 行为性 post-test 修改 / run 未跑全量）

| 指标 | 数值 |
|------|:----:|
| 总测试数 | 31 |
| 通过 | 31 |
| 失败 | 0 |
| 跳过 | 0 |

### 执行器三阶段
| 阶段 | 状态 | 说明 |
|---|---|---|
| setup | ✅ 全部成功 / ❌ N 个错误 | createResource OK |
| test | N PASS / M FAIL / K BLOCKED / J SKIPPED | BLOCKED 全部因 setup.createResource 失败 |
| cleanup | cleaned=X / leftover=Y | 接口 /<resource> 不支持删除，2 条遗留 |

### 接口测试
| # | 场景 | 方法 | URL | 预期 | 实际 | durationMs | 状态 |
|:--:|------|:----:|-----|------|------|----------:|:--:|
| API-001 | 创建资源 | POST | /api/xxx | 200, code=0 | 200, code=0 | 245 | ✅ PASS |
| API-002 | 参数校验 | POST | /api/xxx | code=xxx | code=xxx | 180 | ✅ PASS |
| API-003 | 查询子规则 | GET | /api/xxx/{id} | 200 | — | — | 🟡 BLOCKED（setup.createRule 失败） |

### 请求耗时统计
| 场景 | 方法 | URL | durationMs | 状态 |
|------|:----:|-----|----------:|:----:|
| API-001 | POST | /api/xxx | 245 | ✅ |
| API-010 | GET | /api/yyy | 12450 | 🟡SLOW |

### 数据兼容
| # | 场景 | 预期 | 实际 | 结果 |
|:--:|------|------|------|:--:|
| COM-001 | 旧数据查询 | 200, 不报错 | 200, 新字段=null | ✅ |

### 测试数据
| 类型 | ID | Code | 用途 | 是否需要清理 |
|------|----|------|------|:----------:|
| 资源 | 123 | TEST_xxx_20260622_a3f2_res1 | 分页测试 | ✅ 已清理 |

### 汇总
- 单元测试: N 通过 / 0 失败
- 接口测试: K PASS / L FAIL / B BLOCKED / S SKIPPED / P 🟡SLOW
- 数据兼容: N 通过 / 0 失败
- 请求执行器: 接口测试执行器（✅ 正常）
- serviceState: AI_STARTED → ✅ stopped
- 测试数据: N 条已清理 / M 条遗留
- credentialRefreshCount: 0

### final-summary（顶层维度状态）
- compile: ✅ OK
- unitTest: ✅ OK / 🟡 REUSED_FROM_RUN
- apiTest: **OK / PARTIAL / BLOCKED / NOT_RUN / FAIL**
  - 例：`apiTest=PARTIAL` — 15 个 API 场景中 5 个 PASS，9 个 BLOCKED，1 个 FAIL
- gitDiffCheck: ✅
- serviceLifecycle: ✅ AI_STARTED stopped / 🟡 USER_STARTED 保留

### 关门检查结果
- git status --porcelain: ✅/❌
- git diff --stat: ✅/❌
- git diff --check: ✅/❌（❌ → 最终结果 ❌FAIL）
- 明文敏感信息: ✅无/❌有
- runtime 不提交: ✅已确认
- 服务生命周期: AI_STARTED→✅stopped(pid=12345) / USER_STARTED→🟡保留 / REUSED_EXISTING→🟡保留
- 测试数据清理: ✅已清理/🟡N条遗留
- 执行器表完整性: ✅四种执行器均已列出，未与接口测试执行器混写

### 下一步
- 如果 ✅OK：进入 /harness-review
- 如果 🟡WARN：根据 WARN 原因决定是否补充测试或进入 review
- 如果 ❌FAIL：修复失败项后重新运行 /harness-test
```

## CLI 速查（gate / ledger）

> test 阶段常用子集。`--task` **仅在该 change 启用 checkpoint 时必需**。ledger status 枚举: ok|fail|not_run（没有 PASS）。`record` 还需 `--duration-ms`、`--evidence`，以及 `--files` 或 `--profile-input`+`--project`。
> `--skills-root` 仅用于 `begin`（及 `lint-skills`）：必须是 adapter 根（如 `.cursor/skills`），不是 `scripts/` 子目录。**`close` 不需要 `--skills-root`**（该子命令不接受此参数）。

```powershell
# gate begin/close（phase=test；--task 仅 checkpoint 启用时必需；close 不需要 --skills-root）
python <skills-root>/scripts/harness_gate.py begin --change <cn> --phase test --skills-root <skills-root> [--task N]
python <skills-root>/scripts/harness_gate.py close --change <cn> --phase test --status OK [--task N]

# ledger 记录 / 复用（--profile-input = verification key，不是文件路径）
python <skills-root>/scripts/harness_ledger.py record --change-dir <dir> --verification unitTestFull --status ok --command "<完整命令>" --exit-code 0 --duration-ms 120000 --evidence "Tests run: N, Failures: 0" --coverage full --files "packages/core/src/index.ts"
python <skills-root>/scripts/harness_ledger.py can-reuse --change-dir <dir> --verification unitTestFull --profile-input unitTestFull --project <project>
```

> **Ledger v3（v2 契约 / split-v1 布局起）**：`record` 强制顶层身份（缺失非零退出、不写账本）；`--metrics-json` 必须过 typed schema（unit/apiContract/browserE2E/dbCompatibility 各有不同必填键）；dbCompatibility 等不适用验证用 `--applicability NOT_APPLICABLE --applicability-reason "<scope 原因>"`（不计通过也不计失败）。legacy 契约行为不变。详见 `../protocols/ledger-protocol.md` 第十节。

### 常见报错对照

| 报错 | 原因 | 处理 |
|------|------|------|
| `unsupported status: PASS` | ledger status 无 PASS | 改用 `ok` / `fail` / `not_run` |
| `TASK_NUMBER_REQUIRED` | 该 change 启用了 checkpoint（如 foundation-gate pending） | 补 `--task N` |
| skills-root / BUNDLE_IDENTITY_* | `begin` 未传或传了 `.../scripts` 子目录（`close` 不接受该参数） | 仅对 `begin` 显式传 adapter 根：`.cursor/skills` / `.claude/skills`（含 `.harness-build.json`） |
| `--profile-input` 指向文件路径 | 参数语义是 verification key | 传 `compile` / `unitTestFull` 等 key，不是 JSON 路径 |
| `record requires --files or a non-empty --profile-input file set` | 缺少输入文件集 | 补 `--files` 或 `--profile-input <key> --project <project>` |
| `--profile-input requires --project` | can-reuse/record 展开 profile 需要项目根 | 补 `--project <project>` |
| `record` 缺 `--duration-ms` / `--evidence` | 参数为必填 | 按模板补齐 |

## 结果分级规则

> 结果状态分级与证据要求遵循 `../protocols/evidence-based-reporting-protocol.md`。

### 整体结果

**✅OK**（全部满足）：
- 所有 P0 接口/权限/数据兼容场景真实验证通过
- 无未解释的环境变更
- 请求执行器、token 策略、测试数据均有记录
- 关键测试请求有 durationMs 证据
- git diff --check 通过
- 服务生命周期已正确收尾

**🟡WARN**（任一满足）：
- 业务验证通过，但存在测试环境变更
- 使用了 fallback 请求执行器
- 有测试数据未清理
- 有 P1 场景未验证
- 有慢请求（🟡SLOW）/ 任一 P0 场景被跳过 / BLOCKED
- 有非关键降级
- AI_STARTED 服务未关闭
- `credentialRefreshCount > 1`

**❌FAIL**（任一满足）：
- 任一 P0 场景 FAIL（请求执行了，断言失败）
- 服务无法启动 / 0.1 命令执行模式失败且未恢复
- 编译/单测失败
- 批量 runner 执行失败且无有效 fallback
- git diff --check 失败

> **P0 场景 BLOCKED 不得仍 OK**：必须 🟡 WARN 或 ❌ FAIL。

### API 测试维度状态（final-summary 中输出）

| 状态 | 定义 |
|---|---|
| `OK` | P0 API 全部 PASS |
| `PARTIAL` | 部分 PASS + 部分 FAIL/BLOCKED |
| `BLOCKED` | P0 API 全部无法执行（环境/前置数据） |
| `NOT_RUN` | 完全没执行任何 API |
| `FAIL` | P0 API 明确 FAIL |

> ⚠️ **不得**把"5 PASS + 9 BLOCKED + 1 FAIL"写成 `apiTest=NOT_RUN`。正确：`apiTest=PARTIAL`。

## 请求执行器 fallback 输出

在测试报告中必须区分四种执行器（不得笼统写"Playwright"）：

```markdown
## 请求执行器
- 接口测试执行器:                ✅ 使用 / ❌ 不可用，原因：...
- PowerShell batch runner (.ps1):  未使用 / 🟡 fallback，原因：...
- Playwright MCP browser_evaluate: 未使用 / 🟡 fallback，原因：...
- curl:                            未使用 / 🟡 fallback，原因：...
```

默认期望：`接口测试执行器 ✅ 使用`，其余三项 `未使用`。

- 如果执行器正常执行，其余三项均标"未使用"
- 如果首选执行器不可执行降级为 PowerShell batch / 多次 MCP `browser_evaluate`，按实际标 🟡 fallback 并写原因
- 如果最终用了 curl，必须解释为什么接口测试执行器、PowerShell batch、Playwright MCP 都不可用
- **不得**把 "Playwright API 执行器" 与 "Playwright MCP browser_evaluate" 混写

## 关门检查

在输出最终总结前，必须执行并展示以下 10 项检查：

1. `powershell.exe -NoProfile -Command "git status --porcelain"`
2. `powershell.exe -NoProfile -Command "git diff --stat"`
3. `powershell.exe -NoProfile -Command "git diff --check"`（如果失败 → 最终结果 ❌FAIL）
4. 检查报告和日志是否包含明文凭证/password/secret/access-key/client-secret
5. 检查 `.harness/changes/<change>/runtime/` 是否不会被提交（.gitignore 确认）
6. **服务生命周期收尾**：AI_STARTED→Stop-Process / USER_STARTED→只提示 / REUSED_EXISTING→保留或用户确认 / NOT_STARTED→N/A
7. 检查测试数据是否需要清理
8. 检查请求执行器结果是否完整（4 种执行器表完整、未与接口测试执行器混写）
9. 检查是否存在慢请求或超时风险
10. 如果存在未清理测试数据、fallback 请求执行器、慢请求或环境变更 → 至少 🟡WARN

## 真实 diffHash 生成

> diffHash 与 ledger 复用规则遵循 `../protocols/ledger-protocol.md`。

后续复用 ledger 前必须生成真实 SHA-256 diffHash，且必须同时覆盖 tracked/untracked 变化和 test-tracking manifest 中被忽略的测试。`<baseCommit>` 从 ledger 读取（plan 阶段写入），缺失时用 `git merge-base HEAD <默认分支>`：

```powershell
python <skills-root>/scripts/harness_ledger.py diff-hash --repo . --base <baseCommit> --change-dir ".harness/changes/<change-name>" --json
```

写入 `.harness/changes/<change>/evidence/verification-ledger.json`：

```json
{
  "diffHash": "sha256:<real_hash>",
  "algorithmVersion": "content-changeset-2"
}
```

禁止使用描述性字符串、单段 `git diff` 或自写 hash 替代脚本。manifest 无效、路径越界或 hash 漂移时必须停止，不得删除 manifest 后继续复用旧 ledger。

## 执行日志记录

`/harness-test` 只向 `events.ndjson` 追加事件（schema_version 3，兼容读取 v1/v2）；`logs/execution-log.md` 由 `harness_events.py append` 自动渲染。Phase 0 之前 append `phase.start`；各阶段写入 `command` / `verification` / `decision` / `issue` / `artifact`，人类可读摘要放 `note`。事件类型与脚本用法见 [[../protocols/report-pipeline-protocol.md|report-pipeline-protocol]] 与 SKILL.md `## 执行日志`。

关键 `note` / 事件须覆盖：0.1 命令执行模式、fallback 执行器、serviceState、凭证策略、单元测试复用、批量执行器、verification-ledger 写入、关门检查、API 状态（不得把 PARTIAL 写成 NOT_RUN）。
