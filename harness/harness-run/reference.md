---
description: harness-run 的编译失败策略表、TDD循环详细步骤和编码约束。仅在编码执行遇到编译问题或需要参考详细规则时读取。
---

# harness-run 参考 — 详细规则

## 为什么走变更簇 TDD 而不是逐任务 TDD

逐任务 TDD 有三个严重效率问题：
1. **构建工具反复启动**——每个小任务（如新增一个错误码）都单独启动构建/测试，耗时 30-60 秒 × N 个任务，累计浪费大量时间
2. **测试碎片化**——每个小任务单独建测试类，mock 重复配置，测试之间缺乏关联
3. **上下文切换**——RED→GREEN→REFACTOR 每个小任务独立循环，打断编码思路

变更簇 TDD 将围绕同一业务行为的多个任务合并为一个变更簇，一次 RED、一次 GREEN 验证。每个变更簇 2-5 分钟，构建/测试只启动必要次数。

**变更簇示例**：
- 错误码 + 数据访问层查询 + 业务层校验 + create/update/copy 调用 → 归为一个"ruleCode+version 唯一性"变更簇
- updateRule status 联动 + activateVersion status 联动 + enabledList activeFlag 过滤 → 归为一个"status/activeFlag 一致性"变更簇

## 前置条件

- `.harness/changes/<change-name>/spec/<change-name>-design.md` 存在（含完整 frontmatter）
- `.harness/changes/<change-name>/plans/<change-name>-plan.md` 存在（含完整 frontmatter）
- `.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md` 存在
- `.harness/changes/<change-name>/plans/<change-name>-implementation-detail.md`（新版必需，legacy 缺失时 🟡WARN）
- 用户已审批通过计划
- 如果在 worktree 中，已切换到 worktree 目录

## 步骤 0：加载上下文

## Worktree 创建与切换详细规则

`harness-run` 必须把 `worktree.json` 当作唯一决策源。

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

先执行 runtime doctor，并从 `meta/runtime.json` 读取 adapter 的 `path`、`branch` 以及 PowerShell `argvPrefix`；不要依赖裸 `python`/`powershell.exe`，也不要硬编码 Claude 路径。

```powershell
& <powershell-argv-prefix> -Command "git worktree add -- '<adapter-worktree-path>' -b '<adapter-branch>'"
```

如果分支已存在：

```powershell
& <powershell-argv-prefix> -Command "git worktree add -- '<adapter-worktree-path>' '<adapter-branch>'"
```

验证：

```powershell
& <powershell-argv-prefix> -Command "Test-Path -LiteralPath '<adapter-worktree-path>/.git'"
```

### 状态目录写入

即使代码在 worktree 中修改，`.harness/changes/<change-name>/` 仍是主项目下的状态真相源。run 必须记录：

```json
{
  "projectRoot": ".../udp",
  "worktreeRoot": ".../udp/<adapter-worktree-root>/<change-name>",
  "stateDir": ".../udp/.harness/changes/<change-name>"
}
```



> ⚠️ **phase.start 前置**：步骤 0 第一件事是 `harness_events.py append --type phase.start`（见 SKILL.md `## 执行日志`）。**任何代码修改前必须先记录**，不能等代码改完才补。
> ⚠️ **测试基础设施探测前置**：步骤 0 中必须首先执行"步骤 0.5 测试基础设施探测"，探测完成前不得写任何 TDD 降级结论。

1. **确定变更名**：用 Glob 搜索 `.harness/changes/*/plans/*-plan.md`（**排除 `.harness/archive/*/`**），读取找到的 plan.md 的 YAML frontmatter，提取 `change-name`。默认最多一个未归档变更；如有多个，优先取最近修改的，或询问用户选择。
2. **读取并执行 worktree 决策**：读取 `.harness/changes/<change-name>/meta/worktree.json`。如果 `requested=false`，在主目录执行；如果 `requested=true` 且 worktree 存在，必须 cd 到该 worktree；如果 `requested=true` 且 worktree 不存在，必须创建 worktree，创建失败则停止或询问用户是否改为主目录执行。禁止静默降级。
3. **读取计划文件（主任务源）**：`.harness/changes/<change-name>/plans/<change-name>-plan.md` → 获取任务列表和依赖关系
4. **读取详细计划（补充参考）**：`.harness/changes/<change-name>/plans/<change-name>-implementation-detail.md`（新版必需，legacy 缺失时 🟡WARN）→ 获取自适应执行参考
5. **读取设计文档**：`.harness/changes/<change-name>/spec/<change-name>-design.md` → 获取核心设计决策和不变项
6. **读取测试场景表**：`.harness/changes/<change-name>/plans/<change-name>-test-scenarios.md` → 获取测试真相源
7. **读取验证账本**：`.harness/changes/<change-name>/evidence/verification-ledger.json`（如存在）→ 复用已有 compile/unitTest 结果
8. **读取任务状态**：`.harness/changes/<change-name>/evidence/run-task-status.md`（如存在）→ 恢复上次运行状态
9. **读取 review fixback**：用户传入 `--fixback` 或要求修复 review 问题时，读取最新 `.harness/changes/<change-name>/reports/review/fixback-*.md`，并将 RED/YELLOW 条目映射为本轮变更簇
10. 确认 `项目规则（见 .harness/context-index.json）/` 规则已加载
11. **执行测试基础设施探测**（见下方"步骤 0.5"）
12. 确认构建环境正常（构建命令按技术栈，见项目 CLAUDE.md 或 `.harness/config/harness-build-config.md`；如 Java 的 `powershell.exe -Command "mvn compile -pl <module> -o -q"`）
13. **检查构建配置完整性**：如果在 worktree 中执行，确认构建配置文件存在（如 Java 的 `.mvn/maven.config`/`settings.xml`、JVM 的 `gradle.properties`、前端的 `package.json`/lockfile 等）。worktree 可能不包含主目录的构建配置，缺失时从主目录复制
14. **依赖模块预安装**：如果在 worktree 中执行，检查上游依赖是否已安装（如 Java 的 `mvn install` 到本地仓库、前端的依赖已 install）。缺失时先执行对应安装命令（Java 示例：`powershell.exe -Command "mvn install -pl <upstream-modules> -am -DskipTests -nsu"`）
15. **代码探索优先用 codegraph_explore**：一次调用可获取多个相关符号的源码，替代逐个 Read 文件。违反 `项目 codegraph 规则` 规则逐个 Read 会浪费 3-5 分钟。仅在 codegraph 返回结果不完整时补充 Read

