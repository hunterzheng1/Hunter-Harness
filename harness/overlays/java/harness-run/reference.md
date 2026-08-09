---
description: harness-run 的编译失败策略表、TDD循环详细步骤和编码约束。仅在编码执行遇到编译问题或需要参考详细规则时读取�?
---

# harness-run 参�? �? 详细规则

## 为什么走变更�? TDD 而不是逐任�? TDD

逐任�? TDD 有三个严重效率问题：
1. **Maven 反复启动**——每个小任务（如新增一个错误码）都单独启动 Maven，耗时 30-60 �? × N 个任务，累计浪费大量时间
2. **测试碎片�?**——每个小任务单独建测试类，mock 重复配置，测试之间缺乏关�?
3. **上下文切�?**——RED→GREEN→REFACTOR 每个小任务独立循环，打断编码思路

变更�? TDD 将围绕同一业务行为的多个任务合并为一个变更簇，一�? RED、一�? GREEN 验证。每个变更簇 2-5 分钟，Maven 只启动必要次数�?

**变更簇示�?**�?
- 错误�? + Mapper 查询 + Service 校验 + create/update/copy 调用 �? 归为一�?"ruleCode+version 唯一�?"变更�?
- updateRule status 联动 + activateVersion status 联动 + enabledList activeFlag 过滤 �? 归为一�?"status/activeFlag 一致�?"变更�?

## 前置条件

- `.harness/changes/<change-name>/spec/<change-name>-design.md` 存在（含完整 frontmatter�?
- `.harness/changes/<change-name>/plans/<change-name>-plan.md` 存在（含完整 frontmatter�?
- `.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md` 存在
- `.harness/changes/<change-name>/plans/<change-name>-implementation-detail.md`（如存在，补充读取）
- 用户已审批通过计划
- 如果�? worktree 中，已切换到 worktree 目录

## 步骤 0：加载上下文

## Worktree 创建与切换详细规�?

`harness-run` 必须�? `worktree.json` 当作唯一决策源�?

### 状态机

```text
requested=false
  -> MAIN_DIR

requested=true + path exists
  -> USE_EXISTING_WORKTREE

requested=true + path missing
  -> CREATE_WORKTREE
     -> success: USE_CREATED_WORKTREE
     -> failure: STOP or ASK_USER_TO_DOWNGRADE
```

### PowerShell 命令模板

```powershell
powershell.exe -NoProfile -Command "git worktree add '.worktrees/<change-name>' -b 'harness/<change-name>'"
```

如果分支已存在：

```powershell
powershell.exe -NoProfile -Command "git worktree add '.worktrees/<change-name>' 'harness/<change-name>'"
```

验证�?

```powershell
powershell.exe -NoProfile -Command "Test-Path '.worktrees/<change-name>/.git'"
```

### 状态目录写�?

即使代码�? worktree 中修改，`.harness/changes/<change-name>/` 仍是主项目下的状态真相源。run 必须记录�?

```json
{
  "projectRoot": ".../udp",
  "worktreeRoot": ".../udp/.worktrees/<change-name>",
  "stateDir": ".../udp/.harness/changes/<change-name>"
}
```



> ⚠️ **phase.start 前置**：步�? 0 第一件事�? `harness_events.py append --type phase.start`（见底部「执行日志记录」）�?**任何代码修改前必须先记录**，不能等代码改完才补�?
> ⚠️ **测试基础设施探测前置**：步�? 0 中必须首先执�?"步骤 0.5 测试基础设施探测"，探测完成前不得写任�? TDD 降级结论�?

1. **确定变更�?**：用 Glob 搜索 `.harness/changes/*/plans/*-plan.md`�?**排除 `.harness/archive/*/`**），读取找到�? plan.md �? YAML frontmatter，提�? `change-name`。默认最多一个未归档变更；如有多个，优先取最近修改的，或询问用户选择�?
2. **读取并执�? worktree 决策**：读�? `.harness/changes/<change-name>/worktree.json`。如�? `requested=false`，在主目录执行；如果 `requested=true` �? worktree 存在，必�? cd 到该 worktree；如�? `requested=true` �? worktree 不存在，必须创建 worktree，创建失败则停止或询问用户是否改为主目录执行。禁止静默降级�?
3. **读取计划文件（主任务源）**：`.harness/changes/<change-name>/plans/<change-name>-plan.md` �? 获取任务列表和依赖关�?
4. **读取详细计划（补充参考）**：`.harness/changes/<change-name>/plans/<change-name>-implementation-detail.md`（如存在）→ 获取详细执行说明
5. **读取设计文档**：`.harness/changes/<change-name>/spec/<change-name>-design.md` �? 获取核心设计决策和不变项
6. **读取测试场景�?**：`.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md` �? 获取测试真相�?
7. **读取验证账本**：`通过共享状态目录解析器定位的 evidence/verification-ledger.json`（如存在）→ 复用已有 compile/unitTest 结果
8. **读取任务状�?**：`.harness/changes/<change-name>/run-task-status.md`（如存在）→ 恢复上次运行状�?
9. 确认 `项目规则（见 .harness/context-index.json�?/` 规则已加�?
10. **执行测试基础设施探测**（见下方"步骤 0.5"�?
11. 确认编译环境正常（`powershell.exe -Command "mvn compile -pl <module> -o -q"`�?
12. **检查构建配置完整�?**：如果在 worktree 中执行，确认构建配置文件（如 `.mvn/maven.config`、`settings.xml`、`gradle.properties` 等）存在。worktree 可能不包含主目录的构建配置，缺失时从主目录复�?
13. **依赖模块预安�?**：如果在 worktree 中执行，检查上游依赖模块是否已 `mvn install` 到本地仓库。缺失时先执�? `powershell.exe -Command "mvn install -pl <upstream-modules> -am -DskipTests -nsu"`
14. **代码探索优先�? codegraph_explore**：一次调用可获取多个相关符号的源码，替代逐个 Read 文件。违�? `项目 codegraph 规则` 规则逐个 Read 会浪�? 3-5 分钟。仅�? codegraph 返回结果不完整时补充 Read

