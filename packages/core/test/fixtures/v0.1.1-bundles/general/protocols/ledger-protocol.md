---
description: verification-ledger、diffHash、service-fingerprint 的统一协议。用于 run/test/submit/package/archive 之间复用验证结果。由原 harness-plan/verification-ledger.md 合并而来。
---

# Ledger Protocol

> 本协议被 harness-plan / harness-run / harness-test / harness-submit / harness-archive 共同引用。
> 目标：消除跨阶段重复编译/测试，让每个"✅ 已验证"结论可追溯、可复用，避免 post-test 小改动导致前序报告有效性表达不清。

## 一、为什么需要 verification-ledger

实践教训：

- run 跑过测试命令（如 `mvn test`/`pytest`），test 阶段又原样跑一遍——浪费 3~8 分钟
- submit/package 各自再 compile+test 一次——同一 diff 被验证三四轮
- test 通过后用户改了一行注释/删了一个未用 import，package 不知道该不该重测，干脆全量重跑
- final-summary 只展示全绿，看不出哪些是"重新执行"、哪些是"复用"、哪些是"小改动后复用"

verification-ledger 把每次验证（compile / unit test / api test / package）的**结果 + 证据 + 作用范围 + diffHash** 记下来，后续阶段先读 ledger 再决定是否重跑。

## 二、账本文件位置

```text
.harness/changes/<change-name>/evidence/verification-ledger.json
```

> 旧路径 `.harness/changes/<change-name>/verification-ledger.json`（根目录）兼容读取，详见 `state-layout-protocol.md`。新版本优先写 `evidence/`。

- 不提交到 git（已在 `.harness/` 屏蔽范围内）
- 每次验证执行后**立即写回**（不得等所有阶段结束才补）
- 后续阶段执行验证前**必须先读取** ledger

## 三、账本结构

`.harness/changes/<change>/verification-ledger.json` 必须至少包含：

```json
{
  "changeName": "indicator-permission-fix",
  "projectRoot": "C:/CQ_PROJECT/贡献积分管理系统/udp",
  "worktreeRoot": "... 或 null",
  "stateDir": ".harness/changes/<change>",
  "currentHead": "<git rev-parse HEAD>",
  "baseCommit": "<merge-base 或计划起点>",
  "diffHash": "sha256:<diff 内容指纹>",
  "module": "<module-from-build-profile>",
  "profile": "local-dev",
  "postTestClassification": "NON_BEHAVIORAL_CLEANUP",
  "ledgerReusable": true,
  "scope": "module",
  "validations": {
    "compile": {
      "status": "OK",
      "command": "<构建命令（按技术栈：Java=mvn compile -pl <module> -o -q；前端=npm --prefix <module> run build；Python=pytest <module>）>",
      "scope": "module",
      "evidence": "<构建成功证据（Java=BUILD SUCCESS；前端/Python 按各自工具成功标志）>",
      "startedAt": "2026-06-22T10:00:00+08:00",
      "finishedAt": "2026-06-22T10:01:30+08:00",
      "durationMs": 90000
    },
    "unitTest": {
      "status": "OK",
      "command": "<测试命令（按技术栈：Java=mvn test -pl <module> -o；前端=npm test --prefix <module>；Python=pytest <module>）>",
      "scope": "module",
      "testsRun": 14,
      "failures": 0,
      "errors": 0,
      "skipped": 0,
      "evidence": "<测试通过证据（Java=Tests run: 14, Failures: 0, Errors: 0, Skipped: 0；前端/Python 按各自工具成功标志）>",
      "startedAt": "2026-06-22T10:02:00+08:00",
      "finishedAt": "2026-06-22T10:05:00+08:00",
      "durationMs": 180000
    },
    "apiTest": {
      "status": "OK",
      "runner": "playwright-api-runner",
      "scenariosTotal": 21,
      "passed": 21,
      "failed": 0,
      "skipped": 0,
      "evidence": "api-test-results.json summary",
      "resultsFile": ".harness/changes/<change-name>/runtime/api-test-results.json",
      "startedAt": "2026-06-22T10:06:00+08:00",
      "finishedAt": "2026-06-22T10:08:00+08:00",
      "durationMs": 120000
    },
    "package": {
      "status": "OK",
      "command": "<打包命令（按技术栈：Java=mvn package -pl <module> -am -DskipTests；前端=npm run build；Python=python -m build）>",
      "baseCommit": "<final pushed hash>",
      "deployArtifact": "<构建产物路径（Java=<module>/target/<artifact>.jar；前端=<module>/dist/；Python=<module>/dist/）>",
      "sha256": "<artifact sha256>",
      "testsExecuted": false,
      "testsReusedFrom": "unitTest+apiTest",
      "evidence": "<构建成功证据> + Glob 扫描确认构建产物存在",
      "startedAt": "2026-06-22T10:30:00+08:00",
      "finishedAt": "2026-06-22T10:35:00+08:00",
      "durationMs": 300000
    }
  }
}
```

