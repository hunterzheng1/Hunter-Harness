# Codex、Cursor、CodeBuddy Agent 项目格式调研

- 调研日期：2026-07-12
- 范围：项目级 instructions / rules / `AGENTS.md` / skills / hooks / commands、目录、格式、作用域、优先级和最佳实践
- 来源要求：只采用官方文档、官方发布说明或官方源码；没有官方依据的行为一律标为“不确定”
- 目标：为 Hunter Harness 的多 Agent 安装适配器提供可直接实现的事实基线。本文件是研究结论，不是最终产品规格。

## 1. 结论摘要

1. 三者最稳定的跨工具公共层是：根 `AGENTS.md` + Open Agent Skills 风格的 `SKILL.md`。但 CodeBuddy 在存在 `CODEBUDDY.md` 时不会再把 `AGENTS.md` 当主入口；Cursor Skill 还有 `paths`、`disable-model-invocation` 扩展。
2. “rules”不是同一种东西：Cursor Rules 是模型上下文 `.mdc`；CodeBuddy IDE Rules 也是 `.mdc`，但 CodeBuddy CLI Rules 是 `.md`；Codex `.rules` 是沙箱外命令权限策略，不是编码规范。Harness 不得把同一个 `rule` IR 无条件写到三者的 `rules` 目录。
3. Hook 都能执行本地代码，且三者事件名、配置形状、信任模型不同。安装器必须默认不安装 Hook；只有显式选择并展示命令后才安装。
4. CodeBuddy 必须区分 `ide | cli | both`。官方 IDE/CLI 的 Rule 物理格式不一致；`both` 默认只写 `CODEBUDDY.md`、Skills、Commands，避免规则双重注入。
5. 便宜模型实现时不得“猜字段”。只允许使用本文列出的字段；遇到已有未知字段必须保留并报警。

## 2. 能力与落位矩阵

| 能力 | Codex | Cursor | CodeBuddy Code CLI | CodeBuddy IDE |
|---|---|---|---|---|
| 项目主 instructions | `AGENTS.md` / `AGENTS.override.md` | `AGENTS.md`、`.cursor/rules/*.mdc` | `CODEBUDDY.md`；无此文件时回退 `AGENTS.md` | `CODEBUDDY.md`、IDE Rules |
| 项目 Skills | `.agents/skills/<name>/SKILL.md` | `.agents/skills/` 或 `.cursor/skills/` | `.codebuddy/skills/<name>/SKILL.md` | `.codebuddy/skills/<name>/SKILL.md` |
| 项目 Rules | `.codex/rules/*.rules`，仅命令权限 | `.cursor/rules/**/*.mdc`，模型指令 | `.codebuddy/rules/**/*.md` | `.codebuddy/rules/<name>/RULE.mdc` |
| 项目 Hooks | `.codex/hooks.json` 或 `.codex/config.toml` | `.cursor/hooks.json` | `.codebuddy/settings.json` 内 `hooks` | 官方资料不足，不能声称完整等同 CLI |
| 可复用命令 | 推荐 Skill；旧 `~/.codex/prompts/*.md` 已弃用且非项目级 | `.cursor/commands/*.md` | `.codebuddy/commands/**/*.md` | `.codebuddy/commands/**/*.md` |
| 项目配置 | `.codex/config.toml`（仅 trusted repo） | `.cursor/*` | `.codebuddy/settings.json` | `.codebuddy/*` |

## 3. Codex

### 3.1 `AGENTS.md` 发现与优先级（已确认）

Codex 每次启动/会话建立时构造 instruction chain：

1. 全局：`$CODEX_HOME/AGENTS.override.md` 优先于 `$CODEX_HOME/AGENTS.md`，只取第一个非空文件。
2. 项目：从项目根（通常 Git root）走到当前工作目录；每一级依次尝试 `AGENTS.override.md`、`AGENTS.md`、`project_doc_fallback_filenames`，每个目录最多取一个。
3. 合并：根到叶拼接，靠近 cwd 的文件在后，因此覆盖前面的通用指导。
4. 空文件跳过；合并上限由 `project_doc_max_bytes` 控制，默认 32 KiB。
5. `AGENTS.md` 是普通 Markdown，无固定 frontmatter。`/init` 可以生成脚手架。