### Maven 项目配置与重试预�?

- 运行 Maven 前先读取项目已有�? `.mvn/maven.config`；其中的 `-s`、`-o`、镜像和仓库设置视为项目契约，不在命令行重复追加或覆盖�?
- 若项目配置已启用离线模式，依赖缺失只允许一次有明确原因的恢复尝试：仅在项目规则允许联网时临时执行非离线�? `-nsu` 命令；随后继续遵循项目配置，不得在离�?/联网命令之间循环试错�?
- 同一失败命令不得无分析地重复执行。先按“配�?/依赖缺失、编译、测试、业务断言”分类，再决定修复或停止；每个变更簇仍遵守一�? RED、一�? GREEN �? Maven 预算�?

### 步骤 0.1：执行模式（默认 Inline�?

默认 **Inline Execution**；仅 `--subagent` 强制 Subagent-Driven�?**不询�?**任务�?/模块数（P1-5）�?

### 步骤 0.5：测试基础设施探测（⚠�? 必须先于任何 TDD 降级结论�?

> **核心原则**：探测完成前，执行日志中只能�? `**测试基础设施**: CHECKING`，不得写任何降级结论。证据不足时禁止�?"项目无测试基础设施""RED 降级""TDD 降级"�?

### 探测流程

按顺序收集四项证据：

**探测 1：src/test/java 目录是否存在**
```text
# �? Glob �? Read 检查目标模块下是否�? src/test/java 目录
```
- 结果：✅ 存在 / �? 不存�?

**探测 2：pom.xml 是否包含测试依赖**
检查目标模块的 `pom.xml`，搜索以下依赖：
- `spring-boot-starter-test`
- `junit` / `junit-jupiter`
- `mockito` / `mockito-core` / `mockito-junit-jupiter`
- 结果：✅ 包含关键测试依赖 / 🟡 部分包含 / �? 无测试依�?

**探测 3：是否存在已有测试文�?**
�? Glob 搜索目标模块�? `src/test/java/**/*Test*.java` �? `src/test/java/**/*Tests*.java`
- 结果：✅ 存在 N 个测试文�? / �? 无测试文�?

**探测 4：测试命令是否可运行**
```powershell
powershell.exe -Command "mvn test -pl <module> -o -q"
```
- 结果：✅ BUILD SUCCESS / �? 编译失败（记录失败原因）

### 探测结论

四项证据全部收集完毕后，汇总写入执行日志：

```markdown
### 测试基础设施探测结果
- **src/test/java**: �? 存在 / �? 不存�?
- **测试依赖**: �? spring-boot-starter-test + junit + mockito / 🟡 部分包含 / �? �?
- **已有测试文件**: �? N �? / �? �?
- **测试命令可运�?**: �? BUILD SUCCESS / �? 失败（原因）
- **结论**: �? 测试基础设施可用 / 🟡 测试基础设施部分可用 / �? 测试基础设施不可�?
```

- �? 可用 �? 必须执行完整 TDD 流程
- 🟡 部分可用 �? 记录可用的部分和不可用的部分，降级不可用部分
- �? 不可�? �? TDD RED 降级为静态逻辑验证（见下方降级策略�?

## RED：写测试（变更簇批量模式�?

> **TDD 不可跳过�?** 如果测试基础设施探测结果�? �? 可用，RED 阶段必须写测试。如果探测结果为 �? 不可用，按下方降级策略执行�?
> **进入变更�? RED 前必须执行原�? `run-tdd-protocol`**（详�? `../protocols.md#协议一run-tdd-protocol`），必须在写第一行测试代码或生产代码之前完成 RED 三态判定�?

从场景表选取对应当前变更簇的测试用例�?

- **单元测试**（优先）：JUnit 5 + Mockito，命�? `{方法名}_{场景}_{预期结果}()`，用 AssertJ `assertThat`
- **接口测试**（必要时代码逻辑已覆盖即可，实际 HTTP 调用留给 `harness-test`�?
- **多个测试类合并到一�? Maven 命令执行**：`mvn test -pl <module> -Dtest=TestA,TestB,TestC -o`

### RED 有效性判定（⚠️ 必须逐项确认�?

RED 不是"测试失败"即可通过，必须确认失败原因与目标 bug/需求直接相关�?

**有效 RED（✅ 允许进入 GREEN�?**�?
- 测试编译通过
- 目标测试失败
- 失败断言指向目标业务行为（如 `assertThat(result.getEnabledIndicators()).isNotEmpty()` 失败�?
- 失败信息能对应本�? bug 或需求（�?"期望返回非空列表，但实际返回空列�?"�?

