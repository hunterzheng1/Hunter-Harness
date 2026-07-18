---
name: harness-sync
description: "检查并更新项目AI元数据（CodeGraph索引、harness-codebase-map分析、CLAUDE.md、AGENTS.md、.harness/完整性），确保Claude对代码库的理解与最新代码一致。当用户说'同步/更新索引/刷新元数据/检查一致性'时使用"
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

# harness-sync — 元数据同步

## Purpose

检查并更新 AI 元数据（CodeGraph、codebase map、knowledge 索引、CLAUDE.md、AGENTS.md、`.harness/`），使理解与代码一致。

## When to Use

「同步/更新索引/刷新元数据」、提交前校准、archive/knowledge 变化后。跳过：刚 sync 且无新提交。

## Workflow（薄编排）

运行开始先执行受管 runtime 生命周期：

```powershell
python <skills-root>/scripts/harness_sync.py reap --project . --json
python <skills-root>/scripts/harness_sync.py begin --project . --run-id <run-id> --agent <agent> --purpose harness-sync --json
```

所有 deploy 临时产物只能写入 `begin` 返回的 `workspace`。无论正常完成、命令失败还是异常退出，都必须在 `finally` 中执行：

```powershell
python <skills-root>/scripts/harness_sync.py finalize --project . --run-id <run-id> --json
```

禁止重新使用固定 `sync-deploy-*` 目录；`--keep-temp` 仅供显式诊断。

| Phase | 检查 → 动作 |
|-------|-------------|
| 0 | 读 SKILL + `reference.md` + protocols |
| 1 | git log/diff 感知变更量 |
| 2 | CodeGraph 索引是否需重建 |
| 3 | `.harness/codebase/map/` 是否过期 → 报告建议 `/harness-codebase-map` |
| 3.5 | `harness_knowledge.py sync`；可 `sync --update`；失败不得假装可用。**知识闭环主入口**是 `/harness-knowledge-ingest auto`（含 Agent judge），sync 不重复列人工知识待办 |
| 3.6 | 单次运行 `harness_knowledge.py maintain --project . --drain --json`，有界推进全部 `.harness/knowledge/maintenance-outbox/{pending,failed}`；不得为每个条目重复启动 Python/重建索引（§8.2：archive close 只 enqueue，sync 异步推进 outbox 到 completed/pending-judge） |
| 4 | CLAUDE.md 完整性/行数 → 超限 AskUserQuestion 瘦身 |
| 5 | AGENTS.md 与 CLAUDE.md 一致 |
| 6 | `.harness/` 结构（init 规程 → `reference.md` 第 6 步）；已装 skill 新鲜度只经 `hunter-harness refresh --dry-run --json` 的 post-adaptation freshness 判断，禁止 raw build 字节比较 |
| 7–9 | `项目规则（见 .harness/context-index.json）/`、构建配置、测试目录 — **只提示不自动修复** |

状态判断表格、修复动作、输出示例 → `reference.md`

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则

变更量先行 · CodeGraph 依赖编译产物 · map 与 Repomix 互斥 · CLAUDE 瘦身须用户确认 · Phase 7–9 只提示 · knowledge sync 失败记 WARN/FAIL

## Output Format

各组件状态表格 + 操作摘要 → `reference.md`

## 渐进披露

- **Read `reference.md`** — 10 步详细判定与修复

## 交互白名单

**仅** CLAUDE.md/AGENTS.md 瘦身拆分确认

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`sync`；有未归档变更时写入其 change-dir events
