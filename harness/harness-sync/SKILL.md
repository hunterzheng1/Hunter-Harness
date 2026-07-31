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

读取 `reference.md`。`sync` 自身会在任何重操作之前完成能力握手；不要另起一个
`capabilities` 进程。工作流要求 `sync@2`、`rules-sync@1`、`rules-review@1`、
`knowledge-sync@3`、`codegraph-status@2`。`BLOCKED_CAPABILITY_MISMATCH` 属环境阻塞，
不得降级为手工拼接旧流程。

## Run

```powershell
npx hunter-harness sync --project <项目路径> --profile interactive --progress jsonl --json
```

CLI 负责 Python runtime 解析、投影事务、knowledge、rules、map、指令图、配置来源、change 状态及 CodeGraph 证据汇总。禁止直接调用内部 Python 脚本，禁止使用固定 `HEAD~5`，禁止自动全量重建 CodeGraph。

只读诊断使用 `--check`（`--dry-run` 为兼容别名）；它不得写报告、receipt 或投影。
长阶段的 heartbeat 写 stderr；stdout 只保留紧凑摘要。完整报告写入摘要中的
`reportPath`，并带 `reportSha256`。需要组件级证据时显式加 `--verbose`，不得默认把完整
JSON 报告回显到对话。

摘要中的 `remediations[]` 是稳定修复契约。先用对应 `previewCommand` 预览；低风险修复用
`--apply safe`，指定修复用 `--fix <id>`。需覆盖受管投影的修复必须同时提供 `--yes`，
并依赖 refresh 事务留下的 before snapshot；不允许绕过确认或无备份覆盖。指定修复时，
无关组件只做只读评估，不得顺带写入。

## Interpret

- `OK`：所有可验证组件通过。
- `ADVISORY`：索引最新，但有待评审候选等非阻塞健康提示；退出码仍为 0。
- `WARN`：存在过期、冲突、待评审或 `UNKNOWN` 证据；按 `reportPath` 中的 `nextAction` 处理。
- `FAIL`：组件执行失败；不得宣称同步完成。
- `BLOCKED`：runtime、项目状态或能力契约阻塞；先修复阻塞条件。
- `UNKNOWN`：证据不足，不等于成功，也不触发无界重建。

非交互或 CI 使用 `--check --profile general --progress jsonl --json`，不得等待规则候选确认。交互式运行若报告规则待评审，再按 `reference.md` 的显式入口处理。

## Safety

同步不得修改 `.harness/state` 或 `.harness/cache` 的内部文件；只通过 CLI 事务写入。配置真源与生成投影存在漂移时只报告，不静默覆盖真源。change 清理先 dry-run，仅对已验证归档收据执行安全清理。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`sync`
