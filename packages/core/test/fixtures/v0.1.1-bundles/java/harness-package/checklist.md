---
description: harness-package 的8步工作流详细步骤、模块识别方法和执行日志记录格式。仅在执行打包流程时读取。
---

# harness-package 检查清单

## 步骤 0：启动准备

确定变更名：用 Glob 搜索 `.harness/changes/*/plans/*-plan.md`（**排除 `.harness/archive/*/`**），读取 frontmatter 提取 `change-name`。默认最多一个未归档变更；如有多个，优先取最近修改的，或用 AskUserQuestion 询问用户。

如果 `$ARGUMENTS` 非空且与检测到的变更名不一致，以 `$ARGUMENTS` 为准。

**读取 worktree 状态并切换**：读 `.harness/changes/<change-name>/meta/worktree.json`（旧路径 `worktree.json` 兼容）。`requested=true` 且 `.claude/worktrees/<change-name>/` 已创建 → cd 到该 worktree 目录；`requested=true` 但 worktree 不存在 → 停止，提示先修复 `harness-run`，不得静默回主目录；`requested=false` → 在主目录执行。切换后检查构建配置文件（`.mvn/maven.config`、`settings-*.xml` 等）是否完整，缺失时从主目录复制。

**强制前置检查 — harness-test（硬门禁）和 harness-review（参考性）**：

通过 Glob 检查：
- `.harness/changes/<change-name>/reports/test/test-report-*.md` 是否存在（旧路径 `tests/` 兼容）
- `.harness/changes/<change-name>/reports/review/review-report-*.md` 是否存在（参考性，不阻塞；旧路径 `reviews/` 兼容）

如果缺失 test 报告，使用 `AskUserQuestion` 询问用户：

```
检测到 harness-test 尚未运行（缺少测试报告）：
- 测试报告: <存在/缺失>
- 审查报告: <存在/缺失>（参考性，不阻塞）

打包前建议先运行测试。请选择：
1. 先运行 harness-test — 退出 package 流程，运行 harness-test 后再 package（推荐）
2. 跳过测试继续打包 — 风险自担，报告中明确标记
3. 取消 package
```

**默认不跳过 test**。用户确认跳过时，必须在执行日志和 package-report 中明确写明：
- 执行日志：`- **跳过**: 用户确认跳过 harness-test`
- package-report：`> ⚠️ 用户确认跳过 harness-test，打包结果未经测试验证`

**review 报告**：如果存在，记录路径和摘要供参考；如果不存在，不阻塞 package。review 结果不作为硬门禁。

**读取 verification-ledger + 确定 baseCommit**：

1. 读取 `.harness/changes/<change-name>/evidence/verification-ledger.json`（旧路径 `verification-ledger.json` 兼容），记录 `unitTest`/`apiTest` 的 status、`diffHash`、`currentHead`
2. 确定 `baseCommit`：优先取 `.harness/changes/<change-name>/logs/execution-log.md` 中 harness-submit 阶段的 `final pushed hash`（旧路径 `execution-log.md` 兼容）；无 submit 记录时取当前 `git rev-parse HEAD`
3. 判断 ledger 是否有效（全部满足才算有效）：
   - `unitTest.status=OK` 且 `apiTest.status=OK`
   - `diffHash` 与当前提交一致
   - submit 后无新提交（`git log <baseCommit>..HEAD` 为空）
   - 无行为性 post-test 修改（`postTestClassification` ∈ {无, NON_BEHAVIORAL_CLEANUP, COMMENT_ONLY, TEST_ONLY}）
4. ledger 有效 → 默认 `mvn package -DskipTests` 复用测试；ledger 无效 → 带测试打包或要求先跑 `/harness-test`

**append `phase.start`**（含 worktree/baseCommit/ledger 摘要于 `note`）：

```powershell
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase package --type phase.start --note "<触发指令>"
```

## 步骤 1：拉取最新代码

> **分支名自动读取**：不硬编码 `master` 或 `main`，使用 `git rev-parse --abbrev-ref @{u}` 自动读取 upstream 分支。

合并他人提交，确保打包基于最新代码：

