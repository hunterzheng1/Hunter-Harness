# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

Hunter Harness 是"本地轻量、服务端治理"的 Agent Harness。**本仓库是产品本身的实现**，不是 harness 在目标项目里生成的极简路由 CLAUDE.md（那是 `packages/core/src/project/initialize.ts` 的产物，二者不要混淆）。CLI 维护本地 working copy；`push` 只创建 proposal，服务端人工 Review 通过后，`update` 才事务化应用已批准 artifact。完整产品语义见根 `README.md` 与 `requirements/hunter-harness-complete-dev/`。

## 常用命令

要求 Node.js 24+、npm 11+。npm workspaces，包名前缀 `@hunter-harness`。

- `npm run check` — 一键全量验证：lint → typecheck → test → build → smoke:pack。提交前优先跑它。
- `npm run lint` — `eslint .`（忽略 `dist/`、`.next/`、`coverage/`、`requirements/`）
- `npm run typecheck` — `tsc -b`（构建全部 project references）+ apps/web typecheck
- `npm test` — `vitest run`（根 `vitest.config.ts`）
- 单测：`npx vitest run <文件路径>`，或按用例名 `npx vitest run -t "<名称>"`
- `npm run build` — `tsc -b` + esbuild bundle(cli/skill-cli) + copy-resources + `next build`(web)
- Web 控制台：`npm run dev -w apps/web -- -p 3000`；只读 demo 模式（PowerShell）：`$env:NEXT_PUBLIC_HUNTER_HARNESS_DEMO='true'`
- 服务端：`npm start -w apps/server`（`node dist/main.js`）
- PostgreSQL 实库测试：`$env:HUNTER_HARNESS_TEST_DATABASE_URL='postgresql://...'`，再 `npm run test:postgres -w apps/server`

## 架构（big picture）

### 包依赖方向

`contracts`（纯 Zod 契约，无逻辑）→ `core`（本地侧全部逻辑）→ `{cli, skill-cli, apps/server, apps/web}`。单向依赖；apps/server 与 apps/web 都依赖 contracts + core。

- **packages/contracts** — wire/schema 合同：`file-policy`、`protocol`（artifact/baseline manifest、file operations）、`skill-ir`、`registry`、`project`、`knowledge`、`dashboard`、`errors`、`canonical-json`。改协议先改这里，类型由 `z.infer` 暴露。
- **packages/core** — 本地实现：文件策略分类、Skill IR（compiler/normalize/overlay/bundle + claude-code adapter）、安全扫描（secret：allowlist/entropy/scanner）、state layout、atomic 写、transaction journal + recovery、push/update/conflicts/diff/preview、codebase map、knowledge frontmatter、managed block、project initialize、uuid-v7、api client + retry。`src/index.ts` 用 `export *` 汇总公开 API。
- **packages/cli** — 项目级三命令：`hunter-harness`（初始化/配置/恢复菜单）、`push`、`update`。commander，esbuild bundle 到 `dist/bin.js`。
- **packages/skill-cli** — 独立 skill 分发：`hunter-harness-skill install|upload`。
- **apps/server** — Fastify + PostgreSQL（附 memory 实现作 fallback）+ artifact storage（local/memory）。所有 mutation 走 `Idempotency-Key` + body hash + lock，并写 append-only audit event。
- **apps/web** — Next.js 16（webpack）治理控制台，App Router。生产模式不静默回退 mock；demo 模式需显式开启。

### push → review → update 数据流

1. 本地 `push`：`classifyFile` 判定每个文件能否进 proposal（`push_policy`）→ 敏感扫描 → 上传 proposal-session（分块 blob + `finalize` 校验 SHA-256 与 manifest hash）。
2. 服务端 `review-decisions`：`approve`/`reject`/`split`/`need_more_evidence`；`approve` 产出 artifact。
3. 本地 `update`：拉取 `update-manifest` + artifact manifest/blob，校验 SHA-256，按 `update_policy` + `conflict_policy` 事务化写入 baseline。

