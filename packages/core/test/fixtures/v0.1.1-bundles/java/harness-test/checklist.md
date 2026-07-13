---
description: harness-test 的 Phase 0 环境准备 + Playwright 探测 + 关门检查清单。仅在执行测试前的环境准备阶段读取。
---

# harness-test 检查清单 — Phase 0 环境准备 + 关门检查

这 7 项确认完了再开始测试。每一项背后都有踩坑经历。

#### 0.0 加载项目配置（如存在）与确定变更名

先检查当前项目的测试配置文件（按优先级查找）：

1. **优先**：`.harness/config/harness-test-config.md`（集中配置目录）
2. **兼容**：`.claude/skills/harness-test/harness-test-config.md`（旧路径，过渡期仍支持）

如果任一文件存在，**必须先读取并应用其中的配置**。配置文件通常包含：

- **登录端点**：本地无法直接登录时，远程 SSO/Gateway 的登录 URL
- **测试账号**：各权限级别的用户名密码（如 admin、一层组织管理员等）
- **真实测试数据**：有效的部门编码和名称、项目 ID、规则 ID 等
- **环境调整**：需要使用的 profile、需要临时放行的 URL 路径、需要跳过的模块
- **避坑补充**：本项目特有的已知问题和解决方案

**Profile 选择**（从配置文件读取，如无配置则询问用户）：

| Profile | 适用场景 | 配置文件 |
|---------|---------|---------|
| `local` | 连接远程数据库/Redis | `application-local.yml` |
| `local-dev` | 完全本地隔离 | `application-local-dev.yml` |

> **关键**：不指定 profile 时默认使用 `application.yml` 中的配置（可能指向生产环境），必须显式指定。启动命令必须包含 `--spring.profiles.active=<profile>`。

然后确定变更名：用 Glob 搜索 `.harness/changes/*/plans/*-plan.md`（**排除 `.harness/archive/*/`**），读取 frontmatter 提取 `change-name`。

#### 0.0y：命令执行模式 preflight（⚠️ 必须在编译/启动服务/生成 runner 之前执行）

- [ ] 检查 PowerShell 基础命令：`powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion"` 返回 exitCode=0
- [ ] 检查 Node 绝对路径：`powershell.exe -NoProfile -Command "& 'C:\nvm4w\nodejs\node.exe' --version"` 返回 exitCode=0
- [ ] 检查 Maven 可用性：`powershell.exe -NoProfile -Command "mvn -version"` 返回 exitCode=0
- [ ] 检查安全分类器：上述任一命令是否返回"安全分类器暂时不可用" / Auto mode 拦截 → **不应出现**
- [ ] 将通过的 `nodeAbsolutePath` / `powershellVersion` / `mvnVersion` 写入 `.harness/changes/<change-name>/runtime/preflight.json`
- [ ] **任一情况触发硬停**：原文输出"❌ 命令执行模式不可用：PowerShell/Node runner 无法稳定执行..."，**不得继续编译/启动服务/生成 runner，不得长时间等待，不得盲目降级到 Playwright MCP**
- [ ] 用户确认切换权限模式后，**重新执行 0.0y**；重试 ≤ 1 次

#### 0.0x：fallback 执行器探测（仅在 Node runner 不可用时执行）

- [ ] 如果 0.0y 已确认 PowerShell Node API runner 可用：标记 `NOT_NEEDED`，**跳过本阶段**，直接使用 Node runner
- [ ] 仅当 Node runner 不可用时，检查 PowerShell batch runner (`.ps1`) 是否可用
- [ ] 仅当 PowerShell batch 也不可用时，检查 Claude Code 是否暴露 Playwright MCP 工具（`mcp__plugin_playwright_playwright__*` 存在）
- [ ] 检查 `claude mcp list` 中是否有 playwright（如果可以执行命令）
- [ ] 检查 `@playwright/mcp` 是否可启动
- [ ] 检查当前 skill 的 `allowed-tools` 是否允许 Playwright 相关工具
- [ ] 输出 fallback 执行器可用性表格（见 reference.md）
- [ ] 记录决策：PowerShell Node API runner / PowerShell batch / Playwright MCP browser_evaluate / curl fallback
- [ ] 如果 fallback 不可用，必须写明原因，不得静默改用 curl