**无效 RED（❌ 禁止进入 GREEN，必须先修测试）**�?
- 测试编译失败（语法错误、import 缺失等）
- **测试直接调用 private 方法导致编译失败**
- **�? private 访问限制导致失败**
- mock/stubbing 错误（如 `UnnecessaryStubbingException`、`PotentialStubbingProblem`�?
- `NoSuchBeanDefinitionException`（Spring 上下文加载失败）
- `NullPointerException` 来自测试搭建错误（如�? mock 依赖、未初始化测试数据）
- 不必�? stubbing
- 依赖缺失（如测试依赖的类/method 尚未创建�?
- 测试数据非法导致前置校验失败（如必填字段为空、格式校验不通过�?
- 失败原因与目�? bug 无关（如测试的是另一个方法的逻辑�?

**RED 必须优先通过 public API / public service method / controller behavior 验证**。private 方法只作为实现细节，测试应通过 `createRule` / `updateRule` / `copyRule` / `activateVersion` / `getEnabledList` 等公共行为间接验证�?**不得�?"访问 private 方法失败"记录为有�? RED�?**

**判定流程**�?
1. 运行测试
2. 查看失败输出
3. 逐条对照上述清单判定
4. 写入执行日志：`RED: ✅有�? / 🟡部分有效 / ❌无效`
5. 记录失败原因
6. 记录是否允许进入 GREEN

**如果出现无效 RED**�?
1. 必须先修复测试问题（补充 mock、修�? stub、修复测试数据等�?
2. 重新运行测试确认 RED 有效
3. 只有有效 RED 后才允许进入 GREEN 阶段
4. **禁止在无�? RED 后进入生产代码修�?**

**greenfield 大重写的 RED 处理**�?

当变更簇新建多个此前不存在的方法/类（典型：store/repository/service 大规模重写），新方法未实现时测试会抛 NullPointerException/NoSuchBeanDefinitionException�?"依赖缺失"类无�? RED）。逐方法写"返回错误值的�?"以获�? clean 断言失败，在方法数多时成本过高且桩代码一次性丢弃。处理决策：

| 条件 | 处理 |
|---|---|
| 新方�? �? 2-3 个，或簇内有部分已存在方�? | 仍须写桩，确�? RED �? clean 断言失败（变更簇范式�? |
| 新方法多（如 10+）、桩成本过高�?**且有集成/端到端测试覆盖该簇行�?** | 允许 `🟡RED-skip(原因)`，直接写测试+实现+GREEN 验证 |

允许 RED-skip 时必须：�? 执行日志�? `RED: 🟡RED-skip(greenfield 大重写，N 个新方法，由 <集成测试�?> 覆盖)`；② GREEN 后必须跑该簇测试 + 集成测试全过；③ **不得用于"mock 复杂/配置麻烦"等非 greenfield 场景**（见下方"私有方法/mock 复杂降级决策�?"）�?

### 低价�? TDD 豁免策略

以下变更**不得强制单独建立测试类并单独 Maven 验证**�?

| 变更类型 | 验证方式 | 说明 |
|----------|----------|------|
| ErrorCode 常量 | compile 验证 + 被高层测试间接覆�? | 禁止为单个错误码新增独立测试�? |
| VO/DTO 字段 | �? service/API 测试间接覆盖 | 字段赋值和序列化由上层测试保证 |
| 注释 | compile 验证 | 不影响运行时行为 |
| import 清理 | compile 验证 | 不影响运行时行为 |
| 格式�? | compile 验证 | 不影响运行时行为 |
| SQL 迁移脚本 | 静态审�? + harness-test DB 验证 | 不做 TDD，生成审查清�? |
| 配置模板 | 静态审�? | 部署时生�? |
| 文档文件 | 静态审�? | 不涉及代�? |

### 行为性修改不属豁免（新增逻辑分支必须 RED�?

正则/条件/分支逻辑变更新增的逻辑分支**不属上表豁免**，必须有对应 RED 验证该分支行为，不得仅靠现有测试覆盖省略。现有测试只证明"原有行为未回�?"，不替代"新分支有测试"。例：正则新�? UNC 拦截分支，须构�? UNC 路径�? RED（旧正则漏检）再 GREEN（新正则拦截），原有 `../` 测试覆盖不到新分支。详�? SKILL.md 规则七「行为性修改新分支必须 RED」�?

### Mapper 查询条件验证规则

Mapper 查询条件、LambdaQueryWrapper、SQL/XML 查询逻辑�?**不得通过�? Mock 返回值来宣称自动化测试通过**�?

**低价�? Mock 测试（应标记�? 🟡静态验证）**�?
- Mock mapper 返回期望列表
- 测试只验�? service 返回�? mock 数据
- 没有验证实际 SQL / Wrapper 条件
- 无法证明 `.eq(activeFlag, true)` 等查询条件存�?

**推荐验证方式**�?
1. run 阶段标记�? 🟡静态验�?
2. test 阶段通过真实 DB / 接口验证
3. 如果必须自动化，使用真实 mapper（非 mock）或可检�? wrapper 条件的测试方�?

**禁止把纯 Mock Mapper 测试计入"Mapper 查询条件已自动化测试通过"�?**

### 私有方法 / mock 复杂的降级决策表

> 私有方法不能直接测试，但必须优先寻找公共行为入口测试�?"mock 复杂"不是直接跳过测试的充分理由�?

跳过自动化测试前必须完成此决策表�?

| 问题 | 结果 |
|---|---|
| 是否存在公共方法可测�? | �?/�? |
| 是否可通过 mapper/mock 构造？ | �?/�? |
| 是否可通过 mockStatic 构造？ | �?/�? |
| 是否可写轻量集成测试�? | �?/�? |
| 跳过自动化测试的具体阻塞�? | ... |
| 后续必须由哪个阶段验�? | harness-test / 手工接口 / 部署验证 |

