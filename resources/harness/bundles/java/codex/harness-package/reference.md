---
description: harness-package 的Maven打包参数速查、增量vs全量对比、常见问题处理和报告格式示例。仅在需要参考参数细节或处理问题时读取。
---

# harness-package 参考 — 参数、问题与格式

## Maven 打包参数速查

| 参数 | 说明 | 示例 |
|------|------|------|
| `-pl <modules>` | 指定构建模块列表（逗号分隔） | `-pl module-a,module-b/sub-b` |
| `-am` | 同时构建指定模块的上游依赖（Also Make） | `-pl module-a -am` |
| `-amd` | 同时构建依赖指定模块的下游模块（Also Make Dependents） | `-pl module-a -amd` |
| `-DskipTests` | 跳过测试执行（**ledger 有效时默认使用**，复用 test 阶段验证） | `mvn package -DskipTests` |
| `-Dmaven.test.skip=true` | 跳过测试编译和执行（更激进，连测试代码都不编译） | 不推荐使用 |
| `-T 4` | 并行构建，4个线程 | `mvn package -T 4` |
| `-o` | 离线模式（不从远程仓库下载） | `mvn package -o` |
| `-DfinalName=<name>` | 指定最终产物名称 | `-DfinalName=my-app` |
| `--batch-mode` | 非交互模式（CI 场景） | `mvn package --batch-mode` |

## 可选配置（package 时序与测试策略）

在 `.harness/config/harness-test-config.md` 中可配置 package 行为：

```yaml
package:
  preferred-order: after-submit   # 默认：package 在 submit 之后运行
  allow-before-submit: true       # 允许发版前打包（submit 之前）；false 时 package 启动检查 submit 是否已运行
  reuse-ledger-tests: true        # 默认：ledger 有效时用 -DskipTests 复用 test 阶段验证
  force-with-tests: false         # 强制带测试打包（等同 package-with-tests）
```

- `preferred-order: after-submit`：package 的 `baseCommit` 取 submit 日志的 final pushed hash
- `allow-before-submit: true`：允许在 submit 之前运行 package，此时 `baseCommit` 为当前 HEAD；submit 后若 pull 引入新提交，须重新 package
- `reuse-ledger-tests: true`：ledger 有效时默认 `-DskipTests`，报告标明复用来源；ledger 无效时自动改为带测试打包

> 未配置时使用上述默认值。

## 增量 vs 全量对比

| 维度 | 增量打包 | 全量打包 |
|------|----------|----------|
| **命令** | `mvn package -pl <modules> -am` | `mvn package` |
| **适用场景** | 日常发版、局部变更、迭代开发 | 首次发版、重大重构、不确定依赖关系 |
| **构建范围** | 变更模块 + 上游依赖 | 所有模块 |
| **构建速度** | 快（只构建相关模块） | 慢（全量构建） |
| **风险** | 可能遗漏间接依赖 | 无遗漏风险 |
| **产物数量** | 只产出相关模块的 jar/war | 产出所有模块的 jar/war |
| **推荐优先级** | 首选（默认模式） | 增量失败时的降级方案 |

**何时选择全量**：
- 首次部署或项目初始化
- pom.xml 结构发生重大变更
- 依赖关系不确定或增量打包出现版本冲突
- 用户明确要求全量构建

## 常见问题处理

| 问题 | 原因 | 处理方法 |
|------|------|----------|
| **合并冲突** | 他人代码与本次变更有重叠 | 停止打包流程，提示用户手动解决冲突后重新运行 |
| **合并后编译失败** | 他人代码引入新依赖或修改公共接口 | 分析错误是否与本次变更相关，相关则修复，无关则记录并询问用户 |
| **合并后测试失败** | 他人代码破坏了本次功能 | 记录冲突点，提示用户协调解决 |
| **打包失败：找不到依赖** | 上游模块未安装到本地仓库 | 先执行 `mvn install -pl <upstream> -am`，再打包 |
| **打包失败：版本冲突** | 同一依赖多个版本，SNAPSHOT 冲突 | 检查 pom.xml 版本号，统一版本；或用 `-DallowConflictingSnapshots=true` |
| **打包失败：编译错误** | 变更文件有语法错误或类型不匹配 | 先执行 `mvn compile` 定位错误，修复后重新打包 |
| **打包失败：测试失败** | 单元测试或集成测试报错 | 检查测试日志，修复测试或用户确认后加 `-DskipTests` |
| **打包失败：离线依赖缺失** | `-o` 模式下本地仓库缺少依赖 | 去掉 `-o`，加 `-nsu` 联网下载（见 `项目 maven-offline 规则`） |
| **target/ 目录不存在** | 模块未被打包命令包含 | 检查 `-pl` 参数是否遗漏该模块，或改用全量打包 |
| **增量打包遗漏产物** | `-am` 未包含足够的上游模块 | 检查依赖链，补充遗漏模块到 `-pl` 列表，或改用全量打包 |
| **parent-pom 模块无 jar 产物** | 父 pom 模块只做依赖管理，不生成 jar | 正常行为，状态标记为 SKIPPED |
| **war 包过大** | 包含了不必要的依赖或资源 | 检查 pom.xml 的依赖范围（scope），排除 provided/test 依赖 |
| **并行构建报错** | 模块间存在循环依赖或线程竞争 | 去掉 `-T` 参数，改用串行构建 |

