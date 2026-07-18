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
      "metrics": {"run": 14, "failures": 0, "errors": 0, "skipped": 0},
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
      "command": "<打包命令（按技术栈：Java=mvn clean package -pl <module> -am -DskipTests；前端=npm run build；Python=python -m build）>",
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
  --command "<resolved build-profile.json commands.unitTestFull.command>" --json
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

必须基于真实内容变更集计算 SHA-256，且**必须是 commit-invariant 的**——覆盖本变更集相对 `baseCommit` 的 tracked 变化、标准 untracked 文件，以及 `test-tracking.json` 明确记录的 ignored tests，使 checkpoint commit 前后指纹一致，保证 run→test→submit 复用链不断。

`<baseCommit>` 从 ledger 读取（harness-plan 阶段写入）；缺失时用 `git merge-base HEAD <默认分支>` 兜底。

**canonical 命令（cluster 2 起脚本化，推荐）**：

```text
harness_ledger.py diff-hash --repo <projectRoot> --base <baseCommit> --change-dir ".harness/changes/<change-name>" --json
```

`diff-hash` 用 subprocess 直接捕获 Git bytes，按 repo-relative path 排序并进行长度 framing（`path-len | path | exists | content-len | content`），独立于 shell/控制台编码/BOM/系统换行。算法版本 `content-changeset-2`，输出 `diffHash`/`algorithmVersion`/`fileCount`/`base`/`head`/`trackedTestFileCount`/`testTrackingManifest`。

- `--change-dir` 可选以兼容普通调用；run/test/submit 对正式 change 必须传入。manifest 不存在时贡献 0 个额外路径。
- manifest 存在时必须严格验证 schema/mode/projectRoot、精确相对路径、文件存在性与 SHA-256；结构非法、路径越界或 hash 漂移均非零退出，旧 ledger 不得复用。
- ignored test 在 checkpoint 前由 manifest 加入内容集；经 guard force-stage/commit 后由 Git diff 加入同一路径，集合去重，因此 hash 保持不变。
- diffHash 只用于"内容是否变化"判断，不等于 commit hash
- 账本中 `currentHead`（验证时 HEAD）与 `diffHash` 分开记录；reuse 规则 #2 允许 HEAD 前移（如 harness-run Step 5 checkpoint commit），因 diffHash 已 commit-invariant，HEAD 前移不改变指纹
- **禁止**使用类似 `3files-84plus-5minus` 的描述性字符串作为复用依据
- **禁止**删除/忽略 test-tracking manifest 后继续复用，也禁止用手写 Git/Node/PowerShell hash 替代 canonical 命令。

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

## 九、Ledger v2（cluster 2）

`harness_ledger.py` v2 引入确定性 `diff-hash`（§五）、v2 entry 字段、coverage lattice、`package` verification 与结构化错误码。Skill 只调用 `record`/`can-reuse`/`diff-hash`，不再手工判断或解释自由文本。

### 9.1 v2 entry 字段

`record` 自动写入：

| 字段 | 含义 |
|------|------|
| `algorithmVersion` | 固定 `harness-ledger-2`；缺失即 v1 entry |
| `coverage` | 覆盖层级 `incremental`/`module`/`module-am`/`full`，由 verification+scope 派生或 `--coverage` 显式指定 |
| `toolchainHash`/`profileHash`/`environmentHash` | 可选；`record --toolchain-hash` 等写入，`can-reuse --toolchain-hash` 等比对（UT-017） |
| `metrics` | 可选；`record --metrics-json '{"run":155,"failures":0,...}'` 写入结构化计数（不参与 inputsHash）。archive 读取顺序：`metrics` → evidence dict → evidence 文本正则 → `runtime/api-test-results.json` |

### 9.2 coverage lattice

`COVERAGE_RANK = {incremental:0, module:1, module-am:2, full:3}`。各 verification 最低要求：`unitTest`=0、`unitTestFull`/`compile`/`apiTest`=1、`install`/`package`=2。entry.coverage rank < 要求 → `insufficient-evidence`（code `COVERAGE_INSUFFICIENT`），**禁止增量证据提升为全量门禁**（UT-015/API-005）。

### 9.3 package verification

`package` 加入 `VERIFICATIONS`。`record --verification package` 额外记录 `deployArtifact`/`sha256`/`testsExecuted`/`testsReusedFrom`。API-006/007 的 package 生命周期复用编排由 cluster 4 负责，cluster 2 仅提供 record/can-reuse 能力（UT-018）。

### 9.4 结构化错误码