如果只是"配置麻烦"�?"mock 复杂"，不得直接跳过。对 DTO 字段、分页返回、权限过滤、组织过滤等用户可见行为，必须优先写公共行为测试�?

### TDD 降级策略

当项目无测试基础设施时，RED 阶段降级�?"静态逻辑验证"�?

1. **在执行日志中记录降级原因**：必须包含三项信�?
   - 为什么降级（如：`TDD RED 降级：模�? <module> �? src/test/java 目录` �? `pom.xml 缺少 spring-boot-starter-test 依赖`�?
   - 哪些场景只做了静态验证（列出场景编号清单�?
   - 哪些场景需要部署后验证（列出场景编号清单）
2. 对每个任务，从场景表中选取相关场景�?**在执行日志和覆盖报告中标注静态验证关�?**（如 `执行日志：UT-001 通过静态验�? �? 检�? IndicatorServiceImpl.getEnabledIndicators 已添加组织过滤逻辑`）�?**不得在业务代码注释中标注覆盖关系**，避免污染业务代�?
3. GREEN 阶段完成后，对照场景表逐条确认代码逻辑已覆盖（不运行测试，只做静态检查）
4. 在场景覆盖检查中标注三类状态：
   - �? 已测试通过（仅在测试基础设施可用且测试已运行通过时使用）
   - 🟡 静态验证通过，未真实测试（TDD 降级时使用）
   - �? 未覆�? / 未验证（场景未对应代码逻辑或需端到端验证）
5. 输出必须明确写成�?
   - "🟡 静态逻辑验证通过"
   - "未执行真实单元测�?"
   - "待测试基础设施补齐后运�? harness-test"
6. **禁止写成**�?"测试全部通过"�?"测试通过 N/N"�?"覆盖�? 100%"等含暗示真实测试已运行的表述
7. 提示用户在测试基础设施就绪后补充运�? `harness-test`

## GREEN：最简实现

写最少代码让测试通过。关键约束：
- Controller 只做参数校验和路�?
- Service 是唯一业务逻辑�?
- 统一返回 `Result<T>`
- 集合返回空集合，不返�? null
- 日志�? Slf4j，不�? System.out
- 新增字段允许为空（兼容旧数据�?

## REFACTOR：重�?

在测试保护下重构代码结构。关键约束：
- 重构后重新运行测试确认全部通过
- 清理过程性注释（�? `// 修复分页查询缺项目类�? Bug`），改写为稳定业务规则描述或删除
- 检查代码注释污染：生产代码中不得保留解�?"本次 bug 修复"的临时注�?

## GREEN 后反模式自检（内置清单）

> 如果 `run-tdd-protocol` 已按真实 RED 执行，此步骤可跳过（已包含在 TDD 流程中）�?
> 如果执行静�? RED 或降级，使用以下内置清单作为替代�?

GREEN 阶段完成后，对照以下反模式清单自检�?

```
�? 测试不依赖网络或外部服务（应�? mock 替代�?
�? 无断言链（一个测试方法只断言一个行为，不用多个 assert 串联�?
�? 测试不验证实现细节（只验证公共行为，不验证私有方法调用）
�? 测试命名表达意图（{方法名}_{场景}_{预期结果}�?
�? 每个测试方法独立，不依赖执行顺序
�? 测试数据自包含（不依赖其他测试创建的数据�?
�? �? sleep/硬编码等待（�? Awaitility 或条件判断替代）
�? 测试覆盖正常路径 + 异常路径 + 边界�?
```

## 编译失败的处理策�?

不是所有编译错误都需要修复。先判断是否与本次变更相关：

| 错误类型 | 判断方法 | 处理 |
|----------|----------|------|
| 找不到符号（新代码） | 检查类路径�? import | 修复 |
| 找不到符号（已有代码�? | 对比 git diff | 与本次变更无�? �? 跳过 |
| 依赖缺失 | �? import 了错误的包路�? | 修复导入路径 |
| settings.xml 乱码 | Maven 输出含乱码字�? | 改用相对路径 |
| 子模�? POM �? parent | 非本模块的编译错�? | �? `-pl` 跳过无关模块 |

> 关键是：不要因为一个不相关的模块编译失败就阻塞整个开发流程�?

## Maven 批量验证策略

harness-run 必须减少 Maven 启动次数�?

**默认策略**�?
1. 每个变更簇最多执行一�? RED Maven、一�? GREEN Maven
2. 多个测试类合并到一�? Maven 命令：`mvn test -pl <module> -Dtest=TestA,TestB,TestC -o`
3. 不得每新增一个测试类就立即单独跑一�? Maven
4. 最�? compile 只执行一�?
5. 如果前面已有 compile 成功证据，最�? compile 可复�? verification-ledger

**禁止**�?
```
TestA RED �? TestA GREEN �? TestB RED �? TestB GREEN �? TestC RED �? TestC GREEN
```
**应改�?**�?
```
TestA+TestB+TestC RED �? 实现相关代码 �? TestA+TestB+TestC GREEN �? 最�? compile
```

## Maven 证据规则

如果使用 `-q` quiet 模式�?
- 根据 exit code 0 判断命令成功
- 报告中必须写 `exitCode=0`
- **不得�?"BUILD SUCCESS"**，除非输出中真实出现 BUILD SUCCESS

最终报告推荐格式：
- `mvn compile -q`: �? exitCode=0，无错误输出
- `mvn compile`: �? BUILD SUCCESS

最�? evidence 命令优先不用 `-q`，或者同时记�? exit code�?

## 预存变更隔离

