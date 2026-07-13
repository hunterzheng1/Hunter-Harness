---
description: harness-sync 的10步检查流程详细状态标准和修复动作。仅在执行完整元数据同步时读取。
---

# harness-sync 参考 — 检查流程详情

## 检查流程

### 1. 感知代码变更

用 PowerShell 执行 git 命令（项目路径含中文时必须通过 PowerShell）：

```powershell
powershell.exe -Command "git -C '<项目路径>' log --oneline -10"
powershell.exe -Command "git -C '<项目路径>' diff --stat HEAD~5 2>$null"
```

了解最近变更范围（文件数、模块数），作为判断各组件是否过期的基准。

### 2. CodeGraph 索引

检查索引状态，**优先使用 MCP 工具**（若当前环境提供 `mcp__codegraph__codegraph_status` 则调用）；该工具不可用时**降级**为用 Glob 比对 `.codegraph/` 目录修改时间与最近提交时间。不允许通过普通 Bash 调 codegraph 命令：

| 判断条件 | 状态 | 操作 |
|----------|:----:|------|
| 覆盖率 > 0% 且索引时间在最近提交之后 | ✅OK | 无需操作 |
| 覆盖率 = 0% | ❌FAIL(未初始化) | 通过 PowerShell 执行 `npx @colbymchenry/codegraph && codegraph init --index` |
| 索引时间在最近提交之前 | 🟡WARN(过期) | 同上 |

> 前提：项目构建命令必须已成功。构建失败时先执行 `npx hunter-harness` 初始化检查。
> 若 MCP 工具与 codegraph CLI 均不可用，标记 🟡WARN(CodeGraph 状态无法验证) 并在报告中说明"CodeGraph 状态无法验证，需用户手动确认"。

### 3. harness-codebase-map 分析文档

用 Glob 搜索 `.harness/codebase/map/*` 确认文件是否存在及其修改时间：

| 判断条件 | 状态 | 操作 |
|----------|:----:|------|
| 文件存在且修改时间 < 7 天 | ✅OK | 无需操作 |
| 超过 7 天 + 变更文件 > 10 个 | ❌FAIL(需要重建) | `/harness-codebase-map --fast` |
| 超过 7 天 + 变更文件 ≤ 10 个 | 🟡WARN(可暂缓) | 提示用户，不强制更新 |
| 文件不存在 | ❌FAIL(未初始化) | `/harness-codebase-map` |
| 文件不存在 + CodeGraph 索引已最新 | 🟡WARN(可选) | 提示用户：CodeGraph 已覆盖代码智能，map 属可选重操作，由用户决定是否生成 |

### 4. CLAUDE.md 完整性

用 Read 读取 `CLAUDE.md`（或 `.claude/CLAUDE.md`），检查以下章节：

| 必要章节 | 检测方式 | 缺失影响 |
|----------|----------|----------|
| 技术栈 | Read 后查找技术栈关键词（如框架/语言名称） | AI 可能建议不兼容的库 |
| 构建命令 | Read 后查找 构建/编译 相关描述 | AI 不知道如何编译项目 |
| 代码规范 | Read 后查找 分层/编码规范 相关描述 | AI 可能写出不符合项目约定的代码 |
| 测试约定 | Read 后查找 test/测试/TDD 相关描述 | AI 不知道测试框架和命名规范 |
| 架构约束 | Read 后查找 架构/分层/循环依赖/约束 相关描述 | AI 可能建议违反架构的设计 |
| 行数 ≤ 200 | Read 后估算行数 | 超限 → 与用户确认瘦身策略，拆分到 `.claude/rules/`。含 Skill 工作流说明的可放宽到 300 行 |

**瘦身策略**：如果超过 200 行，不是简单截断——而是把可独立成篇的细节（如完整编码规范、详细架构图）迁移到 `.claude/rules/` 下，CLAUDE.md 保留简洁的索引和关键命令。

> ⚠️ CLAUDE.md 需要瘦身时，必须用 AskUserQuestion 与用户确认拆分方案后再执行。

### 5. AGENTS.md 一致性

检查 `AGENTS.md` 是否引用最新版 CLAUDE.md，是否包含项目概述和规则索引。如果 CLAUDE.md 刚刚更新过，同步更新 AGENTS.md 中的引用描述。

### 6. .harness/ 完整性

检查 `.harness/` 目录结构和配置文件。结构以产品 file-policy（`requirements/.../22-FILE-POLICY-MATRIX`）为准，init 实际产出的核心路径如下：

| 检查项 | 判断条件 | 状态 | 操作 |
|--------|----------|:----:|------|
| 项目配置 | `.harness/project.yaml` 存在（user_editable，保存 project_id/server.url/token_env） | ✅OK | 无需操作 |
| 路由索引 | `.harness/context-index.json` 存在（generated_reviewable） | ✅OK | 无需操作 |
| 知识库 | `.harness/knowledge/index.json` 存在（user_editable） | ✅OK | 无需操作 |
| state 目录 | `.harness/state/baseline/` 存在（internal_state） | ✅OK | 无需操作 |
| codebase map | `.harness/codebase/map/` 状态 | — | 见第 3 步 |
| 整体缺失 | `project.yaml` 与 `context-index.json` 均不存在 | ❌FAIL(未初始化) | 执行 `hunter-harness init`（见下方风险规程） |
| .gitignore 选择性跟踪 | 未整条忽略 `.harness/`：user_editable（project.yaml/knowledge/）、generated_reviewable（codebase/map）多需跟踪；internal_state（state/）、generated_cache（cache/、generated/、reports/）不跟踪 | ✅OK | 无需操作 |
| .gitignore 整体忽略 | `.gitignore` 含整条 `.harness/` | 🟡WARN(过度忽略) | 提示按 file-policy 拆分跟踪策略，而非整体忽略 |

