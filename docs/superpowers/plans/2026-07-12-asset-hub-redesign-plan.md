# 资产中心改造 分阶段执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-07-12-asset-hub-redesign-design.md`（下称 design）把 Hunter Harness 改造为个人 Agent 资产中心：治理简化（auto-approve）、Skill npm 发布、External Skill、Workflow Family、Public Distribution 拆分、语义索引、Semantic MCP、CI。

**权威规格：** design 全文 + 仓库根 `CONTEXT.md` 术语表。本计划与 design 冲突时以 design 为准并停止报告。design §6 停止条件命中时立即停止。

**执行节奏（已确认）：** 每个 Phase 一个独立执行会话；Phase 内任务顺序执行；**Phase 结束必须 `npm run check` exit 0 才能进入下一 Phase**。Phase 之间不并行。

---

## 执行铁律（每个任务都适用）

1. 先写测试 → 运行确认失败 → 实现 → 运行确认通过 → commit。禁止跳步。
2. 每个任务结束运行该任务的"验证"命令并记录 exit code；失败则停止修复，不得进入下一任务。
3. 不猜测现有代码行为；改前先 Read 目标文件全文。
4. registry snapshot 新字段一律 optional + 默认值，旧快照必须可读（写兼容读测试）。
5. 删除代码（skill-proposal、旧 workflow 域）必须连同其测试、OpenAPI 条目、Web 调用点一起删干净，`rg` 全库确认无残留引用。
6. token/secret 永不写入代码、测试 fixture、文档示例。
7. 每个 Phase 完成后更新 `apps/server/openapi/hunter-harness-v1.yaml` 与 README 对应章节。
8. `packages/cli/test/init.test.ts` 有已知并行 flaky（超时）；`npm run check` 失败时先单跑该文件确认是否 flaky，勿误判。

---

## Phase 0：CI 兜底

**Files:** 新 `.github/workflows/check.yml`

- [ ] **Task 0.1:** 创建 workflow：`on: [push: branches [main], pull_request]`；job：ubuntu-latest + windows-latest 矩阵，Node 24，`npm ci` → `npm run check`。PostgreSQL 实库测试不进 CI。
- [ ] **验证:** 本地 `npm run check` exit 0；推送后 Actions 绿（如无远端权限则本地验证 YAML 语法后报告）。

## Phase 1：治理简化

**Files:**
- 改 `apps/server/src/app.ts`（finalize auto-approve；删 skill-proposals 路由、review-decisions 路由；finalize 请求体 + `base_artifact_id`）
- 改 `apps/server/src/repositories/postgres.ts` 与 memory 实现（finalize 内联 approve、写 `reviews.decision='auto-approved'`、STALE_PUSH 比对）
- 改 `apps/server/src/registry/store.ts`（删 createProposal/reviewProposal）
- 改 `packages/contracts`（finalize schema、STALE_PUSH 错误码、proposal 相关 schema 标记 deprecated 只读）
- 改 `packages/core/src/push/push.ts`（携带 base_artifact_id、STALE_PUSH 提示、成功文案）
- 改 `apps/web`：`app/proposals/*` → 变更历史；`components/console.tsx` 删审核表单；导航文案
- 改 `tests/e2e/harness.e2e.test.ts`、`apps/server/test/registry-api.test.ts`

- [ ] **Task 1.1 契约:** finalize 请求 schema 加 `base_artifact_id: string | null`；新错误码 `STALE_PUSH`。
- [ ] **Task 1.2 服务端 auto-approve:** finalize 成功即事务内生成 artifact + `auto-approved` review 记录 + 更新 `projects.latest_*`；先在 memory 与 postgres repository 测试断言"finalize 后 artifact 立即可查、无 pending proposal"。
- [ ] **Task 1.3 Stale Push Rejection:** finalize 比对 `base_artifact_id` vs `latest_artifact_id`（首推 null 跳过）；不一致 409 `STALE_PUSH`。测试：两个会话交叉推。
- [ ] **Task 1.4 CLI:** push 读 baseline artifact ID 并携带；STALE_PUSH → 冲突类退出码 + 中文提示"先 git pull + npx hunter-harness update"；成功输出 artifact ID。
- [ ] **Task 1.5 删除 skill-proposal 轨:** 路由 + store 方法 + 测试 + OpenAPI + Web 调用点；`rg "skill-proposal|skillProposal|createProposal|reviewProposal"` 全库无业务残留（snapshot 兼容读取除外）。
- [ ] **Task 1.6 Web 变更历史:** `/proposals` 改为按时间线列 auto-approved artifact 与发布事件；删 approve/reject UI；文案更新。
- [ ] **Task 1.7 e2e:** harness.e2e 改为 push→（自动）→update 直通 + STALE_PUSH 用例 + rollback 保持通过。
- [ ] **验证:** `npm run check` exit 0。

