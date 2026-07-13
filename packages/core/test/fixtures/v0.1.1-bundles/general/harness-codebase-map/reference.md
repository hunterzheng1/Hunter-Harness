# harness-codebase-map Reference

## 1. 设计来源与迁移边界

`harness-codebase-map` 参考 GSD `map-codebase` 的核心思想：

- 使用多个 mapper focus 分别分析技术栈、架构、质量和风险。
- 输出结构化代码库文档。
- 主流程只收集确认和摘要，降低上下文占用。

但它不是 GSD 原始 skill 的机械复制。

必须移除的旧行为：

| 旧行为 | 新行为 |
|---|---|
| 输出到 `.planning/codebase/` | 输出到 `.harness/codebase/map/` |
| 自动 commit codebase map | 禁止自动 Git 写操作 |
| `gsd-map-codebase` / `gsd-codebase-mapper` 命名 | `harness-codebase-map` / harness mapper focus |
| GSD query intel | 不纳入本 skill MVP |
| 依赖 GSD runtime | 不依赖，作为 hunter-harness 自有能力 |

## 2. 输出文档职责

| 文档 | document_type | Focus | 作用 |
|---|---|---|---|
| `STACK.md` | `stack` | tech | 技术栈、运行时、构建工具、关键依赖 |
| `INTEGRATIONS.md` | `integrations` | tech | 外部系统、数据库、缓存、消息、第三方 API |
| `ARCHITECTURE.md` | `architecture` | arch | 架构模式、分层、模块边界、数据流 |
| `STRUCTURE.md` | `structure` | arch | 目录结构、关键文件位置、新代码应放哪里 |
| `CONVENTIONS.md` | `conventions` | quality | 命名、编码风格、错误处理、日志、配置约定 |
| `TESTING.md` | `testing` | quality | 测试框架、测试目录、运行方式、mock 和覆盖策略 |
| `CONCERNS.md` | `concerns` | concerns | 风险、技术债、易错点、安全与迁移关注点 |
| `map-summary.md` | `map-summary` | summary | AI 快速阅读入口，汇总代码库地图核心结论 |
| `map-manifest.json` | `map-manifest` | metadata | 工具和 sync 使用的文档清单、hash、stale policy |

## 2.1 模板文件规则

`templates/` 中的模板是可直接落地的目标文件骨架，不是说明型代码块。

- 生成 `STACK.md` 等 7 个主文档时，直接使用同名模板结构。
- 生成 `.harness/codebase/map-summary.md` 时，使用 `templates/map-summary.md`。
- 生成 `.harness/codebase/map-manifest.json` 时，参考 `templates/map-manifest.schema.json`。
- 不得把 `# xxx Template`、外层 ```markdown 代码块或模板说明文字复制到最终产物中。

## 3. 模式与刷新范围

### full / --refresh

刷新全部 7 个文档，适合首次生成或大型变更后使用。

### --fast

刷新：

```text
STACK.md
STRUCTURE.md
CONCERNS.md
```

适合依赖、目录、风险轻量更新。

### --focus tech

刷新：

```text
STACK.md
INTEGRATIONS.md
```

### --focus arch

刷新：

```text
ARCHITECTURE.md
STRUCTURE.md
```

### --focus quality

刷新：

```text
CONVENTIONS.md
TESTING.md
```

### --focus concerns

刷新：

```text
CONCERNS.md
```

### --paths

增量扫描指定路径。

安全规则：

- 只允许 repo-relative path。
- 禁止 `..`。
- 禁止 `/` 开头或 Windows drive absolute path。
- 禁止 shell 元字符：`;`、`` ` ``、`$`、`&`、`|`、`<`、`>`。
- 路径值只作为扫描范围，不直接拼接到 shell 命令。

Git 只允许只读查询：`status`、`diff --name-only`、`rev-parse`。禁止 `add`、`commit`、`pull`、`merge`、`push`、`reset`、`checkout`、`rebase`、`clean` 等写入或改变工作区状态的操作。

## 4. Mapper Agent Prompt Contract

并行 agent 可使用以下任务格式。

### Tech Mapper

```text
你是 harness-codebase-map 的 tech mapper。

目标：分析当前项目的技术栈和外部集成。

范围：<full repo or path scope>

必须直接写入：
- .harness/codebase/map/STACK.md
- .harness/codebase/map/INTEGRATIONS.md

要求：
- 使用 templates/STACK.md 和 templates/INTEGRATIONS.md 的结构。
- 包含实际文件路径。
- 不输出明文敏感信息。
- 不执行 Git 写操作。
- 完成后只返回文件路径、行数、warnings。
```

### Arch Mapper

```text
你是 harness-codebase-map 的 arch mapper。

目标：分析当前项目的架构模式、模块边界和物理目录结构。

必须直接写入：
- .harness/codebase/map/ARCHITECTURE.md
- .harness/codebase/map/STRUCTURE.md
```

### Quality Mapper

```text
你是 harness-codebase-map 的 quality mapper。

目标：分析编码约定、测试框架、测试组织方式和验证命令。

必须直接写入：
- .harness/codebase/map/CONVENTIONS.md
- .harness/codebase/map/TESTING.md
```

