---
description: harness-test 的踩坑规则（来自真实对话日志）。执行测试前必须通读，遇到测试失败时重新参考。
---

# 避坑规则（30 条）

> 以下规则来自真实对话日志（2026-06-12 ~ 06-24），每个都有明确的现象和根因。
> 执行 `harness-test` 时必须通读，避免重蹈覆辙。

| # | 规则 | 现象 | 根因 | 解法 |
|:--:|------|------|------|------|
| 1 | 凭证可展示但注意安全 | 对话日志记录了凭证 | Bearer 凭证被粘贴到聊天中 | 凭证可以在对话中展示用于调试，但不要写入持久化文件（测试报告、执行日志等） |
| 2 | 不用 curl 发中文 | `Invalid UTF-8 start byte 0xb2` | Windows curl 默认 GBK 编码 | 用 PowerShell Invoke-WebRequest 或 Playwright fetch |
| 3 | 必须带租户标识 | 所有接口 500 | 租户上下文为空 | 请求头加租户标识（见 build-profile.httpHeaders） |
| 4 | 认证降级 | 接口 401 "账号未登录" | 本地无认证服务 | 应用配置放行（如 permit-all-urls）或权限降级 |
| 5 | 错误码双格式兼容 | 测试断言失败 | 预期 `1_003_002_009`，实际 `1003002009` | 自动兼容下划线和数字两种格式 |
| 6 | 编译产物确认 | 修改代码后测试结果不变 | IDE 热重载未触发 | 测试前编译（如 `mvn compile -o`） |
| 7 | 构建工具配置路径用相对 | 构建工具输出 `׻ֹ` 乱码 | 配置文件路径含中文 | 构建工具配置用相对路径（如 `.mvn/maven.config` 用 `-s ../settings.xml`） |
| 8 | 跳过无关模块 | `mvn compile -am` 在无关子模块报错 | 子模块 POM 无 parent | 用 `-pl <module>` 不 `-am` |
| 9 | 服务注册只发现不注册 | 线上流量被路由到本地 | register-enabled=true | 确认服务注册开关关闭（如 `register-enabled=false`） |
| 10 | 先导航再 fetch | `fetch is not defined` | 页面是 about:blank | 先 `browser_navigate` 到服务页面 |
| 11 | MCP 就绪等待 | `No such tool available` | 服务器仍在连接 | 等 MCP 连接完成再调用 |
| 12 | 大请求体分批 | `Range of input length [1, 202745]` | 上下文超 API 输入限制 | 超过 200KB 时分批 |
| 13 | 必填字段先查明 | 创建资源 500 | 不知道必填字段有哪些 | 查看已有代码或数据契约定义 |
| 14 | 用唯一编码 | 编码冲突错误 | 之前测试已创建同名编码 | 每个用例使用唯一编码，测试后清理 |
| 15 | permit-all 放行 ≠ 有用户上下文 | 接口返回 500 "系统异常" | 安全层放行但业务层调用权限校验时当前用户为 null | 获取真实凭证带上，或跳过需要用户上下文的接口 |
| 16 | 远程认证服务获取凭证 | 本地无独立认证服务，无法登录 | 应用服务不提供登录接口 | 通过远程认证服务（如 SSO/Gateway）登录获取凭证，或从项目配置文件中读取已知凭证 |
| 17 | Windows 禁用 Python3 解析 JSON | 凭证提取静默失败，后续所有请求未认证 | Windows 环境 Python3 可能段错误（segfault） | 用 `grep -o + cut` 或 PowerShell `ConvertFrom-Json` 替代 |
| 18 | **Bash 不可执行执行器（如 node）** | "Bash 中没有 node" → 错误降级到 Playwright MCP | Windows 中文路径项目下 Bash 被 hook 拒；Node 不在 Bash PATH | 强制 `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '<executorPath>' '...mjs'"`，禁止裸 `node`、禁止用 Bash 执行执行器 |
| 19 | **Auto mode / 安全分类器降级时静默等待** | 接口测试长时间无响应，最终错误降级到逐条 MCP | PowerShell 命令被安全分类器拦截，Claude 静默重试 + fallback | Phase 0.1 preflight 检测出后**硬停**，原文输出"命令执行模式不可用..."，提示用户切换权限模式 |
| 20 | **Playwright API 执行器与 Playwright MCP 混写** | 报告写"Playwright ✅ 使用"，实际是逐条 `browser_evaluate` | 两者被笼统称为"Playwright" | 报告中**强制区分**四种执行器：接口测试执行器 / PowerShell batch / Playwright MCP browser_evaluate / curl |
| 21 | **直接 Edit tracked 应用配置文件** | 测试期间改配置，之后又还原，diff 噪声大 | 把运行时配置覆盖直接写进 tracked 文件 | 生成 ASCII 运行时配置叠加 `C:/temp/harness-test-overlay/<change>/application-harness-test.yml`，启动用该绝对路径叠加（如 `-Dspring.config.additional-location=...`） |
| 22 | **唯一约束字段与本地预存数据冲突** | 大面积唯一约束冲突，9 个场景 BLOCKED | 执行器用硬编码字段值 | 用随机值（如 `900000 + random`）/ 先查避让 / 用唯一隔离值 |
| 23 | **setup 失败后继续用 null ID 发送请求** | 后续 9 个接口全部 400/500，掩盖真正问题 | 执行器不区分 BLOCKED 状态 | 执行器强制 setup/test/cleanup 三阶段，依赖未满足 → 标 🟡 BLOCKED，**不发起请求** |
| 24 | **final-summary 把 PARTIAL 写成 NOT_RUN** | 报告显示"未执行"，但实际跑了 6 个场景 | 状态枚举不完整，只有 OK/FAIL/NOT_RUN | API 维度状态使用 OK/PARTIAL/BLOCKED/NOT_RUN/FAIL，5 PASS+9 BLOCKED+1 FAIL → `apiTest=PARTIAL` |
| 25 | **AI 启动的服务测试结束不关闭** | 端口长期占用，下次启动端口占用异常（如 `BindException`） | 没有 service lifecycle 管理 | 通过 `service.pid` + `serviceState` 区分，AI_STARTED 默认 Stop-Process，**即使测试失败也 finally 清理** |
| 26 | **凭证在同一流程内重复获取** | 浏览器 origin 在认证服务就再走一次登录 | 执行器依赖浏览器当前页面 origin | 执行器用 request context 直连本地 baseURL，凭证从 cache 读，`credentialRefreshCount > 1` → 🟡 WARN |
| 27 | **服务启动盲等 + 无反馈** | 等待 90s 后才发现启动报错 | 没有启动状态机和异常关键字检测 | 0–30s/2s × 30–120s/5s 状态机；遇启动失败特征（按技术栈，如 BindException/Could not resolve placeholder/BeanCreationException）立即停；> 10s 必须输出一次状态行 |
| 28 | **已有服务未先决策就跑业务接口** | 旧服务不含新代码，接口 500 后才发现版本不匹配 | 检测到已有应用服务（端口被占）后，未先展示服务决策门就跑业务接口 | 先展示服务决策门，询问复用/重启/跳过/停止；询问前只允许 health/meta 检查 |
| 29 | **启动命令反复试相对配置叠加 / 中文路径** | 相对路径或中文路径导致应用读不到运行时配置叠加，启动失败 | 默认只用 `C:/temp/harness-test-overlay/<change>/application-harness-test.yml` ASCII 绝对路径，并固化已知良好测试配置 |
| 30 | **伪 diffHash 导致错误复用** | `3files-84plus-5minus` 不能证明代码未变 | 用 `git diff --binary` 生成 patch 并计算 SHA-256，ledger 只认 `sha256:<hash>` |


