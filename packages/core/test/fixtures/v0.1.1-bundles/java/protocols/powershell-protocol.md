---
description: harness 全流程的 Windows/中文路径命令执行协议。所有 skill 在需要 git/构建命令/node/文件系统命令时按本协议执行。由原 harness-plan/shell-safety.md 合并而来。
---

# PowerShell Protocol

> 本协议适用于所有 harness-skills（sync/codebase-map/plan/run/test/review/submit/archive）。Windows 中文路径项目中，Bash 工具会被 hook 拒绝（返回 `Denied: non-ASCII path in Bash`），且 Bash 在中文路径下经常超时。统一通过 `powershell.exe -NoProfile -Command "..."` 执行，规避路径编码问题。

## 1. PowerShell-first 自动重试策略

Claude **必须默认使用 PowerShell** 执行 git/构建命令/系统命令，不应先尝试普通 Bash。

正确策略：

1. **优先直接使用 PowerShell**：`powershell.exe -NoProfile -Command "<命令>"`
2. 如果 Claude 意外使用了普通 Bash，并出现以下任一输出：
   - `PreToolUse:Bash hook error`
   - `Denied: non-ASCII path in Bash`
   - `Use Write/Edit/PowerShell instead`
3. **必须立即自动改用等价 PowerShell 命令重试一次**——不得中断流程，也不得推断成功
4. 只有 PowerShell 重试也失败、被拒绝、超时、无有效输出、或 exit code 非 0，才停止当前阶段
5. 停止时不得宣称成功，必须标记为 ❌FAIL 或 🟡WARN(状态未知)

```
❌ 错误：先尝试普通 Bash，被拒绝后中断流程并宣称"工作区干净"
git status --porcelain  → 被拒 → 输出"工作区干净" ← 禁止

✅ 正确：直接使用 PowerShell，或被拒后自动重试
powershell.exe -NoProfile -Command "git -C '<项目路径>' status --porcelain"
```

只有 PowerShell 命令也失败时，才停止当前阶段并请求用户介入。

## 2. 统一模板

```powershell
powershell.exe -NoProfile -Command "<command>"
```

复杂命令优先写成临时 `.ps1`，再执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".harness/changes/<change>/runtime/<script>.ps1"
```

## 3. 禁止普通 Bash

如果当前路径包含中文、空格、非 ASCII 字符，或项目位于 Windows 路径（如 `C:\...`），**禁止使用普通 Bash 执行以下命令**：

- `git`（任何子命令：log、diff、status、stash、pull、push、commit、add、worktree 等）
- 构建命令（按技术栈：`mvn` compile/test/package、`npm` run build/test、`pytest` 等子命令）
- `node`、`curl`
- `mkdir`、`cp`、`mv`、`rm`、`touch`、`cat`、`sed`、`awk`（文件操作）
- `find`、`ls`、`grep`（文件搜索）

禁止 Bash here-doc、Bash command substitution、Bash 管道作为默认执行方式。
禁止因 Bash 中没有 node/构建命令/git 就降级执行器；应改用 PowerShell 绝对路径。

## 4. 优先使用内置工具

文件读写、移动前验证、扫描**优先使用 Claude Code 内置工具**：

| 操作 | 内置工具 | 替代 Bash 命令 |
|------|----------|----------------|
| 读取文件 | `Read` | `cat` |
| 编辑文件 | `Edit` | `sed` |
| 写入文件 | `Write` | `echo >` / `touch` |
| 搜索文件 | `Glob` | `find` / `ls` |
| 搜索内容 | `Grep` | `grep` |
| 创建目录 | `Write`（写入目标文件时自动创建） | `mkdir -p` |
| 移动文件 | `Read` + `Write` + 验证 | `mv` / `cp` |

## 5. Git/构建命令 通过 PowerShell 执行

所有 git/构建命令必须通过 `Bash(powershell.exe:*)` 调用 PowerShell 执行：

```powershell
# Git 命令示例
powershell.exe -NoProfile -Command "git -C 'C:\CQ_PROJECT\贡献积分管理系统\udp' status"
powershell.exe -NoProfile -Command "git -C 'C:\CQ_PROJECT\贡献积分管理系统\udp' diff --name-only"
powershell.exe -NoProfile -Command "git -C 'C:\CQ_PROJECT\贡献积分管理系统\udp' log --oneline -10"