缺少 `diffHash/currentHead/baseCommit/module/profile` 时，后续 skill 不得复用该 ledger，只能作为参考报告。

字段说明：

| 字段 | 含义 |
|------|------|
| `diffHash` | 本变更集相对 `baseCommit` 的全部内容变更 sha256 = `git diff baseCommit..HEAD`（已提交）+ `git diff`（未提交 tracked）+ 未跟踪新文件内容的合并指纹；**commit-invariant**（未提交 diff 转为已提交 diff，指纹不变），保证 run→test 跨 checkpoint commit 可复用 |
| `currentHead` | 验证执行时的 HEAD commit hash |
| `baseCommit` | merge-base 或计划起点（package 项另有 `baseCommit` 指 final pushed hash） |
| `projectRoot` / `worktreeRoot` | 项目根与 worktree 根（无 worktree 时 `worktreeRoot=null`） |
| `stateDir` | `.harness/changes/<change>`，避免手拼路径 |
| `scope` | 验证范围：`module` / `module-am` / `full`，越严格越容易复用 |
| `evidence` | 必须是命令实际输出的关键证据串，不得为空 |
| `postTestClassification` | test 之后若发生代码变更，标注变更类型（见第六章） |
| `ledgerReusable` | 布尔型，当前 ledger 是否可被后续阶段复用；由 postTestClassification（非行为性）+ diffHash 比对一致 + module/profile/scope 一致共同决定；缺关键字段时为 false，后续阶段不得复用 |
| `scope`（顶层） | 顶层 scope 取 validations 中最宽 scope，作为复用判定的整体范围；条目级 scope 见各 validation |
| `package.testsExecuted` | package 本次是否真实跑了测试；为 false 时 `testsReusedFrom` 必须指明复用来源 |

## 四、复用判定规则

后续阶段执行验证前先读 ledger。**同时满足以下全部条件**才可复用已有验证结果，否则必须重新执行：

1. `diffHash` 与当前 diff 一致
2. `currentHead` 或 merge-base 未发生影响当前 diff 的变化（HEAD 可前移，但本次变更文件未被他人提交触碰）
3. `module` 一致
4. `profile` 一致
5. ledger 中该项 `command` 的 `scope` 一致或更严格（当前阶段范围 ⊆ ledger 范围）
6. 前一次验证结果 `status=OK` 且 `evidence` 非空
7. 前一次验证后**没有行为性代码变更**（见第六章分类；只有 NON_BEHAVIORAL_CLEANUP / COMMENT_ONLY / TEST_ONLY 才算"无行为性变更"）

**禁止复用的高风险场景**（即使 diffHash 相同也必须重跑）：

- post-test 修改属于 BEHAVIORAL_SERVICE_CHANGE / API_CONTRACT_CHANGE / SQL_OR_MAPPER_CHANGE / SECURITY_OR_PERMISSION_CHANGE
- 远端 pull/rebase 引入了新提交
- 用户显式要求 `submit-full-verify` / `package-with-tests`
- ledger 缺失、损坏或 `evidence` 为空

### 4.1 service-fingerprint（API 测试服务复用）

接口测试复用已有服务前，读取：

```text
.harness/changes/<change>/runtime/service-session.json
```

字段（由 `harness_service.py ensure` 写入）：

```json
{
  "pid": 0,
  "startedBy": "AI / User",
  "moduleInputsHash": "sha256:<依赖闭包内容指纹>",
  "moduleInputsFiles": ["<project>/Svc.java", "..."],
  "profile": "local-dev-remote-sdk",
  "overlayPath": "C:/temp/harness-test-overlay/<change>/application-harness-test.yml",
  "startCommandHash": "sha256:<command 指纹>",
  "command": "<serviceStart.command>",
  "startedAt": "..."
}
```

`moduleInputsHash` 由 CLI `--files` ∪ `build-profile.json` 的 `serviceStart.inputFiles`（glob 列表，相对 project 展开）计算。**空输入被拒绝**（exit 非 0），不得生成可复用的空指纹（§5.1/§5.2）。

复用必须**同时**满足（§5.3）：`moduleInputsHash` 一致、`startCommandHash` 一致、`profile` 一致、`overlayPath` 一致、进程身份（pid 存活 + create time 匹配 `startedAt`）可确认。任一变化 -> AI 自动 restart；身份无法确认 -> `needs-user-decision`；非 AI 用户进程永不自动 kill。否则必须进入 Service Decision Gate（见 harness-test）。