## 详细说明

### 规则 1：凭证可展示但注意安全
**严重度**：🟡WARN
**场景**：测试脚本需要 Bearer 凭证时，需要在对话中展示用于调试
**正确做法**：凭证可以在对话中展示用于调试和验证。但不要将凭证写入持久化文件（测试报告、执行日志、代码注释等）。测试报告中引用凭证时用前 8 位 + `***` 脱敏。

> 凭证处理遵循 `../protocols/sensitive-info-protocol.md`。

### 规则 2：不用 curl 发中文
**严重度**：❌FAIL
**场景**：用 `curl -d '{"name":"张三"}'` 测试接口
**后果**：Windows curl 默认 GBK 编码，服务器期望 UTF-8，导致 `Invalid UTF-8 start byte 0xb2`
**正确做法**：用 PowerShell `Invoke-WebRequest` 或 Playwright MCP 的 `browser_evaluate` + `fetch`

### 规则 3：必须带租户标识
**严重度**：❌FAIL
**场景**：忘记在请求头中加租户标识
**后果**：租户上下文为空，所有接口返回 500，错误信息不直观，容易误判为权限问题
**正确做法**：所有 HTTP 请求头使用 build-profile 的 `httpHeaders`（项目自定义）

### 规则 4：认证降级
**严重度**：🟡WARN
**场景**：本地测试时收到 401 "账号未登录"
**后果**：无法测试需要认证的接口
**正确做法**：在应用配置文件中配置放行（如 `permit-all-urls`），或降级为高权限账号上下文。测试完成后还原配置。

