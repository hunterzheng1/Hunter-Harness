# hunter-harness

[![npm](https://img.shields.io/npm/v/hunter-harness)](https://www.npmjs.com/package/hunter-harness)

Hunter Harness 命令行工具：在任意项目一键安装/升级结构化 harness——固定的 `.agents/skills/` 技能投影（自动双写 `.codebuddy/skills/`）、单文件 `AGENTS.md` 指令、`.harness/` 工程元数据，并支持运行引擎、归档自动学习与远程治理同步。

**v1.0.0 为破坏性升级**：移除了安装时的 agent/profile 选择、静态 rules 投影、CLAUDE.md/CODEBUDDY.md 受管块与 rules-sync/instructions 命令；新增 `uninstall` 一键清理历史内容。升级路径见根 README「从 0.x 升级」。

## 安装

```bash
npm install -g hunter-harness
```

要求 Node.js 22.12+。

## 快速开始

```bash
cd your-project
hunter-harness init
```

`init` 零选择执行：技能写入 `.agents/skills/` 并无条件双写 `.codebuddy/skills/`，指令收敛为 `AGENTS.md` 受管块。已安装项目升级内容用 `hunter-harness refresh`（保留 `.harness/project.yaml` 配置）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `hunter-harness init` | 安装 harness 内容并写入项目配置 |
| `hunter-harness uninstall` | 删除所有历史版本写入的受管内容（默认 dry-run，`--yes` 执行，`--keep-data` 保留运行数据，`--global` 清理用户级目录） |
| `hunter-harness refresh` | 升级到当前数据包内容，保留项目配置 |
| `hunter-harness update` | 检查数据包更新（默认 dry-run，`--yes` 写入） |
| `hunter-harness sync` | 运行安装后体检（instruction-graph、instruction-frontmatter、mcp-server 等） |
| `hunter-harness doctor` | 诊断本地安装与 Node 环境 |
| `hunter-harness status` | 本地 harness 状态（安装/更新/配置/MCP/同步/遥测） |
| `hunter-harness archive upload` | 归档并上传会话记录；成功后自动把高置信规则候选刷新进 AGENTS.md 经验规则受管段 |
| `hunter-harness push` | 推送本地治理内容（AGENTS.md、skills、codebase map 等） |
| `hunter-harness plan ...` | 计划证据包/评审记录/finalize/publish |
| `hunter-harness run ...` / `service ...` | 工作区运行引擎管理 |
| `skills install <slug>` | 安装技能包（独立包 `@hunter-harness/skills`；固定双写 `.agents/skills` + `.codebuddy/skills`，`--agent` 可收窄） |
| `skills upload <目录或zip>` | 上传技能包草稿供审核发布 |

完整命令与参数见 `hunter-harness --help`。

## 文档

更多文档见仓库根目录 `README.md` 与 `docs/`；v1.0 逐条破坏性变更决策见 `docs/decisions/`。

## 许可证

MIT © AIRuler Team