### 步骤 0.0：正式产物来源确认

在读取计划文件后，确认本次执行只使用 `.harness/changes/<change-name>/` 下的正式产物：

```
检查逻辑：
1. 读取 .harness/changes/<change-name>/spec/<change-name>-design.md
2. 读取 .harness/changes/<change-name>/plans/<change-name>-plan.md
3. 读取 .harness/changes/<change-name>/plans/<change-name>-implementation-detail.md（legacy 缺失时 🟡WARN）
4. 读取 .harness/changes/<change-name>/plans/<change-name>-test-scenarios.md
```

**禁止 /harness-run 默认读取 `docs/superpowers/plans/*.md`** 作为任务来源。旧 `docs/superpowers/` 草稿最多作为人工线索，不作为执行输入。

### 步骤 0.1：执行模式（无询问）

**默认 Inline Execution**。仅 `--subagent` 启用 Subagent-Driven；`--inline` 显式等同默认。**不因任务数/模块数询问**。

## 步骤 0.5：测试基础设施探测（⚠️ 必须先于任何 TDD 降级结论）

> **核心原则**：探测完成前，执行日志中只能写 `**测试基础设施**: CHECKING`，不得写任何降级结论。证据不足时禁止写"项目无测试基础设施""RED 降级""TDD 降级"。

### 探测流程

按顺序收集四项证据：

**探测 1：测试目录是否存在**（如 Java 的 src/test/java）
```text
# 用 Glob 或 Read 检查目标模块下是否有测试目录（按技术栈，如 Java 的 src/test/java）
```
- 结果：✅ 存在 / ❌ 不存在

**探测 2：构建配置/依赖清单是否包含测试依赖**
检查目标模块的构建配置（如 Java 的 `pom.xml`），搜索测试依赖（Java 示例）：
- `spring-boot-starter-test`
- `junit` / `junit-jupiter`
- `mockito` / `mockito-core` / `mockito-junit-jupiter`
- 结果：✅ 包含关键测试依赖 / 🟡 部分包含 / ❌ 无测试依赖

**探测 3：是否存在已有测试文件**
用 Glob 搜索目标模块的测试文件（按技术栈命名约定，如 Java 的 `src/test/java/**/*Test*.java` 或 `src/test/java/**/*Tests*.java`）
- 结果：✅ 存在 N 个测试文件 / ❌ 无测试文件

**探测 4：测试命令是否可运行**
```powershell
powershell.exe -Command "<测试命令> <模块定位参数>"
```
（Java 示例：`mvn test -pl <module> -o -q`）
- 结果：✅ 构建成功（如 Java 的 BUILD SUCCESS）/ ❌ 构建失败（记录失败原因）

### 探测结论

四项证据全部收集完毕后，汇总写入执行日志：

```markdown
### 测试基础设施探测结果
- **测试目录**: ✅ 存在 / ❌ 不存在（如 Java 的 src/test/java）
- **测试依赖**: ✅ 包含（如 Java 的 spring-boot-starter-test + junit + mockito）/ 🟡 部分包含 / ❌ 无
- **已有测试文件**: ✅ N 个 / ❌ 无
- **测试命令可运行**: ✅ 构建成功（如 Java 的 BUILD SUCCESS）/ ❌ 失败（原因）
- **结论**: ✅ 测试基础设施可用 / 🟡 测试基础设施部分可用 / ❌ 测试基础设施不可用
```

- ✅ 可用 → 必须执行完整 TDD 流程
- 🟡 部分可用 → 记录可用的部分和不可用的部分，降级不可用部分
- ❌ 不可用 → TDD RED 降级为静态逻辑验证（见下方降级策略）

## RED：写测试（变更簇批量模式）

> **TDD 不可跳过。** 如果测试基础设施探测结果为 ✅ 可用，RED 阶段必须写测试。如果探测结果为 ❌ 不可用，按下方降级策略执行。
> **进入变更簇 RED 前必须执行 `protocols.md` 的 `run-tdd-protocol`**（必须在写第一行测试代码或生产代码之前）。

从场景表选取对应当前变更簇的测试用例：

- **单元测试**（优先）：按技术栈测试框架（如 Java 的 JUnit 5 + Mockito + AssertJ），命名 `{方法名}_{场景}_{预期结果}()`，用断言库（如 Java 的 AssertJ `assertThat`）
- **接口测试**（必要时代码逻辑已覆盖即可，实际 HTTP 调用留给 `harness-test`）
- **多个测试类合并到一次构建/测试命令执行**（按技术栈模块/用例定位参数，如 Java 的 `mvn test -pl <module> -Dtest=TestA,TestB,TestC -o`）

### RED 有效性判定（⚠️ 必须逐项确认）

RED 不是"测试失败"即可通过，必须确认失败原因与目标 bug/需求直接相关。

**有效 RED（✅ 允许进入 GREEN）**：
- 测试编译通过
- 目标测试失败
- 失败断言指向目标业务行为（如 `assertThat(result.getEnabledIndicators()).isNotEmpty()` 失败）
- 失败信息能对应本次 bug 或需求（如"期望返回非空列表，但实际返回空列表"）

**无效 RED（❌ 禁止进入 GREEN，必须先修测试）**：
- 测试编译失败（语法错误、import 缺失等）
- **测试直接调用 private 方法导致编译失败**
- **因 private 访问限制导致失败**
- mock/stubbing 错误（如 Java 的 `UnnecessaryStubbingException`、`PotentialStubbingProblem`）
- 依赖注入上下文加载失败（如 Java 的 `NoSuchBeanDefinitionException`）
- `NullPointerException` 来自测试搭建错误（如未 mock 依赖、未初始化测试数据）
- 不必要 stubbing
- 依赖缺失（如测试依赖的类/method 尚未创建）
- 测试数据非法导致前置校验失败（如必填字段为空、格式校验不通过）
- 失败原因与目标 bug 无关（如测试的是另一个方法的逻辑）