### 规则 5：错误码双格式兼容
**严重度**：🟡WARN
**场景**：测试断言预期 `1_003_002_009`，实际返回 `1003002009`
**后果**：断言失败，误判为 Bug
**正确做法**：自动兼容两种格式，比较时统一去掉下划线

### 规则 6：编译产物确认
**严重度**：🟡WARN
**场景**：修改代码后运行测试，结果不变
**后果**：IDE 热重载未触发，测试运行的是旧产物，浪费排查时间
**正确做法**：测试前执行构建工具编译（如 `mvn compile -o`）确保编译产物最新

### 规则 7：构建工具配置路径用相对
**严重度**：🟡WARN
**场景**：构建工具配置文件路径包含中文（如 Maven 的 settings.xml）
**后果**：构建工具输出乱码字符 `׻ֹ`，编译失败
**正确做法**：构建工具配置中使用相对路径（如 Maven 的 `.mvn/maven.config` 中 `-s ../settings.xml`）

### 规则 8：跳过无关模块
**严重度**：🟡WARN
**场景**：构建工具编译带依赖模块（如 `mvn compile -am`）在无关子模块报错
**后果**：被不相关的编译错误阻塞
**正确做法**：只编译目标模块（如 Maven 用 `-pl <module>` 指定模块，不 `-am`）

### 规则 9：服务注册只发现不注册
**严重度**：❌FAIL
**场景**：本地启动服务，服务注册开关开启（如 Spring Cloud Nacos 的 `register-enabled=true`）
**后果**：线上流量可能被网关路由到本地机器
**正确做法**：确认服务注册开关关闭（如 `spring.cloud.nacos.discovery.register-enabled: false`）

### 规则 10：先导航再 fetch
**严重度**：🟡WARN
**场景**：直接调用 Playwright MCP 的 `browser_evaluate` 执行 fetch
**后果**：`fetch is not defined`，因为页面是 about:blank
**正确做法**：先 `browser_navigate` 到服务的任意页面，再执行 fetch

### 规则 11：MCP 就绪等待
**严重度**：🟡WARN
**场景**：刚启动 Claude Code 就调用 MCP 工具
**后果**：`No such tool available`，MCP 服务器仍在连接中
**正确做法**：等待几秒确认 MCP 连接完成后再调用