> ⚠️ **`hunter-harness init` 风险规程**（`.harness/` 未初始化时触发）：
> 1. **预览**：`node packages/cli/dist/bin.js --non-interactive --dry-run --adapter claude-code --profile general --json`，确认将写入的路径清单与 `project_id`（`null` = 未绑服务器，本地自治理）。
> 2. **备份**：将 `.claude/skills/`（尤其 `harness-*/SKILL.md`）、`CLAUDE.md`、`AGENTS.md` 复制到 `$env:TEMP/hh-init-backup-<时间戳>`。`.claude/` 若被 gitignore，被覆盖文件无 git 兜底，备份是唯一恢复途径。
> 3. **执行**：`init --yes` 写入预览路径。
> 4. **恢复**：逐个比对 `.claude/skills/harness-*/SKILL.md` 与备份；被覆盖的从备份恢复，新增 skill（如 `harness-knowledge-ingest`、`harness-skill-optimizer`）保留。
> 5. **验证**：`.harness/project.yaml`、`context-index.json` 就位；`CLAUDE.md`/`AGENTS.md` 的 managed block 为增量插入（原内容保留）。
>
> file-policy 备注：`.harness/changes/**`（user_editable，push/update=never，本地工作材料）、`.harness/rules/**`（internal_state，本地默认不创建）都不作为完整性判断标志；旧文本的 `.harness/config/harness-test-config.md` 路径在产品中不存在，勿作检查项。

### 7. .claude/rules/ 完整性

用 Glob 搜索 `.claude/rules/*.md`，检查是否覆盖 5 个必要主题：

| 必要主题 | 检测方式 | 缺失影响 |
|----------|----------|----------|
| 架构规范 | 查找 framework/patterns/架构 相关文件 | AI 可能写出违反分层的代码 |
| 编码规范 | 查找 coding-style/standards 相关文件 | AI 可能使用不一致的命名和注解 |
| 数据库安全 | 查找 database-safety/sql 相关文件 | AI 可能执行危险的 DDL 操作 |
| 测试约定 | 查找 test/validation/tdd 相关文件 | AI 可能不知道测试框架和命名规范 |
| Git 提交 | 查找 git-commit/commit 相关文件 | AI 可能跳过确认直接提交 |

> 缺失主题只提示用户补充，不自动创建规则文件。

### 8. 构建配置健康度

用 Read 读取项目构建配置文件（如 `.mvn/maven.config` 等）：

| 检查项 | 判断条件 | 状态 | 操作 |
|--------|----------|:----:|------|
| 离线模式 | 包含 `-o` | 🟡WARN(离线模式) | 提示"离线模式可能导致依赖未缓存时构建失败，建议在 CLAUDE.md 中说明降级方案" |
| settings 文件 | 包含 `-s` | ✅OK | 无需操作 |
| 内容为空 | 无任何配置 | 🟡WARN(配置为空) | 提示"构建配置为空，可能缺少必要设置" |

### 9. 测试基础设施

用 Glob 搜索各模块的测试目录：

| 判断条件 | 状态 | 操作 |
|----------|:----:|------|
| 模块有测试目录且含测试文件 | ✅OK | 无需操作 |
| 模块有测试目录但无测试文件 | 🟡WARN(测试为空) | 提示"模块 X 测试目录为空，建议创建 SmokeTest" |
| 模块无测试目录 | 🟡WARN(无测试目录) | 提示"模块 X 无测试目录，TDD 将降级为静态验证" |

> 只检查有构建文件的业务模块，跳过 `*-client`、`*-sdk` 等纯接口模块。

## 输出示例

```markdown
## 元数据同步报告 — `<service-module>`

| 组件 | 状态 | 操作 |
|------|:----:|------|
| CodeGraph | 🟡WARN(索引过期) | 索引已过期（上次: 3天前，最近提交: 今天），已重新索引 |
| harness-codebase-map (.harness/codebase/map/) | ✅OK | 2 天前更新，变更量 5 个文件，无需更新 |
| CLAUDE.md | ✅OK | 180 行，6 个必要章节完整 |
| AGENTS.md | ✅OK | 已正确引用 CLAUDE.md |
| .harness/ | ✅OK | config 目录存在，1 个变更目录（contribution-module） |

### 自动更新
- CodeGraph 索引已重建，覆盖率 92%
```

## 关键原则

- 先看 git log 了解变更量，再决定是否需要重建各组件（避免盲目全量重建）
- CodeGraph 索引依赖编译产物，确保构建命令先通过
- harness-codebase-map 和 Repomix 不要同时触发（两者都会产生大量上下文，叠加可能导致 API 输入超限）
- CLAUDE.md 瘦身时，拆分到 `.claude/rules/` 的文件必须有正确的 YAML frontmatter（含 `paths:` 字段）
- **CLAUDE.md 需要瘦身时必须先与用户确认拆分方案**

## 执行日志记录

harness-sync 默认在控制台报告。检测到未归档变更时向 `events.ndjson` append `phase.start` / `phase.end` / `decision` / `issue`（`note` 含 10 项检查摘要）。见 SKILL.md `## 执行日志`。