**RED 必须优先通过 public API / 业务层 public 方法 / 接口层行为验证**。private 方法只作为实现细节，测试应通过 `createRule` / `updateRule` / `copyRule` / `activateVersion` / `getEnabledList` 等公共行为间接验证。**不得把"访问 private 方法失败"记录为有效 RED。**

**判定流程**：
1. 运行测试
2. 查看失败输出
3. 逐条对照上述清单判定
4. 写入执行日志：`RED: ✅有效 / 🟡部分有效 / ❌无效`
5. 记录失败原因
6. 记录是否允许进入 GREEN

**如果出现无效 RED**：
1. 必须先修复测试问题（补充 mock、修正 stub、修复测试数据等）
2. 重新运行测试确认 RED 有效
3. 只有有效 RED 后才允许进入 GREEN 阶段
4. **禁止在无效 RED 后进入生产代码修改**

**greenfield 大重写的 RED 处理**：

当变更簇新建多个此前不存在的方法/类（典型：store/repository 大规模重写），新方法未实现时测试会抛 TypeError（"依赖缺失"类无效 RED）。逐方法写"返回错误值的桩"以获得 clean 断言失败，在方法数多时成本过高且桩代码一次性丢弃。处理决策：

| 条件 | 处理 |
|---|---|
| 新方法 ≤ 2-3 个，或簇内有部分已存在方法 | 仍须写桩，确保 RED 是 clean 断言失败（变更簇范式） |
| 新方法多（如 10+）、桩成本过高、**且有集成/端到端测试覆盖该簇行为** | 允许 `🟡RED-skip(原因)`，直接写测试+实现+GREEN 验证 |

允许 RED-skip 时必须：① 执行日志记 `RED: 🟡RED-skip(greenfield 大重写，N 个新方法，由 <集成测试名> 覆盖)`；② GREEN 后必须跑该簇测试 + 集成测试全过；③ **不得用于"mock 复杂/配置麻烦"等非 greenfield 场景**（见下方"私有方法/mock 复杂降级决策表"）。

### 低价值 TDD 豁免策略

以下变更**不得强制单独建立测试类并单独构建/测试验证**：

| 变更类型 | 验证方式 | 说明 |
|----------|----------|------|
| 错误码常量 | 构建验证 + 被高层测试间接覆盖 | 禁止为单个错误码新增独立测试类 |
| 数据契约字段（VO/DTO）| 被业务层/API 测试间接覆盖 | 字段赋值和序列化由上层测试保证 |
| 注释 | 构建验证 | 不影响运行时行为 |
| 代码整理（import 清理）| 构建验证 | 不影响运行时行为 |
| 格式化 | 构建验证 | 不影响运行时行为 |
| 数据库迁移脚本 | 静态审查 + harness-test DB 验证 | 不做 TDD，生成审查清单 |
| 配置模板 | 静态审查 | 部署时生效 |
| 文档文件 | 静态审查 | 不涉及代码 |

### 行为性修改不属豁免（新增逻辑分支必须 RED）

正则/条件/分支逻辑变更新增的逻辑分支**不属上表豁免**，必须有对应 RED 验证该分支行为，不得仅靠现有测试覆盖省略。现有测试只证明"原有行为未回归"，不替代"新分支有测试"。例：正则新增 UNC 拦截分支，须构造 UNC 路径先 RED（旧正则漏检）再 GREEN（新正则拦截），原有 `../` 测试覆盖不到新分支。详见 SKILL.md 规则七「行为性修改新分支必须 RED」。

### 数据访问层查询条件验证规则

数据访问层查询逻辑（Java 的 Mapper/LambdaQueryWrapper/SQL/XML），**不得通过纯 Mock 返回值来宣称自动化测试通过**。

**低价值 Mock 测试（应标记为 🟡静态验证）**：
- Mock 数据访问层返回期望列表
- 测试只验证业务层返回了 mock 数据
- 没有验证实际查询条件（如 Java 的 SQL/Wrapper 条件）
- 无法证明 `.eq(activeFlag, true)` 等查询条件存在

**推荐验证方式**：
1. run 阶段标记为 🟡静态验证
2. test 阶段通过真实 DB / 接口验证
3. 如果必须自动化，使用真实数据访问层（非 mock）或可检查查询条件的测试方式

**禁止把纯 Mock 数据访问层测试计入"数据访问层查询条件已自动化测试通过"。**

### 私有方法 / mock 复杂的降级决策表

> 私有方法不能直接测试，但必须优先寻找公共行为入口测试。"mock 复杂"不是直接跳过测试的充分理由。

跳过自动化测试前必须完成此决策表：

| 问题 | 结果 |
|---|---|
| 是否存在公共方法可测？ | 是/否 |
| 是否可通过数据访问层/mock 构造？ | 是/否 |
| 是否可通过静态 mock（如 Java 的 mockStatic）构造？ | 是/否 |
| 是否可写轻量集成测试？ | 是/否 |
| 跳过自动化测试的具体阻塞点 | ... |
| 后续必须由哪个阶段验证 | harness-test / 手工接口 / 部署验证 |

如果只是"配置麻烦"或"mock 复杂"，不得直接跳过。对数据契约字段（DTO）、分页返回、权限过滤、组织过滤等用户可见行为，必须优先写公共行为测试。

### TDD 降级策略

当项目无测试基础设施时，RED 阶段降级为"静态逻辑验证"：

1. **在执行日志中记录降级原因**：必须包含三项信息
   - 为什么降级（如：`TDD RED 降级：模块 <module> 无测试目录` 或 `构建配置缺少测试依赖（如 Java 的 pom.xml 缺 spring-boot-starter-test）`）
   - 哪些场景只做了静态验证（列出场景编号清单）
   - 哪些场景需要部署后验证（列出场景编号清单）