实现含义：根 `AGENTS.md` 放全仓约束；子目录仅放该子树差异；不要重复整份根文档。Harness 修改既有 `AGENTS.md` 时应使用可识别 managed block，不能覆盖用户内容。

来源：[Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)（访问 2026-07-12）。

### 3.2 Skills（已确认）

项目级首选结构：

```text
.agents/skills/<skill-name>/
├── SKILL.md
├── scripts/       # 可选
├── references/    # 可选
├── assets/        # 可选
└── agents/
    └── openai.yaml # 可选，Codex UI/策略/依赖元数据
```

`SKILL.md` 最小格式：

```yaml
---
name: skill-name
description: Explain what it does and exactly when it should or should not trigger.
---

Imperative workflow with explicit inputs, outputs, and verification.
```

事实：

- `name`、`description` 必需；Skill 通过 `description` 隐式匹配，也可用 `$skill` 或 `/skills` 显式调用。
- Codex 从 cwd 到 repo root 的每个 `.agents/skills` 扫描项目 Skill；还支持 `$HOME/.agents/skills`、`/etc/codex/skills` 和系统内置层。
- 同名 Skill 不合并，可能同时出现在选择器中。因此 Harness 必须把同名视为冲突，而不是依赖“后者覆盖”。
- `agents/openai.yaml` 可配置显示信息、`policy.allow_implicit_invocation` 和工具依赖；跨 Agent 公共 Skill 不应默认生成这个 Codex 专属文件。
- 最佳实践：一项 Skill 只做一件事；除非需要确定性/外部工具，优先 instructions；步骤写清输入输出；用正例/反例测试 `description` 是否正确触发。

