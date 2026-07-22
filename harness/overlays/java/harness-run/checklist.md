# harness-run 执行检查清单

> 编码执行时逐项勾选，确保不遗漏关键步骤。

## 步骤 0：加载上下文

### 步骤 0.0：Worktree 决策执行 ⚠️

- [ ] 读取 `.harness/changes/<change-name>/worktree.json`
- [ ] 如果文件缺失：🟡WARN，按 legacy 逻辑询问用户是否主目录执行或创建 worktree
- [ ] `requested=false` → 主目录执行，记录原因
- [ ] `requested=true` 且 worktree 存在 → 切换到 worktree 执行
- [ ] `requested=true` 且 worktree 不存在 → 必须创建 worktree
- [ ] worktree 创建命令必须使用 PowerShell：`git worktree add ...`
- [ ] 创建后验证 `.worktrees/<change-name>/.git` 存在
- [ ] 创建成功后更新 `worktree.json` 的 `created=true/createdAt/createdBy`
- [ ] 创建失败 → 停止，或 blocking user confirmation 询问是否改为主目录执行
- [ ] 禁止 `requested=true && worktree 不存在` 时直接主目录执行
- [ ] 记录 `projectRoot / worktreeRoot / stateDir`



- [ ] 确定变更名：Glob 搜索 `.harness/changes/*/plans/*-plan.md`（排除 `.harness/archive/*/`），提取 `change-name`
- [ ] 读取并执行 `worktree.json`：如果 `requested=true` 必须创建/切换 worktree，创建失败则停止或询问用户改为主目录；禁止静默降级
- [ ] **读取计划文件（主任务源）**：`.harness/changes/<change>/plans/<change>-plan.md` — 获取任务列表和依赖关系
- [ ] **读取详细计划（补充参考）**：`.harness/changes/<change>/plans/<change>-implementation-detail.md`（如存在）
- [ ] **读取设计文档**：`.harness/changes/<change>/spec/<change>-design.md` — 获取核心设计决策和不变项
- [ ] **读取测试场景表**：`.harness/changes/<change>/plans/<change>-test-scenarios.md` — 获取与当前任务相关的测试场景
- [ ] **读取验证账本**：`.harness/changes/<change>/verification-ledger.json`（如存在）— 复用已有 compile/unitTest 结果
- [ ] **读取任务状态**：`.harness/changes/<change>/run-task-status.md`（如存在）— 恢复上次运行状态
- [ ] 确认 `项目规则（见 .harness/context-index.json）/` 规则已加载
- [ ] 检查构建配置完整性（worktree 中确认 `.mvn/maven.config`、`settings.xml` 等存在）
- [ ] 读取 `.mvn/maven.config`，确认命令没有重复或覆盖项目已有的 `-s` / `-o` / 仓库设置
- [ ] 离线依赖缺失时仅在项目规则允许联网的前提下执行至多一次非离线 `-nsu` 恢复；禁止离线/联网循环重试
- [ ] 依赖模块预安装（worktree 中检查上游模块是否已 `mvn install`）
- [ ] 代码探索优先用 `codegraph_explore`，仅在返回不完整时补充 Read
- [ ] append `phase.start`（`note` 含测试基础设施 CHECKING 直至探测完成）

### 步骤 0.1：执行模式

- [ ] 默认 Inline；`--subagent` → Subagent-Driven；**不 blocking user confirmation 选模式**

## 步骤 0.5：测试基础设施探测（⚠️ 必须先于任何 TDD 降级结论）

> 探测完成前，执行日志中只能写 `**测试基础设施**: CHECKING`，不得写任何降级结论。

- [ ] 探测 1：`src/test/java` 目录是否存在
- [ ] 探测 2：`pom.xml` 是否包含 `spring-boot-starter-test` / `junit` / `mockito` 依赖
- [ ] 探测 3：是否存在已有测试文件（`*Test.java` 或 `*Tests.java`）
- [ ] 探测 4：目标模块测试基础设施是否可用（`mvn test-compile -pl <module> -o -q` 验证测试可编译，或测试枚举/秒级 smoke；**禁止完整模块测试**，spec §3.3）
- [ ] 四项证据收集完毕 → 写结论：✅ 测试基础设施可用 / 🟡 测试基础设施部分可用 / ❌ 测试基础设施不可用
- [ ] 如果 ❌ 不可用 → 记录 TDD 降级原因（必须引用具体证据，如"模块 X 无 src/test/java 目录"）

## 步骤 0.2：预存变更检测与隔离

> 如果 run 开始前检测到已有未提交变更，必须执行此步骤。

