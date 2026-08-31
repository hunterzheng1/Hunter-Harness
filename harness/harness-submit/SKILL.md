---
name: harness-submit
description: "最终提交封装：验证→中文 commit→提交/推送；worktree 模式含 --no-ff 合并回主分支。仅当用户显式调用 /harness-submit（或 /harness-merge 重入合并段）时使用；用户口头说'提交/commit/push'时必须先确认，不得自动触发。"
disable-model-invocation: true
argument-hint: "变更名或留空自动检测"
effort: medium
allowed-tools: [Bash(powershell.exe:*), Read, Write, Edit, Glob, Grep]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(cp *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
---

# harness-submit — 最终提交（含 worktree 合并）

## Purpose

仅在 `plannedPhases` 包含 Submit 时执行 Git 提交/推送交付；没有 Git、没有远端或本次计划省略 Submit 时直接进入下一计划阶段，不得把 Submit 当作归档前提。

## When to Use

仅当用户显式调用 `/harness-submit`（或 `/harness-merge` 从合并段重入）且 `plannedPhases` 包含 Submit 时执行。用户口头说「提交代码」「commit」「push」「完成开发」而未调用本 skill 时，先确认。前置阶段只按实际计划检查；Test/Review 被计划省略时不得补跑。

> **主目录模式**（`worktree.json` requested=false）：commit+push 主分支后**停止**，仅提示可执行 `/harness-archive`，不自动归档。**worktree 模式**（requested=true）：worktree 内仅本地 commit，随后本 skill 在同一次调用内接续合并流程（这是同一次提交动作的一部分，不属于跨阶段自动推进）；**push 只在主分支发生一次**；合并完成后同样**停止**，仅提示 `/harness-archive`。

## 前置条件

- test 已通过、无未暂存修改
- 读取 `meta/worktree.json`：`requested=true` 且 worktree 已创建 → 在 worktree 目录执行提交段；不存在 → 停止并提示修复，不得静默回主目录
- review 报告可读作参考，不得阻塞提交

## Inputs

- `$ARGUMENTS`：变更名（可选，Glob `.harness/changes/*/plans/` 自动检测）
- 相关文件：`plans/*-plan.md`、`evidence/verification-ledger.json`、`meta/worktree.json`

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## 状态目录分层

新产物遵循 `../protocols/state-layout-protocol.md`；读取时先新路径后兼容旧路径。

## Workflow

worktree 合并前必须运行 `harness_change.py integration-lock acquire --run-id <run-id> --json`；获取失败即停止。无论成功、冲突或异常，都在 `finally` 运行 `harness_change.py integration-lock release --run-id <run-id> --json`。持有 integration lock 后不得反向申请 change lease。

**模式判定**：读 `meta/worktree.json`。`requested=false` → 步骤 0–7（主目录）；`requested=true` → 步骤 0–6 在 worktree 执行，成功后**不结束**，接续「worktree 合并流程」。用户仅调用 `/harness-merge` 且 worktree 已有本地 commit 时，从合并流程步骤 M0 重入。

### 提交流程（步骤 0–7）

0. **启动准备** — `harness_context.py prepare --project . --change <id> --phase submit --executor <tool> --json`（`--project` 必填）确定唯一变更与 executionRoot；`harness_context.py begin --project . --change <id> --phase submit --executor <tool> --json` 校验 review→submit receipt；**`harness_gate.py begin --phase submit --change <id>`**；读 ledger，以 `harness_ledger.py diff-hash --repo <executionRoot> --base <baseCommit> --change-dir ".harness/changes/<change-name>" --json` 计算 diffHash + post-test 7 类分类（`executionRoot` 必须直接取准备回执；禁止手写 ledger / 手工 phase.end）。若 gate begin 报 `CONTEXT_HANDOFF_REQUIRED` / `CONTEXT_BEGIN_REQUIRED`（上一阶段关门时未写交接的历史断链），**一条命令修复**：`harness_context.py handoff --project . --change <id> --to-phase submit --executor <tool> --json`（自动补租约→写收据→begin 确认；**不要**再 `harness_change.py claim` 阶段租约，也不要手工拼 context close/prepare/begin 序列）
1. **合并最新代码** — 主目录与 worktree 均**不在业务工作区 stash/pull**；远端同步由合并段 integration transaction 在隔离 integration worktree 内完成（见「worktree 合并流程」）；**正常路径禁止 `git stash` / `stash pop`**
2. **最终验证** — ledger 复用优先；提交前只调用 `can-reuse --project . --profile-input unitTestFull --command <profile 规范命令>`。不得传入另一套 `--files`，不得把 runner 包装说明写进 `command`。`reuse=true` 时禁止重跑；只有真实输入、依赖、工具链或环境身份变化时才执行一次同一 profile 验证，并只登记一条结果。不要读取 ledger/archive 实现源码或临时编写散列脚本排查参数。
   - 无远端 CI 且 gate-policy 未强制 remote provider 时，验证通过/复用后运行 `harness_archive.py certify-local --change-dir ... --project . --json`，从同一 ledger 生成 `local-reproducible` 产品候选收据；该命令不执行测试。
   - **被与本变更无关的预存失败卡住时的正规出路**：用 `harness_preflight.py record-quirk --project . --action skip-not-block --pattern "<具体错误签名，≥8 字符>" --reason "<为什么与本变更无关>"` 把它声明进 build-profile 的 `knownPreexistingErrors`，certify-local 会在**该失败的 ledger 证据里确实出现该签名**时放行，并把 `{validation, pattern, reason}` 写进收据的 `verification.preexistingExemptions` 留痕。**不得**改 gate-policy 的 `candidateVerification.requiredValidations` 来绕过——那是把门禁本身拆掉。声明了但证据对不上、或签名短到能匹配一切，仍然阻断。
   - gate-policy 要求 `remote-attested` 时不得降级成本地收据，等待远端 attestation。
3. **.gitignore + 精确暂存** ⚠️ — 检查 `.harness/` 在 `.gitignore`；**禁止 `git add -A`**。若存在 `evidence/test-tracking.json`，先执行 `python <skills-root>/scripts/harness_test_guard.py stage --project . --change-dir ".harness/changes/<change-name>" --json`；失败即硬停止。无 manifest 时不使用 `-f`。manifest 之外的文件按精确业务路径正常暂存，**禁止全局 force-add**。
4. **提交方式** — 主目录：blocking user confirmation 三选项（commit+push / 仅本地 / 取消）；**worktree：固定仅本地 commit**
5. **commit-message.txt** ⚠️ — 展示 staged、diff stat、完整中文 message；用户确认
6. **commit / push** — `git commit -F`；主目录按选项 push（push 前 fetch 检查远端）；无 upstream 时允许仅本地 commit。commit 后立即重新运行 `harness_archive.py certify-local`：若验证输入未变化，脚本把候选从提交前身份安全重绑定到最终 commit，不得重跑测试或手工复制账本；**worktree：只 commit，记录 local hash**
7. **收尾** — `harness_gate.py close --phase submit --status ... --to-phase <实际计划后继>`；通常后继为 Archive，但不得显示“等待 merge”或固定写死。主目录停止并提示真实下一阶段；worktree 才接续下方同一 Submit 内的合并流程。`--json` 的 stdout 只含 JSON；关门摘要横幅在 stderr——管道给 `jq` 时**不要** `2>&1` 合并（stderr 不缓冲会先写，合并后横幅会混进 JSON 流）。

详细步骤见 `checklist.md`。

### worktree 合并流程（requested=true，commit 后自动执行）

合并由 `harness_integration.py` transaction 执行：隔离 integration worktree + journal + 保护 ref + 精确清理。skill 只负责确认提交信息、调用子命令、展示结构化结果；**禁止手工 `checkout --ours/--theirs`**。

M0. append `phase.start`（phase=merge，若从 `/harness-merge` 重入则 note 标注重入）
M1. **preflight** — `harness_integration.py preflight --change <id> --run-id <run> --feature-branch worktree/<id> --target-branch <主分支> --temp-root <task temp>`；获取 integration lock、写 journal 与保护 ref；锁被持有即停止
M2. **prepare** — fetch 后从已提交 target 创建临时 integration worktree；primary 的 dirty 状态不被触碰
M3. **merge** — `--no-ff` 合并 feature 分支；merge diff 出现其他 Change 的 contract/runtime 路径 → 结构化拒绝；冲突 → step FAILED，**停下**列出冲突文件，人工解决后以 `recover` 续跑（已完成步骤返回 REUSED，不重复 merge/push）
M4. **verify** — 在 integration worktree 内执行组合态验证；他人提交引入或 ledger 不可复用时必跑
M5. **push** — 仅在验证身份与远端基线仍匹配时 push；远端漂移 → `TARGET_MOVED` 结构化失败，不继续
M6. **cleanup** — `git worktree remove --force` 精确路径 + 临时分支 + （push 成功后）保护 ref；释放 integration lock；失败保留 journal 与诊断证据；更新 `worktree.json`（`created=false` + removedAt）
M6.5. **formal snapshot** — mergeFinalHash 写入后调用 `harness_paths.snapshot_change_formal_layer(projectRoot, changeId)`，备份到主仓 `.harness/cache/change-snapshots/<change>/`（不得写在 feature worktree 内）
M7. **ledger + 收尾** — 经 `harness_ledger.py record` 写入 `mergeFinalHash`（= journal `pushedHead`）；**`harness_gate.py close --phase merge`**（禁止手工 phase.end）；提示 `/harness-archive`

> Ledger v3（v2 契约 / split-v1 布局起）：`record` 强制顶层身份（`schemaVersion=3/repositoryId/baseCommit/currentHead/diffHash/ownershipHash`，缺失非零退出、`LEDGER_IDENTITY_INVALID`，不写账本）与 typed metrics；legacy 契约行为不变。详见 `../protocols/ledger-protocol.md` 第十节。

正常路径**禁止创建、应用或删除仓库级 stash**。中断恢复：`harness_integration.py status` 读 journal，`recover` 从首个未完成步骤续跑；protection refs 只在 push 成功后的 cleanup 删除。

**失败 txn 回收（abandon）**：verify/push 未成功且 remote 不含 mergeCommit 时，运行 `harness_integration.py abandon --change … --run-id …`：清理 integrationRoot / temp branch / protection refs / lock；**绝不删除 feature worktree**。push 已成功或 remote 已含 merge → `ABANDON_REFUSED`，改走 cleanup。

**清 feature worktree 迁根硬门槛（H-1/H-2）**：删除 feature worktree 前，若 Agent root / cwd 落在待删路径内，必须先 `move_agent_to_root(projectRoot)`（目标为主仓已存在的 `main`/`master`；**禁止**为迁根去 fetch 已删除的 feature 分支）。迁根失败 → **拒绝删除**。清理前调用 `harness_paths.assert_cleanup_safe(cleanupRoot, stateRoots, archiveRoots)`；state/archive（含 junction/symlink 解析后）落在 cleanup 内 → `CLEANUP_TOPOLOGY_REFUSED`。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 细则见 `checklist.md`、`reference.md` 与各 protocol。

### 一、提交方式固定三选项（主目录）

commit+push / 仅本地 commit / 取消；**不调用 Superpowers 呈现 PR/丢弃选项**。

### 二、中文 commit 永远用文件

`.harness/changes/<change>/runtime/commit-message.txt` + `git commit -F`；禁止 amend 英文、禁止 `--no-verify`、禁止 AI footer。

### 三、.gitignore / 远程新提交 / ledger 复用

见 `checklist.md` 与 `../protocols/ledger-protocol.md`、`../protocols/submit-protocol.md`。

test-tracking manifest 是 ignored test 的唯一强制暂存授权：只允许 `harness_test_guard.py stage` 暂存 manifest 中已校验且相对 `HEAD` 仍有差异的路径，禁止 `git add -f .`、目录级 `git add -f` 或全局修改 `.gitignore`。worktree commit 前须确认 guard 返回的 `files` 全部进入 cached diff；manifest 中已由 `HEAD` 跟踪且未变化的历史条目允许保留而不进入本次 cached diff。合并回主分支后、删除 worktree 前仍须确认 manifest 路径已由目标 commit 跟踪，否则停止清理。

### 四、worktree 合并硬规则

- **push 只在主分支**；worktree 分支不 push
- **`git merge --no-ff` 固定**；禁止 fast-forward
- **冲突不自动解** → 停下 → 用户手动解 → 确认后继续
- **`mergeFinalHash`** = 主分支 push 后 HEAD；archive 优先读此字段
- **迁根后再删 feature WT**：Agent 仍在待删 root 内则拒绝删除；目标分支已删时切主仓 `main`/`master`，禁止强行 fetch
- **snapshot 后再清**：正式层已写入 `.harness/cache/change-snapshots/<change>/`
- **拓扑安全**：`assert_cleanup_safe` 拒绝 state/archive ⊆ cleanup（含 junction）
- **abandon ≠ cleanup**：仅失败 txn；永不删 feature worktree

### 五、Shell 安全 / 敏感信息 / 证据化

git 经 PowerShell；commit/报告不得含明文密钥。遵循 `../protocols/sensitive-info-protocol.md`、`../protocols/evidence-based-reporting-protocol.md`。

## Submit 决策所有权

确定性 Git 流程；验证基线由 ledger、`git diff --cached`、远端检查与必要构建/测试决定；Superpowers 仅人工参考。

## Output Format

主目录：commit hash、分支、变更统计、archive 建议。worktree：merge commit、push 范围、`mergeFinalHash`、worktree 清理状态、archive 建议。详见 `reference.md`。

## 渐进披露

- **Read `checklist.md`** — 提交流程 + worktree 合并详细步骤
- **Read `reference.md`** — commit 模板、Windows worktree 清理兜底、输出示例

## 交互白名单

本 skill **仅允许**以下 blocking user confirmation；其余默认值 + `decision` 事件：

1. **提交方式 + commit message**（主目录一次确认）；worktree 固定仅本地 commit，仅确认 message
2. **远程有新提交**（push 前）：重新验证 / 停止 push

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`submit`/`merge`