2. 对每个任务，从场景表中选取相关场景，**在执行日志和覆盖报告中标注静态验证关系**（如 `执行日志：UT-001 通过静态验证 — 检查业务层方法（如 getEnabledIndicators）已添加组织过滤逻辑`）。**不得在业务代码注释中标注覆盖关系**，避免污染业务代码
3. GREEN 阶段完成后，对照场景表逐条确认代码逻辑已覆盖（不运行测试，只做静态检查）
4. 在场景覆盖检查中标注三类状态：
   - ✅ 已测试通过（仅在测试基础设施可用且测试已运行通过时使用）
   - 🟡 静态验证通过，未真实测试（TDD 降级时使用）
   - ❌ 未覆盖 / 未验证（场景未对应代码逻辑或需端到端验证）
5. 输出必须明确写成：
   - "🟡 静态逻辑验证通过"
   - "未执行真实单元测试"
   - "待测试基础设施补齐后运行 harness-test"
6. **禁止写成**："测试全部通过"、"测试通过 N/N"、"覆盖率 100%"等含暗示真实测试已运行的表述
7. 提示用户在测试基础设施就绪后补充运行 `harness-test`

## GREEN：最简实现

写最少代码让测试通过。关键约束：
- 接口层只做参数校验和路由
- 业务层是唯一业务逻辑层
- 统一返回结构（如 Java 的 `Result<T>`）
- 集合返回空集合，不返回 null
- 日志用日志框架（如 Java 的 Slf4j），不用 System.out
- 新增字段允许为空（兼容旧数据）

## REFACTOR：重构

在测试保护下重构代码结构。关键约束：
- 重构后重新运行测试确认全部通过
- 清理过程性注释（如 `// 修复分页查询缺项目类型 Bug`），改写为稳定业务规则描述或删除
- 检查代码注释污染：生产代码中不得保留解释"本次 bug 修复"的临时注释

## GREEN 后反模式自检（内置清单）

> 此步骤是 `/harness-run` 的内置自检，不依赖 Superpowers `test-driven-development`，也不存在外部 skill 调用成功后的跳过分支。

GREEN 阶段完成后，对照以下反模式清单自检：

```
□ 测试不依赖网络或外部服务（应用 mock 替代）
□ 无断言链（一个测试方法只断言一个行为，不用多个 assert 串联）
□ 测试不验证实现细节（只验证公共行为，不验证私有方法调用）
□ 测试命名表达意图（{方法名}_{场景}_{预期结果}）
□ 每个测试方法独立，不依赖执行顺序
□ 测试数据自包含（不依赖其他测试创建的数据）
□ 无 sleep/硬编码等待（用 Awaitility 或条件判断替代）
□ 测试覆盖正常路径 + 异常路径 + 边界值
```

## 构建失败的处理策略

不是所有构建错误都需要修复。先判断是否与本次变更相关：

| 错误类型 | 判断方法 | 处理 |
|----------|----------|------|
| 找不到符号/未定义引用（新代码） | 检查类路径/模块路径和导入 | 修复 |
| 找不到符号/未定义引用（已有代码） | 对比 git diff | 与本次变更无关 → 跳过 |
| 依赖缺失 | 导入了错误的包/模块路径 | 修复导入路径 |
| 构建配置乱码（如 Java 的 settings.xml） | 构建输出含乱码字符 | 改用相对路径 |
| 子模块缺少父配置（如 Java 的 POM 无 parent） | 非本模块的构建错误 | 用模块定位参数（如 `-pl`）跳过无关模块 |

> 关键是：不要因为一个不相关的模块构建失败就阻塞整个开发流程。

## 批量构建验证策略

harness-run 必须减少构建/测试启动次数。

**默认策略**：
1. 每个变更簇最多执行一次 RED 构建/测试、一次 GREEN 构建/测试
2. 多个测试类合并到一次构建/测试命令（按技术栈模块/用例定位参数，如 Java 的 `mvn test -pl <module> -Dtest=TestA,TestB,TestC -o`）
3. 不得每新增一个测试类就立即单独跑一次构建/测试
4. 最终构建只执行一次
5. 如果前面已有构建成功证据，最终构建可复用 verification-ledger

**禁止**：
```
TestA RED → TestA GREEN → TestB RED → TestB GREEN → TestC RED → TestC GREEN
```
**应改为**：
```
TestA+TestB+TestC RED → 实现相关代码 → TestA+TestB+TestC GREEN → 最终 compile
```

## 构建证据规则

如果使用静默模式（如 Maven `-q`）：
- 根据 exit code 0 判断命令成功
- 报告中必须写 `exitCode=0`
- **不得写"构建成功"字样**（如 Java 的 BUILD SUCCESS），除非输出中真实出现

最终报告推荐格式：
- 构建命令静默模式（如 `mvn compile -q`）: ✅ exitCode=0，无错误输出
- 构建命令（如 `mvn compile`）: ✅ 构建成功（Java 的 BUILD SUCCESS）

最终 evidence 命令优先不用静默模式，或者同时记录 exit code。

## 预存变更隔离

如果 harness-run 开始时检测到已有未提交变更，并且用户选择保留，必须创建 baseline。

### baseline 文件

**pre-existing-files.json**：
```json
{
  "detectedAt": "YYYY-MM-DD HH:mm:ss",
  "userChoice": "keep | stash | abort",
  "allowSubmit": false,
  "files": [
    {
      "path": "relative/path/to/file",
      "diffHash": "sha256:...",
      "inPlan": false
    }
  ]
}
```

**pre-existing-diff.patch**：完整 `git diff` 输出保存为 patch 文件。

### 变更来源区分

结束时必须在输出中区分：

| 文件 | 来源 | 是否计划内 | 是否允许提交 |
|---|---|---|---|
| 文件A | 本次 run 修改 | 是 | 是 |
| 文件B | run 前预存变更 | 否/未知 | 需用户确认 |

如果存在预存变更，最终结果至少为 🟡WARN。

## 数据库迁移任务处理

