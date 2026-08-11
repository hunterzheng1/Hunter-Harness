# Hunter Harness

Hunter Harness 是“本地轻量、服务端治理”的 Agent Harness。项目 CLI 负责本地工作流、确定性归档打包和安全应用；Hunter Platform 保存归档原包、解包入库、提供远端知识查询，并生成中文项目指令优化提案。

## 快速安装

要求：Node.js 22.12 或更高版本（已验证 22.17；不再要求 Node 24）。

```powershell
mkdir my-project
cd my-project
npx hunter-harness
```

交互安装先选择一个或多个目标 Agent，再选择通用或 Java Harness。空输入保持兼容行为，只安装 Claude Code。安装是本地操作，不需要 Hunter-Harness 服务器、Python 或访问源 Vault。

自动化场景：

```powershell
npx hunter-harness --profile general --non-interactive --yes
npx hunter-harness --profile java --non-interactive --yes
npx hunter-harness --agents claude-code,codex,cursor,codebuddy --profile general --non-interactive --yes
npx hunter-harness --agents codebuddy --codebuddy-surface both --profile general --non-interactive --yes
```

`--agents` 接受逗号分隔的 `claude-code`、`codex`、`cursor`、`codebuddy`，或 `all`；输出顺序固定。`--codebuddy-surface` 接受 `both|ide|cli`，未选择 CodeBuddy 时不能提供该参数。

| 能力 | Claude Code | Codex | Cursor | CodeBuddy `both` |
|---|---|---|---|---|
| 项目指令 | `AGENTS.md` + `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` + `CODEBUDDY.md` |
| Skills | `.claude/skills/` | `.agents/skills/` | `.cursor/skills/` | `.codebuddy/skills/` |
| 项目规则 | `.claude/rules/*.md` | `AGENTS.md` | `.cursor/rules/*.mdc` | `CODEBUDDY.md` + IDE `.codebuddy/.rules/*.mdc` + CLI `.codebuddy/rules/*.md` |
| 自定义 Agent | `.claude/agents/` | 不生成 | 不生成 | `.codebuddy/agents/` |

已初始化项目可用 `npx hunter-harness refresh --agents codex,cursor --non-interactive --yes` 安全切换 Agent 集合；本地修改的 Harness working copy 会保留并报告冲突。

选择 CodeBuddy 时，CLI 不再复制 Claude 规则或改写 Agent 文档，而是提示运行 `instructions audit` 生成统一优化提案。项目已有 `.codegraph/` 且 `.mcp.json` 未配置 CodeGraph 时，仍会询问是否合并项目级 MCP 配置；未选择 CodeBuddy 时不读取或修改这些配置。

## 项目级 CLI

项目级公开命令：

```bash
npx hunter-harness
npx hunter-harness status --json
npx hunter-harness recover <recovery-id> --action inspect --json
npx hunter-harness resume <recovery-id> --non-interactive --yes --json
npx hunter-harness recover <recovery-id> --action rollback --non-interactive --yes --json
npx hunter-harness rules-sync --json
npx hunter-harness instructions audit --json
npx hunter-harness instructions apply --proposal <proposal.json> --yes --json
npx hunter-harness knowledge query "<问题>" --json
npx hunter-harness archive upload --file <archive.zip> --change-key <change-key> --yes --json
npx hunter-harness push
npx hunter-harness update
```

- `npx hunter-harness`：未安装时离线初始化；已安装且状态健康时直接 refresh；存在未完成事务时先进入恢复。
- `status`：只读输出本地恢复状态、变更是否已部分应用和建议动作。
- `recover` / `resume`：按稳定 recovery ID 检查或回滚指定事务；非交互回滚必须显式提供 `--yes`。
- `rules-sync`：兼容入口；调用远端审计生成中文提案，不再注入 `<!-- hunter-harness:start ... -->` 标记或直接改写项目文件。
- `instructions audit/apply`：服务端结合项目类型、现有文档、Codebase Map、近期变更和公开最佳实践生成提案；本地审阅后按基线哈希事务化应用。变更经验只形成规则候选，不自动采纳。
- `knowledge query`：只查询 Hunter Platform；远端不可用时直接失败，不建立本地索引或离线回退。
- `archive upload`：上传一个确定性 ZIP。服务端保存原包、安全解包并 ingest；ZIP 只包含 summary、spec、plans、archive-meta 和 change-context 等核心文件。
- `push`：预览、敏感信息扫描、首次项目绑定并上传 proposal；不推进 baseline。
- `update`：仅拉取已批准 artifact，校验 SHA-256 后事务化写入。