```powershell
# 0. 自动读取当前分支的 upstream
powershell.exe -Command "git -C '<项目路径>' rev-parse --abbrev-ref @{u}"
# 输出示例：origin/master 或 origin/develop

# 1. 暂存当前变更
powershell.exe -Command "git -C '<项目路径>' stash"

# 2. 拉取远程最新代码（使用读取到的 upstream）
powershell.exe -Command "git -C '<项目路径>' pull"

# 3. 恢复暂存的变更
powershell.exe -Command "git -C '<项目路径>' stash pop"
```

**冲突处理**：
- `git stash pop` 产生冲突 → **停止打包流程**，提示用户手动解决冲突
- `git pull` 失败（网络问题）→ 提示用户检查网络，询问是否继续（基于本地代码打包）
- 无冲突 → 继续步骤 2

**Shell 安全规则（强制）**：
- 如果 `git stash` / `git pull` 命令被 hook 拒绝（输出含 `Denied` / `PreToolUse:Bash hook error`），**必须停止流程**或重试 PowerShell 调用
- **不得基于被拒绝的输出继续后续步骤**（不能假装"拉取成功"）
- 拉取成功的判断证据：git 输出包含 `Already up to date.` 或 `Fast-forward`、`Updating <hash>..<hash>`，且 exit code 为 0

## 步骤 2：合并后重新验证（ledger 复用优先）

合并后必须重新编译；测试是否重跑按 ledger 有效性决定。

**ledger 有效时**（步骤 0 已判定）：跳过 `mvn test`，仅执行 `mvn compile` 确认合并后可编译，测试结果复用 ledger。

**ledger 无效时**：执行 `mvn compile` + `mvn test`，结果写回 ledger。

**合并后重新验证前，先检查依赖模块**：
```powershell
# 检查上游依赖模块是否已 install 到本地仓库
powershell.exe -Command "Test-Path '$env:USERPROFILE\.m2\repository\<group-path>\<module>\*\*.jar'"
```
如果缺失，先安装：
```powershell
powershell.exe -Command "mvn install -pl <upstream-modules> -am -DskipTests -nsu"
```

```powershell
# 编译验证（始终执行）
powershell.exe -Command "mvn compile -pl <module> -am"

# 测试验证（仅 ledger 无效或用户要求 package-with-tests 时执行）
powershell.exe -Command "mvn test -pl <module> -am"
```

**编译/测试成功必须有明确证据**：
- `mvn compile` 输出必须包含 `BUILD SUCCESS`
- `mvn test` 输出必须包含 `Tests run: N, Failures: 0, Errors: 0`
- 命令被 hook 拒绝或 exit code 非 0 → 标记为 ❌ 失败，停止流程

**pull 后远程变更检查**：
```powershell
# 检查 pull 是否引入了他人提交
powershell.exe -Command "git -C '<项目路径>' log HEAD@{1}..HEAD --oneline"
```
- 如果有他人提交（输出非空），**ledger 失效**，必须重新 compile + test，即使 pull 前已验证过
- 如果没有他人提交（输出为空），ledger 仍然有效，可基于已有验证结果继续

**验证失败处理**：
- 编译失败 → 分析是否与本次变更相关。相关则修复后重试；无关（他人引入的问题）则记录并询问用户是否继续
- 测试失败 → 分析失败原因。如果是他人代码破坏了本次功能，记录冲突点并提示用户

> **为什么合并后必须重新编译**：他人代码可能引入新依赖（编译失败）、修改公共接口（调用点断裂）、修改数据库结构（测试数据不匹配）。即使 git 自动合并无冲突，语义层面可能存在冲突。ledger 复用仅在 pull 未引入他人提交时成立。

## 步骤 3：变更模块识别

**变更模块识别必须区分四种来源，不得把远程他人变更误判为本次变更**：

| 来源 | git 命令 | 用途 |
|------|---------|------|
| a. 本地未提交变更（工作区） | `git diff --name-only` | 当前正在编辑但未 add 的变更 |
| b. staged 变更 | `git diff --cached --name-only` | 已 add 但未 commit 的变更 |
| c. 已提交但未推送变更 | `git log @{u}..HEAD --name-only --pretty=format:` | 本次开发的本地提交 |
| d. 远程 pull 进来的他人变更 | `git log HEAD@{1}..HEAD --name-only --pretty=format:` | pull 引入的他人提交，**不得纳入本次变更模块** |