数据库迁移脚本不做 TDD，也不自动执行。

### run 阶段处理

1. 尽早生成数据库迁移脚本
2. 在脚本头部标注：
```sql
-- ⚠️ 人工审查后手动执行，禁止自动运行
-- 变更: <change-name>
-- 生成时间: YYYY-MM-DD HH:mm
```
3. 生成数据库迁移审查清单
4. 在 run-task-status 中标记 NEEDS_DB_VALIDATION

### 数据库迁移审查清单模板

| # | 检查项 | 结果 |
|:--:|--------|:---:|
| 1 | DROP INDEX 是否存在 IF EXISTS 或等效检查 | ✅/❌ |
| 2 | 新索引名称 | <名称> |
| 3 | 新索引字段 | <字段列表> |
| 4 | 是否包含 deleted_time | 是/否 |
| 5 | 是否兼容已有数据 | 是/否/需验证 |
| 6 | 是否包含历史数据修正 | 是/否 |
| 7 | 是否需要备份 | 是/否 |
| 8 | 是否需要回滚 SQL | 是/否 |

数据库迁移相关任务状态：🟡 NEEDS_DB_VALIDATION，**不得标记为完全自动化测试通过**。

## 最终状态分级

### ✅OK
- 所有计划内代码变更完成
- 关键 P0 场景已自动化测试通过
- 构建成功
- 无预存变更或预存变更已明确隔离
- 无非计划文件混入
- 无 P0 静态-only 场景

### 🟡WARN
- 存在 P0/P1 场景仅静态验证，需 harness-test
- 存在预存变更
- 数据库迁移脚本需要人工执行或 DB 验证
- 数据访问层/数据库迁移查询只做静态验证
- 使用了低价值 Mock 替代真实验证
- 构建/测试成功但仍需接口/DB 验证

### ❌FAIL
- 构建失败
- 有效测试失败
- RED 无法建立
- 非计划文件被修改且无法解释
- git diff --check 失败

如果存在数据库迁移、接口验证、DB 验证未完成，最终不得输出纯 ✅OK，应输出：
🟡WARN：编码完成，需 harness-test 验证剩余 DB/API 场景。

## 步骤 2：构建验证（默认轻量，按需全量 test）

> **轻量验证职责**：`/harness-run` 默认只做开发反馈，不默认跑全量测试命令。是否跑全量 test 按下方条件判断。

### 2a. 构建验证（始终执行）

```powershell
powershell.exe -Command "<构建命令> <模块定位参数>"
```
（Java 示例：`mvn compile -pl <module> -o`）优先不用静默模式，以获取构建成功证据（如 Java 的 BUILD SUCCESS）。如果使用静默模式（如 `-q`），报告中写 `exitCode=0`。

### 2b. 全量测试（仅当满足触发条件时执行）

默认**跳过**全量测试命令，把完整单元测试留给 `/harness-test`。仅当满足以下任一条件时才在本阶段执行测试命令（按技术栈，如 Java 的 `mvn test -pl <module> -o`）：

- 修改了公共模块（被多模块依赖的 common/utils 等）
- 修改了数据访问层 / 数据库迁移 / 查询配置
- 修改了权限 / 认证 / 组织过滤逻辑
- 修改了接口层 / 数据契约（VO/DTO）
- 用户要求 `full-run-validation`
- 用户不打算继续运行 `/harness-test`（run 需自证 P0 场景）

```powershell
powershell.exe -Command "<测试命令> <模块定位参数>"
```
（Java 示例：`mvn test -pl <module> -o`）

**构建/测试成功必须有明确证据**：
- 构建命令（非静默模式）输出必须包含构建成功证据（如 Java 的 `BUILD SUCCESS`）才能宣称"构建成功"
- 构建命令静默模式（如 `mvn compile -q`）：根据 exit code 0 判断，报告中写 `✅ exitCode=0`
- 测试命令输出必须包含测试通过证据（如 Java 的 `Tests run: N, Failures: 0, Errors: 0`）才能宣称"测试通过"
- 如果命令被 hook 拒绝，**必须停止流程或切换 PowerShell 重试**，不得继续宣称"成功"
- 如果 exit code 非 0 或无有效 stdout，标记为 ❌ 构建失败 / 状态未知
- 如果是 TDD 降级（无测试基础设施），测试命令步骤跳过，标记 🟡 静态验证

### 2c. 写入 verification-ledger（仅经 `harness_ledger.py record`）

步骤 2 完成后**必须**通过 `harness_ledger.py record` 写入/更新 ledger（**禁止** Write/Edit `verification-ledger.json`）：

- `compile` 项：始终写入（status / command / scope / evidence / 时间戳 / durationMs）
- `unitTest` 项：仅当 2b 执行了全量测试命令时写入（testsRun / failures / errors / skipped / evidence）；未执行时标记 `{"status": "NOT_RUN_BY_RUN", "note": "轻量验证，全量单元测试由 harness-test 执行"}`
- 顶层写入 `diffHash` / `currentHead` / `baseCommit` / `module` / `profile`
- `baseCommit`：merge-base 或计划起点（worktree 分支从主分支分出点，由 harness-plan 写入、run 读取复用；缺失时用 `git merge-base HEAD <默认分支>` 兜底）
- `currentHead`：`git rev-parse HEAD`（步骤 2c 在 Step 5 checkpoint commit 之前执行，此时 HEAD==baseCommit；commit 后 HEAD 前移到 checkpoint commit，由 ledger-protocol reuse 规则 #2「currentHead 可前移」容忍，**不需为它改时序**）
- `diffHash`：必须由 ledger v2 的 commit-invariant 内容变更集算法生成，并通过 `--change-dir` 纳入 test-tracking manifest 中被 `.gitignore` 忽略的测试；禁止自行拼接 Git 输出或仅使用某一段 diff：

```powershell
python <skills-root>/scripts/harness_ledger.py diff-hash --repo . --base <baseCommit> --change-dir ".harness/changes/<change-name>" --json
python <skills-root>/scripts/harness_ledger.py record --change-dir ".harness/changes/<change-name>" --verification compile --status ok --command "<cmd>" --exit-code 0 --json
```