#### 0.1 编译确认

```powershell
powershell.exe -Command "Test-Path 'target/classes/<package>/<ChangedClass>.class'"
```
编译产物时间戳早于源文件 → 重新编译：
```powershell
powershell.exe -Command "mvn compile -pl <module> -o -q"
```

**编译成功必须有证据**：
- mvn 输出包含 `BUILD SUCCESS` 才能继续测试
- 如果命令被 hook 拒绝（`Denied` / `PreToolUse:Bash hook error`），停止流程
- 不得在编译失败时继续宣称"准备进入测试阶段"

#### 0.1b 依赖模块预安装检查

> **强制检查，不可跳过。** 即使服务已运行，worktree 中的编译仍可能缺少依赖（服务可能从主目录启动）。

**在编译前检查上游依赖模块是否已安装到本地仓库**：

```powershell
powershell.exe -Command "Test-Path '$env:USERPROFILE\.m2\repository\<group-path>\<module>\*\*.jar'"
```

如果缺失，先安装上游依赖：
```powershell
powershell.exe -Command "mvn install -pl <upstream-modules> -am -DskipTests -nsu"
```

#### 0.2 认证方案确认

| 方案 | 适用场景 | 操作 |
|------|----------|------|
| A. 配置放行 | 纯本地开发 | `application-local.yml` 的 `permit-all-urls` |
| B. 本地 Token | 有本地 SSO | 通过本地登录接口获取 |
| C. 权限降级 | 临时测试 | 无认证上下文时降级为 admin |

> ⚠️ 方案 A 或 C 时，测试完成后确认还原配置。

#### 0.3 请求头确认

所有 HTTP 请求必须带：`Content-Type: application/json; charset=UTF-8` 及 build-profile 的 `httpHeaders`。

#### 0.4 编码确认

Windows 环境特别注意：
- 不要用 `curl` 发送含中文的请求体（curl 在 Windows 默认用 GBK 编码）
- 优先用 PowerShell Node API runner；单次临时请求可用 PowerShell `Invoke-RestMethod`
- curl 仅作为最后兜底，且必须用 UTF-8 JSON body file

#### 0.5 服务确认、Service Decision Gate 与启动等待

检查服务是否运行（优先使用已知接口，不依赖 `/actuator/health`）：

```powershell
powershell.exe -NoProfile -Command "Test-NetConnection -ComputerName localhost -Port <port>"
powershell.exe -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:<port>/<context-path>/meta' -UseBasicParsing -TimeoutSec 3).StatusCode } catch { $_.Exception.Message }"
```

**如果端口已有 <service-module-from-build-profile> 进程，必须先进入 Service Decision Gate，禁止先跑业务接口。**

需要展示：pid、profile、startTime、commandLine、healthResult、serviceFingerprint(match/missing/mismatch)、当前源码是否晚于服务启动时间。

询问用户：

```text
1. 直接复用当前服务
2. 重启服务，使用 known-good-test-profile
3. 跳过接口测试，只执行单元测试
4. 停止测试
```

只有 service-fingerprint 与当前真实 diffHash/profile/sdkUrl/startCommandHash 完全匹配时，才允许自动复用。否则必须询问。

**如果服务未运行**，询问用户：

```text
服务未启动（端口 <port> 无响应）。请选择：
1. AI 启动 — 使用 known-good-test-profile，serviceState=AI_STARTED
2. 用户手动启动 — 启动后告诉我继续，serviceState=USER_STARTED
3. 跳过接口测试 — 只运行单元测试，serviceState=NOT_STARTED
4. 停止测试
```