`can-reuse` 每个非 reuse 结果携带 `code` 字段，Skill 据 `code` 决策，不解析 `detail` 自由文本：

| code | reason | 含义 |
|------|--------|------|
| `LEDGER_MISSING`/`VALIDATIONS_MISSING`/`VALIDATION_MISSING` | insufficient-evidence | ledger/条目缺失 |
| `MISSING_V2_FIELDS` | insufficient-evidence | v1 entry 缺 algorithmVersion/coverage，**一次性保守失效**（COM-002），重记录 v2 后可复用 |
| `MISSING_FIELDS` | insufficient-evidence | 缺 status/evidence/inputsHash/scope 等基础字段 |
| `COVERAGE_INSUFFICIENT` | insufficient-evidence | coverage rank 不足 |
| `SCOPE_INSUFFICIENT` | insufficient-evidence | unitTest scope 不覆盖请求 |
| `INPUT_FILE_MISSING` | insufficient-evidence | 当前文件集读取失败 |
| `COMMAND_CHANGED` | rerun | 命令变化 |
| `TOOLCHAIN_CHANGED`/`PROFILE_CHANGED`/`ENVIRONMENT_CHANGED` | rerun | 对应 hash 变化（UT-017） |
| `INPUTS_HASH_CHANGED` | rerun | inputsHash 变化 |
| `REUSED` | reuse | 复用 |

### 9.5 v1→v2 兼容

v1 ledger 可读；entry 缺 v2 字段时 `can-reuse` 返回 `MISSING_V2_FIELDS`（insufficient-evidence），**不静默升级证据**。重新 `record`（自动补 v2 字段）后恢复复用。diffHash 算法升级后旧 ledger 一次性失效，不危险复用。

## 十、Ledger v3（contract-gated，2026-07 起）

v3 仅在 change contract 为 schemaVersion ≥ 2（或声明 `stateOwnership.runtimeRoot`，即 split-v1 布局）时启用；legacy v1 契约与无契约目录**行为完全不变**（零回归，旧 362 测试套件证明）。

### 10.1 强制顶层身份

v2 契约下 `record` 写入前强制解析并校验顶层身份字段，缺失且不可解析时**非零退出、不写账本**：

| 字段 | 解析顺序 |
|------|------|
| `schemaVersion` | 固定 `3` |
| `repositoryId` | `harness_paths.repository_identity(repo_root)`（远端规范化 + root commit；无远端回退 git common-dir，跨 worktree 稳定，RET-09） |
| `changeName` | change 目录名 |
| `baseCommit` | `--base-commit` → 既有 ledger 值 → `git rev-parse --verify HEAD` |
| `currentHead` | `git rev-parse --verify HEAD`（验证执行时） |
| `diffHash` | `--diff-hash` → 既有 ledger 值 → 按 ownership 范围重算（§10.3） |
| `ownershipHash` | 契约 `ownership` 段规范化 JSON 的 sha256 |

### 10.2 类型化 metrics 与 applicability

- v2 契约下 `--metrics-json` 必须通过 `validate_metrics` 类型校验：`unitTest`/`unitTestFull` 要求 `total/passed/failed`；`apiContract` 要求 `scenariosTotal/passed/failed`；`browserE2E` 要求 `total/passed/failed`；`dbCompatibility` 要求 `applicability ∈ APPLICABLE|NOT_APPLICABLE`，`NOT_APPLICABLE` 必须带 `reason`（UT-005/RET-15、UT-006/RET-16）。未知 verification 类型放行。
- `--applicability APPLICABLE|NOT_APPLICABLE` + `--applicability-reason` 写入 entry 级 applicability；`NOT_APPLICABLE` 无 reason 直接报错。applicability **既不计入通过也不计入失败**（UT-012/RET-24）。
- legacy 契约不校验 metrics 形状（旧的 `{"run","failures"}` 松散格式继续可用）。

### 10.3 ownership 范围 diffHash（RET-18）

`compute_ownership_diff(repo_root, base, change_dir)` 只对本变更 ownership 范围内的路径计算 diffHash：

- 排除 `.harness/state/**` 动态运行时证据（计入 `excludedRuntimeCount`）
- 他变更路径（`.harness/changes/<other>/`、`.harness/state/changes/<other>/`）单列 `foreignPaths`，不混入哈希
- 输出 `diffHash/files/foreignPaths/excludedRuntimeCount/ownedFileCount/ownershipHash`

### 10.4 原子写入

`write_ledger` 采用 tmp → fsync → `os.replace`；replace 失败时旧账本字节不变、不留 `.tmp` 残骸。所有写路径（record / 其他命令）统一走原子写。