> `content-changeset-2` 同时读取 tracked diff、标准 untracked 文件和 manifest 的精确测试路径。manifest 缺失时保持普通行为；manifest 存在但路径越界、内容 hash 漂移或结构非法时命令失败，ledger 不可复用。checkpoint commit 不改变各路径的工作树内容，因此提交前后 hash 保持一致。

> 这样 harness-test 的 Phase 1 可读取 ledger 判断是否复用 run 的 unitTest（diffHash commit-invariant + reuse 规则 #2 允许 HEAD 前移 → run 的 checkpoint commit 不破坏复用），submit 也可复用 compile 结果。详见 `../protocols/ledger-protocol.md`。
>
> **Ledger v3（v2 契约 / split-v1 布局起）**：`record` 自动解析并强制顶层身份（`schemaVersion=3/repositoryId/changeName/baseCommit/currentHead/diffHash/ownershipHash`），缺字段非零退出、不写账本；`--metrics-json` 必须通过 typed schema（unit=`total/passed/failed`，apiContract=`scenariosTotal/passed/failed`，browserE2E=`total/passed/failed`，dbCompatibility=`applicability(+reason)`）；新增 `--base-commit/--diff-hash/--applicability/--applicability-reason`。legacy 契约行为不变。详见 `../protocols/ledger-protocol.md` 第十节。

阶段边界：`harness_gate.py begin/close`；测试跟踪：`harness_test_guard.py begin/close`。close 失败不得用自然语言覆盖。

## 步骤 3：场景覆盖检查

对照场景表，逐条确认代码逻辑已覆盖，**并将覆盖结果展示给用户**。**状态必须三类标注**：

- ✅ **已测试通过**：测试基础设施可用且测试已实际运行通过（测试命令输出测试通过证据，如 Java 的 Tests run + Failures: 0）
- 🟡 **静态检查通过，未真实测试**：TDD 降级，仅做代码逻辑静态检查。**不得计入"已测试通过"**
- ❌ **未覆盖 / 未验证**：场景未对应代码逻辑或需端到端验证

### 静态验证不等于测试覆盖（⚠️ 关键规则）

1. 🟡 静态检查 **不得计入"已测试通过"**
2. 如果任一 P0 场景仅静态验证，则 harness-run 最终结果必须是：
   `🟡WARN：编码和编译完成，但存在 P0 场景未真实验证`
3. 只有所有 P0 场景都有自动化测试或真实接口验证时，最终结果才能是：
   `✅OK成功`
4. **最终摘要禁止写**：`5✅ + 17🟡 = 22/22`
5. **最终摘要必须写**：
   ```
   自动化测试通过: 5
   静态检查未真实验证: 17
   未验证: 0
   harness-run 结果: 🟡WARN，必须进入 harness-test 后才能 submit
   ```
6. **禁止用测试用例数冒充场景数**：计数对象是 `test-scenarios.md` 的场景编号（UT-001/N、API-001/N、COM-001/N、INT-001/N），不是测试框架的测试方法数（如 vitest "178 tests"、junit "Tests run: 178"）。场景总数 = test-scenarios.md 的场景数。
7. **三类计数须自洽**：只要存在任一 🟡 或 ❌ 场景，"未验证"计数不得为 0；"待 harness-test"的场景归入 🟡静态或 ❌未验证，不得既不算 ✅ 又让"未验证:0"。
8. **输出须为场景表映射**：按 `UT-001~037: ✅X/🟡Y/❌Z`、`API-001~032: ...`、`COM-001~007: ...`、`INT-001~008: ...` 形式逐条或范围标注，不得只给一个聚合测试数。

> 展示格式示例：
> ```
> ### 场景覆盖检查
> - ✅ UT-001~005: getEnabledIndicators 正常/异常/边界场景已测试通过
> - 🟡 UT-006~010: getIndicatorPage 分页场景静态验证通过，待测试基础设施补齐后运行 harness-test
> - ❌ UT-011~015: getIndicatorByCode 场景未覆盖，需补充测试用例
> - ✅ API-001~005: enabled 接口场景代码逻辑已覆盖（接口测试待 harness-test 验证）
> - ✅ COM-001~005: 数据库迁移脚本覆盖
> - 🟡 INT-001~004: 需端到端部署验证
> ```
>
> **最终汇总**：
> ```
> 自动化测试通过: 5
> 静态检查未真实验证: 17
> 未验证: 0
> harness-run 结果: 🟡WARN，必须进入 harness-test 后才能 submit
> ```

## 步骤 3.5：权限/组织过滤类变更 — 安全矩阵

> 凡是修改了以下逻辑，必须强制生成安全矩阵。如果任一权限边界的预期不明确，不允许标记 harness-run 为 ✅OK。

### 触发条件

修改了以下任一逻辑即触发：
- 管理员 / 非管理员判断
- 组织编码 orgCode 过滤
- token 中的组织
- 请求参数中的组织
- 数据权限
- 越权异常
- public/common 数据可见性

### 安全矩阵模板

| 角色 | token orgCode | 请求 orgCode | projectType | 预期结果 | 覆盖状态 |
|---|---|---|---|---|---|
| 超级管理员 | 空 | 空 | 有 | 查全部 | ✅/🟡/❌ |
| 超级管理员 | 空 | 空 | 无 | 查全部 | ✅/🟡/❌ |
| 超级管理员 | 其他组织 | 指定组织 | 有 | 按请求组织查询 | ✅/🟡/❌ |
| 超级管理员 | 其他组织 | 指定组织 | 无 | 按请求组织查询 | ✅/🟡/❌ |
| 非管理员 | 本组织 | 本组织 | 有 | 允许 | ✅/🟡/❌ |
| 非管理员 | 本组织 | 本组织 | 无 | 允许 | ✅/🟡/❌ |
| 非管理员 | 本组织 | 其他组织 | 有 | 拒绝 | ✅/🟡/❌ |
| 非管理员 | 本组织 | 其他组织 | 无 | 拒绝 | ✅/🟡/❌ |
| 非管理员 | 空 | 指定组织 | 有 | 必须明确：拒绝/允许/依赖上游保证 | ✅/🟡/❌ |
| 非管理员 | 空 | 指定组织 | 无 | 必须明确：拒绝/允许/依赖上游保证 | ✅/🟡/❌ |
| 非管理员 | 本组织 | 空 | 有 | 按本组织过滤 | ✅/🟡/❌ |
| 非管理员 | 本组织 | 空 | 无 | 按本组织过滤 | ✅/🟡/❌ |