**识别本次变更模块的标准来源**：
- 本次开发涉及的变更 = a + b + c（工作区 + staged + 本地未推送提交）
- 远程 pull 进来的 d 是他人变更，仅作为"合并验证"对象，不写入本次打包变更模块清单

1. **确定本次变更比较基线**：使用 upstream（不硬编码 master/main）：

```powershell
# 自动读取 upstream 名称
powershell.exe -Command "git -C '<项目路径>' rev-parse --abbrev-ref @{u}"
# 输出示例：origin/master

# 计算 merge-base
powershell.exe -Command "git -C '<项目路径>' merge-base HEAD '@{u}'"
```

2. **获取本次变更文件列表（排除 pull 进来的他人变更）**：

```powershell
# 获取本地未提交+本地已提交（不含远程拉入的他人提交）
powershell.exe -Command "git -C '<项目路径>' diff '@{u}'...HEAD --name-only"
```

> 注意 `...HEAD`（三点）会自动排除从 upstream 合并进来的他人提交，只保留本地分叉后的变更。

3. **映射到 Maven 模块**：逐个检查变更文件的路径，判断其所属的 Maven 模块：
   - 找到变更文件所在目录及其父目录中的 `pom.xml`
   - 模块路径 = `pom.xml` 所在目录的相对路径（如 `module-a/sub-module-b`）
   - 同一模块的多个变更文件只记录一次
   - 根目录 `pom.xml` 的变更属于父项目本身（用根路径 `.` 表示）

4. **识别依赖链**：对每个变更模块，检查哪些其他模块依赖它：
   - 扫描其他模块的 `pom.xml` 中 `<dependency>` 引用了变更模块的 `<groupId>:<artifactId>`
   - 这些下游模块也需要打包（对应 Maven `-amd` 参数）
   - 上游依赖模块（变更模块自身依赖的模块）由 `-am` 自动包含

5. **输出模块清单**：汇总所有变更模块 + 依赖链涉及模块，展示给用户：

```markdown
## 变更模块识别结果

### 直接变更模块 (N 个)
- `module-a` — 变更文件: 5 (src/main/java/..., src/main/resources/...)
- `module-b/sub-b` — 变更文件: 2

### 依赖链涉及模块
- 上游（-am）: parent-pom, module-common
- 下游（-amd）: module-web (依赖 module-a)

### 未变更模块（将跳过）
- module-c, module-d
```

## 步骤 4：打包模式选择

使用 AskUserQuestion 向用户展示选项：

```markdown
已识别 N 个变更模块及其依赖链，请选择打包模式：

1. 增量打包 — 只打包变更模块 + 上游依赖（-pl <modules> -am）
   适用：日常发版，构建速度快
   命令：mvn package -pl module-a,module-b/sub-b -am

2. 增量打包（含下游） — 打包变更模块 + 上游 + 下游（-pl <modules> -am -amd）
   适用：需要验证下游模块兼容性

3. 全量打包 — 打包所有模块
   适用：首次发版、重大重构、不确定依赖关系时
   命令：mvn package

4. 自定义 — 手动指定模块列表
```

降级策略：用户无明确偏好时，默认选择选项 1（增量打包 + 上游依赖）。

## 步骤 5：执行打包

根据步骤 4 的选择构建 Maven 命令。**是否带 `-DskipTests` 由 ledger 有效性决定**：

**ledger 有效时（默认）**：复用 test 阶段验证，跳过测试

```powershell
# 增量打包（选项 1）
powershell.exe -Command "mvn package -pl <module-list> -am -DskipTests"
# 增量打包含下游（选项 2）
powershell.exe -Command "mvn package -pl <module-list> -am -amd -DskipTests"
# 全量打包（选项 3）
powershell.exe -Command "mvn package -DskipTests"
```

**ledger 无效时或用户要求 package-with-tests**：去掉 `-DskipTests`