来源：[Build skills](https://developers.openai.com/codex/skills)（访问 2026-07-12）。

### 3.3 Codex Rules 不是模型规则（已确认）

`<repo>/.codex/rules/*.rules` 控制“哪些命令可在沙箱外运行”，当前仍标注 experimental。格式是 `prefix_rule(...)`，不是 Markdown/MDC：

```python
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "prompt", # allow | prompt | forbidden
    justification = "Viewing PRs requires approval",
    match = ["gh pr view 123"],
    not_match = ["gh pr --repo org/repo view 123"],
)
```

- trusted repo 才加载项目 `.codex/rules/`。
- 多规则命中时取最严格：`forbidden > prompt > allow`。
- `match` / `not_match` 是加载时内联测试，生成器应始终提供，避免过宽权限。
- 不能把编码规范写入这里；编码规范属于 `AGENTS.md` 或 Skill。

来源：[Rules](https://developers.openai.com/codex/rules)（访问 2026-07-12）。

### 3.4 Hooks（已确认）

位置：`<repo>/.codex/hooks.json` 或同层 `.codex/config.toml` 的 `[hooks]`；项目层仅在 trusted repo 加载。若同层两种表示同时存在，Codex 会合并并警告，故 Harness 每层只选一种。

当前事件包括：`SessionStart`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`。所有匹配来源都会运行；同一事件多个 command hook 并发启动。非托管 Hook 在运行前需要按定义 hash 审阅和信任。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^Bash$",
      "hooks": [{
        "type": "command",
        "command": "python3 path/to/check.py",
        "timeout": 30,
        "statusMessage": "Checking command"
      }]
    }]
  }
}
```

当前只有 `type: "command"` 真正执行；`prompt`、`agent` 虽可解析但会跳过。命令从 session cwd 运行，项目 Hook 应从 git root 解析脚本路径。每个 Hook 从 stdin 接收 JSON、stdout 返回 JSON；`PreToolUse` 可 deny 或改写输入，但官方明确说明它不是完整安全边界。

来源：[Hooks](https://learn.chatgpt.com/docs/hooks)、[Advanced Configuration](https://developers.openai.com/codex/config-advanced#hooks)（访问 2026-07-12）。

### 3.5 Commands（已确认）

项目级可复用工作流应使用 Skill。旧 `~/.codex/prompts/*.md` custom prompts 已弃用、只在用户目录顶层加载、显式调用 `/prompts:<name>`，不能作为 Harness 项目适配目标。不要生成 `.codex/commands/`：官方没有这种项目格式。

来源：[Custom Prompts](https://developers.openai.com/codex/custom-prompts)、[Developer commands](https://developers.openai.com/codex/cli/slash-commands)（访问 2026-07-12）。

## 4. Cursor

### 4.1 Instructions / Rules / `AGENTS.md`（已确认）

Cursor Project Rules 位于 `.cursor/rules/**/*.mdc`。普通 `.md` 在此目录会被忽略。`.mdc` 是 YAML frontmatter + Markdown：

```yaml
---
description: RPC service conventions and patterns for the backend
globs: src/services/**/*.ts
alwaysApply: false
---

- Validate inputs at the service boundary.
```

三字段判定必须按下表实现：

| `alwaysApply` | `description` | `globs` | 行为 |
|---|---|---|---|
| `true` | 任意 | 任意 | 总是注入；其余两字段不参与触发 |
| `false` | 无 | 有 | 匹配文件进入上下文时自动附加 |
| `false` | 有 | 无 | Agent 根据 description 选择 |
| `false` | 无 | 无 | 仅通过 `@rule` 手动引用 |

`AGENTS.md` 是无 frontmatter 的普通 Markdown，官方支持项目根和子目录。适合简单可读指令；子目录文件按目录范围生效。CLI 同时读取项目根 `AGENTS.md`、`CLAUDE.md`，并与 `.cursor/rules` 一起应用。

已知边界：官方文档没有给出 `AGENTS.md`、Project Rules、Team Rules、User Rules 相互冲突时逐字段的完整确定性优先级。因此 Harness 不能承诺某一类一定覆盖另一类；必须在生成阶段检测语义冲突并报警。

最佳实践：规则少而精；小于 500 行；拆成可组合规则；用具体示例/引用文件；避免复制会过期的源码；只有重复出现的错误才沉淀成规则；提交到 Git。

来源：[Rules](https://cursor.com/docs/rules)、[Using Agent in CLI](https://docs.cursor.com/en/cli/using)（访问 2026-07-12）。

### 4.2 Skills（已确认）

Cursor 自动发现以下目录：

- 项目：`.agents/skills/`、`.cursor/skills/`
- 用户：`~/.agents/skills/`、`~/.cursor/skills/`
- 兼容读取：项目/用户 `.claude/skills/`、`.codex/skills/`

结构为 `<root>/<name>/SKILL.md`，可有 `scripts/`、`references/`、`assets/`；Cursor 递归扫描 Skill root。当前 frontmatter：

| 字段 | 必需 | 说明 |
|---|---:|---|
| `name` | 是 | 小写字母、数字、连字符；与父目录同名 |
| `description` | 是 | 做什么、何时使用；Agent 据此选择 |
| `paths` | 否 | glob 字符串或数组；仅在处理匹配文件时暴露 |
| `disable-model-invocation` | 否 | `true` 时只允许 `/skill-name` 显式调用 |
| `metadata` | 否 | 任意映射 |

旧 `globs` 在 Skill 中仍兼容，但新 Skill 应使用 `paths`。嵌套 Skill 已由所在目录隐式限定时，不必再重复 `paths`。脚本应自包含、有明确错误信息并处理边界条件。

跨工具公共 Skill 只生成 `name`、`description` 和正文；`paths` 与 `disable-model-invocation` 放在 Cursor adapter overlay，不能污染 Codex/CodeBuddy canonical 源。

来源：[Agent Skills](https://cursor.com/docs/skills)（访问 2026-07-12）。

### 4.3 Hooks（已确认）

项目位置 `.cursor/hooks.json`，用户位置 `~/.cursor/hooks.json`。所有匹配来源都会执行；发生响应冲突时由更高优先级来源合并裁决。配置版本为 `1`：

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{
      "command": ".cursor/hooks/check.sh",
      "timeout": 30,
      "matcher": "curl|wget",
      "failClosed": true
    }]
  }
}
```

Hook 是子进程，通过 stdin/stdout 交换 JSON。命令 Hook exit `0` 使用 JSON 输出，exit `2` 阻止操作，其他退出码默认 fail-open；安全关键场景可设 `failClosed: true`。事件覆盖 session、subagent、shell、MCP、文件、prompt、compact、stop、agent response/thought、Tab 与 workspace 生命周期。

Cloud Agent 会读取项目 `.cursor/hooks.json`，但早期只读探索轮次不运行 Hook；用户级 Hook 在 Cloud 不可用；Cloud 只支持 command-based Hook。不同 Cursor surface 的事件覆盖并不完全相同，因此 Harness 验证时必须按 IDE/CLI/Cloud 分别标注，不得声称完全一致。

来源：[Hooks](https://cursor.com/docs/hooks)（访问 2026-07-12）。

### 4.4 Commands（已确认）

`.cursor/commands/<name>.md` 是纯 Markdown，输入 `/` 时发现；当前仍是 beta。适合显式、简单的团队快捷流程。若流程需要自动选择、脚本或资源，优先 Skill。

来源：[Commands](https://docs.cursor.com/en/agent/chat/commands)、[Cursor 1.6 changelog](https://cursor.com/changelog/1-6)（访问 2026-07-12）。

## 5. CodeBuddy

### 5.1 产品面必须拆分（已确认）

CodeBuddy 有 CodeBuddy IDE 与 npm 包 `@tencent-ai/codebuddy-code`（CLI）。两者共享 `.codebuddy/` 概念，但 Rules/Hook 规范不完全一致。因此目标类型应为：

```ts
type CodeBuddySurface = "ide" | "cli" | "both";
```

CLI 推荐目录：

```text
CODEBUDDY.md                 # 或 .codebuddy/CODEBUDDY.md
CODEBUDDY.local.md           # 本地私有，不提交
.codebuddy/
├── settings.json
├── settings.local.json      # 本地私有，不提交
├── agents/*.md
├── rules/**/*.md            # CLI
├── skills/<name>/SKILL.md
└── commands/**/*.md
```

来源：[Introduction](https://www.codebuddy.ai/docs/ide/Introduction)、[.codebuddy Directory Structure](https://www.codebuddy.ai/docs/cli/codebuddy-dir)（访问 2026-07-12）。

### 5.2 `CODEBUDDY.md`、`AGENTS.md` 与加载顺序（已确认）

- 有 `CODEBUDDY.md` 时使用它；只有不存在时才回退 `AGENTS.md`。根 `CODEBUDDY.md` 与 `.codebuddy/CODEBUDDY.md` 等价。
- 普通 Markdown，无固定 schema；支持 `@path` 导入，相对/绝对/`~` 路径，最多递归 5 层。
- 子目录 `CODEBUDDY.md` 在操作该子树文件时按需加载。
- CLI 顺序：`~/.codebuddy/CODEBUDDY.md` → 用户 rules → 向上查找的项目 `CODEBUDDY.md` → 当前 cwd 的项目 rules → `CODEBUDDY.local.md` → 按需子目录 `CODEBUDDY.md`。
- 同名 agents / skills / rules 优先级：project > user > plugin。

Harness 不得同时生成内容不同的 `CODEBUDDY.md` 与 `AGENTS.md` 而不告警；否则用户可能误判 `AGENTS.md` 已生效。

来源：[Managing CodeBuddy's Memory](https://www.codebuddy.ai/docs/cli/memory)、[Best Practices](https://www.codebuddy.ai/docs/cli/best-practices)（访问 2026-07-12）。

### 5.3 Rules：IDE/CLI 不兼容点（已确认）

CLI：`.codebuddy/rules/**/*.md`，frontmatter 为：

```yaml
---
enabled: true
alwaysApply: false
paths:
  - "src/api/**/*.ts"
---
```

- `alwaysApply: true` 始终应用。
- `false` + `paths` 为条件规则，在文件工具或 `@file` 命中后注入。
- `false` 且无 `paths` 官方标为不支持，不加载。
- 项目 rules 只从当前 workDir 的 `.codebuddy/rules/` 读取，不向父目录搜索。

IDE：`.codebuddy/rules/<name>/RULE.mdc`，已确认字段示例为 `description`、`alwaysApply`、`enabled`、`updatedAt`、`provider`，支持 Always / Agent Requested / Manual。IDE 文档没有公布三种 UI 类型到所有 frontmatter 字段的完整映射。

安全结论：

- `cli` 才生成 `.codebuddy/rules/<slug>.md`。
- `ide` 才生成 `.codebuddy/rules/<slug>/RULE.mdc`，只写官方确认字段。
- `both` 默认不生成模块化 Rules；核心规则写 `CODEBUDDY.md`。
- 不同时复制同一规则为 `.md` 和 `RULE.mdc`，避免重复注入。

来源：[CLI Memory / Rules](https://www.codebuddy.ai/docs/cli/memory)、[IDE Rules](https://www.codebuddy.ai/docs/zh/ide/User-guide/Rules)、[IDE Context](https://www.codebuddy.ai/docs/ide/User-guide/Context)（访问 2026-07-12）。

### 5.4 Skills（已确认）

共同稳定结构：`.codebuddy/skills/<name>/{SKILL.md,scripts/,references/,assets/}`。CLI 对 `name`/`description` 可缺省，但 IDE 视为必需；Harness 必须按更严格交集始终生成二者。

CLI 还支持 `allowed-tools`、`disable-model-invocation`、`user-invocable`、`context`、`agent`、`model`、`hooks`，以及 `$ARGUMENTS`、`@file`、内联 shell、`${CODEBUDDY_SKILL_DIR}` 等扩展。跨 Agent Skill 默认不得使用这些扩展；只在 CodeBuddy adapter 明确需要时添加。

非内置 Skill/Agent frontmatter Hook 默认不注册，需用户显式设置 `allowUntrustedFrontmatterHooks: true`。Harness 不默认生成带 Hook 的 Skill。

最佳实践：description 同时说明做什么/何时触发；正文祈使句；长文放 references；确定性操作放 scripts；模板放 assets；信息只存一处；Skill body 建议小于 5k words。

来源：[CLI Skills](https://www.codebuddy.ai/docs/cli/skills)、[IDE Skills](https://www.codebuddy.ai/docs/ide/Features/Skills)（访问 2026-07-12）。

### 5.5 Hooks / Commands / Agents（已确认与边界）

CLI Hook 位于 `~/.codebuddy/settings.json`、项目 `.codebuddy/settings.json` 或 `.codebuddy/settings.local.json` 的 `hooks`；不同 scope 加法合并，同事件匹配 Hook 并行。事件 27+，当前为 Beta；matcher 是大小写敏感正则；stdin/stdout JSON；exit `0` 成功、`2` 阻止、其他非阻塞错误。Windows 强制 Git Bash，因此项目 Hook 不得生成 PowerShell/cmd 专属语法。

官方 IDE 资料未提供与 CLI Reference 等价的完整 Hook 契约。故 Harness 只能把 CodeBuddy Hook 标为 `cli` / experimental，并默认关闭。

Commands：`.codebuddy/commands/**/*.md`，子目录映射为冒号命令，例如 `frontend/build.md` → `/frontend:build`；支持 `description`、`argument-hint`、`allowed-tools`、`model`、`disable-model-invocation`、`$ARGUMENTS`、位置参数和 `@file`。

Agents：`.codebuddy/agents/*.md`，必需 `name`、`description`，可选 `tools`、`model`、`permissionMode`、`skills`。Harness 若无 agent persona 抽象，不应为凑目录而生成。

来源：[Hooks Reference](https://www.codebuddy.ai/docs/cli/hooks)、[Hooks Guide](https://www.codebuddy.ai/docs/cli/hooks-guide)、[CLI Slash Commands](https://www.codebuddy.ai/docs/cli/slash-commands)、[IDE Slash Commands](https://www.codebuddy.ai/docs/ide/User-guide/Slash-Commands)、[Sub-Agents](https://www.codebuddy.ai/docs/cli/sub-agents)（访问 2026-07-12）。

## 6. Harness 最小兼容设计建议

### 6.1 安装选项

```text
npx <package> init
? Select agents (multi-select)
  [ ] codex
  [ ] cursor
  [ ] codebuddy

# 仅选择 codebuddy 时继续
? CodeBuddy surface
  both (default) | ide | cli

# 任何目标存在 Hook 产物时继续
? Install executable hooks? No (default) | Yes
```

非交互建议：`--agents codex,cursor,codebuddy --codebuddy-surface both --with-hooks=false`。不提供 `--agents` 时可以保持现有默认行为，但必须在最终设计中明确，不能静默改变老用户产物。

### 6.2 Canonical 内容与 adapter overlay

```text
canonical instructions  -> AGENTS.md managed block
canonical skill         -> name + description + Markdown body + resources
canonical workflow      -> skill-first
agent overlay           -> Cursor paths/disable flag、CodeBuddy allowed-tools 等
security policy         -> 每个 Agent 独立 Hook/permission adapter，绝不共享原始配置
```

不得建立“通用 rule 文件 → 三个 rules 目录”的直接映射。正确映射：

- 编码/架构/测试规范 → `AGENTS.md`、`CODEBUDDY.md`、Cursor `.mdc`（按目标选择）。
- 可复用过程 → Skill。
- 显式快捷动作 → Cursor/CodeBuddy Command；Codex 仍用 Skill。
- 沙箱外命令许可 → Codex `.rules`。
- 确定性拦截/审计 → 各 Agent Hook adapter。

### 6.3 `both` 默认产物

```text
AGENTS.md                                  # codex + cursor + CodeBuddy fallback
.agents/skills/<name>/SKILL.md             # codex + cursor 公共 Skill
.cursor/commands/<name>.md                 # 仅有显式 command 需求时
CODEBUDDY.md                               # 选择 codebuddy 时生成/合并
.codebuddy/skills/<name>/SKILL.md
.codebuddy/commands/<name>.md              # 仅有显式 command 需求时
```

CodeBuddy `both` 默认不生成 Rules/Hook。Codex 默认不生成 `.codex/rules`/Hook。Cursor 默认不生成 Hook。安全能力必须显式开启。

### 6.4 便宜模型必须严格执行的写入算法

1. 扫描：列出目标文件、符号链接、是否在 Git、是否有本地未提交修改。
2. 分类：`missing | managed | user-owned | malformed | conflict`。
3. 解析：Markdown managed block；YAML 用严格 parser；JSON 用 JSON parser；不得正则拼接 frontmatter/JSON。
4. 规划：输出将创建/修改/跳过/报警的清单。Hook 必须单独列出执行命令。
5. 合并：只修改 Harness managed block 或已知字段；保留未知字段和用户正文。
6. 原子写：同目录临时文件 → parse 验证 → rename；失败恢复原文件。
7. 幂等：二次运行 diff 必须为空。
8. 验证：执行下一节检查；任何失败返回非零，不宣称成功。

禁止事项：

- 不覆盖整个已有 `AGENTS.md` / `CODEBUDDY.md`。
- 不在 CodeBuddy 同时写等价 `.md` 与 `RULE.mdc`。
- 不生成 `.codex/commands/`。
- 不把编码规则写入 Codex `.rules`。
- 不默认启用 Hook 或 `allowUntrustedFrontmatterHooks`。
- 不向 repo 写 `*.local.*`。
- 不根据相似产品猜 frontmatter 字段。

## 7. 验收清单

- [ ] `AGENTS.md` managed block 唯一；用户块字节不变。
- [ ] Skill 目录名与 `name` 一致，`name`/`description` 存在且非空。
- [ ] 所有 YAML、JSON、TOML、`.rules` 均可解析。
- [ ] Cursor Rules 只用 `.mdc`；`.cursor/rules` 无 Harness 生成的 `.md`。
- [ ] Codex `.rules` 只有 `prefix_rule` 权限策略，并带 `match/not_match`。
- [ ] CodeBuddy `both` 未生成双份 Rule；`ide`/`cli` 路径符合各自规范。
- [ ] `CODEBUDDY.md` 与 `AGENTS.md` 同时存在且核心指令冲突时安装失败或明确警告。
- [ ] Hook 未经 `--with-hooks` 不产生；启用时展示命令与信任/风险说明。
- [ ] Windows CodeBuddy Hook 不含 PowerShell/cmd-only 语法。
- [ ] 对同名 Skill 不依赖覆盖优先级，必须显式冲突处理。
- [ ] 安装连续运行两次，第二次 `git diff` 为空。
- [ ] 卸载只删除 Harness managed 内容，不删除用户内容。

## 8. 明确不确定项与保守策略

| 不确定项 | 保守策略 |
|---|---|
| Cursor 多类规则冲突的完整优先级未在公开文档中形成可实现的总序 | 生成前做语义冲突检测，不承诺覆盖顺序 |
| Cursor IDE/CLI/Cloud Hook 事件覆盖随版本变化 | capability matrix 按 surface/version 标记；默认关闭 |
| CodeBuddy IDE 是否完整支持 CLI 的 27+ Hook 事件 | 只标 `codebuddy-cli experimental` |
| CodeBuddy IDE Rule 三种 UI 类型的完整 frontmatter 映射未公开 | 仅写官方示例字段；`both` 不生成模块化 Rule |
| CodeBuddy v2.33.0 提到 `.mdc` memory 兼容，但主文档仍以 `.md` 为规范 | instructions 使用 `.md`；不依赖 `AGENTS.mdc`/`CODEBUDDY.mdc` |
| 各工具高级 Skill 扩展不属于共同标准 | canonical Skill 只用 `name`、`description`、正文和资源目录；扩展放 adapter overlay |

## 9. 官方来源索引

访问日期均为 2026-07-12。

### OpenAI Codex

- [AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Build skills](https://developers.openai.com/codex/skills)
- [Rules](https://developers.openai.com/codex/rules)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Advanced configuration](https://developers.openai.com/codex/config-advanced)
- [Custom prompts（deprecated）](https://developers.openai.com/codex/custom-prompts)
- [Developer commands](https://developers.openai.com/codex/cli/slash-commands)
- [OpenAI Skills 官方示例仓库](https://github.com/openai/skills)

### Cursor

- [Rules](https://cursor.com/docs/rules)
- [Agent Skills](https://cursor.com/docs/skills)
- [Hooks](https://cursor.com/docs/hooks)
- [Commands](https://docs.cursor.com/en/agent/chat/commands)
- [Using Agent in CLI](https://docs.cursor.com/en/cli/using)
- [Cursor 1.6 changelog](https://cursor.com/changelog/1-6)
- [Cursor 2.4 changelog](https://cursor.com/changelog/2-4)
- [Best practices for coding with agents](https://cursor.com/blog/agent-best-practices)

### Tencent CodeBuddy

- [Introduction](https://www.codebuddy.ai/docs/ide/Introduction)
- [.codebuddy Directory Structure](https://www.codebuddy.ai/docs/cli/codebuddy-dir)
- [Managing CodeBuddy's Memory](https://www.codebuddy.ai/docs/cli/memory)
- [CodeBuddy Code Best Practices](https://www.codebuddy.ai/docs/cli/best-practices)
- [CodeBuddy Code Skills](https://www.codebuddy.ai/docs/cli/skills)
- [CodeBuddy IDE Skills](https://www.codebuddy.ai/docs/ide/Features/Skills)
- [CodeBuddy IDE Rules](https://www.codebuddy.ai/docs/zh/ide/User-guide/Rules)
- [CodeBuddy IDE Context](https://www.codebuddy.ai/docs/ide/User-guide/Context)
- [Hooks Reference](https://www.codebuddy.ai/docs/cli/hooks)
- [Hooks Guide](https://www.codebuddy.ai/docs/cli/hooks-guide)
- [CodeBuddy Code Slash Commands](https://www.codebuddy.ai/docs/cli/slash-commands)
- [CodeBuddy IDE Slash Commands](https://www.codebuddy.ai/docs/ide/User-guide/Slash-Commands)
- [Sub-Agents](https://www.codebuddy.ai/docs/cli/sub-agents)
- [CodeBuddy Code v2.33.0 release](https://www.codebuddy.ai/docs/cli/release-notes/v2.33.0)
- [CodeBuddy IDE release notes](https://www.codebuddy.ai/docs/ide/release-notes/release-notes)