### 文件策略矩阵（核心概念）

每个受管文件由 `classifyFile(relativePath)`（`packages/core/src/policy/file-policy.ts`）映射到一条 `FilePolicy` = `file_kind` × `{edit, push, update, conflict}_policy`。这**取代了旧 A/B/C 分类**（规范层已废止）。默认表关键路径：

- `CLAUDE.md` / `AGENTS.md` → managed-block-only（只改 Harness block）
- `.claude/rules/`、`.claude/skills/harness-*` → user_editable + diff-proposal
- `.harness/knowledge/`（`project-local/` 除外）→ full-diff-proposal；`project-local/` → confirm-before-proposal, update=never
- `.harness/codebase/map/` → generated_reviewable
- `.harness/state/`、`.harness/rules/` → internal_state, push=never（仅协议层写）
- `.harness/cache/`、`.harness/generated/` → generated_cache, push=never
- `.codegraph/` 及其他 → external_unmanaged, push=never, update=never

改文件策略 = 改 `classifyFile` 的路径匹配 + `contracts/src/file-policy.ts` 的枚举。`decidePush` / `decideUpdate` 是对应的判定入口。

### 状态目录布局

`.harness/state/{baseline,transactions,locks,local}` + `.harness/cache/server-artifacts` + `.harness/reports`（见 `core/src/state/layout.ts`）。**仅协议层写 state**；cache 可清理重建。`.codegraph/` 永不进 proposal。

### Skill IR 编译

canonical Skill IR（YAML；`resources/bootstrap-ir/` 是离线首次编译的种子集）→ `compileSkill` 按 adapter 输出。**MVP 仅 `claude-code` adapter 真正可执行**，输出 `.claude/skills/<name>/SKILL.md`；`codex`/`generic`/`mcp` 只生成 placeholder（`.harness/generated/<adapter>/`），保留契约与预览边界。

## TypeScript 约定（易踩坑）

- `tsconfig.base.json`：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `NodeNext`。
- `verbatimModuleSyntax` 要求：相对导入必须带 `.js` 扩展名（`from "./foo.js"`，即使源是 `.ts`）；类型导入用 `import type`。
- eslint 强制 `@typescript-eslint/consistent-type-imports = error`（类型 import 必须拆分）。
- 所有包 ESM（`"type": "module"`），target ES2023。

## 测试约定

- 根 `vitest.config.ts` 把 `@hunter-harness/contracts` 与 `@hunter-harness/core` 别名直接指向 `src/index.ts`（不依赖 dist），所以改 core/contracts 源码后测试立即生效，无需先 build。
- 测试文件放 `packages/**`、`apps/**`、`tests/**`，命名 `*.test.ts(x)`。
- apps/web 用 `@testing-library/react` + jsdom。

## 规范文档

- `requirements/hunter-harness-complete-dev/docs/` — 权威设计/协议规范（`00-DESIGN`、`17-PUSH-UPDATE-PROTOCOL`、`18-SERVER-SECURITY-MODEL`、`19-SKILL-IR-AND-ADAPTER-CONTRACT`、`22-FILE-POLICY-MATRIX`、`25-OPENAPI-CONTRACT` 等）。被 eslint 忽略、不参与构建；改协议前应先读对应编号文档。
- `docs/SERVER-DEPLOYMENT.md` — 部署/TLS/secrets/备份/升级回滚。
- `apps/server/openapi/hunter-harness-v1.yaml` — 完整 API 合同。

## 安全边界（硬约束，改代码时必须守住）

- token 只从环境变量、secret file 或浏览器 session storage 读，绝不写入项目文件或 CLI JSON。
- `.harness/state/**`、`.harness/cache/**`、`.codegraph/**` 永不进 proposal。
- 高风险 secret 阻断；中低风险 override 必须留审计证据。artifact 下载/安装必须校验 SHA-256；本地 dirty skill 默认拒绝覆盖。
