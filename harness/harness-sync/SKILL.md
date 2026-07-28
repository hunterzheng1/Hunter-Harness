---
name: harness-sync
description: "Use when the user asks to synchronize, refresh, or validate Harness metadata, adapters, knowledge, rules, instruction entrypoints, config origins, or CodeGraph status."
argument-hint: "项目路径或留空使用当前目录"
effort: medium
allowed-tools: [Read, Glob, Grep, Edit, Write, Bash(powershell.exe:*)]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
---

# harness-sync

## Purpose

通过一个有界入口同步 Harness 投影、知识、公共规则和元数据，并输出可验证的组件收据。

## Before running

读取 `reference.md`。先执行只读能力握手；若最低 CLI 版本或任一必需能力不满足，立即停止，不得先运行 knowledge、refresh 或其他重操作：

```powershell
npx hunter-harness capabilities --json
```

工作流要求 `sync@1`、`rules-sync@1`、`rules-review@1`、`knowledge-sync@2`。`BLOCKED_CAPABILITY_MISMATCH` 属环境阻塞，不得降级为手工拼接旧流程。

## Run

```powershell
npx hunter-harness sync --project <项目路径> --profile interactive --progress jsonl --json
```

CLI 负责 Python runtime 解析、投影事务、knowledge、rules、map、指令图、配置来源、change 状态及 CodeGraph 证据汇总。禁止直接调用内部 Python 脚本，禁止使用固定 `HEAD~5`，禁止自动全量重建 CodeGraph。

长阶段的 heartbeat 写 stderr；stdout 只保留紧凑摘要。完整报告写入摘要中的 `reportPath`，并带 `reportSha256`。不得把完整 JSON 报告直接回显到对话。

## Interpret

- `OK`：所有可验证组件通过。
- `WARN`：存在过期、冲突、待评审或 `UNKNOWN` 证据；按 `reportPath` 中的 `nextAction` 处理。
- `FAIL`：组件执行失败；不得宣称同步完成。
- `BLOCKED`：runtime、项目状态或能力契约阻塞；先修复阻塞条件。
- `UNKNOWN`：证据不足，不等于成功，也不触发无界重建。

非交互或 CI 使用 `--profile general --progress jsonl --json`，不得等待规则候选确认。交互式运行若报告规则待评审，再按 `reference.md` 的显式入口处理。

## Safety

同步不得修改 `.harness/state` 或 `.harness/cache` 的内部文件；只通过 CLI 事务写入。配置真源与生成投影存在漂移时只报告，不静默覆盖真源。change 清理先 dry-run，仅对已验证归档收据执行安全清理。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`sync`