**如果用户选择 AI 启动或 AI 重启**：
1. 从 `known-good-test-profile` 读取 module/profile/port/healthUrl/sdkUrl。
2. 生成 ASCII overlay：`C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml`。
3. 禁止默认直接 Edit tracked `application-local-dev.yml`。
4. 默认启动命令：
   ```powershell
   powershell.exe -NoProfile -Command "mvn spring-boot:run -pl <module-from-build-profile> -Dspring-boot.run.profiles=local-dev -Dspring-boot.run.jvmArguments='-Dspring.config.additional-location=file:C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml'"
   ```
5. 写入 `service.pid`、`service-start-command.txt`、`service-start.log`、`service-fingerprint.json`。
6. 服务启动等待：0–30s 每 2s 探测；30–120s 每 5s 探测；>10s 必须输出状态行；>120s 读取最近 200 行日志。
7. 发现 `BindException` / `Could not resolve placeholder` / `Connection refused during bean init` / `BeanCreationException` / `Failed to start bean` / `BUILD FAILURE` 立即失败。

#### 0.5x 重入沿用（同一变更 harness-test 再次执行时）

满足以下**全部**条件时，可沿用上次服务决策，不重复询问：

1. 重入：同一 change-name 的 harness-test 再次执行（非首次）
2. 环境未变：PG 可用性、目标端口、执行器可用性与上次一致
3. 上次已确认执行器/服务方案（如"AI_STARTED，known-good-test-profile，端口 N"）
4. 当前源码未改服务启动逻辑（如未改 main 启动路径、未改端口/profile 配置、未改 spring-boot:run 启动相关代码）

沿用时执行日志记录：`重入沿用上次服务决策 + 环境未变（PG=<同上次>、端口=<同上次>、执行器=<同上次>）`。

**不适用重入沿用**（仍须询问/重启）：
- service-fingerprint 不匹配（diffHash 变化说明源码改了）
- 环境已变（PG 从不可用变可用、端口被占、执行器丢失）
- 上次 serviceState=USER_STARTED（用户手动启动，状态未知）
- 源码改动影响服务启动逻辑

#### 0.5d 服务生命周期收尾（即使测试失败也要进入 finally 清理）

测试结束前必须按 serviceState 分支处理：

- `AI_STARTED` → 默认 `Stop-Process -Id <pid> -Force`，删除 `service.pid`，记录 `testServiceStopped=✅`。
- `AI_RESTARTED_FROM_USER_SERVICE` → 默认停止新服务，报告中明确 `restoredOriginalService=❌ not supported`。
- `USER_STARTED` → 保留进程，报告中提示用户可手动停止。
- `REUSED_EXISTING` → 保留进程，除非用户明确要求关闭。

最终报告 / final-summary 必须包含：

```md
## 服务生命周期
| 项 | 值 |
|---|---|
| originalServicePid | ... / N/A |
| originalServiceStopped | ✅ / ❌ / N/A |
| testServicePid | ... / N/A |
| testServiceStopped | ✅ / ❌ / N/A |
| restoredOriginalService | ❌ not supported / N/A |
| finalPortState | no service / service running |
```

> 不要使用 Monitor 工具等待健康检查，直接用 PowerShell 检查已知接口。`/actuator/health` 可能返回 404。

#### 0.5b 配置文件完整性检查

**如果使用 worktree**，检查配置文件是否完整：

```powershell
powershell.exe -Command "Test-Path '<worktree-path>/<module>/src/main/resources/application-<profile>.yml'"
```

如果缺失，从主目录复制：
```powershell
powershell.exe -Command "Copy-Item '<main-dir>/<module>/src/main/resources/application-<profile>.yml' '<worktree-path>/<module>/src/main/resources/' -Force"
```

**检查关键配置项**（读取配置文件内容确认）：
- `workflow.baseUrl`（或类似条件属性）— 缺失会导致 Bean 创建失败
- `spring.cloud.nacos.discovery.register-enabled: false` — 缺失会导致线上流量路由到本地
- `udp.security.permit-all-urls` — 需包含本次测试的接口路径