### 4.2 unitTestFull 最终全量门禁

`unitTestFull` 是 submit 前的**模块级全量单元测试**门禁，与增量 `unitTest` 严格区分，二者键独立、不可互冒充：

| verification | 合法 scope | 复用规则 |
|---|---|---|
| `unitTest` | 测试类列表或 `module`/`module-am`/`full` | 可覆盖请求的受影响测试类 |
| `unitTestFull` | 只能是 `module` / `module-am` / `full`（broad scope） | 只允许复用已有 `unitTestFull`；增量 `unitTest` 结果不能复用 |

`unitTestFull` 复用必须**同时**满足：ledger 存在 `validations.unitTestFull`、`status=OK`、`scope ∈ broad scopes`、`evidence` 非空、`command` 非空（调用方传 `--command` 时须完全一致）、`inputsHash` 与当前文件集一致、`inputsFiles` 为非空 list。任一不满足（含 scope 为测试类名等增量范围）→ `insufficient-evidence`，执行全量测试但不允许缓存复用。

**依赖闭包必须由 profile 展开**，最终门禁禁止用仅含 staged 文件的 `--files` 快捷方式冒充全量闭包：

```text
harness_ledger.py can-reuse --verification unitTestFull --scope module \
  --project . --profile-input unitTestFull \
  --command "<build-profile.json buildCommands.unitTestFull>" --json
```

`build-profile.json` 新增 `verificationInputs.unitTestFull`（glob 列表，相对 project 展开，只保留 project 内文件、去重排序）：

```json
{
  "verificationInputs": {
    "unitTestFull": ["pom.xml", "module/pom.xml", "module/src/main/**", "module/src/test/**"]
  }
}
```

profile key 缺失 / glob 无匹配 / 结果为空 → `insufficient-evidence`（exit 0），仍须执行全量测试但不允许缓存复用，直到 profile 被正确配置。`harness_preflight.py detect` 对单模块 Java 项目写入根级默认闭包 `["pom.xml", "src/main/**", "src/test/**"]`；多模块项目需手工改为 module 专属 glob，detect 不会覆盖用户已配置的 `verificationInputs`。

## 五、真实 diffHash

必须基于真实 diff 计算 SHA-256，且**必须是 commit-invariant 的**——覆盖本变更集相对 `baseCommit` 的全部内容变更（已提交 + 未提交 + 未跟踪），使 checkpoint commit 前后指纹一致，保证 run→test 复用链不断。

`<baseCommit>` 从 ledger 读取（harness-plan 阶段写入）；缺失时用 `git merge-base HEAD <默认分支>` 兜底。推荐命令：

```powershell
powershell.exe -NoProfile -Command "$base = '<baseCommit>'; $patch = '.harness/changes/<change>/runtime/current-diff.patch'; & { git diff $base HEAD --binary; git diff --binary; git ls-files --others --exclude-standard | ForEach-Object { Get-Content -Raw -LiteralPath $_ } } | Out-File -Encoding utf8 $patch; (Get-FileHash $patch -Algorithm SHA256).Hash"
```

- 命令为模板：`<baseCommit>`/`<change>` 需替换；经 `powershell.exe -Command "..."` 从 PowerShell/Bash 调用时外层会展开 `$` 变量，建议直接用 PowerShell 工具执行去外壳脚本，或外层用单引号/`--%` 防展开
- 三部分合并：`git diff $base HEAD`（已提交变更）+ `git diff`（未提交 tracked）+ 未跟踪新文件内容（`git ls-files --others --exclude-standard`）；`& { }` 必须带 `&` 才执行 scriptblock（bare `{ } | Out-File` 只写脚本块字符串，不执行）
- commit 前：`$base..HEAD` 为空 + 未提交 24 文件 + 未跟踪 9 文件 = 全量；commit 后：`$base..HEAD` 24 文件 + 未提交空 + 未跟踪空 = 同内容 → 指纹一致 ✅
- diffHash 只用于"内容是否变化"判断，不等于 commit hash
- 账本中 `currentHead`（验证时 HEAD）与 `diffHash` 分开记录；reuse 规则 #2 允许 HEAD 前移（如 harness-run Step 5 checkpoint commit），因 diffHash 已 commit-invariant，HEAD 前移不改变指纹
- **禁止**使用类似 `3files-84plus-5minus` 的描述性字符串作为复用依据
- **禁止**仅用 `git diff`（未提交）计算 diffHash——checkpoint commit 后工作树干净会致指纹变空，断裂 run→test 复用链
- **禁止**任何单部分简化：含 `git diff <base> HEAD`（仅已提交部分）、`git diff`（仅未提交）、`node -e`/`crypto.createHash` 自算 SHA-256。无论 commit 前后、无论工作树是否 clean，必须用上述三部分合并命令。commit 后 clean 致单部分偶然等价不得作为省略依据——时序或工作树状态变化即复现复用链断裂
- **commit 前时序说明**：harness-run 步骤 2c 在 Step 5 checkpoint commit **之前**写 ledger，此时 `git diff baseCommit..HEAD` 部分为空（HEAD==baseCommit），只有"未提交 + 未跟踪"是全量。**即使第一部分为空也必须保留三部分合并命令**——commit 后第一部分被填充、未提交/未跟踪变空，两者内容相同 → diffHash 一致。省略第一部分只用未提交 diff，commit 后未提交变空 → diffHash 变化 → 复用链断裂（真实教训：run 产出非规范 `8a94c874`，test 重算 `b4c580fc` 不一致被迫重跑全量单元测试）。harness-run 步骤 2c 已 inline 完整三部分命令，执行者直接跑 verbatim，不得自行省略

