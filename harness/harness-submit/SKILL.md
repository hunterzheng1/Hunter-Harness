---
name: harness-submit
description: "最终提交封装：验证→中文 commit→提交/推送；worktree 模式含 --no-ff 合并回主分支。使用场景：提交代码、commit、push、合并分支、merge to main、完成开发"
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

合并最新代码→最终验证→生成中文 commit→提交/推送；worktree 模式在本地 commit 后**自动接续** `--no-ff` 合并回主分支、push、清理 worktree，完成开发闭环。

## When to Use

- 代码开发完成，准备提交
- 用户说「提交代码」「commit」「push」「完成开发」
- worktree 模式：用户说「合并分支」「merge to main」「合入主分支」「/harness-merge」（别名，从合并阶段重入亦可）
- review 和 test 已通过或已明确跳过

> **主目录模式**（`worktree.json` requested=false）：commit+push 主分支后直接 `/harness-archive`。**worktree 模式**（requested=true）：worktree 内仅本地 commit，随后本 skill 自动执行合并流程；**push 只在主分支发生一次**。

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

0. **启动准备** — `harness_change.py resolve` 确定变更名；**`harness_gate.py begin --phase submit --change <id>`**；读 ledger，以 `harness_ledger.py diff-hash --repo . --base <baseCommit> --change-dir ".harness/changes/<change-name>" --json` 计算 diffHash + post-test 7 类分类（禁止手写 ledger / 手工 phase.end）
1. **合并最新代码** — 主目录与 worktree 均**不在业务工作区 stash/pull**；远端同步由合并段 integration transaction 在隔离 integration worktree 内完成（见「worktree 合并流程」）；**正常路径禁止 `git stash` / `stash pop`**
2. **最终验证** — ledger 复用优先；**提交前最终门禁只调 `can-reuse`**（删除与 coverage 冲突的二次全量门禁）：`harness_ledger.py can-reuse --verification unitTestFull --scope module --project . --profile-input unitTestFull --command <resolved commands.unitTestFull.command>`。`--command` **按 profile key resolve**：读 `build-profile.json` 的 `commands.unitTestFull.command`（v2），或 `harness_profile.py resolve --project . --key unitTestFull --json` 取 resolved command，**不复制示例模块名**（文档示例只展示 key）。`--profile-input unitTestFull` 从 `verificationInputs.unitTestFull`（v2 由 `commands.unitTestFull.inputs` 派生）展开依赖闭包，**禁止用仅含 staged 文件的 `--files` 快捷方式**冒充全量闭包。`reuse=true` → 不再执行二次全量测试；仅 `reuse=false` 时执行**同一 resolved verification**（profile `unitTestFull` 命令），成功后用同一文件集、command、`scope=module` 经 **`harness_ledger.py record`** 写回 ledger `unitTestFull` 项。增量 `unitTest` 永远不能冒充 `unitTestFull` 门禁。
3. **.gitignore + 精确暂存** ⚠️ — 检查 `.harness/` 在 `.gitignore`；**禁止 `git add -A`**。若存在 `evidence/test-tracking.json`，先执行 `python <skills-root>/scripts/harness_test_guard.py stage --project . --change-dir ".harness/changes/<change-name>" --json`；失败即硬停止。无 manifest 时不使用 `-f`。manifest 之外的文件按精确业务路径正常暂存，**禁止全局 force-add**。
4. **提交方式** — 主目录：AskUserQuestion 三选项（commit+push / 仅本地 / 取消）；**worktree：固定仅本地 commit**
5. **commit-message.txt** ⚠️ — 展示 staged、diff stat、完整中文 message；用户确认
6. **commit / push** — `git commit -F`；主目录按选项 push（push 前 fetch 检查远端）；**worktree：只 commit，记录 local hash**
7. **收尾** — **`harness_gate.py close --phase submit --status ...`**；主目录：可选 worktree 清理 + 提示 `/harness-archive`；**worktree：接续下方合并流程**

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
M7. **ledger + 收尾** — 经 `harness_ledger.py record` 写入 `mergeFinalHash`（= journal `pushedHead`）；**`harness_gate.py close --phase merge`**（禁止手工 phase.end）；提示 `/harness-archive`

正常路径**禁止创建、应用或删除仓库级 stash**。中断恢复：`harness_integration.py status` 读 journal，`recover` 从首个未完成步骤续跑；protection refs 只在 push 成功后的 cleanup 删除。

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

test-tracking manifest 是 ignored test 的唯一强制暂存授权：只允许 `harness_test_guard.py stage` 暂存 manifest 中已校验路径，禁止 `git add -f .`、目录级 `git add -f` 或全局修改 `.gitignore`。worktree commit 前须确认 manifest 路径全部进入 cached diff；合并回主分支后、删除 worktree 前须确认这些路径已由目标 commit 跟踪，否则停止清理。

### 四、worktree 合并硬规则

- **push 只在主分支**；worktree 分支不 push
- **`git merge --no-ff` 固定**；禁止 fast-forward
- **冲突不自动解** → 停下 → 用户手动解 → 确认后继续
- **`mergeFinalHash`** = 主分支 push 后 HEAD；archive 优先读此字段

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

本 skill **仅允许**以下 AskUserQuestion；其余默认值 + `decision` 事件：

1. **提交方式 + commit message**（主目录一次确认）；worktree 固定仅本地 commit，仅确认 message
2. **远程有新提交**（push 前）：重新验证 / 停止 push

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`submit`/`merge`