## Phase 2：npm 发布基建 + Skill npm Release

**Files:**
- 新 `apps/server/src/npm/publisher.ts`（libnpmpublish 封装：源文件→tarball→publish）、`apps/server/src/npm/config.ts`（scope/token env 读取）
- 改 `apps/server/src/app.ts`（`POST /api/v1/skills/:slug/npm-release`）、`apps/server/src/registry/store.ts`（npmReleases 记录）
- 改 `packages/contracts`（npmReleaseSchema）
- 改 `packages/skill-cli/src/bin.ts`（`install --from npm`，用 pacote）
- 改 `apps/web`：skill 详情 npm 徽章 + 发布按钮
- 依赖：`npm i -w apps/server libnpmpublish`、`npm i -w packages/skill-cli pacote`（装最新版）

- [ ] **Task 2.1 publisher:** 输入已发布版本源文件 + manifest → 生成 `package.json`（name/version/files，无 bin/scripts）→ tarball → publish。单测用注入的 fake publish 函数，断言 tarball 内容与 package.json 字段；不真连 npm。
- [ ] **Task 2.2 路由与状态:** 仅最新已发布版本可发；幂等键 slug+version；结果（published/failed/conflict）写 registry；未配置 token/scope 时返回明确错误码。409 冲突单独状态。
- [ ] **Task 2.3 skill-cli --from npm:** pacote 拉包（可注入 fake registry fixture 测试）→ 校验 `hunter-skill.json` → 复用现有安装/SHA-256 路径。
- [ ] **Task 2.4 Web:** 徽章三态 + 按钮（禁用态含未配置提示）；demo 模式只读。
- [ ] **验证:** `npm run check` exit 0。

## Phase 3：Workflow Family 域

**Files:**
- 改 `packages/contracts`（workflowFamilySchema；旧 workflow/workflowPackage schema 删除）
- 改 `apps/server/src/registry/store.ts` + `app.ts`（新 `/api/v1/workflow-families` 路由组：draft 上传/checks/publish/版本/diff/下载；删旧 `/workflows`、`/workflow-packages` 全部路由与 store 代码）
- 改项目绑定：`PUT /api/v1/projects/:id/workflow-binding` → `{ familySlug, profile, version? }`
- 新 `scripts/upload-workflow.mjs`（sync:harness 构建 → 打 ZIP → 推 draft）
- 改 `apps/web`：workflow 中心重建（Family 列表/详情/上传/publish/npm 状态）；删 WorkflowEditor 与 skill-binding UI
- 改 `apps/server/test/registry-api.test.ts`

- [ ] **Task 3.1 契约:** workflowFamilySchema（族版本 + per-profile bundle manifest）；快照字段 `workflowFamilies`；旧字段兼容读不写。
- [ ] **Task 3.2 服务端域:** draft（multipart per-profile ZIP）→ checks（manifest 存在/profile 完整/文件哈希）→ publish（整族一版本）→ 版本历史/diff/ZIP 下载。测试覆盖：上传两 profile、publish、缺 profile 时 checks 报错。
- [ ] **Task 3.3 删除旧域:** 旧 workflow CRUD + workflow-packages 路由/store/测试/OpenAPI/Web 调用点全删；`rg "workflow-package|workflowPackage|skillBinding"` 无业务残留。
- [ ] **Task 3.4 项目绑定改造:** binding 结构改 Family+Profile；项目详情页绑定 UI 同步。
- [ ] **Task 3.5 上传脚本:** `node scripts/upload-workflow.mjs --family harness --server <url>`；本地对 memory server 集成测试。
- [ ] **Task 3.6 Web 重建:** Family 列表/详情/上传/checks/publish；npm Release 按钮占位（Phase 4 接线）。
- [ ] **验证:** `npm run check` exit 0。

## Phase 4：Public Distribution 拆分

**Files:**
- 新 `packages/workflow-data-harness`（发布名 `@hunter-harness/workflow-harness`：bundles + manifest，纯数据）
- 改 `packages/cli`：package.json files 移除内嵌 bundle；安装时 pacote 解析数据包（默认 latest，`--workflow-version` 钉住）→ 下载至 `.harness/cache/workflow-packages/` → 现有 bundle 加载路径 + SHA-256 校验；无网络无 cache 时明确报错
- 改 `scripts/sync-harness.mjs`（产物输出到数据包目录）、`scripts/smoke-pack.mjs`（两包分别 pack/install）
- 服务端：workflow-family npm-release 路由复用 Phase 2 publisher（包名 `@hunter-harness/workflow-<family>`）

