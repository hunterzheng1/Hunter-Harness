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
apps/web            Next.js Review Console（治理控制台）
resources           bootstrap Skill IR
tests/e2e           完整治理闭环测试
docs                 实施与部署文档
```

## Web 控制台

`apps/web` 是基于 Next.js 的治理控制台，提供人工审核与可视化管理界面。

### 快速本地预览（Mock 模式）

无需连接真实后端即可浏览完整 UI：

```bash
cd apps/web
npx next dev --webpack -p 3000
```

打开 `http://localhost:3000`，所有数据来自内置 Mock 层，适用于离线开发与 UI 调试。

### 连接真实后端

在侧边栏底部点击 **设置 → API 令牌**，输入有效的治理 token 后保存，控制台自动切换为实时数据。

### UI 功能

| 功能 | 说明 |
|------|------|
| **双语界面** | 默认中文，设置面板中一键切换 English。所有页面文案同步翻译 |
| **深色/浅色主题** | 设置面板自由切换，偏好自动持久化到 localStorage |
| **设置面板** | 侧边栏底部齿轮按钮，集成语言、主题、API 令牌管理 |
| **主题 Logo** | 侧边栏 Logo 随主题自动切换（深色/浅色各一套） |
| **Mock 数据** | 5 个示例项目、3 个待审核提案、2 个已批准制品，零配置预览 |
| **页面总览** | 总览（统计卡片）、项目注册表、工作流、技能浏览器、审核队列、制品历史 |

### 设计系统

基于 Emil Kowalski（动画约束）、Impeccable（反模式）、Taste-Skill（反 slop）三个开源设计指南构建：

- 深色产品 UI，Linear 风格
- OKLCH 色空间精炼配色（主色调 `#829cff` 蓝靛）
- 自定义 `cubic-bezier` 缓动曲线，器质性动效
- 语义化 z-index 层级，四档阴影系统
- 响应式断点适配移动端

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
