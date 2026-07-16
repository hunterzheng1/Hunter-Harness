---
name: harness-package
description: "增量模块打包：拉取最新→编译验证→mvn package→汇总 jar/war。使用场景：打包、package、发版准备"
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

# harness-package — 增量模块打包（Java overlay）

## Purpose

基于 final pushed commit 识别变更模块 → 增量 `mvn package` → 汇总 jar/war 路径与大小。

> 默认时序：`submit → package → archive`。test 已通过且 ledger 有效时可 `-DskipTests`。

## When to Use

- submit 已推送，准备发版打包
- 触发语："打包""package""发版准备"

## 前置条件

- 推荐已完成 `/harness-submit`；`baseCommit` 以 submit 最终 hash 为准
- test 报告存在或 ledger 可复用；读 `meta/worktree.json` 决定 worktree 目录

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow

0. `harness_change.py resolve` → **`harness_gate.py begin --phase package --change <id>`**
1. 读 ledger + build-profile 的 `commands.package`（v2，按 profile key resolve）；验证经 `harness_ledger.py can-reuse` / `record`（禁止手写 ledger）
2. 识别变更模块（git diff + pom 结构）
3. **单次** Maven package lifecycle（spec §3.3 去重，不预先 compile/test）：full test 可复用（`can-reuse unitTestFull=true`）→ 按 `commands.package` resolve 执行一次 skip-tests package；不可复用 → 按 `commands.package` resolve 执行一次含测试 package
4. 写打包报告 → **`harness_gate.py close --phase package --status ...`**（禁止手工 phase.end）

> `MISSING_V2_FIELDS` 时必须重新 `record`/执行验证，禁止用自然语言绕过。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 渐进披露

- **Read `reference.md`** — 模块识别与报告格式
- **Read `checklist.md`** — 逐步勾选

## 交互白名单

**无** AskUserQuestion；冲突/失败记 `issue`/`decision`。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`package`
