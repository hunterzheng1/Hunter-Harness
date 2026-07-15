# hunter-harness

Local-first, server-governed Agent Harness CLI.

```bash
npx hunter-harness
npx hunter-harness --agents all --profile general --non-interactive --yes
npx hunter-harness refresh --agents codex,cursor --non-interactive --yes
npx hunter-harness push
npx hunter-harness update
```

- 默认命令可离线初始化或打开事务恢复菜单。
- `--agents <csv>` 可选择 `claude-code`、`codex`、`cursor`、`codebuddy` 的任意组合（或 `all`）；未提供时保持 Claude Code 默认值。
- `--codebuddy-surface both|ide|cli` 只在选择 CodeBuddy 时有效，默认 `both`。
- `push` 只创建 proposal，不发布、不推进本地 baseline。
- `update` 只事务化应用人工批准的 artifact。

| Agent | Skills | Rules | 自定义 Agent |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `.claude/rules/*.md` | `.claude/agents/` |
| Codex | `.agents/skills/` | `AGENTS.md` | 不生成 |
| Cursor | `.cursor/skills/` | `.cursor/rules/*.mdc` | 不生成 |
| CodeBuddy `both` | `.codebuddy/skills/` | `CODEBUDDY.md` + `.codebuddy/.rules/*.mdc` + `.codebuddy/rules/*.md` | `.codebuddy/agents/` |

需要 Node.js 22.12 或更高版本。选择 CodeBuddy 时，可将已有 `.claude/rules` 非破坏性同步到 CodeBuddy，并在检测到 `.codegraph/` 时合并项目级 `.mcp.json`；疑似凭据内容会跳过。token 只通过 `--token-env` 指定的环境变量读取，不要写入项目文件或命令参数。

本包使用 MIT License。
