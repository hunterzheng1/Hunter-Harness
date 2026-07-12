# Hunter Harness

Hunter Harness 是“本地轻量、服务端治理”的 Agent Harness。项目 CLI 维护本地 working copy；`push` 只创建 proposal，人工审核通过后，`update` 才事务化应用已发布 artifact。

## 快速安装

要求：Node.js 24 或更高版本。

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
| 项目规则 | `.claude/rules/*.md` | `AGENTS.md` | `.cursor/rules/*.mdc` | `CODEBUDDY.md` |
| 自定义 Agent | `.claude/agents/` | 不生成 | 不生成 | `.codebuddy/agents/` |

已初始化项目可用 `npx hunter-harness refresh --agents codex,cursor --non-interactive --yes` 安全切换 Agent 集合；本地修改的 Harness working copy 会保留并报告冲突。

## 项目级 CLI

项目级公开命令保持不变：

```bash
npx hunter-harness
npx hunter-harness push
npx hunter-harness update
```

- `npx hunter-harness`：离线初始化、配置与事务恢复菜单。
- `push`：预览、敏感信息扫描、首次项目绑定并上传 proposal；不推进 baseline。
- `update`：仅拉取已批准 artifact，校验 SHA-256 后事务化写入。

初始化默认创建 `AGENTS.md`，`CLAUDE.md` 保持为极简路由文件；默认不创建 `.harness/rules/`。Claude Code Skill 由 canonical Skill IR 编译到 `.claude/skills/harness-*/SKILL.md`。

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
packages/contracts  wire/schema 合同
packages/core       文件策略、Skill IR、扫描、事务、push/update
packages/cli        项目级三命令 CLI
packages/skill-cli  独立 Skill install/upload CLI
apps/server         Fastify API、PostgreSQL repository、artifact storage
apps/web            Next.js 治理控制台
resources           bootstrap Skill IR
tests/e2e           治理闭环测试
docs                实施、部署与验收文档
```

## Web 治理控制台

控制台提供总览、项目、Workflow、Skill Center、审核队列和 Artifact 历史：

- Skill Center：搜索、标签/Agent/状态筛选、ZIP 或文件夹上传、Canonical IR、adapter 输出、版本历史与 Diff、标签管理、安装命令和 ZIP 下载。
- Skill 内容上传/修改：Web demo 可本地暂存未发布 Skill；真实服务端链路通过 Skill proposal 创建，owner 人工 approve/reject 后才发布版本与 adapter artifact。
- Workflow：直接 CRUD、启停、删除保护和有序 Skill binding，不进入 proposal，但保留审计与 revision 冲突保护。
- 标签：创建、重命名、合并、停用和 Skill 绑定直接生效，保留审计。
- 项目详情：展示并直接绑定 Workflow；项目受管文件仍沿用原有 proposal/review/update 治理协议。
- Dark 与 Light 使用同一套语义设计 token；技能中心在两套主题下保持一致的信息层级和卡片区分，首次遵循系统主题，用户选择后写入本地偏好。

### 连接真实服务端

生产模式不会静默回退到 mock。侧栏设置中填写 API Token，控制台先执行真实认证探测，成功后仅将 token 保存到当前浏览器 session storage。

```bash
npm run dev -w apps/web -- -p 3000
```

如仅需本地 UI 演示，必须显式启用只读 demo 模式，页面会持续显示“演示数据”标识：

```powershell
$env:NEXT_PUBLIC_HUNTER_HARNESS_DEMO='true'
npm run dev -w apps/web -- -p 3000
```

## 本地开发与验证

要求 Node.js 24+、npm 11+。

```bash
npm ci
npm run check
```

`npm run check` 依次执行 lint、TypeScript、全部测试、生产构建和两个 npm 包的 pack/install smoke test。

PostgreSQL 实库测试需要单独设置：

```powershell
$env:HUNTER_HARNESS_TEST_DATABASE_URL='postgresql://...'
npm run test:postgres -w apps/server
```

部署、TLS、secrets、备份、恢复、升级与回滚见 [SERVER-DEPLOYMENT.md](docs/SERVER-DEPLOYMENT.md)。完整 API 合同见 [hunter-harness-v1.yaml](apps/server/openapi/hunter-harness-v1.yaml)。

## Semantic MCP（只读）

治理服务端在 `/mcp` 暴露只读 Semantic MCP（Streamable HTTP），复用 API Bearer Token，不提供写入口。Agent 可查询跨项目语义索引；单项目本地知识写入仍走 CLI push。

可用工具：

| 工具 | 作用 |
|---|---|
| `search_knowledge` | 按关键词搜索知识文档（可按 `project_id` 限定） |
| `get_project_overview` | 项目语义索引概览计数 |
| `get_knowledge_entry` | 按 `document_id` 或 `source_path` 取单条知识 |
| `list_recent_changes` | 列出项目 archive 变更记录 |

Cursor / Claude Desktop 示例（把 `YOUR_TOKEN` 换成真实 `hh_…` token）：

```json
{
  "mcpServers": {
    "hunter-harness-semantic": {
      "url": "http://127.0.0.1:3001/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

## 安全边界

- token 只从环境变量、secret file 或浏览器 session storage 读取，不写入项目文件或 CLI JSON。
- `.harness/state/**`、`.harness/cache/**`、`.codegraph/**` 永不进入 proposal。
- 高风险 secret 永远阻断；中低风险 override 必须保留审计证据。
- Skill artifact 下载与安装必须校验 SHA-256；本地 dirty Skill 默认拒绝覆盖。
- CodeGraph、Superpowers 只在初始化检查；Yao 不进入 CLI、项目和 MVP 验收。
- 对外发布参考资产前仍须确认上游许可证、commit/tag 与再分发范围。