如果 harness-run 开始时检测到已有未提交变更，并且用户选择保留，必须创�? baseline�?

### baseline 文件

**pre-existing-files.json**�?
```json
{
  "detectedAt": "YYYY-MM-DD HH:mm:ss",
  "userChoice": "keep | stash | abort",
  "allowSubmit": false,
  "files": [
    {
      "path": "relative/path/to/file.java",
      "diffHash": "sha256:...",
      "inPlan": false
    }
  ]
}
```

**pre-existing-diff.patch**：完�? `git diff` 输出保存�? patch 文件�?

### 变更来源区分

结束时必须在输出中区分：

| 文件 | 来源 | 是否计划�? | 是否允许提交 |
|---|---|---|---|
| A.java | 本次 run 修改 | �? | �? |
| B.java | run 前预存变�? | �?/未知 | 需用户确认 |

如果存在预存变更，最终结果至少为 🟡WARN�?

## SQL 迁移任务处理

SQL 迁移脚本不做 TDD，也不自动执行�?

### run 阶段处理

1. 尽早生成 SQL 脚本
2. 在脚本头部标注：
```sql
-- ⚠️ 人工审查后手动执行，禁止自动运行
-- 变更: <change-name>
-- 生成时间: YYYY-MM-DD HH:mm
```
3. 生成 SQL 审查清单
4. �? run-task-status 中标�? NEEDS_DB_VALIDATION

### SQL 审查清单模板

| # | 检查项 | 结果 |
|:--:|--------|:---:|
| 1 | DROP INDEX 是否存在 IF EXISTS 或等效检�? | �?/�? |
| 2 | 新索引名�? | <名称> |
| 3 | 新索引字�? | <字段列表> |
| 4 | 是否包含 deleted_time | �?/�? |
| 5 | 是否兼容已有数据 | �?/�?/需验证 |
| 6 | 是否包含历史数据修正 | �?/�? |
| 7 | 是否需要备�? | �?/�? |
| 8 | 是否需要回�? SQL | �?/�? |

SQL 相关任务状态：🟡 NEEDS_DB_VALIDATION�?**不得标记为完全自动化测试通过**�?

## 最终状态分�?

### ✅OK
- 所有计划内代码变更完成
- 关键 P0 场景已自动化测试通过
- compile 成功
- 无预存变更或预存变更已明确隔�?
- 无非计划文件混入
- �? P0 静�?-only 场景

### 🟡WARN
- 存在 P0/P1 场景仅静态验证，需 harness-test
- 存在预存变更
- SQL 脚本需要人工执行或 DB 验证
- Mapper/SQL 查询只做静态验�?
- 使用了低价�? Mock 替代真实验证
- compile/test 成功但仍需接口/DB 验证

### ❌FAIL
- compile 失败
- 有效测试失败
- RED 无法建立
- 非计划文件被修改且无法解�?
- git diff --check 失败

如果存在 SQL 迁移、接口验证、DB 验证未完成，最终不得输出纯 ✅OK，应输出�?
🟡WARN：编码完成，需 harness-test 验证剩余 DB/API 场景�?

## 步骤 2：编译验证（默认轻量，按需全量 test�?

> **轻量验证职责**：`/harness-run` 默认只做开发反馈，不默认跑全量 `mvn test`。是否跑全量 test 按下方条件判断�?

### 2a. 编译验证（始终执行）

```powershell
powershell.exe -Command "mvn compile -pl <module> -o"
```
优先不用 `-q`，以获取 BUILD SUCCESS 证据。如果使�? `-q`，报告中�? `exitCode=0`�?

### 2b. 全量 mvn test（仅当满足触发条件时执行�?

默认**跳过**全量 `mvn test`，把完整单元测试留给 `/harness-test`。仅当满足以下任一条件时才在本阶段执行 `mvn test -pl <module> -o`�?

- 修改了公共模块（被多模块依赖�? common/utils 等）
- 修改�? mapper / sql / xml
- 修改了权�? / 认证 / 组织过滤逻辑
- 修改�? controller / VO / DTO
- 用户要求 `full-run-validation`
- 用户不打算继续运�? `/harness-test`（run 需自证 P0 场景�?

```powershell
powershell.exe -Command "mvn test -pl <module> -o"
```

**编译/测试成功必须有明确证�?**�?
- `mvn compile`（无 `-q`）输出必须包�? `BUILD SUCCESS` 才能宣称"编译成功"
- `mvn compile -q`：根�? exit code 0 判断，报告中�? `�? exitCode=0`
- `mvn test` 输出必须包含 `Tests run: N, Failures: 0, Errors: 0` 才能宣称"测试通过"
- 如果命令�? hook 拒绝�?**必须停止流程或切�? PowerShell 重试**，不得继续宣�?"成功"
- 如果 exit code �? 0 或无有效 stdout，标记为 �? 编译失败 / 状态未�?
- 如果�? TDD 降级（无测试基础设施），mvn test 步骤跳过，标�? 🟡 静态验�?

### 2c. 写入 verification-ledger

步骤 2 完成�?**必须**写入/更新 `通过共享状态目录解析器定位的 evidence/verification-ledger.json`�?