- [ ] 检查 git status 是否有 run 前的预存变更
- [ ] 如果有预存变更 → 使用 blocking user confirmation 询问用户处理方式（保留/暂存/终止）
- [ ] 用户选择保留 → 创建 `.harness/changes/<change>/pre-existing-files.json`（文件列表 + diff hash + 用户选择）
- [ ] 用户选择保留 → 创建 `.harness/changes/<change>/pre-existing-diff.patch`（完整 diff 备份）
- [ ] 在执行日志中记录预存变更检测结果和用户选择

## 变更簇 TDD 循环

> 默认按变更簇执行 TDD，不按每个小任务单独 RED/GREEN。

### 步骤 1a：划分变更簇

- [ ] 读取 plan.md 任务列表，按业务行为分组为变更簇
- [ ] 检查是否有低价值 TDD 豁免项（ErrorCode 常量、VO/DTO 字段、注释、import 清理、格式化、SQL 脚本、配置模板、文档）→ 标记为豁免，不单独建测试类
- [ ] 确定每个变更簇的测试范围（哪些测试类合并执行）
- [ ] 确认变更簇内 Mapper 查询条件是否需要用真实 DB 验证（非纯 Mock）

### 进入变更簇 RED 前：执行 run-tdd-protocol

- [ ] 在写第一行测试代码或生产代码之前执行 `run-tdd-protocol`（详见 `../protocols.md#协议一run-tdd-protocol`）
- [ ] 测试基础设施可用 → 写真实 RED，记录：✅ 真实 RED 已建立
- [ ] 测试基础设施不可用 → 记录降级原因，降级为静态 RED
- [ ] RED 无效（测试搭建错误、private 访问限制、mock/stubbing 错误等）→ 必须先修测试，禁止进入 GREEN

### RED（写测试 — 按变更簇批量执行）

- [ ] 从场景表选取对应当前变更簇的测试用例
- [ ] 写单元测试（JUnit 5 + Mockito + AssertJ），**优先通过 public API 验证**（非 private 方法）
- [ ] **多个测试类合并到一次 Maven 命令执行**：`mvn test -pl <module> -Dtest=TestA,TestB,TestC -o`
- [ ] **RED 有效性判定**（必须逐项确认）：
  - [ ] 测试编译通过？（编译失败 → ❌无效 RED，先修测试）
  - [ ] 未直接调用 private 方法？（private 访问限制 → ❌无效 RED）
  - [ ] 失败断言指向目标业务行为？（mock/stubbing 错误 → ❌无效 RED）
  - [ ] 失败原因与本次 bug/需求直接相关？（无关 → ❌无效 RED）
  - [ ] 无 NoSuchBeanDefinitionException / NPE 来自测试搭建错误 / 不必要 stubbing？
- [ ] 判定结果写入执行日志：`RED: ✅有效 / 🟡部分有效 / ❌无效`
- [ ] 如果 ❌无效 RED → 必须先修测试，重新运行 RED，**禁止进入 GREEN**
- [ ] 如果无测试基础设施 → 降级为静态逻辑验证（在执行日志和覆盖报告中标注覆盖关系，**不得在业务代码注释中标注**）

### 低价值 TDD 豁免检查

- [ ] ErrorCode 常量 → 不单独建测试类，compile 验证 + 被高层测试间接覆盖
- [ ] VO/DTO 字段 → 不单独建测试类，被 service/API 测试间接覆盖
- [ ] 注释 / import 清理 / 格式化 → compile 验证即可
- [ ] SQL 迁移脚本 → 不做 TDD，生成审查清单，标记 NEEDS_DB_VALIDATION
- [ ] 配置模板 / 文档 → 静态审查

### Mapper 查询条件验证检查

- [ ] 如果变更涉及 Mapper 查询条件 / LambdaQueryWrapper / SQL/XML → 不得用纯 Mock 宣称"自动化测试通过"
- [ ] 纯 Mock Mapper 测试 → 标记为 🟡静态验证，交给 harness-test 真实 DB 验证
- [ ] 如果必须自动化 → 使用真实 mapper 或可检查 wrapper 条件的测试方式

### GREEN（最简实现 — 按变更簇批量实现）

- [ ] 写最少代码让变更簇测试全部通过
- [ ] 遵循约束：Controller 只做参数校验和路由；Service 是唯一业务逻辑层；统一返回 `Result<T>`；集合返回空集合不返回 null；日志用 Slf4j；新增字段允许为空

### REFACTOR（重构）

- [ ] 在测试保护下重构代码结构
- [ ] 清理过程性注释（如 `// 修复分页查询缺项目类型 Bug`），改写为稳定业务规则描述或删除
- [ ] 重构后重新运行变更簇测试确认全部通过

### Maven 批量验证（变更簇间）