### 规则 12：大请求体分批
**严重度**：🟡WARN
**场景**：请求体超过 200KB
**后果**：超出 API 输入限制，请求被截断
**正确做法**：超过 200KB 时分批发送

### 规则 13：必填字段先查明
**严重度**：🟡WARN
**场景**：创建资源时 500 错误
**后果**：不知道必填字段有哪些，反复试错
**正确做法**：查看已有代码中的请求示例或数据契约定义，确认必填字段

### 规则 14：用唯一编码
**严重度**：🟡WARN
**场景**：多个测试用例使用相同编码
**后果**：编码冲突错误，后续用例失败
**正确做法**：每个用例使用唯一编码（加时间戳后缀），测试完成后清理

### 规则 15：permit-all 放行 ≠ 有用户上下文
**严重度**：❌FAIL
**场景**：在应用配置文件中配置了放行（如 `permit-all-urls`），接口返回 200 但业务逻辑报 500 "系统异常"
**后果**：安全框架（如 Spring Security）放行了请求，但安全工具获取当前用户返回 null。业务层调用权限校验方法时，内部远程调用失败，错误信息不直观
**正确做法**：理解两层检查机制——安全层（Filter）和业务层（Service）是独立的。放行只跳过第一层，第二层仍需要有效的用户上下文。要么获取真实凭证带上，要么跳过需要用户上下文的接口

### 规则 16：远程认证服务获取凭证
**严重度**：❌FAIL
**场景**：本地启动应用服务，自身不提供登录接口，无法获取访问凭证
**后果**：所有需要认证的接口返回 401，无法测试
**正确做法**：通过远程认证服务（如 SSO/Gateway）的登录接口获取凭证。查看项目配置文件（`harness-test-config.md`）中的登录端点和测试账号。如果项目配置不存在，询问用户如何获取有效的凭证

### 规则 17：Windows 禁用 Python3 解析 JSON
**严重度**：❌FAIL
**场景**：用 Python3 解析 curl 返回的 JSON（如提取凭证）
**后果**：Windows 环境 Python3 可能段错误（segfault），导致脚本静默失败，后续所有依赖该输出的命令全部异常（如凭证为空导致所有请求未认证）
**正确做法**：用 PowerShell `Invoke-RestMethod` + `ConvertFrom-Json` 替代（推荐）：
```powershell
# 推荐：PowerShell Invoke-RestMethod + ConvertFrom-Json（经 Bash(powershell.exe:*) 通道或直接 PowerShell）
$resp = Invoke-RestMethod -Uri '...' -Method Post -Headers @{...} -Body '...'
$cred = $resp.data.accessToken
```

> **反例（禁止）**：以下 Bash + curl + grep + cut 方式违反 PowerShell-first 规则，不得使用：
> ```bash
> # ❌ 禁止：裸 Bash + curl + grep + cut（Windows 中文路径 + GBK 编码双重风险）
> CRED=$(curl -s ... | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
> ```

### 规则 18：Bash 不可执行执行器（如 node）
**严重度**：❌FAIL
**场景**：日志显示 PowerShell 中确认了执行器可用，但接着错误地用 Bash `node api-test-runner.mjs` 执行，失败后直接降级到 Playwright MCP 逐条执行接口
**后果**：浪费 1–2 分钟在错误降级路径上；接口测试以"Playwright"名义被逐条执行，丧失批量执行器的所有优势
**正确做法**：硬规则——禁止裸 `node`、禁止用 Bash 执行执行器；必须 `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '<executorPath>' '...mjs'"`，`<executorPath>` 从 0.1 preflight 写入的 `preflight.json` 读取