# 构建命令示例（按技术栈；Java=mvn，前端=npm，Python=pytest）
powershell.exe -NoProfile -Command "mvn compile -pl <module> -o -q"
powershell.exe -NoProfile -Command "npm --prefix <module> run build"
powershell.exe -NoProfile -Command "pytest <module>"
```

> **路径引用**：PowerShell 中路径必须用单引号或双引号包裹，避免中文路径解析错误。使用 `git -C "<路径>"` 指定项目目录。

## 6. PowerShell 调用被拒绝时的处理

如果 `powershell.exe` 或 `pwsh` 调用被 hook 拒绝，或返回无有效输出：

- **必须停止当前阶段**，标记为 ❌FAIL 或 🟡WARN，不得宣称成功
- **不得回退到普通 Bash**——这是硬性约束，不是建议
- **不得在 PowerShell 重试失败后继续流程**——必须请求用户介入
- 提示格式：`"Shell 命令执行失败：powershell.exe 调用被拒绝或无有效输出。请在终端手动执行：<命令>，完成后告诉我继续。"`

## 7. 失败判定

出现以下任一情况，当前阶段至少 `🟡WARN`，影响关键门禁时必须 `❌FAIL`：

- `PreToolUse:Bash hook error` — **必须立即改用 PowerShell 等价命令重试**
- `Denied: non-ASCII path in Bash` — **必须立即改用 PowerShell 等价命令重试**
- `Denied: non-ASCII path in Bash. Use Write/Edit/PowerShell instead.` — **必须立即改用 PowerShell 等价命令重试**
- `安全分类器暂时不可用` 且命令不可执行
- PowerShell 重试后仍出现上述标志 → ❌FAIL，停止当前阶段
- 非 0 exit code → ❌FAIL
- 无有效 stdout → ❌FAIL（空输出 ≠ 无提交，先怀疑工具问题）
- `internal error` / `timeout` / `Tool result missing` → ❌FAIL

普通 Bash 被拒绝 = 必须 PowerShell 重试，不是成功，也不是最终失败。
PowerShell 重试失败 = 当前阶段失败或未知，必须停止。

## 8. 证据化成功结论

所有"成功"结论必须绑定**明确证据**：

| 结论 | 必须的证据 |
|------|-----------|
| 编译成功 | 构建工具输出包含构建成功证据（Java=`BUILD SUCCESS`；前端/Python 按各自工具成功标志） |
| 拉取成功 | git 输出包含 `Already up to date.` 或实际 pull/push/commit 成功信息 |
| 打包成功 | 构建产物通过 Glob 扫描产物目录实际确认存在（Java=`target/*.jar`；前端=`dist/`；Python=`dist/`） |
| 推送成功 | git push 输出包含 `To <remote>` 和实际推送范围 |
| 测试通过 | 测试命令输出包含测试通过证据（Java=`Tests run: N, Failures: 0`；前端/Python 按各自工具成功标志） |
| exit code 0 | 命令返回 exit code 0 |

> 构建工具的 quiet 模式（如 `mvn -q`）只能写 `exitCode=0，无错误输出`，不得把"无输出"改写成 `BUILD SUCCESS`。

**没有证据 = 不成功。** 如果命令被拒绝、超时、或输出不含成功标志，必须标注"未知"或"失败"，不得推断成功。

## 9. allowed-tools 配置规则

Claude Code 不支持 `PowerShell(...)` 过滤语法，且 `allowed-tools` 不是严格白名单而是免确认通道。所有 skill 的 `allowed-tools` 使用以下策略实现 PowerShell-first：

- **需要执行 git/构建命令的 skill**：`allowed-tools` 含 `Bash(powershell.exe:*)`（免确认通道），`disallowed-tools` 禁 `Bash(git *)`、`Bash(mvn *)`/`Bash(npm *)`/`Bash(pytest *)` 等裸命令（激活期间硬限制）
- **不需要执行 git/构建命令的 skill**：不包含任何 Bash 工具
- **codegraph 命令**：改为 MCP 工具调用（`mcp__codegraph__codegraph_*`），不再通过 Bash 调用
- 不禁止 `Bash(powershell.exe:*)`——这是 PowerShell 调用的免确认通道
- 所有 skill 正文中明确：Windows 或中文路径下，所有 git/构建命令/文件移动命令必须通过 `powershell.exe -NoProfile -Command "..."` 执行

> 真正的强安全边界应结合 `permissions.deny`、`hooks`、`sandbox`；`allowed-tools`/`disallowed-tools` 只做激活期间预批准/限制。

## 10. 各 skill 命令示例统一格式

所有 skill 中的命令示例统一用 PowerShell 格式：

```powershell
# ❌ 旧格式（会被 hook 拒绝）
git stash
git pull origin master
<构建命令> <模块定位参数>  # 例：mvn compile -pl <module> -o -q / npm --prefix <module> run build

# ✅ 新格式（通过 PowerShell 执行）
powershell.exe -NoProfile -Command "git -C '<项目路径>' stash"
powershell.exe -NoProfile -Command "git -C '<项目路径>' pull origin <upstream-branch>"
powershell.exe -NoProfile -Command "<构建命令> <模块定位参数>"  # 例：mvn compile -pl <module> -o -q
```

> 注意：构建命令（如 mvn）在 PowerShell 中通常不需要特殊处理（不含中文路径参数时可以直接执行），但为保持一致性，仍建议通过 powershell.exe 执行。

## 11. 复杂 PowerShell 命令必须脚本化

简单命令可以使用 `powershell.exe -NoProfile -Command "..."`。

但如果命令包含以下内容，不得内联到 `-Command`：

- `$variable`、`$_`、`$PSVersionTable` 等变量；
- `@{}` hashtable；
- `ForEach-Object` / `Where-Object` / script block `{ ... }`；
- here-string；
- 多管道和 JSON/HTML 大文本拼接。

必须写入 `.harness/changes/<change>/scripts/*.ps1` 后使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".harness/changes/<change>/scripts/<name>.ps1"
```

原因：Claude Code 的 Bash 工具外壳会先处理双引号内容，`$log`、`$_` 这类变量可能被外层 shell 吃掉，导致命令变形。简单命令可以 inline；复杂命令必须 `-File`。