### 判定规则

- 如果任一权限边界的预期不明确（如"非管理员+token空+指定组织"场景未明确是拒绝还是允许），则必须标记为 ❌未验证，且不允许标记 harness-run 为 ✅OK
- 每个场景的覆盖状态必须真实标注：✅ 自动化测试通过 / 🟡 静态检查未真实测试 / ❌ 未验证
- 安全矩阵必须写入执行日志

## 步骤 4：关门检查（⚠️ 结束前强制执行）

在输出最终总结前，必须执行并展示以下 10 项检查：

### 1. git status --porcelain
```powershell
powershell.exe -Command "git -C '<project-path>' status --porcelain"
```
展示所有变更文件列表。

### 2. git diff --stat
```powershell
powershell.exe -Command "git -C '<project-path>' diff --stat"
```
展示变更统计。

### 3. git diff --check
```powershell
powershell.exe -Command "git -C '<project-path>' diff --check"
```
检查空白字符冲突。**如果此命令失败 → 最终结果必须是 ❌FAIL**。

### 4. 变更文件是否全部在计划范围内
对照 plan.md 的任务描述，确认每个变更文件都在计划范围内。

### 5. 是否新增/修改了测试文件
如果探测到测试基础设施可用但未新增/修改测试文件，必须记录原因。

### 6. 是否误改 .harness/ 以外的非计划文件
如果有非计划文件变更 → 至少 🟡WARN，并要求用户确认。

### 7. conflict marker 检查
搜索以下模式（用 Grep）：
- `<<<<<<<`
- `=======`
- `>>>>>>>`

如果命中 → 最终结果必须是 ❌FAIL。

### 8. 临时 debug 检查
搜索以下模式（用 Grep）：
- `System.out.println`
- `console.log`
- `debugger`
- 临时 `TODO` / `FIXME`（不含计划中的 TODO）

如果命中 → 在 REFACTOR 阶段清理。

### 9. 敏感信息检查
搜索以下模式（用 Grep）：
- `password`
- `token`
- `secret`
- `accessKey`
- 私有 IP 地址
- 内部 URL（如非必要不得新增）

如果命中且非必要 → 必须清理后再标记完成。

### 10. 代码注释污染检查
搜索以下模式（用 Grep）：
- `// 修复` + `Bug`
- `// 本次` + `变更` / `修改`
- `// 新增` + `功能` / `字段`
- 其他解释"本次变更过程"的临时注释

如果命中 → 在 REFACTOR 阶段清理或改写为稳定业务规则描述。

### 关门检查结果模板

```markdown
## 关门检查结果
- git status --porcelain: ✅/❌
- git diff --stat: ✅/❌
- git diff --check: ✅/❌（❌ → 最终结果 ❌FAIL）
- 变更文件在计划内: ✅/❌
- 新增/修改测试文件: ✅/❌/🟡不适用（TDD降级）
- 非计划文件变更: ✅无/❌有（❌ → 🟡WARN）
- conflict marker: ✅无/❌有（❌ → ❌FAIL）
- 临时 debug: ✅无/🟡有已清理/❌有未清理
- 敏感信息: ✅无/❌有（❌ → 必须清理）
- 代码注释污染: ✅无/🟡有已清理/❌有未清理
```

## 步骤 5：计划状态持久化

如果 `.harness/changes/<change>/plans/*.md` 是任务来源，则 harness-run 完成任务后必须持久化任务状态。

### 持久化方式

**方式一（推荐）**：更新 plan.md 中的任务状态

在 plan.md 的任务列表中，为每个任务追加状态标记：

```markdown
### Task 1: 修复分页查询缺项目类型 Bug
- **状态**: ✅ DONE_AUTOMATED_TESTED
- **测试**: UT-001~005 已通过
```

**方式二**：新增 `evidence/run-task-status.md`

在 `.harness/changes/<change-name>/evidence/run-task-status.md` 中记录：

```markdown
# Run Task Status — <change-name>
## 执行时间: YYYY-MM-DD HH:MM

| 任务 | 状态 | 测试场景 | 待验证 |
|------|------|----------|--------|
| Task 1 | ✅ DONE_AUTOMATED_TESTED | UT-001~005 | - |
| Task 2 | 🟡 DONE_STATIC_ONLY | UT-006~010 | harness-test |
| Task 3 | 🟡 DONE_NEEDS_INTERFACE_TEST | API-001~003 | harness-test |

## 待验证场景汇总
- UT-006~010: 静态验证通过，需 harness-test 接口验证
- API-001~003: 接口逻辑已覆盖，需 harness-test 真实 HTTP 验证
```

### 状态定义

- ✅ **DONE_AUTOMATED_TESTED**：自动化测试通过，测试命令输出 Failures: 0（如 Java 的 mvn test）
- 🟡 **DONE_STATIC_ONLY**：仅静态代码逻辑审查通过，未运行真实测试
- 🟡 **DONE_NEEDS_INTERFACE_TEST**：代码逻辑已实现，需接口级验证
- ❌ **FAILED**：编译失败或测试失败，需修复

### 规则

- 不允许只在对话里说"任务完成"但不写入任何持久化文件
- 后续 harness-test 和 harness-review 必须能从持久化状态识别哪些场景仍待验证

## 输出示例