### 规则 19：Auto mode / 安全分类器降级时静默等待
**严重度**：❌FAIL
**场景**：Claude Code 在 Auto mode / 安全分类器临时不可用时，PowerShell 命令被拦截，Claude 静默重试、静默 fallback，最终接口测试卡住很久
**后果**：用户体验极差，错误降级到逐条 MCP，最终报告里"Playwright"✅ 使用但实际是 fallback
**正确做法**：Phase 0.1 preflight 检测出以下任一情况立即**硬停**：
- 出现"安全分类器暂时不可用"
- Auto mode 导致 PowerShell 命令不可执行
- PowerShell 被拒
- PowerShell 可用但执行器/构建工具不可执行

输出原文："❌ 命令执行模式不可用：PowerShell/接口测试执行器无法稳定执行。请切换 Claude Code 权限模式..."；用户确认后重试 ≤ 1 次

> 结果状态分级与硬停判定遵循 `../protocols/evidence-based-reporting-protocol.md`。

### 规则 20：Playwright API 执行器与 Playwright MCP 混写
**严重度**：🟡WARN
**场景**：报告写"Playwright ✅ 使用"，实际是 Playwright MCP `browser_evaluate` 逐条执行
**后果**：审计混乱，看不出真实降级路径
**正确做法**：报告中**强制区分**四种执行器，且不得用一个"Playwright"代指两者：
- `接口测试执行器` (`.mjs`)
- `PowerShell batch runner` (`.ps1`)
- `Playwright MCP browser_evaluate`
- `curl`

### 规则 21：直接 Edit tracked 应用配置文件
**严重度**：🟡WARN
**场景**：测试期间为了切换外部服务配置直接 Edit tracked 配置文件（如 `application-local-dev.yml`），测试后再还原，留下 diff 噪声
**后果**：git diff --stat 出现意外文件、提交风险、误以为有业务变更
**正确做法**：生成运行时配置叠加 `.harness/changes/<change>/runtime/application-harness-test.yml`（不提交），启动用 `-Dspring.config.additional-location=file:...` 叠加（按技术栈）；如必须改 tracked 配置，先 AskUserQuestion，最终报告至少 🟡 WARN

### 规则 22：唯一约束字段与本地预存数据冲突
**严重度**：❌FAIL
**场景**：执行器创建资源时唯一约束字段用硬编码值（如 `priority=1`），与本地已存在数据冲突，导致 9 个依赖该资源的场景全部 BLOCKED
**后果**：API 测试出现大面积 BLOCKED，且容易误判为代码 Bug
**正确做法**：所有创建类接口对唯一约束字段三选一：
1. 随机：`900000 + Math.floor(Math.random() * 9999)`
2. 先查再避让
3. 用唯一隔离值隔离

### 规则 23：setup 失败后用 null ID 继续请求
**严重度**：❌FAIL
**场景**：执行器没有阶段化，`createResource` 失败后 `resourceId=null`，但仍用 null 继续请求 9 个后续接口
**后果**：后续接口大面积 400/500，掩盖真正的根因（setup 失败）
**正确做法**：执行器强制 setup/test/cleanup 三阶段；依赖 setup 数据的场景在 test 阶段开头判定依赖，缺失则标 🟡 BLOCKED，**不发起请求**

### 规则 24：final-summary 把 PARTIAL 写成 NOT_RUN
**严重度**：🟡WARN
**场景**：15 个 API 场景中 5 PASS + 9 BLOCKED + 1 FAIL，final-summary 写 `apiTest=NOT_RUN`
**后果**：报告与现实不符，下游 review / submit / package 误判
**正确做法**：API 维度状态使用 5 个值：`OK / PARTIAL / BLOCKED / NOT_RUN / FAIL`。"部分执行+部分阻塞" 是 `PARTIAL`，附说明：`apiTest=PARTIAL — 15 个场景中 5 个 PASS, 9 个 BLOCKED, 1 个 FAIL`

> 结果状态枚举与证据要求遵循 `../protocols/evidence-based-reporting-protocol.md`。