#### 0.5c Playwright 远程访问确认

如果接口测试需要通过 Playwright 访问远程服务（如远程 SSO 获取 token），确认 Playwright MCP 配置允许目标地址。

检查 `.mcp.json` 或全局 MCP 配置中 Playwright 的 `allowedOrigins`：
```json
{
  "playwright": {
    "allowedOrigins": ["http://localhost:*", "http://<remote-ip>:*"]
  }
}
```

> 如果 Playwright 无法访问远程地址，降级为 PowerShell Invoke-RestMethod 获取 token。

#### 0.6 Nacos 风险确认

确认 `application-local.yml` 中 `spring.cloud.nacos.discovery.register-enabled: false`。

## 接口测试执行检查

### Token 缓存与复用

- [ ] 检查 `.harness/changes/<change-name>/runtime/credential-cache.json` 是否存在
- [ ] 如果存在 → 读取已有 token，用**本地轻量接口**（直连本地 baseURL）验证有效性
- [ ] 验证通过 → 复用，不重新登录、不访问远程 SSO
- [ ] 验证失败（401/expired） → 才访问远程 SSO 重新获取后写回 cache
- [ ] 同一上下文中，前面已获取过 token 时必须优先复用
- [ ] **同一次测试流程内只允许因 token 失效重新获取 1 次**；超过 1 次 → 🟡 WARN，记录原因
- [ ] API runner 用 request context / node fetch 直连本地 baseURL，**不依赖浏览器当前页面 origin**
- [ ] **不得因浏览器 origin 在 SSO 就重新获取 token**；禁止"SSO 取 token→导航 localhost→重新取 token"
- [ ] **不得在报告、execution-log、对话总结中输出明文 token**

### 单元测试复用（ledger 驱动）

- [ ] Phase 1 前读取 `.harness/changes/<change-name>/evidence/verification-ledger.json`
- [ ] 判断是否复用 run 的 unitTest：diffHash 一致 + module/profile 一致 + scope 一致或更严格 + run 后无行为性修改 + run 实际跑了全量 mvn test
- [ ] 复用 → 跳过重跑，标记"✅ 复用 harness-run 单元测试结果"
- [ ] 不复用 → 重跑 `mvn test -pl <module>`，结果写回 ledger 的 `unitTest` 项

### 批量 Runner（强制单次 PowerShell + Node 绝对路径执行）