```markdown
## 编码完成 — <功能名>

### 变更文件 (N 个)
| 文件 | 类型 | 说明 |
|------|:----:|------|
| xxx.<ext> | 新增 | ... |
| xxx.<ext> | 修改 | ... |

### 编译验证
- 构建命令: ✅ 构建成功（如 Java 的 BUILD SUCCESS，证据明确） / 🟡 静态验证 / ❌ 命令被拒绝/失败
- 测试命令: ✅ 测试通过（如 Java 的 N tests run, 0 failures，证据明确） / 🟡 未执行真实测试，仅静态验证 / ❌ 命令被拒绝/失败

### 场景覆盖
- 自动化测试通过: K
- 静态检查未真实验证: M
- 未验证: P
- harness-run 结果: ✅OK成功 / 🟡WARN，必须进入 harness-test 后才能 submit

### 关门检查结果
- git status --porcelain: ✅/❌
- git diff --stat: ✅/❌
- git diff --check: ✅/❌
- 变更文件在计划内: ✅/❌
- 新增/修改测试文件: ✅/❌/🟡不适用
- 非计划文件变更: ✅无/❌有
- conflict marker: ✅无/❌有
- 临时 debug: ✅无/🟡有已清理
- 敏感信息: ✅无/❌有
- 代码注释污染: ✅无/🟡有已清理

### 计划状态持久化
- 状态已写入: `.harness/changes/<change-name>/evidence/run-task-status.md`

### 下一步
> ⚠️ 如果存在 P0 场景为 🟡静态验证，下一步必须且只能是 harness-test。

运行 `/harness-test` 验证剩余 P0 场景。
在 harness-test 通过前，不建议也不应进入 `/harness-submit`。
```

## CLI 速查（gate / ledger）

> 可直接复制；替换 `<skills-root>` / `<cn>` / `<dir>` / `<project>`。`--task` **仅在该 change 启用 checkpoint 时必需**（checkpoints 文件缺失或不含 pending foundation-gate 时不要传）。
> `ledger record` 必需：`--duration-ms`、`--evidence`，以及 `--files`（逗号分隔源文件）或 `--profile-input <verificationKey> --project <project>`（从 build-profile 展开）。`status` 枚举: `ok|fail|not_run`（没有 PASS）。
> `--skills-root` 仅用于 `begin`（及 `lint-skills`）：必须是 adapter 根（如 `.cursor/skills`），不是 `scripts/` 子目录。**`close` 不需要 `--skills-root`**（该子命令不接受此参数）。

```powershell
# gate begin/close（--task 仅在该 change 启用 checkpoint 时必需；close 不需要 --skills-root）
python <skills-root>/scripts/harness_gate.py begin --change <cn> --phase run --skills-root <skills-root> [--task N]
python <skills-root>/scripts/harness_gate.py close --change <cn> --phase run --status OK [--task N]

# ledger 记录（status: ok|fail|not_run —— 没有 PASS）
python <skills-root>/scripts/harness_ledger.py record --change-dir <dir> --verification unitTestFull --status ok --command "<完整命令>" --exit-code 0 --duration-ms 120000 --evidence "Tests run: 155, Failures: 0, Errors: 0, Skipped: 0" --coverage full --files "packages/core/src/index.ts"

# 复用检查（--profile-input 取 verification key，不是文件路径；配合 --project）
python <skills-root>/scripts/harness_ledger.py can-reuse --change-dir <dir> --verification unitTestFull --profile-input unitTestFull --project <project>
```

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

## 关键原则

- 增量构建优先：`powershell.exe -Command "<构建命令> <模块定位参数>"`（Java 示例：`mvn compile -pl <module> -o -q`，不用 clean，用离线模式加速）
- 编译失败不盲目重试：先分析错误类型，再针对性修复
- 与本次变更无关的编译错误记录但跳过，不要阻塞流程
- 数据库迁移只生成脚本，不自动执行；脚本保存到 `.harness/changes/<change-name>/sqls/`
- 不在代码或日志中输出明文 Token/密码（遵循 `../protocols/sensitive-info-protocol.md`）
- **TDD 降级时不得伪装为真实测试通过**（遵循 `../protocols/evidence-based-reporting-protocol.md`）
- **构建/测试结论必须有证据绑定**：构建成功证据（如 Java 的 BUILD SUCCESS）/ 测试通过证据（如 Java 的 Tests run + 0 Failures）/ 实际文件存在 / exit code 0
- **长时间命令处理**：构建命令和测试命令（如 Java 的 `mvn compile`/`mvn test`）可能需要 1-5 分钟。使用后台执行或等待完成，不要在等待中超时停顿要求用户发"继续"

## 执行日志记录

`/harness-run` 只向 `events.ndjson` 追加事件（schema_version 3，兼容读取 v1/v2）；`logs/execution-log.md` 由 `harness_events.py append` 自动渲染。步骤 0 之前 append `phase.start`；各阶段写入 `command` / `verification` / `decision` / `issue`，人类可读摘要放 `note`。事件类型与脚本用法见 [[../protocols/report-pipeline-protocol.md|report-pipeline-protocol]] 与 SKILL.md `## 执行日志`。

关键 `note` / `decision` 须覆盖：测试基础设施探测（CHECKING→结论）、预存变更、run-tdd-protocol RED 类型、变更簇 RED/GREEN、批量构建 exit code、关门检查 10 项、计划状态持久化路径。

## verification-ledger 可复用判定

后续阶段只有在以下字段齐全且匹配时才允许复用：

- `diffHash`
- `currentHead`
- `module`
- `profile`
- `validations.<type>.status`
- 明确证据：构建成功（如 Java 的 `BUILD SUCCESS`）/ 测试通过（如 Java 的 `Tests run: N, Failures: 0, Errors: 0`）/ `exitCode=0`

缺任一字段：`ledgerReusable=false`。

## 数据访问层复杂查询真实验证要求

数据访问层复杂查询（Java 的 `@Select`/JOIN/DISTINCT/IPage 分页/SQL/XML）变更在 run 阶段只能标记 🟡DONE_STATIC_ONLY，必须交给 harness-test 真实 DB/API 验证：

- SQL 可执行；
- total 正确；
- records 正确；
- orgCode 条件与 scene 条件同时生效；
- 无场景关联指标不会误返回；
- pageNo/pageSize 分页正确。
