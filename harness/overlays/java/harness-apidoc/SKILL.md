---
name: harness-apidoc
description: "从 Java 后端代码生成结构化前端 API 文档（Controller/VO/ErrorCode）。使用场景：接口文档、前端接口文档、API 文档生成"
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

# harness-apidoc — 前端接口文档（Java overlay）

## Purpose

基于 Controller、VO、ErrorCode 生成结构化前端接口文档（增量 + 全量）。

## When to Use

- 新功能完成需出接口文档
- 触发语："接口文档""API 文档""写文档给前端"

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow

先用 `harness_change.py resolve [--change] --json` 解析 change；多个 active change 未显式选择时返回 `CHANGE_SELECTION_REQUIRED`。确认存在真实 API diff；无变化时记录跳过，不生成空文档。阶段边界使用 `harness_gate.py begin --phase apidoc --change <id> --task <n> --skills-root <skills-root> --executor-tool <tool> --json` 与 `harness_gate.py close --phase apidoc --change <id> --status <OK|WARN|FAIL> --run-id <begin-run-id> --json`，禁止手工追加阶段事件。

默认输出 40–80 行契约差异摘要，只保留前端动作、变化接口、请求/响应边界、变化的枚举/错误码、兼容性和证据链接；显式 `--full` 才生成完整七章节。文件名使用 `YYYY-MM-DD-<变更语义安全名称>.md`，不以 commit hash 充当标题。

文件名必须由 `harness_apidoc.py filename --description "<做了什么变更>" --json` 生成，避免 Windows 非法字符、超长路径和不可读 hash 文件名。

1. 确定 change-name（Glob plans，读 frontmatter）
2. append `phase.start`
3. 扫描变更涉及 Controller/VO/ErrorCode（CodeGraph 优先）
4. 生成/更新 `reports/apidoc/` 下 Markdown
5. append `artifact` + `phase.end`

## Output

- `.harness/changes/<cn>/reports/apidoc/api-doc-*.md`（或项目约定路径）
- 控制台摘要：新增/变更接口数

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 渐进披露

- **Read `reference.md`** — 文档模板与字段规则
- **Read `checklist.md`** — 逐步勾选

## 交互白名单

**无** AskUserQuestion；缺输入记 `issue`。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`apidoc`
