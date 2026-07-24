# hunter-harness

Local-first, server-governed Agent Harness CLI.

```bash
npx hunter-harness
npx hunter-harness --agents all --profile general --non-interactive --yes
npx hunter-harness refresh --agents codex,cursor --non-interactive --yes
npx hunter-harness rules-sync --json
npx hunter-harness push
npx hunter-harness update
```

- 默认命令可离线初始化或打开事务恢复菜单。
- `--agents <csv>` 可选择 `claude-code`、`codex`、`cursor`、`codebuddy` 的任意组合（或 `all`）；未提供时保持 Claude Code 默认值。
- `--codebuddy-surface both|ide|cli` 只在选择 CodeBuddy 时有效，默认 `both`。
- `rules-sync` 扫描各 Agent 的用户规则，将全局一致内容收敛到 `.harness/rules/` 并刷新受管投影；分歧不覆盖，带路径范围的规则保留为 Agent 专属。默认还会从结构化 review/test/archive 证据生成 `.harness/knowledge/rule-candidates.json`，候选不会自动激活；可用 `--no-learn` 跳过。
- `push` 只创建 proposal，不发布、不推进本地 baseline。
- `update` 只事务化应用人工批准的 artifact。

| Agent | Skills | Rules | 自定义 Agent |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `.claude/rules/*.md` | `.claude/agents/` |
| Codex | `.agents/skills/` | `AGENTS.md` | 不生成 |
| Cursor | `.cursor/skills/` | `.cursor/rules/*.mdc` | 不生成 |
| CodeBuddy `both` | `.codebuddy/skills/` | `CODEBUDDY.md` + `.codebuddy/.rules/*.mdc` + `.codebuddy/rules/*.md` | `.codebuddy/agents/` |

需要 Node.js 22.12 或更高版本。公共规则以 `.harness/rules/` 为唯一真源，由受管文件投影到 Claude、Cursor、CodeBuddy，并在 Codex 的 `AGENTS.md` 中建立索引；疑似凭据或提示注入内容不会进入历史规则候选。token 只通过 `--token-env` 指定的环境变量读取，不要写入项目文件或命令参数。

本包使用 MIT License。