- [ ] **Task 4.1 数据包:** 建包 + sync-harness 输出改道 + manifest；版本号与 Family 版本一致的约定写入包 README。
- [ ] **Task 4.2 CLI 瘦身:** bundle 解析改为数据包来源（测试注入本地 tarball fixture，不连网）；`--workflow-version`；缓存与离线兜底；错误信息中文明确。
- [ ] **Task 4.3 Family npm Release:** 路由 + Web 按钮接线（复用 Phase 2 状态模型）。
- [ ] **Task 4.4 smoke:** smoke-pack 两包验证；e2e 安装路径用 fixture tarball 跑通 init general/java。
- [ ] **验证:** `npm run check` exit 0。

## Phase 5：语义索引

**Files:**
- 新 `packages/contracts/src/knowledge.ts`（knowledge entry Zod 合同 + schemaVersion；**先 Read `harness/harness-knowledge-ingest/scripts/harness_knowledge.py` 的 entry 产出结构反推**，对不上时触发 design §6.1 停止条件）
- 改 `harness/harness-knowledge-ingest/scripts/harness_knowledge.py`（entry 写入 schemaVersion）+ 其 tests
- 改 `packages/core/src/policy/file-policy.ts`（knowledge entries/index.json 可推；sqlite/cache/reports/views/context-packs 排除）+ push 测试
- 新 `apps/server/migrations/004_semantic_index.sql`（semantic_documents + semantic_edges + tsvector GIN）
- 新 `apps/server/src/semantic/indexer.ts`（artifact 落库后异步触发；knowledge entry 直采、rules/CLAUDE.md/AGENTS.md 条目化、archive summary-data 变更记录；按 project 幂等重建）+ memory 实现
- 改 `apps/server/src/app.ts`（`/api/v1/projects/:id/semantic/{overview,knowledge,rules,changes,graph}`、`/api/v1/semantic/search`）
- 改 `apps/web`：项目详情五标签（概览/知识库/规则/变更史/图谱）+ 导出 context pack；图谱用轻量渲染库（如 force-graph 系，装最新版）

- [ ] **Task 5.1 知识合同:** 反推 schema → Python 写 schemaVersion → 双端测试（Python unittest + contracts vitest 用同一 fixture JSON）。
- [ ] **Task 5.2 push 范围:** file-policy 分类 + push 测试（entries 进、sqlite 不进）。
- [ ] **Task 5.3 索引构建:** migration + indexer + 四类解析器；测试用 fixture artifact 断言 documents/edges 落库与幂等重建。
- [ ] **Task 5.4 查询路由:** 五个项目内 endpoint + 跨项目 search（FTS）；memory 与 postgres 双实现。
- [ ] **Task 5.5 Web 五标签:** 概览/知识库（树 + markdown + 搜索）/规则/变更史/图谱 + 导出按钮；demo 模式给静态演示数据。
- [ ] **验证:** `npm run check` exit 0。

## Phase 6：Semantic MCP

**Files:**
- 新 `apps/server/src/mcp/`（`@modelcontextprotocol/sdk` Streamable HTTP，挂 `/mcp`，复用 API token 认证；装最新版 SDK）
- README 增加 agent mcp 配置示例

- [ ] **Task 6.1 MCP server:** 四工具 `search_knowledge` / `get_project_overview` / `get_knowledge_entry` / `list_recent_changes`，全只读，输入输出复用 contracts schema，内部直调 semantic 查询层（不走 HTTP 自环）。
- [ ] **Task 6.2 测试:** SDK client 连 memory server 走通四工具 + 未认证 401。
- [ ] **验证:** `npm run check` exit 0。

## Phase 7：External Skill

**Files:**
- 改 `packages/contracts`（externalSkillSchema）
- 新 `apps/server/src/external/fetchers.ts`（npm registry API + GitHub API，注入 fetch 便于测试；GitHub token 可选 env）
- 改 `apps/server/src/app.ts` + store（`/api/v1/external-skills` CRUD + `/:id/refresh`；每日定时任务比版本、只动 snapshot 不动 curationNote）
- 改 `apps/web`：列表混排 + 外部徽章 + 来源筛选；引入对话框；详情页（README + 安装命令复制 + 策展笔记 + 有更新徽章）

- [x] **Task 7.1 契约与 fetcher:** 两种来源解析 + 元数据快照；fetch 注入 fake 测试。
- [x] **Task 7.2 服务端:** CRUD + refresh + 定时任务（interval 可配置，测试用手动触发）；断言 refresh 不改 curationNote。
- [x] **Task 7.3 Web:** 混排/徽章/筛选/对话框/详情页；demo 模式静态数据。
- [x] **验证:** `npm run check` exit 0。

---

## 完成定义

- 全部 Phase `npm run check` exit 0；OpenAPI 与 README 与实现一致。
- e2e 覆盖：push auto-approve 直通、STALE_PUSH、skill npm release（fake publish）、workflow family 上传→publish→CLI 从 fixture tarball 安装、semantic 索引查询、MCP 四工具。
- `rg` 确认 skill-proposal、旧 workflow CRUD、workflow-packages 无业务残留。
- `docs/BACKLOG.md` 未被本计划实现的条目原样保留。
