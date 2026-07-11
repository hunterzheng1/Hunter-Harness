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