- `compile` 项：始终写入（status / command / scope / evidence / 时间�? / durationMs�?
- `unitTest` 项：仅当 2b 执行了全�? mvn test 时写入（testsRun / failures / errors / skipped / evidence）；未执行时标记 `{"status": "NOT_RUN_BY_RUN", "note": "轻量验证，全量单元测试由 harness-test 执行"}`
- 顶层写入 `diffHash` / `currentHead` / `baseCommit` / `module` / `profile`
- `baseCommit`：merge-base 或计划起点（worktree 分支从主分支分出点，�? harness-plan 写入、run 读取复用；缺失时�? `git merge-base HEAD <默认分支>` 兜底�?
- `currentHead`：`git rev-parse HEAD`（步�? 2c �? Step 5 checkpoint commit 之前执行，此�? HEAD==baseCommit；commit �? HEAD 前移�? checkpoint commit，由 ledger-protocol reuse 规则 #2「currentHead 可前移」容忍，**不需为它改时�?**�?
- `diffHash`�?**必须�? ledger-protocol「五、真�? diffHash」的 commit-invariant 三部分合并命�?**（与 harness-test 重算命令逐字一致）�?**禁止仅用 `git diff`（未提交�?**。命令如下（�? `Bash(powershell.exe:*)` 通道时外层用单引号防 `$base` 展开，见 ledger-protocol 五）�?

```powershell
powershell.exe -NoProfile -Command "$base = '<baseCommit>'; $patch = '.harness/changes/<change>/runtime/current-diff.patch'; & { git diff $base HEAD --binary; git diff --binary; git ls-files --others --exclude-standard | ForEach-Object { Get-Content -Raw -LiteralPath $_ } } | Out-File -Encoding utf8 $patch; (Get-FileHash $patch -Algorithm SHA256).Hash"
```

> ⚠️ **commit 前时序陷阱（真实教训�?**：步�? 2c �? Step 5 checkpoint commit **之前**执行，此�? `git diff $base HEAD` 部分为空（HEAD==baseCommit），只有"未提�? + 未跟�?"是全量�?**即使第一部分为空也必须保留三部分合并**——commit 后第一部分被填充、未提交/未跟踪变空，两者内容相�? �? diffHash 一致。若省略第一部分只用未提�? diff，commit 后未提交变空 �? diffHash 变化 �? run→test 复用链断裂（真实日志：run 产出非规�? `8a94c874` 即因此，test 重算 `b4c580fc` 不一致，被迫重跑全量单元测试）�?

> ⚠️ **禁止任何单部分简化（堵字面空子）**：上述教训只点了"仅用未提�? diff"。实际还有两种等价违规简化，�?**禁止**�?
> - `git diff <base> HEAD --binary`（仅已提交部分）：commit 后工作树 clean 时结果偶然与三部分合并一致，�? commit 前算会漏未提�?+未跟踪，且方法本身违�?"三部分合�?"要求�?
> - `node -e "...crypto.createHash('sha256')..."` 自算：绕�? PowerShell 三部分合并命令，且无法捕获未跟踪文件内容�?
>
> 无论 commit 前后、无论工作树是否 clean�?**必须**用三部分合并命令�?"commit �? clean 致单部分偶然等价"不得作为省略三部分的依据——时序或工作树状态一旦变化即复现复用链断裂�?

> 这样 harness-test �? Phase 1 可读�? ledger 判断是否复用 run �? unitTest（diffHash commit-invariant + reuse 规则 #2 允许 HEAD 前移 �? run �? checkpoint commit 不破坏复用），submit/package 也可复用 compile 结果。详�? `../protocols/ledger-protocol.md`�?

## 步骤 3.5：权�?/组织过滤类变�? �? 安全矩阵

> 凡是修改了以下逻辑，必须强制生成安全矩阵。如果任一权限边界的预期不明确，不允许标记 harness-run �? ✅OK�?

### 触发条件

修改了以下任一逻辑即触发：
- 管理�? / 非管理员判断
- 组织编码 orgCode 过滤
- token 中的组织
- 请求参数中的组织
- 数据权限
- 越权异常
- public/common 数据可见�?

### 安全矩阵模板

| 角色 | token orgCode | 请求 orgCode | projectType | 预期结果 | 覆盖状�? |
|---|---|---|---|---|---|
| 超级管理�? | �? | �? | �? | 查全�? | �?/🟡/�? |
| 超级管理�? | �? | �? | �? | 查全�? | �?/🟡/�? |
| 超级管理�? | 其他组织 | 指定组织 | �? | 按请求组织查�? | �?/🟡/�? |
| 超级管理�? | 其他组织 | 指定组织 | �? | 按请求组织查�? | �?/🟡/�? |
| 非管理员 | 本组�? | 本组�? | �? | 允许 | �?/🟡/�? |
| 非管理员 | 本组�? | 本组�? | �? | 允许 | �?/🟡/�? |
| 非管理员 | 本组�? | 其他组织 | �? | 拒绝 | �?/🟡/�? |
| 非管理员 | 本组�? | 其他组织 | �? | 拒绝 | �?/🟡/�? |
| 非管理员 | �? | 指定组织 | �? | 必须明确：拒�?/允许/依赖上游保证 | �?/🟡/�? |
| 非管理员 | �? | 指定组织 | �? | 必须明确：拒�?/允许/依赖上游保证 | �?/🟡/�? |
| 非管理员 | 本组�? | �? | �? | 按本组织过滤 | �?/🟡/�? |
| 非管理员 | 本组�? | �? | �? | 按本组织过滤 | �?/🟡/�? |

### 判定规则

- 如果任一权限边界的预期不明确（如"非管理员+token�?+指定组织"场景未明确是拒绝还是允许），则必须标记为 ❌未验证，且不允许标�? harness-run �? ✅OK
- 每个场景的覆盖状态必须真实标注：�? 自动化测试通过 / 🟡 静态检查未真实测试 / �? 未验�?
- 安全矩阵必须写入执行日志