### 规则 25：AI 启动的服务测试结束不关闭
**严重度**：❌FAIL
**场景**：选择 AI 启动服务，测试结束后忘记 Stop-Process，端口被长期占用；下次启动端口占用异常（如 `BindException`）
**后果**：端口被占、内存浪费、下次启动失败
**正确做法**：维护 `service.pid` + `serviceState`：
- `AI_STARTED` → 默认 Stop-Process 并删除 pid 文件
- `USER_STARTED` → 不动，只提示
- `REUSED_EXISTING` → 不动，除非用户确认

即使测试失败，也必须进入 finally 清理 AI_STARTED 服务

### 规则 26：凭证在同一流程内重复获取
**严重度**：🟡WARN
**场景**：执行器因为浏览器当前 origin 在远程认证服务，就重新走一次认证登录获取凭证，覆盖了刚拿到的有效凭证
**后果**：浪费一次认证调用（10+ 秒），且暴露低效流程的根本误解（凭证是独立凭证，不依赖浏览器 origin）
**正确做法**：执行器用 `request.newContext({ baseURL: 本地 })` 或原生 HTTP 客户端直连本地 baseURL；凭证从 `credential-cache.json` 读，本地轻量接口验证；同一次流程内 `credentialRefreshCount > 1` → 🟡 WARN，原因要写入报告

### 规则 27：服务启动盲等 + 无反馈
**严重度**：🟡WARN
**场景**：选择 AI 启动后默认每 30 秒检查一次健康，等 90 秒才发现启动失败（如配置缺失导致 `Could not resolve placeholder`）
**后果**：启动反馈滞后，节奏极慢
**正确做法**：启动状态机——0–30s 每 2s/30–120s 每 5s 探测；> 10s 必须输出一次状态行；遇到启动失败特征（按技术栈识别，如 Java Spring Boot 的 `BindException` / `Could not resolve placeholder` / `Connection refused during bean init` / `BeanCreationException` / `Failed to start bean` / `BUILD FAILURE`）立即停止等待

### 规则 28：已有服务未先决策就跑业务接口
**严重度**：❌FAIL
**场景**：检测到已有应用服务进程（端口被占），未先展示服务决策门，直接调用业务接口
**后果**：旧服务不含新代码，接口 500 后才发现版本不匹配，浪费时间分析业务数据，掩盖根因（服务版本/配置不匹配）
**正确做法**：检测到已有服务后，先展示服务决策门（pid/profile/startTime/commandLine/fingerprint/源码是否晚于服务启动时间），询问复用/重启/跳过/停止。询问前只允许 health/meta 检查。只有 service-fingerprint 与当前真实 diffHash/profile/sdkUrl/startCommandHash 完全匹配时才允许自动复用。

### 规则 29：启动命令反复试相对配置叠加 / 中文路径
**严重度**：🟡WARN
**场景**：运行时配置叠加用相对路径 `.harness/changes/<change>/runtime/application-harness-test.yml` 或中文路径作为 JVM `additional-location`，应用（如 Spring Boot）读不到配置叠加，启动失败后反复试不同路径
**后果**：启动反复失败，浪费时间；中文路径进入 JVM 参数也可能失败
**正确做法**：默认只用 ASCII 绝对路径 `C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml`，并固化已知良好测试配置。禁止把相对路径作为默认 JVM `additional-location`。

### 规则 30：伪 diffHash 导致错误复用
**严重度**：❌FAIL
**场景**：ledger 的 diffHash 用描述性文本如 `3files-84plus-5minus`，无法证明代码未变，却据此复用 run 的 unitTest/apiTest 结果
**后果**：代码已变却复用旧测试结果，掩盖回归问题
**正确做法**：用 `git diff --binary` 生成 patch 并计算 SHA-256，ledger 只认 `sha256:<hash>` 格式。diffHash 不一致时必须重跑相关测试。

> diffHash/ledger 复用规则遵循 `../protocols/ledger-protocol.md`；结果证据要求遵循 `../protocols/evidence-based-reporting-protocol.md`。