## 六、Post-test 变更分类

当 `/harness-test` 完成后又发生代码变更（常见于 review 后清理、submit 前发现的小问题），后续 submit/package/archive **必须先对变更做分类**，写入 ledger 的 `postTestClassification`：

| 类型 | 示例 | 是否需要重跑 API | 是否需要重跑 unit | 是否需要重 compile |
|------|------|:---:|:---:|:---:|
| `NON_BEHAVIORAL_CLEANUP` | 删除未使用 import、删除未使用字段、格式化 | 否 | 否 | 是（轻量） |
| `COMMENT_ONLY` | 注释调整、Javadoc 补充 | 否 | 否 | 否 |
| `TEST_ONLY` | 只改测试文件 | 否，但需重跑对应测试 | 是（对应测试） | 否 |
| `BEHAVIORAL_SERVICE_CHANGE` | service 逻辑变化 | 是 | 是 | 是 |
| `API_CONTRACT_CHANGE` | controller / VO / DTO 变化 | 是 | 是 | 是 |
| `SQL_OR_MAPPER_CHANGE` | 数据访问层 / sql / 映射文件变化 | 是 | 是 | 是 |
| `SECURITY_OR_PERMISSION_CHANGE` | 权限 / 组织过滤 / 认证变化 | 是 | 是 | 是 |

分类方法：对 post-test diff 逐文件判断，按"最严格类型"汇总——只要有一个文件属于行为性变更，整体即视为行为性变更。

**NON_BEHAVIORAL_CLEANUP 复用记录格式**（写入对应阶段报告）：

```md
post-test 变更: NON_BEHAVIORAL_CLEANUP
影响: 不影响运行时行为
追加验证: compile + unit test passed（如确实重跑了 compile/unit）
API 测试: 🔁 复用上一轮结果（diffHash 未变 / 仅清理性变更）
```

**行为性变更**：必须重新运行 `/harness-test` 的相关场景（至少覆盖变更影响的接口/权限/SQL），ledger 对应项作废并重写。

## 七、各阶段与 ledger 的交互

| 阶段 | 读 ledger | 写 ledger |
|------|:---:|:---:|
| harness-plan | 计划起点读（了解前序变更状态/已有 ledger，作为复用链起点） | 计划落定后写初始 ledger（changeName/module/profile/baseCommit/diffHash 占位） |
| harness-run | 步骤 2 前读（确认是否已有 compile/unitTest 可复用） | 步骤 2 后写 compile + unitTest（若跑了全量测试） |
| harness-test | Phase 1 前读（复用 run 的 unitTest） | Phase 1/2 后写 unitTest + apiTest |
| harness-submit | 验证前读（复用 test 的 compile/unitTest） | 若重跑则写回 |
| harness-archive | 归档前读（汇总各阶段状态用于 final-summary） | 不写（归档时一并移入 archive） |

## 八、状态与 final-summary 的对应

ledger 的 `status` 与 final-summary 展示状态对应：

| ledger status | 含义 | final-summary 标记 |
|:---:|------|------|
| `OK`（本阶段真实执行并通过） | 真实验证 | ✅OK |
| `OK` 但本阶段复用了前一阶段 | 复用 | 🔁REUSED |
| `OK` 但 post-test 后重测通过 | 重测 | 🔁RETESTED |
| `WARN` | 静态验证 / 跳过 / 降级 | 🟡WARN |
| `ADVISORY` | review 参考性 | 📝ADVISORY |
| postTestClassification=NON_BEHAVIORAL_CLEANUP | 小清理 | 🧹NON_BEHAVIORAL_CLEANUP |

**强制规则**：任何阶段若复用了前一阶段结果，final-summary 必须显示 `🔁REUSED`，**不得伪装成重新执行**。