## 步骤 4：关门检查（⚠️ 结束前强制执行）

在输出最终总结前，必须执行并展示以�? 10 项检查：

### 1. git status --porcelain
```powershell
powershell.exe -Command "git -C '<project-path>' status --porcelain"
```
展示所有变更文件列表�?

### 2. git diff --stat
```powershell
powershell.exe -Command "git -C '<project-path>' diff --stat"
```
展示变更统计�?

### 3. git diff --check
```powershell
powershell.exe -Command "git -C '<project-path>' diff --check"
```
检查空白字符冲突�?**如果此命令失�? �? 最终结果必须是 ❌FAIL**�?

### 4. 变更文件是否全部在计划范围内
对照 plan.md 的任务描述，确认每个变更文件都在计划范围内�?

### 5. 是否新增/修改了测试文�?
如果探测到测试基础设施可用但未新增/修改测试文件，必须记录原因�?

### 6. 是否误改 .harness/ 以外的非计划文件
如果有非计划文件变更 �? 至少 🟡WARN，并要求用户确认�?

### 7. conflict marker 检�?
搜索以下模式（用 Grep）：
- `<<<<<<<`
- `=======`
- `>>>>>>>`

如果命中 �? 最终结果必须是 ❌FAIL�?

### 8. 临时 debug 检�?
搜索以下模式（用 Grep）：
- `System.out.println`
- `console.log`
- `debugger`
- 临时 `TODO` / `FIXME`（不含计划中�? TODO�?

如果命中 �? �? REFACTOR 阶段清理�?

### 9. 敏感信息检�?
搜索以下模式（用 Grep）：
- `password`
- `token`
- `secret`
- `accessKey`
- 私有 IP 地址
- 内部 URL（如非必要不得新增）

如果命中且非必要 �? 必须清理后再标记完成�?

### 10. 代码注释污染检�?
搜索以下模式（用 Grep）：
- `// 修复` + `Bug`
- `// 本次` + `变更` / `修改`
- `// 新增` + `功能` / `字段`
- 其他解释"本次变更过程"的临时注�?

如果命中 �? �? REFACTOR 阶段清理或改写为稳定业务规则描述�?

### 关门检查结果模�?

```markdown
## 关门检查结�?
- git status --porcelain: �?/�?
- git diff --stat: �?/�?
- git diff --check: �?/❌（�? �? 最终结�? ❌FAIL�?
- 变更文件在计划内: �?/�?
- 新增/修改测试文件: �?/�?/🟡不适用（TDD降级�?
- 非计划文件变�?: ✅无/❌有（❌ �? 🟡WARN�?
- conflict marker: ✅无/❌有（❌ �? ❌FAIL�?
- 临时 debug: ✅无/🟡有已清理/❌有未清�?
- 敏感信息: ✅无/❌有（❌ �? 必须清理�?
- 代码注释污染: ✅无/🟡有已清理/❌有未清�?
```

## 步骤 5：计划状态持久化

如果 `.harness/changes/<change>/plans/*.md` 是任务来源，�? harness-run 完成任务后必须持久化任务状态�?

### 持久化方�?

**方式一（推荐）**：更�? plan.md 中的任务状�?

�? plan.md 的任务列表中，为每个任务追加状态标记：

```markdown
### Task 1: 修复分页查询缺项目类�? Bug
- **状�?**: �? DONE_AUTOMATED_TESTED
- **测试**: UT-001~005 已通过
```

**方式�?**：新�? `run-task-status.md`

�? `.harness/changes/<change-name>/run-task-status.md` 中记录：

```markdown
# Run Task Status �? <change-name>
## 执行时间: YYYY-MM-DD HH:MM

| 任务 | 状�? | 测试场景 | 待验�? |
|------|------|----------|--------|
| Task 1 | �? DONE_AUTOMATED_TESTED | UT-001~005 | - |
| Task 2 | 🟡 DONE_STATIC_ONLY | UT-006~010 | harness-test |
| Task 3 | 🟡 DONE_NEEDS_INTERFACE_TEST | API-001~003 | harness-test |

## 待验证场景汇�?
- UT-006~010: 静态验证通过，需 harness-test 接口验证
- API-001~003: 接口逻辑已覆盖，需 harness-test 真实 HTTP 验证
```

### 状态定�?

- �? **DONE_AUTOMATED_TESTED**：自动化测试通过，mvn test 输出 Failures: 0
- 🟡 **DONE_STATIC_ONLY**：仅静态代码逻辑审查通过，未运行真实测试
- 🟡 **DONE_NEEDS_INTERFACE_TEST**：代码逻辑已实现，需接口级验�?
- �? **FAILED**：编译失败或测试失败，需修复

### 规则

- 不允许只在对话里�?"任务完成"但不写入任何持久化文�?
- 后续 harness-test �? harness-review 必须能从持久化状态识别哪些场景仍待验�?

## 步骤 3：场景覆盖检�?

对照场景表，逐条确认代码逻辑已覆盖，**并将覆盖结果展示给用�?**�?**状态必须三类标�?**�?

- �? **已测试通过**：测试基础设施可用且测试已实际运行通过（mvn test 输出 Tests run + Failures: 0�?
- 🟡 **静态检查通过，未真实测试**：TDD 降级，仅做代码逻辑静态检查�?**不得计入"已测试通过"**
- �? **未覆�? / 未验�?**：场景未对应代码逻辑或需端到端验�?

### 静态验证不等于测试覆盖（⚠�? 关键规则�?