- [ ] 每个变更簇最多执行一次 RED Maven、一次 GREEN Maven — **不得每新增一个测试类就单独跑一次 Maven**
- [ ] 多个测试类合并执行：`mvn test -pl <module> -Dtest=TestA,TestB,TestC -o`
- [ ] 最终 compile 只执行一次（如前面已有 compile 成功证据，可复用 verification-ledger）
- [ ] 使用 `-q` 模式时：报告中写 `exitCode=0`，不得写 `BUILD SUCCESS`（除非输出中真实出现）
- [ ] 按需触发 `change-cluster-review-protocol`（详见 `../protocols.md#协议二change-cluster-review-protocol`）

## 步骤 2：编译验证（默认轻量，Maven 批量执行）

- [ ] `mvn compile -pl <module> -o`（始终执行，优先不用 `-q` 以获取 BUILD SUCCESS 证据）
- [ ] 如果使用 `-q` quiet 模式 → 报告中写 `exitCode=0`，**不得写 BUILD SUCCESS**
- [ ] 最终 compile 只执行一次，如果前面已有 compile 成功证据，可复用 verification-ledger
- [ ] 判断是否需要全量 `mvn test`：改了公共模块/mapper/sql/权限认证/controller/VO，或用户要求 full-run-validation → 执行 `mvn test -pl <module> -o`；否则跳过全量 test
- [ ] 编译失败 → 先分析错误类型（见 reference.md 编译失败策略表）
- [ ] **写入 verification-ledger.json**：`compile` 项必写（status/command/scope/evidence/时间戳/durationMs）；若执行了 mvn test 则 `unitTest` 项必写（testsRun/failures/errors/skipped/evidence）；未执行时标记 `NOT_RUN_BY_RUN`
- [ ] 顶层写入 `diffHash` / `currentHead` / `baseCommit` / `module` / `profile`；`diffHash` **必须用三部分合并命令**（inline 见 reference 步骤 2c，与 ledger-protocol 五一致），**禁止仅用 `git diff` 未提交**；`currentHead`=`git rev-parse HEAD`
- [ ] test/submit/package 阶段如果 diffHash 一致，可复用 run 的 compile/unitTest 结果

## 步骤 3：场景覆盖检查

- [ ] 单元测试场景逐条确认覆盖
- [ ] 接口测试场景逐条确认代码逻辑覆盖
- [ ] 数据兼容场景逐条确认（新字段 nullable、旧格式兼容）
- [ ] 将覆盖结果展示给用户（✅/🟡/❌ 标注）
- [ ] **覆盖状态必须正确分类**：✅ 自动化测试通过 / 🟡 静态检查未真实测试 / ❌ 未验证
- [ ] 🟡 静态检查 **不得计入"已测试通过"**
- [ ] 如果任一 P0 场景仅静态验证 → 最终结果必须是 🟡WARN
- [ ] 最终摘要禁止写 `5✅ + 17🟡 = 22/22`，必须写 `自动化测试通过: 5 / 静态检查未真实验证: 17 / 未验证: 0`

### 权限/组织过滤类变更：安全矩阵

> 凡是修改了管理员/非管理员、orgCode、数据权限、越权异常等逻辑，必须强制生成。

- [ ] 生成安全矩阵（模板见 reference.md）
- [ ] 覆盖：超级管理员 token 空/非空 × 请求 orgCode 空/指定 × projectType 有/无
- [ ] 覆盖：非管理员 token 本组织/空 × 请求 orgCode 本组织/其他组织/空 × projectType 有/无
- [ ] 如果任一权限边界预期不明确 → 不允许标记 ✅OK

## 步骤 4：关门检查（⚠️ 结束前强制执行）

- [ ] `git status --porcelain`
- [ ] `git diff --stat`
- [ ] `git diff --check`（如果失败 → 最终结果必须是 ❌FAIL）
- [ ] 变更文件是否全部在计划范围内
- [ ] 是否新增/修改了测试文件
- [ ] 是否误改 .harness/ 以外的非计划文件（如有 → 至少 🟡WARN，要求用户确认）
- [ ] 是否有 conflict marker：`<<<<<<<` / `=======` / `>>>>>>>`
- [ ] 是否有临时 debug：`System.out.println` / `console.log` / `debugger` / 临时 TODO/FIXME
- [ ] 是否有敏感信息：`password` / `token` / `secret` / `accessKey` / 私有 IP/URL
- [ ] 代码注释污染检查：生产代码中是否有 `// 修复 xxx Bug` / `// 本次变更` 等过程性注释（如有 → 必须在 REFACTOR 阶段清理）

### 变更来源区分（预存变更隔离）

- [ ] 区分本次 run 修改的文件 vs run 前预存变更的文件
- [ ] 输出变更来源表（文件 / 来源 / 是否计划内 / 是否允许提交）
- [ ] 如果存在预存变更 → 最终结果至少为 🟡WARN

### SQL 迁移任务审查清单

> 如果变更涉及 SQL 脚本，必须生成此清单。

