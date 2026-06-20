# Hunter Harness

Hunter Harness 是“本地轻量、服务端治理”的 Agent Harness。CLI 在项目中维护可编辑 working copy；push 只创建 proposal，人工 Review 批准后，update 才事务化应用已发布 artifact。

## 三个公开命令

```bash
npx hunter-harness
npx hunter-harness push
npx hunter-harness update
```

- `npx hunter-harness`：离线初始化、配置和事务恢复菜单。
- `push`：生成 preview、扫描敏感信息、首次绑定项目并上传 proposal；不推进 baseline。
- `update`：只拉取人工批准的 artifact，校验 SHA-256 后以本地事务应用。

初始化自动创建 `AGENTS.md`，保持 `CLAUDE.md` 为 managed block 路由文件；默认不创建 `.harness/rules/`。Claude Code Skill 由 canonical Skill IR 编译到 `.claude/skills/harness-*/SKILL.md`。

## 仓库结构

```text
packages/contracts  wire/schema 合同
packages/core       文件策略、Skill IR、扫描、事务、push/update
packages/cli        三命令 CLI
apps/server         Fastify API、PostgreSQL repository、artifact storage
apps/web            Next.js Review Console
resources           bootstrap Skill IR
tests/e2e           完整治理闭环测试
docs                 实施与部署文档
```

## 本地开发

要求 Node.js 24+、npm 11+。

```bash
npm ci
npm run check
```

`npm run check` 依次执行 lint、TypeScript、全部单元/集成/E2E 测试和生产构建。PostgreSQL 实库测试需要单独设置：

```bash
set HUNTER_HARNESS_TEST_DATABASE_URL=postgresql://...
npm run test:postgres -w apps/server
```

服务端和 Web 的生产部署、TLS、secrets、备份、恢复、升级与回滚见 [SERVER-DEPLOYMENT.md](docs/SERVER-DEPLOYMENT.md)。完整 API 描述位于 [hunter-harness-v1.yaml](apps/server/openapi/hunter-harness-v1.yaml)。

## 安全边界

- token 只从环境变量、secret file 或浏览器 session storage 读取，不写入项目文件或 CLI JSON。
- `.harness/state/**`、`.harness/cache/**`、`.codegraph/**` 永不进入 proposal。
- 高风险 secret 永远阻断；中低风险 override 必须保留审计证据。
- CodeGraph、Superpowers 只在初始化检查；Yao 不进入 CLI、项目和 MVP 验收。
- 发布参考资产前仍需确认上游 license、commit/tag 和再分发范围。