```powershell
powershell.exe -Command "mvn package -pl <module-list> -am"
```

**关键规则**：
- **ledger 有效时默认 `-DskipTests`**，复用 test 阶段的 unitTest + apiTest 结果（不是"跳过测试"，是"复用已验证结果"）
- ledger 无效 / 用户要求 `package-with-tests` / test 报告缺失 → 必须带测试打包
- `-pl` 中的模块路径使用相对于根 pom.xml 的路径，多模块用逗号分隔
- 记录开始时间用于计算耗时
- 打包失败时**立即停止**，不继续后续步骤，转入错误处理

**失败处理**：
- 输出失败模块名称和错误信息
- 提示用户检查：
  1. 依赖是否完整（是否需要先 `mvn install` 安装上游模块）
  2. 版本冲突（参考 `reference.md` 常见问题）
  3. 编译错误（是否遗漏了某个变更文件）
- 用 AskUserQuestion 询问用户：重试 / 调整模块范围 / 停止

## 步骤 6：结果收集

打包成功后，逐模块扫描产物（**必须通过 Glob 实际扫描确认，不能仅根据 Maven 输出猜测**）：

1. **扫描 target/ 目录**：对每个打包模块，用 **Glob 工具实际扫描**：

```
<module-path>/target/*.jar
<module-path>/target/*.war
```

2. **收集信息**（基于 Glob 实际返回的文件）：
   - 产物文件名
   - 产物相对路径（相对于项目根目录）
   - 文件大小（用 `powershell.exe -Command "Get-Item '<path>' | Select-Object Length"` 获取）
   - **sha256**（必填，用于 ledger 和部署校验：`powershell.exe -Command "Get-FileHash '<path>' -Algorithm SHA256"`）

3. **构建状态判定（必须基于实际证据）**：
   - ✅ SUCCESS — Glob 扫描确认 target/ 中存在预期的 jar/war 文件 + Maven 输出含 `BUILD SUCCESS`
   - 🟡 SKIPPED — 模块不含主产物（如 parent-pom 模块只有 pom.xml）
   - ❌ FAILED — 打包命令报错（已在步骤 5 处理）/ Glob 扫描未找到产物 / Maven 输出含 `BUILD FAILURE`

4. **汇总产物表**：

```markdown
| 模块 | 产物 | 路径 | 大小 | 状态 |
|------|------|------|------|------|
| module-a | xxx-service.jar | module-a/target/xxx-service-1.0.jar | 12.5 MB | ✅ SUCCESS |
| module-web | xxx-web.war | module-web/target/xxx-web-1.0.war | 45.2 MB | ✅ SUCCESS |
| parent-pom | — | — | — | 🟡 SKIPPED |
```

## 步骤 7：持久化报告 + 写回 ledger

将打包报告写入 `.harness/changes/<change-name>/reports/package/package-report-YYYYMMDD-HHmm.md`。

时间戳取当前时间，格式 `YYYYMMDD-HHmm`（如 `20260617-1430`）。

报告内容格式见 `reference.md` 的"报告格式示例"。报告必须包含「测试执行策略」段落（见 reference.md）。

**写回 `evidence/verification-ledger.json` 的 `package` 项**：

```json
"package": {
  "status": "OK",
  "command": "mvn package -pl <module> -am -DskipTests",
  "baseCommit": "<final pushed hash 或当前 HEAD>",
  "deployArtifact": "<module>/target/<artifact>.jar",
  "sha256": "<artifact sha256>",
  "testsExecuted": false,
  "testsReusedFrom": "unitTest+apiTest",
  "evidence": "BUILD SUCCESS + Glob 扫描确认 jar 存在",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 0
}
```

- `testsExecuted`：本次 package 是否真实跑了测试（ledger 有效且用了 `-DskipTests` → false）
- `testsReusedFrom`：`testsExecuted=false` 时必须指明复用来源（`unitTest+apiTest`）

## 步骤 8：events 结束

**append `phase.complete`**（`note` 含 baseCommit/打包策略/结果/报告路径）：

```powershell
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase package --type phase.complete --note "OK|WARN|FAIL — <摘要>"
```
