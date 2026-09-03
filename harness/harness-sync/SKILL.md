---
name: harness-sync
description: "Use when the user asks to synchronize, refresh, or validate Harness metadata, adapters, remote knowledge ownership, instruction entrypoints, config origins, or CodeGraph status."
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

通过一个有界入口刷新 Harness Adapter 与元数据、检查远端知识职责和项目指令状态，并在当前命令输出中给出组件结果。`sync` 是维护命令，不是 change 生命周期阶段：不追加 change 事件、不上传运行监控。`sync` 不直接改写 AGENTS/CLAUDE/CODEBUDDY 或规则；文档优化使用远端审计提案。

## Before running

读取 `reference.md`。`sync` 自身会在任何重操作之前完成能力握手；不要另起一个
`capabilities` 进程。工作流要求 `sync@2`、`rules-sync@1`、`rules-review@1`、
`knowledge-sync@3`、`codegraph-status@2`。`BLOCKED_CAPABILITY_MISMATCH` 属环境阻塞，
不得降级为手工拼接旧流程。

## Run

```powershell
npx hunter-harness sync --project <项目路径> --profile interactive --progress jsonl --json
```

CLI 负责 Python runtime 解析、Adapter 事务、远端知识职责、文档审计提示、map、指令图、配置来源、change 状态及 CodeGraph 证据汇总。禁止直接调用旧知识 Python 脚本，禁止使用固定 `HEAD~5`，禁止自动全量重建 CodeGraph。

只读诊断使用 `--check`（`--dry-run` 为兼容别名）；它不得写 receipt 或投影。普通模式只允许执行用户请求的 Adapter 事务，不写入 `.harness/runtime/sync/`。长阶段的 heartbeat 写 stderr；stdout 只保留紧凑摘要。需要组件级证据时显式加 `--verbose`；`reportPath` 和 `reportSha256` 固定为 `null`。

摘要中的 `remediations[]` 是稳定修复契约。先用对应 `previewCommand` 预览；低风险修复用
`--apply safe`，指定修复用 `--fix <id>`。需覆盖受管投影的修复必须同时提供 `--yes`，
并依赖 refresh 事务留下的 before snapshot；不允许绕过确认或无备份覆盖。指定修复时，
无关组件只做只读评估，不得顺带写入。

## Interpret

- `OK`：所有可验证组件通过。
- `ADVISORY`：例如需要运行中文指令审计提案；退出码仍为 0，且 `sync` 本身没有改写文档。`CODEGRAPH_SERVICE_UNREACHABLE` 也属此级：daemon 未运行时索引仍可正常查询（CLI/MCP 直读数据库），仅增量自动同步暂停，不需要按 WARN 修复。
- `WARN`：存在过期、冲突、待评审或 `UNKNOWN` 证据；按组件的中文 `nextAction` 处理。
- `FAIL`：组件执行失败；不得宣称同步完成。
- `BLOCKED`：runtime、项目状态或能力契约阻塞；先修复阻塞条件。
- `UNKNOWN`：证据不足，不等于成功，也不触发无界重建。

非交互或 CI 使用 `--check --profile general --progress jsonl --json`。交互式运行若报告 `INSTRUCTION_AUDIT_REQUIRED`，运行 `hunter-harness instructions audit`；规则候选只进入提案，永不自动应用。

## 交互后续动作

交互式宿主支持选择器时，必须使用**多选复选框**，保持用户熟悉的勾选形式；只显示与本次非 OK 组件对应的选项，再附加“保持现状”。不要改成自由输入或普通编号问答。选项标题和说明优先使用通俗中文，机器原因码只放在技术详情中。

- **生成 Codebase Map**：仅在 `codebase-map` 缺失或过期时显示。说明它会扫描项目的技术栈、外部集成、架构、目录结构、编码约定、测试方式和风险，生成 `.harness/codebase/map/` 下的 `STACK.md`、`INTEGRATIONS.md`、`ARCHITECTURE.md`、`STRUCTURE.md`、`CONVENTIONS.md`、`TESTING.md`、`CONCERNS.md`，以及 `map-summary.md` 和 `map-manifest.json`；不会修改源码。
- **运行指令审计**：仅在 `rules` 需要审计时显示。说明服务端会结合项目类型、现有指令文档、Codebase Map 和近期变更生成中文优化提案，不会直接修改项目文档；用户审阅后才可显式应用。
- **检查 CodeGraph 后台同步**：仅在 watcher 未验证、停用或存在待同步源码时显示。若索引可用且待同步数为 0，应说明当前查询仍可用，检查 watcher 只是为了确认后续源码能否自动增量更新。
- **保持现状**：接受本次提示，不执行任何后续动作。

## Safety

同步不得直接修改项目指令文档或规则。配置真源与生成投影存在漂移时只报告，不静默覆盖真源。change 清理先 dry-run，仅对已验证归档收据执行安全清理。知识查询和 ingest 均为远端职责，不创建 `.harness/knowledge`。

无论结果如何，`sync` 都不写持久同步报告、不追加 change 事件，也不上传监控；组件详情仅存在于本次 stdout。Adapter 事务本身的必要备份和回滚证据不属于 sync 日志，不得因此禁用。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]