1. 🟡 静态检�? **不得计入"已测试通过"**
2. 如果任一 P0 场景仅静态验证，�? harness-run 最终结果必须是�?
   `🟡WARN：编码和编译完成，但存在 P0 场景未真实验证`
3. 只有所�? P0 场景都有自动化测试或真实接口验证时，最终结果才能是�?
   `✅OK成功`
4. **最终摘要禁止写**：`5�? + 17🟡 = 22/22`
5. **最终摘要必须写**�?
   ```
   自动化测试通过: 5
   静态检查未真实验证: 17
   未验�?: 0
   harness-run 结果: 🟡WARN，必须进�? harness-test 后才�? submit
   ```

> 展示格式示例�?
> ```
> ### 场景覆盖检�?
> - �? UT-001~005: getEnabledIndicators 正常/异常/边界场景已测试通过
> - 🟡 UT-006~010: getIndicatorPage 分页场景静态验证通过，待测试基础设施补齐后运�? harness-test
> - �? UT-011~015: getIndicatorByCode 场景未覆盖，需补充测试用例
> - �? API-001~005: enabled 接口场景代码逻辑已覆盖（接口测试�? harness-test 验证�?
> - �? COM-001~005: SQL 迁移脚本覆盖
> - 🟡 INT-001~004: 需端到端部署验�?
> ```
>
> **最终汇�?**�?
> ```
> 自动化测试通过: 5
> 静态检查未真实验证: 17
> 未验�?: 0
> harness-run 结果: 🟡WARN，必须进�? harness-test 后才�? submit
> ```

## 输出示例

```markdown
## 编码完成 �? <功能�?>

### 变更文件 (N �?)
| 文件 | 类型 | 说明 |
|------|:----:|------|
| xxx.java | 新增 | ... |
| xxx.java | 修改 | ... |

### 编译验证
- mvn compile: �? BUILD SUCCESS（如证据明确�? / 🟡 静态验�? / �? 命令被拒�?/失败
- mvn test: �? N tests run, 0 failures（如证据明确�? / 🟡 未执行真实测试，仅静态验�? / �? 命令被拒�?/失败

### 场景覆盖
- 自动化测试通过: K
- 静态检查未真实验证: M
- 未验�?: P
- harness-run 结果: ✅OK成功 / 🟡WARN，必须进�? harness-test 后才�? submit

### 关门检查结�?
- git status --porcelain: �?/�?
- git diff --stat: �?/�?
- git diff --check: �?/�?
- 变更文件在计划内: �?/�?
- 新增/修改测试文件: �?/�?/🟡不适用
- 非计划文件变�?: ✅无/❌有
- conflict marker: ✅无/❌有
- 临时 debug: ✅无/🟡有已清理
- 敏感信息: ✅无/❌有
- 代码注释污染: ✅无/🟡有已清理

### 计划状态持久化
- 状态已写入: `.harness/changes/<change-name>/run-task-status.md`

### 下一�?
> ⚠️ 如果存在 P0 场景�? 🟡静态验证，下一步必须且只能�? harness-test�?

运行 `/harness-test` 验证剩余 P0 场景�?
�? harness-test 通过前，不建议也不应进入 `/harness-submit`�?
```

## 关键原则

- 增量编译优先：`powershell.exe -Command "mvn compile -pl <module> -o -q"`（不�? clean，用离线模式加速）
- 编译失败不盲目重试：先分析错误类型，再针对性修�?
- 与本次变更无关的编译错误记录但跳过，不要阻塞流程
- SQL 变更只生成脚本，不自动执行；脚本保存�? `.harness/changes/<change-name>/sqls/`
- 不在代码或日志中输出明文 Token/密码（遵�? `../protocols/sensitive-info-protocol.md`�?
- **TDD 降级时不得伪装为真实测试通过**（遵�? `../protocols/evidence-based-reporting-protocol.md`�?
- **编译/测试结论必须有证据绑�?**：BUILD SUCCESS / Tests run + 0 Failures / 实际文件存在 / exit code 0
- **长时间命令处�?**：`mvn compile` �? `mvn test` 可能需�? 1-5 分钟。使用后台执行或等待完成，不要在等待中超时停顿要求用户发"继续"

## 执行日志记录

`/harness-run` 只向 `events.ndjson` 追加事件（schema_version 3，兼容读�? v1/v2）；`logs/execution-log.md` �? `harness_events.py append` 自动渲染。步�? 0 之前 append `phase.start`；各阶段写入 `command` / `verification` / `decision` / `issue`，人类可读摘要放 `note`。详�? [[../../protocols/report-pipeline-protocol.md|report-pipeline-protocol]] �? core `harness-run/SKILL.md`�?

## verification-ledger 可复用判�?

后续阶段只有在以下字段齐全且匹配时才允许复用�?

- `diffHash`
- `currentHead`
- `baseCommit`
- `module`
- `profile`
- `validations.<type>.status`
- 明确证据：`BUILD SUCCESS` / `Tests run: N, Failures: 0, Errors: 0` / `exitCode=0`

缺任一字段：`ledgerReusable=false`�?

## Mapper @Select / JOIN / IPage 真实验证要求

`@Select`、JOIN、DISTINCT、IPage 分页、SQL/XML 变更�? run 阶段只能标记 🟡DONE_STATIC_ONLY，必须交�? harness-test 真实 DB/API 验证�?

- SQL 可执行；
- total 正确�?
- records 正确�?
- orgCode 条件�? scene 条件同时生效�?
- 无场景关联指标不会误返回�?
- pageNo/pageSize 分页正确�?