- [ ] DROP INDEX 是否存在 IF EXISTS 或等效检查
- [ ] 新索引名称
- [ ] 新索引字段
- [ ] 是否包含 deleted_time
- [ ] 是否兼容已有数据
- [ ] 是否包含历史数据修正
- [ ] 是否需要备份
- [ ] 是否需要回滚 SQL
- [ ] SQL 脚本头部已标注"人工审查后手动执行，禁止自动运行"
- [ ] SQL 任务状态标记为 🟡 NEEDS_DB_VALIDATION（不得标记为自动化测试通过）

## 步骤 5：Worktree checkpoint commit（⚠️ 强制阻断）

> 仅在 worktree 中执行时触发此步骤。在主目录执行时跳过（标记 ⏭️主目录跳过）。

- [ ] 确认当前 cwd 在 `.worktrees/<change-name>/` 下
- [ ] 生成变更摘要：`git diff --stat` + `git diff --stat --cached`
- [ ] 构建 commit message：`wip(<scope>): <change-name> 编码完成 — N任务/M文件变更`
- [ ] **⚠️ 强制阻断**：用 blocking user confirmation 展示变更列表 + commit message，等待用户确认
- [ ] 用户确认 → 执行 `git add -A` + `git commit`（不用 --no-verify、--no-gpg-sign）
- [ ] 用户拒绝 → 记录 `❌用户拒绝`，继续后续流程
- [ ] 记录 checkpoint commit hash 到执行日志

## 步骤 6：计划状态持久化

- [ ] 每个任务状态更新到 plan 文件或新增 `run-task-status.md`
- [ ] 状态区分：✅ DONE_AUTOMATED_TESTED / 🟡 DONE_STATIC_ONLY / 🟡 DONE_NEEDS_INTERFACE_TEST / 🟡 NEEDS_DB_VALIDATION / ❌ FAILED
- [ ] 确保后续 harness-test / harness-review 可读取待验证场景

## 执行日志完成记录

- [ ] 追加结束时间、耗时、结果、摘要、checkpoint commit 状态
- [ ] **执行日志去重检查**：同一阶段不重复追加小节，如需补充应 Edit 原小节
- [ ] 如果存在 🟡静态验证 P0 场景 → 下一步必须写 `必须先运行 /harness-test`，不得并列"提交代码"
- [ ] 如果存在 SQL 迁移/DB 验证未完成 → 最终不得输出纯 ✅OK

### 最终状态分级

- [ ] **✅OK**：所有计划内代码变更完成 + 关键 P0 场景已自动化测试通过 + compile 成功 + 无预存变更或已隔离 + 无非计划文件混入 + 无 P0 静态-only 场景
- [ ] **🟡WARN**：存在 P0/P1 场景仅静态验证 / 存在预存变更 / SQL 需人工执行 / Mapper 只做静态验证 / 低价值 Mock 替代真实验证
- [ ] **❌FAIL**：compile 失败 / 有效测试失败 / RED 无法建立 / 非计划文件被修改且无法解释 / git diff --check 失败
- [ ] 如果存在 SQL 迁移/接口验证/DB 验证未完成 → 最终输出 🟡WARN，不得纯 ✅OK

## events 记录（禁止手工 Edit execution-log）

- [ ] 步骤 0 前 append `phase.start`
- [ ] TDD/compile/test 写 `command` + `verification`；预存/worktree/降级写 `decision`/`issue`
- [ ] `execution-log.md` 仅由 `harness_events.py` 渲染

## PowerShell-only 命令检查

- [ ] 所有 git 命令使用 `powershell.exe -NoProfile -Command "git ..."`
- [ ] 所有 Maven 命令使用 `powershell.exe -NoProfile -Command "mvn ..."`
- [ ] 所有文件系统命令使用 PowerShell
- [ ] 如果出现 Bash hook error，记录违规命令并将当前阶段至少标为 🟡WARN

## Ledger 必填字段检查

- [ ] verification-ledger.json 包含 changeName/projectRoot/worktreeRoot/stateDir
- [ ] 包含 currentHead/baseCommit/diffHash/module/profile
- [ ] 包含 validations.compile 与 validations.unitTest
- [ ] diffHash 必须用三部分合并命令（inline 见 reference 步骤 2c；commit 前 `baseCommit..HEAD` 部分为空也**必须保留**），`currentHead`=`git rev-parse HEAD`；禁止仅用 `git diff` 未提交——省略第一部分会导致 commit 后 diffHash 变化、run→test 复用链断裂
- [ ] 缺字段时标记 `ledgerReusable=false`，后续阶段不得复用

## 新筛选参数非法值行为检查

- [ ] 如果新增筛选参数，设计中已明确非法值行为
- [ ] 如果采用“忽略并不过滤”，必须有用户确认记录
- [ ] 测试场景覆盖非法值