### Concerns Mapper

```text
你是 harness-codebase-map 的 concerns mapper。

目标：分析风险、技术债、易错点、安全注意事项和后续开发关注点。

必须直接写入：
- .harness/codebase/map/CONCERNS.md
```

## 5. Manifest Schema

`map-manifest.json` 建议结构：

```json
{
  "schema_version": 1,
  "generator": "harness-codebase-map",
  "generated_at": "YYYY-MM-DD HH:mm:ss",
  "mode": "full",
  "profile": "general",
  "project_root": ".",
  "last_mapped_commit": "unknown",
  "path_scope": {
    "type": "full",
    "paths": []
  },
  "documents": [
    {
      "document_type": "stack",
      "path": ".harness/codebase/map/STACK.md",
      "sha256": "sha256:<hash>",
      "line_count": 120,
      "focus": "tech",
      "status": "generated"
    }
  ],
  "summary": {
    "path": ".harness/codebase/map-summary.md",
    "sha256": "sha256:<hash>",
    "line_count": 60
  },
  "warnings": [],
  "stale_policy": {
    "max_age_days": 7,
    "changed_files_threshold": 10
  }
}
```

## 6. Summary Template

`map-summary.md` 应简洁，面向 AI 快速加载：

```markdown
# Codebase Map Summary

**Generated At:** YYYY-MM-DD HH:mm
**Mode:** full
**Profile:** <profile>
**Commit:** unknown

## Project Snapshot

<项目一句话说明>

## Key Stack

- Language: ...
- Framework: ...
- Build: ...
- Database: ...

## Main Modules

- `<path>` — <purpose>

## Entry Points

- `<path>` — <purpose>

## Testing

- Command: ...
- Test location: ...

## Concerns

- ...

## Detailed Documents

- `.harness/codebase/map/STACK.md`
- `.harness/codebase/map/INTEGRATIONS.md`
- `.harness/codebase/map/ARCHITECTURE.md`
- `.harness/codebase/map/STRUCTURE.md`
- `.harness/codebase/map/CONVENTIONS.md`
- `.harness/codebase/map/TESTING.md`
- `.harness/codebase/map/CONCERNS.md`
```

## 7. Freshness / Stale 判断

建议供 `harness-sync` 使用的判断规则：

| 条件 | 判定 | 状态 | 建议 |
|---|---|---|---|
| map 不存在 | missing | ❌FAIL(未生成) | 建议运行 full |
| 7 个文档缺失 | incomplete | 🟡WARN(不完整) | 建议运行 full |
| manifest 不存在 | unknown | 🟡WARN(元数据未知) | 建议运行 full 或 status 修复 |
| 超过 7 天且变更文件 > 10 | stale | 🟡WARN(过期) | 建议运行 full 或 focus |
| 超过 7 天且变更文件 ≤ 10 | aging | 🟡WARN(老化) | 可暂缓，提示用户 |
| 关键配置变化 | stale | 🟡WARN(过期) | 建议 focus tech |
| 目录结构变化明显 | stale | 🟡WARN(过期) | 建议 focus arch |
| 测试目录/依赖变化 | stale | 🟡WARN(过期) | 建议 focus quality |

关键配置包括：

```text
pom.xml
build.gradle
package.json
pnpm-lock.yaml
yarn.lock
requirements.txt
pyproject.toml
Dockerfile
docker-compose.yml
application*.yml
application*.properties
```

## 8. 敏感信息处理

禁止写入：

- token
- password
- secret
- Authorization header
- Cookie
- API key
- 私钥
- 真实生产账号密码

允许写入脱敏描述：

```text
配置文件 `<path>` 中存在数据库连接配置，敏感字段已脱敏。
```

## 9. CodeGraph 边界

代码探索优先使用 CodeGraph MCP 工具（`mcp__codegraph__codegraph_explore` 等）；MCP 不可用时降级为 Glob/Grep 手动定位，并标注降级。`npx hunter-harness` 初始化阶段可检查 CodeGraph 是否安装，但不作为运行时探索手段。

本 skill：

- 不检查 CodeGraph 安装状态。
- 不触发 CodeGraph sync。
- 不修改 `.codegraph/`。
- 不上传 `.codegraph/`。

mapper 优先通过 CodeGraph MCP 探索代码；不得把本 skill 的成功建立在 CodeGraph 必须可用上——MCP 不可用时降级为 Glob/Grep 并标注降级。

## 10. 报告模板

```markdown
# harness-codebase-map Report

**Time:** YYYY-MM-DD HH:mm
**Mode:** full
**Scope:** full repo
**Status:** ✅OK

## Outputs

| Document | Path | Lines | Status |
|---|---|---:|---|
| STACK | `.harness/codebase/map/STACK.md` | 120 | generated |

## Manifest

- `.harness/codebase/map-manifest.json`

## Summary

- `.harness/codebase/map-summary.md`

## Context Index

updated / skipped / failed

## Warnings

- none

## Evidence

- All output files readable.
- Manifest JSON readable.
- Document hashes calculated.
```
