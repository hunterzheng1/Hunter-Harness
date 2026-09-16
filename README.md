# Hunter Harness

[![npm](https://img.shields.io/npm/v/hunter-harness)](https://www.npmjs.com/package/hunter-harness)

一个用 TypeScript 实现的 CLI + 数据包工具：在你的项目根目录运行一条命令，即可安装一套结构化 harness——固定的 `.agents/skills/` 技能投影（自动双写 `.codebuddy/skills/`）、单文件 `AGENTS.md` 指令（含归档自动沉淀的经验规则段）、`.harness/` 工程元数据，以及远程治理同步。

`hunter-harness` 面向希望在 Codex / CodeBuddy 等兼容 AGENTS.md 的编码助手中获得一致工作流的团队：版本化内容同步、工作区引擎（run/service）、归档自动学习与治理上传。

当前发布版本：**v1.0.0**（相对 0.x 为破坏性升级，见下文“从 0.x 升级”）。

## 前提条件

- **Node.js 22.12 或更高版本**

## 安装 Hunter Harness

```bash
npm install -g hunter-harness
hunter-harness init
```

`init` 零选择执行：不再询问 agent 或 profile——技能固定投影到 `.agents/skills/`，并无条件双写 `.codebuddy/skills/`；指令收敛为单文件 `AGENTS.md` 受管块。

已安装过的项目，升级数据包内容用：

```bash
hunter-harness refresh
```

`refresh` 只更新 harness 内容，不会重置你的 `.harness/project.yaml` 配置。若检测到 0.x 时代的历史投影（`.claude/`、`.cursor/`、`.pi/`、`CLAUDE.md`、`CODEBuddy.md` 等），会打印 warning 引导你运行 `uninstall` 清理。

## 从 0.x 升级

v1.0 为破坏性版本，新旧内容面不兼容：

```bash
hunter-harness uninstall          # 预览将删除的历史内容（dry-run）
hunter-harness uninstall --yes    # 执行清理（只删受管文件与受管段落）
hunter-harness init               # 重新安装 v1.0 内容面
```

`uninstall` 精确删除所有历史版本写入的 hunter-harness 内容：`.agents/`、`.claude/`、`.cursor/`、`.pi/`、`.codebuddy/` 中的受管文件，`AGENTS.md`/`CLAUDE.md`/`CODEBUDDY.md` 中的受管段落，`.mcp.json` 中的 harness 条目，以及 `.harness/`（加 `--keep-data` 可保留运行数据）。用户手写内容不受影响。

## 安装内容

| 能力 | 写入位置 | 说明 |
| --- | --- | --- |
| Harness 技能 | `.agents/skills/<name>/` | 规范投影面（Codex 及兼容 `.agents` 的代理直接消费） |
| Harness 技能（派生） | `.codebuddy/skills/<name>/` | 无条件双写，内容与 `.agents/skills/` 一致 |
| 项目指令 | `AGENTS.md` | 单指令文件受管块；CodeBuddy 官方兼容 AGENTS.md，无需 CODEBUDDY.md |
| 经验规则 | `AGENTS.md` 受管段 | `archive upload` 后自动从归档学习并幂等刷新，与手写内容隔离 |
| 元数据与规则映射 | `.harness/` | 项目配置、内容与状态 |

`.harness/project.yaml` 保存服务端地址、token 环境变量与开关等；也可通过 `hunter-harness init` 的 `--config` / `--server-url` / `--token-env` 非交互写入，0.x 配置中的已废弃字段会被自动剥离并给出 warning。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `hunter-harness init` | 安装 harness 内容并写入 `.harness/project.yaml` |
| `hunter-harness uninstall` | 删除所有历史版本写入的受管内容（默认 dry-run，`--yes` 执行） |
| `hunter-harness refresh` | 升级到当前数据包内容，保留项目配置 |
| `hunter-harness update` | 检查数据包更新（默认 dry-run，`--yes` 写入） |
| `hunter-harness sync` | 运行安装后体检（instruction-graph、instruction-frontmatter、mcp-server 等） |
| `hunter-harness doctor` | 诊断本地安装（版本、路径、MCP、配置与 Node 环境） |
| `hunter-harness status` | 本地 harness 状态（安装/更新/配置/MCP/同步/遥测） |
| `hunter-harness archive upload` | 归档并上传会话记录，服务端提取规则候选；成功后自动刷新 AGENTS.md 经验规则受管段 |
| `hunter-harness push` | 推送本地治理内容（AGENTS.md、skills、codebase map 等） |
| `hunter-harness knowledge status` | 知识库状态 |

完整列表见 `hunter-harness --help`。

## 技能包 CLI（skill-cli）

技能包的安装与上传由独立包 `@hunter-harness/skills` 提供（bin：`skills` / `hunter-harness-skill`）：

```bash
skills install <slug>     # 安装技能包（固定双写 .agents/skills + .codebuddy/skills）
skills upload <目录或zip>  # 上传技能包草稿（--agent claude-code|codex|cursor）
```

- `install`：下载已发布的技能包并按 v1.0 固定投影安装；`--agent codex` / `--agent codebuddy` 可收窄为单面写入，`--scope user` 安装到用户级目录。
- `upload`：将本地技能目录或 zip 上传到服务端草稿区，供审核发布。

## 本地开发

```bash
git clone https://github.com/AIRuler/hunter-harness.git
cd hunter-harness
npm install
npm run build
npm link
```

之后在任意项目目录运行 `hunter-harness init`。

要求 Node.js 22.12+。

## 发布（维护者）

```bash
npm run release:preflight
```

包含数据包同步校验（版本四点一致性）、lint、typecheck、受改动影响的测试（`test:changed` 按变更文件选择相关测试）与 npm publish 产物演练（tarball + Node 22 smoke + 关键文件清单断言）。

本地 preflight 是快速通道，只跑受改动影响的测试；完整测试矩阵交由 CI 执行。需要本地全量验证（含打包冒烟）时运行：

```bash
npm run check:all
```

发布与打标的完整 SOP 见 `docs/` 目录下维护者文档；`docs/decisions/` 记录了 v1.0 破坏性变更的逐条决策与迁移说明。

## 在本仓库 dogfood

本仓库自身也安装 harness：

```powershell
node packages/cli/dist/bin.js sync --json
node packages/cli/dist/bin.js archive upload --dry-run --json
```

## 许可证

MIT © AIRuler Team