**依赖缺失的典型解决流程**：

```powershell
# 1. 先安装所有上游依赖到本地仓库
powershell.exe -Command "mvn install -pl module-common,module-parent -am"

# 2. 再对变更模块执行增量打包
powershell.exe -Command "mvn package -pl module-a -am"
```

## 报告格式示例

```markdown
---
change-name: user-auth-feature
package-mode: incremental
generated-at: 2026-06-17 14:30:00
base-commit: abc1234
base-commit-source: submit final pushed hash
maven-command: mvn package -pl module-auth,module-api -am -DskipTests
tests-executed: false
tests-reused-from: unitTest+apiTest
ledger-diff-hash: sha256:...
---

# 打包报告 — user-auth-feature

## 打包概要

| 项目 | 值 |
|------|-----|
| 变更名 | user-auth-feature |
| 打包模式 | 增量（-pl + -am） |
| Maven 命令 | `mvn package -pl module-auth,module-api -am -DskipTests` |
| 基准 commit | abc1234（来源：submit final pushed hash） |
| 开始时间 | 2026-06-17 14:25:00 |
| 结束时间 | 2026-06-17 14:30:00 |
| 构建耗时 | 5分0秒 |
| 构建结果 | SUCCESS |

## 测试执行策略

- package 本次是否执行 tests: **否**（`-DskipTests`）
- 复用来源: verification-ledger 的 `unitTest` + `apiTest`（status=OK）
- ledger diffHash: sha256:...
- 复用成立条件: diffHash 一致 + submit 后无新提交 + 无行为性 post-test 修改
- 若 ledger 无效: 改为"是（带测试打包）"并说明原因（test 未跑 / diffHash 不一致 / submit 后有新提交 / 行为性 post-test 修改）

## 变更模块

### 直接变更模块 (2 个)

| 模块 | 变更文件数 | 变更类型 |
|------|-----------|----------|
| module-auth | 5 | 新增+修改 |
| module-api | 2 | 修改 |

### 依赖链模块

| 类型 | 模块 |
|------|------|
| 上游依赖 (-am) | parent-pom, module-common |
| 下游依赖 (-amd) | 未包含 |

## 产物清单

| 模块 | 产物文件名 | 相对路径 | 大小 | 状态 |
|------|-----------|----------|------|------|
| module-auth | auth-service-1.0.0.jar | module-auth/target/auth-service-1.0.0.jar | 12.5 MB | SUCCESS |
| module-api | api-model-1.0.0.jar | module-api/target/api-model-1.0.0.jar | 3.2 MB | SUCCESS |
| module-common | common-utils-1.0.0.jar | module-common/target/common-utils-1.0.0.jar | 8.1 MB | SUCCESS |
| parent-pom | — | — | — | SKIPPED |

**产物总计**: 3 个 jar, 总大小 23.8 MB

## 构建日志摘要

```
[INFO] Reactor Build Order:
  parent-pom  .................................. SKIPPED
  module-common  ................................ SUCCESS [8.1s]
  module-api  ................................... SUCCESS [3.2s]
  module-auth  .................................. SUCCESS [12.5s]
[INFO] BUILD SUCCESS
```

## 部署建议

- 部署顺序：common-utils → api-model → auth-service（按依赖顺序）
- 注意：auth-service 依赖 common-utils 和 api-model，确保目标环境已有这两个依赖
```

## 变更模块识别方法

### 方法 1：git diff + pom.xml 映射（推荐）

```powershell
# 1. 获取基准 commit
powershell.exe -Command "git -C '<项目路径>' merge-base HEAD origin/master"

# 2. 获取变更文件列表
powershell.exe -Command "git -C '<项目路径>' diff <base-commit> --name-only"

# 3. 对每个变更文件，向上查找 pom.xml 所在目录
#    变更文件: module-a/src/main/java/com/example/Service.java
#    → pom.xml 在: module-a/pom.xml
#    → 模块路径: module-a
```

### 方法 2：git diff + Maven Reactor 映射

```powershell
# 1. 获取变更文件列表
powershell.exe -Command "git -C '<项目路径>' diff <base-commit> --name-only"

# 2. 对变更目录执行 Maven 列出模块
powershell.exe -Command "mvn -f <项目路径>/pom.xml help:active-profiles -pl :<module-artifactId>"
```

### 依赖链识别

**上游依赖（-am）**：变更模块 pom.xml 中 `<dependencies>` 引用的同项目模块，由 Maven `-am` 参数自动处理。

**下游依赖（-amd）**：需要扫描其他模块的 pom.xml，找出 `<dependency>` 中引用了变更模块 `<groupId>:<artifactId>` 的模块：

```powershell
# 扫描所有子模块 pom.xml 中对变更模块的引用（使用 Grep 工具更高效）
Grep("<artifactId>module-a</artifactId>", "<项目路径>/", glob="**/pom.xml")
```

### 边界情况

- **根 pom.xml 变更**：属于父项目，需全量打包
- **多模块同一变更**：合并到 `-pl` 列表，用逗号分隔
- **无变更文件**：提示用户确认是否需要全量打包
- **新增模块**：pom.xml 本身是新增文件，需全量打包确保 Reactor 顺序正确