- [ ] 0.0y preflight 已通过，`preflight.json` 包含 `nodeAbsolutePath`
- [ ] 生成 `.harness/changes/<change-name>/runtime/api-test-runner.mjs`，**按 setup / test / cleanup 三阶段结构**编写
- [ ] payload 来自 `<XxxSaveReqVO>` / Controller / 真实样例，runner 注释/JSON 中标注字段来源；**禁止临场猜字段、禁止先跑失败接口再补**
- [ ] 唯一前缀 `JAVATEST_<change-name>_<timestamp>_<random>`，priority/projectSubtype 用随机或避让策略，防 `priority=1` 冲突
- [ ] 通过**一次命令**执行（PowerShell + node 绝对路径）：
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '<nodeAbsolutePath>' '.harness/changes/<change-name>/runtime/api-test-runner.mjs'"
   ```
- [ ] **禁止**裸 `node ...`、禁止用 Bash 执行 node
- [ ] runner 失败 ≤ 1 次重试；仍失败 → 提示用户切换权限模式或手动执行，**不得继续盲目重试或长时间等待**
- [ ] runner 输出 `.harness/changes/<change-name>/runtime/api-test-results.json`，包含
      `passed/failed/blocked/skipped/setupErrors/cleanupResult/tokenRefreshCount`
- [ ] **setup 失败时依赖该数据的场景必须标 🟡 BLOCKED，不得用 null ID 继续请求**
- [ ] 主会话只 Read JSON 生成摘要，不再调用 MCP
- [ ] **只有 Node runner 不可执行才降级**：PowerShell batch (.ps1) → 多次 MCP `browser_evaluate` → curl
- [ ] **如果 Node 在 PowerShell 可用，禁止使用 Playwright MCP 逐条执行接口测试**
- [ ] runner 直连本地 baseURL，复用 token，不依赖浏览器 origin
- [ ] 记录每个请求的 durationMs、status、code、message、assertionResult
- [ ] 支持失败时继续执行后续非依赖场景
- [ ] 报告区分四种执行器：**PowerShell Node API runner / PowerShell batch / Playwright MCP browser_evaluate / curl**（不得与"Playwright"混写）

### 测试数据命名

- [ ] 所有测试数据使用前缀 `JAVATEST_<change-name>_<timestamp>_<random>`
- [ ] 测试报告记录测试数据表（ID、Code、用途、是否需要清理）
- [ ] 测试结束后清理可清理的数据
- [ ] 不能清理的记录遗留数据和原因

### 请求耗时

- [ ] 每个请求记录 durationMs
- [ ] durationMs > 10000 → 🟡SLOW，说明原因
- [ ] durationMs > 30000 → ❌TIMEOUT_RISK，说明原因

## 关门检查（⚠️ 结束前强制执行）

- [ ] `powershell.exe -NoProfile -Command "git status --porcelain"`
- [ ] `powershell.exe -NoProfile -Command "git diff --stat"`
- [ ] `powershell.exe -NoProfile -Command "git diff --check"`（如果失败 → 最终结果 ❌FAIL）
- [ ] 检查报告和日志是否包含明文 token/password/secret/access-key/client-secret
- [ ] 检查 `.harness/changes/<change>/runtime/` 是否不会被提交（.gitignore 确认）
- [ ] **服务生命周期收尾**：AI_STARTED→Stop-Process / USER_STARTED→提示 / REUSED_EXISTING→保留或确认 / NOT_STARTED→N/A
- [ ] 检查测试数据是否需要清理
- [ ] 检查请求执行器结果是否完整（4 种执行器，未与 API runner 混写）
- [ ] 检查是否存在慢请求或超时风险
- [ ] **API 维度状态正确**：5 PASS + 9 BLOCKED + 1 FAIL → `apiTest=PARTIAL`，不得写成 `NOT_RUN`
- [ ] 如果存在未清理测试数据、fallback 请求执行器、慢请求或环境变更 → 至少 🟡WARN

## 关键原则

- 如果有项目配置文件，优先从 `.harness/config/harness-test-config.md` 读取并应用（含 `known-good-test-profile`）
- 环境准备（阶段 0）的 **0.0y 命令执行模式 preflight + 7 项检查 + Playwright 探测** 必须在测试之前全部通过
- 单元测试优先于接口测试（先跑 `mvn test`，通过后再跑接口）
- 接口测试优先级：**PowerShell Node API runner > PowerShell batch > Playwright MCP browser_evaluate > curl**
- 单用例失败不阻塞后续用例；setup 失败时依赖场景必须标 🟡 BLOCKED，**不得用 null ID 继续请求**
- 失败类型必须区分：代码 Bug vs 测试脚本问题 vs 预存问题
- 测试数据使用唯一前缀命名 + 唯一字段（priority/projectSubtype）随机或避让，测试后确认清理或记录遗留
- 测试报告持久化到 `.harness/changes/<change-name>/reports/test/test-report-YYYYMMDD-HHmm.md`（时间戳区分多次运行）
- 请求执行器必须在报告中明确记录（四种执行器，含降级原因）
- 请求耗时统计必须包含在报告中
- 服务由 AI 启动的情况，测试结束默认 Stop-Process；**即使测试失败也要进入 finally 清理**
- final-summary 的 apiTest 状态必须用 OK/PARTIAL/BLOCKED/NOT_RUN/FAIL（不得把 PARTIAL 写成 NOT_RUN）