初始化只在文档不存在或为空时创建简洁中文入口，已有 `AGENTS.md` / `CLAUDE.md` / `CODEBUDDY.md` 保持原样。优化通过“审计—提案—确认应用”完成；CLI 不要求也不生成消费项目的 `.gitattributes`。Claude Code Skill 由 canonical Skill IR 编译到 `.claude/skills/harness-*/SKILL.md`。

归档 finalize 始终先生成单个 ZIP 与按 change 命名的上传回执；配置远端凭据后自动上传。日志、测试/审查报告、HTML、缓存、备份和临时文件只留在本地归档，不进入远端核心包；缺少凭据、上传失败或索引未就绪时，ZIP 与 `<change-key>.upload.json` 保留在 `.harness/state/local/archive-packages/` 供枚举重试。仅在远端同时确认原包耐久保存和知识索引 ready 后清理。本地 Python/SQLite 知识引擎已从当前 Bundle 移除。

## 独立 Skill CLI

独立 Skill 分发使用单独的 npm 包，只提供安装和上传两个动作：

```bash
npx @hunter-harness/skill-cli install <skill-slug> --agent claude-code
npx @hunter-harness/skill-cli upload <directory-or-zip> --agent claude-code
```

- `install`：不存在时安装，已安装且未被本地修改时更新；校验 artifact SHA-256 与 ZIP identity 后原子写入。
- `upload`：上传 ZIP 或目录（也兼容单个 canonical Skill IR 文件）并创建待审 proposal，不直接发布；当前发布校验目标为 Claude Code。
- CLI 不提供 search、download、update、uninstall 或 publish 命令；浏览、历史版本、详情与 ZIP 下载位于 Web Console。
- MVP 仅将 Claude Code adapter 标记为可安装；Codex、Generic、MCP 保留契约与预览边界。

## 仓库结构

```text
packages/contracts              wire/schema 合同（含 OpenAPI 副本）
packages/core                   文件策略、Skill IR、扫描、事务、push/update
packages/cli                    项目级 Harness CLI
packages/skill-cli              独立 Skill install/upload CLI
packages/workflow-data-harness  工作流数据包（npm）
resources                       bootstrap Skill IR
tests                           CLI / core 验证
docs                            实施与验收文档
```

## Web 治理控制台

Web Console（`apps/web` + `apps/server`）已拆到独立仓库 **hunter-platform**（`E:\MyProject\AI Related\hunter-platform` / GitHub `hunterzheng1/hunter-platform`）。本仓只保留 CLI 与 npm 发布相关包。

浏览、审核、Skill Center、服务端部署见 hunter-platform 的 README 与 compose。

OpenAPI 合同副本保留在 [packages/contracts/openapi/hunter-harness-v1.yaml](packages/contracts/openapi/hunter-harness-v1.yaml)（权威实现随 hunter-platform）。

## 本地开发与验证

要求 Node.js 24+、npm 11+。

```bash
npm ci
npm run check
```

`npm run check` 依次执行 lint、TypeScript、全部 Vitest 测试和公开产物构建。需要在本机额外验证 npm 打包与安装时，运行 `npm run check:all`。

发布前默认运行快速预检：

```bash
npm run release:preflight
```

快速预检同步 Harness Bundle，执行 lint、TypeScript、受改动影响的测试，并重新构建公开产物。该命令不在本机重复执行全仓测试；完整回归由 CI 承担。CI 在 Ubuntu 执行一次完整检查，在两个 Windows 分片中覆盖全部测试，并行验证 npm 打包和 Node.js 22.17 兼容性。

在本 monorepo 内 dogfood CLI（勿依赖全局 PATH）可用：

```powershell
npm run hh -- --help
npm run hh -- rules-sync --json
npx hunter-harness --help
```

`npm run hh` 直接跑 `packages/cli/dist/bin.js`；改 CLI 源码后需先 `npm run bundle -w packages/cli`。

Semantic MCP、External Skill 策展列表、服务端部署与控制台能力见 **hunter-platform**。

## 安全边界

- token 只从环境变量、secret file 或浏览器 session storage 读取，不写入项目文件或 CLI JSON。
- `.harness/state/**`、`.harness/cache/**`、`.codegraph/**` 永不进入 proposal。
- 高风险 secret 永远阻断；中低风险 override 必须保留审计证据。
- Skill artifact 下载与安装必须校验 SHA-256；本地 dirty Skill 默认拒绝覆盖。
- CodeGraph、Superpowers 只在初始化检查；Yao 不进入 CLI、项目和 MVP 验收。
- 对外发布参考资产前仍须确认上游许可证、commit/tag 与再分发范围。
