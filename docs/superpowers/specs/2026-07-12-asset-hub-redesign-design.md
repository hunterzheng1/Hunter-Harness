# Hunter Harness 资产中心改造设计

- 日期：2026-07-12
- 状态：已确认（grilling 会话逐条敲定），可进入实现计划
- 目标读者：实现工程师，以及 Composer 2.5 等低成本编码模型
- 配套计划：`docs/superpowers/plans/2026-07-12-asset-hub-redesign-plan.md`
- 术语表：仓库根 `CONTEXT.md`（本次已更新，冲突时以 CONTEXT.md 为准）
- 跨期未做事项：`docs/BACKLOG.md`

## 1. 产品转向

Hunter Harness 从"服务端治理平台"（人工审核为核心）转向"**个人 Agent 资产中心**"：

- **技能中心**：自有 Skill 上传/维护/版本化 + 发布到 npm + 第三方 Skill 策展展示。
- **工作流中心**：Workflow Family（harness 等）像 Skill 一样在服务端管理、版本化、经 npm 分发。
- **项目语义中心**：CLI push 上报项目业务语义（知识库/规则/变更史/约定），服务端派生语义索引，经页面（浏览/搜索/图谱）与 Semantic MCP 消费。

安全底线不变：token 不入库不入文件、SHA-256 校验、审计事件、敏感信息扫描全部保留。

## 2. 非目标

1. 不做多租户/多用户权限体系；单 owner 模型。
2. 不恢复人工审核 UI；未来若需要以开关形式回加（见 §4.1）。
3. 不做 External Skill 的二次分发：服务端永不托管、不安装第三方内容。
4. 不引入图数据库、不做 LLM 实时推断的"智能关联"图谱。
5. 不做服务端 CD 自动化（记入 BACKLOG）。
6. 语义索引 AI 增强（embedding/pgvector、去重建议、promote 建议）本期不做（记入 BACKLOG，约束已定：只做派生不回写）。
7. 不改 harness/ 源树的 authoring 模型（canonical + overlay + 本地构建不变）。
8. Bundle-Internal Skill（harness-plan 等）不进技能中心。

## 3. 已确认决策汇总

| # | 决策 | 要点 |
|---|---|---|
| D1 | 审核全面移除 | 技能侧**删除** skill-proposal 遗留轨；项目侧 push finalize 后服务端 **auto-approve** 生成 artifact。CLI push/update 协议、SHA-256、事务回滚全部保留。审核队列页改造为**变更历史（Change History）**。`reviews` 表保留，写入 `auto-approved` 记录，保未来开关可逆 |
| D2 | Skill npm 包 = 纯数据包 | `@<scope>/<slug>`，scope 由服务端环境变量配置；内容 = 已发布版本源文件 + `hunter-skill.json`；无 bin。安装逻辑集中在 skill-cli：`install <slug> --from npm`（默认仍走 server） |
| D3 | npm Release Action | 手动按钮、仅对 registry 最新已发布版本；token 只从服务端 env/secret file 读；失败不回滚 registry、状态可重试；npm 409 → 提示先发新 registry 版本，绝不 force；发布记录（版本/时间/结果）入 registry 供展示 |
| D4 | External Skill | 来源：npm 包名 + GitHub URL；录入即抓元数据快照（名称/描述/版本/README/安装命令/license）+ owner 策展笔记；更新 = 手动刷新按钮 + 每日定时任务（只比版本号、打"有更新"徽章、不动策展笔记）；同列表展示带"外部"徽章；详情页只有 README + 官方安装命令复制，无上传/发布/下载；**不进** skill-cli 与 npm 发布链路 |
| D5 | Workflow Family | 一个实体 = 一个族（如 `harness`），族下多个 Profile 变体（general/java/…）；**一个版本号覆盖整族**；上传物 = 本地构建好的 per-profile 自包含 bundle（最终字节，Bundle Fidelity），服务端不做 overlay 合并；发布链路同技能：draft → checks → Direct Publish → 版本/diff/下载；**废弃删除**旧 workflow 元数据 CRUD（skill binding 清单）与 workflow-package 半成品域；项目绑定改为 Family + Profile |
| D6 | Public Distribution 拆分 | CLI 变薄（只有逻辑），每个 Family 发数据包（如 `@hunter-harness/workflow-harness`）；数据包 semver 与 Family 版本一一对应；安装默认取最新，`--workflow-version` 可钉住；链路：本地 authoring → 构建 → 上传服务端 → Direct Publish → npm Release Action → 数据包上 npm → `npx hunter-harness` |
| D7 | push 唯一上传通道 + 语义索引 | 不建任何网页手动上传/编辑项目知识入口；服务端对最新 artifact 派生**语义索引**（可随时重建，非第二数据源）；想进语义中心的信息必须进受管文件集走 push |
| D8 | 单一抽取原则 | 本地 Python `harness_knowledge.py` 是唯一知识抽取器，服务端不重新实现；`.harness/knowledge/entries/**/*.json` + `index.json` 进 push 范围（sqlite/cache/reports 排除）；服务端直采结构化条目，无知识索引的项目才退化为解析原始文件；条目 JSON 结构上升为 `packages/contracts` Zod 合同（带 schema 版本） |
| D9 | 查询双层 | 项目内 agent 查本地 SQLite MCP（不变）；**跨项目**查服务端 Semantic MCP |
| D10 | First-Push Registration | 项目只能由首次 CLI push 自动注册（`projects:resolve`），网页不提供创建；网页可编辑显示名/描述/绑定 Family+Profile/归档（软删除）；多设备靠 `.harness/project.yaml` 随 git 走 |
| D11 | Stale Push Rejection | push finalize 携带本地 baseline 对应的服务端 artifact ID；非最新则拒绝，CLI 提示先 `git pull` + `update`；不做锁、不做服务端合并 |
| D12 | Semantic MCP | 内建于 apps/server（HTTP transport + API token 认证）；v1 四个只读工具：`search_knowledge`、`get_project_overview`、`get_knowledge_entry`、`list_recent_changes`；写永远走 CLI push |
| D13 | CI only | GitHub Actions 跑 `npm run check`（main + PR 必须全绿）；服务端 CD 与内容发布自动化不做 |

## 4. 域设计

### 4.1 治理简化（Phase 1）

**服务端**：

- `POST /api/v1/projects/:projectId/proposal-sessions/:id:finalize` 成功后，同一事务内自动执行现有 approve 逻辑（复用 `reviewProposal` 的写 artifact 路径），`reviews` 表写入 `decision='auto-approved'` 审计记录。
- 删除 skill-proposal 路由（`GET/POST /api/v1/skill-proposals`、`POST .../review`）及 `RegistryStore.createProposal/reviewProposal`；registry snapshot 中的 `proposals` 字段做一次性迁移清空（保留 schema 兼容读取旧快照）。
- `POST /api/v1/proposals/:proposalId/review-decisions` 路由删除（无人工审核）。
- Stale Push Rejection：finalize 请求体新增 `base_artifact_id`（nullable，首推为 null）；服务端比对项目 `latest_artifact_id`，不一致返回 409 语义错误码 `STALE_PUSH`。

**CLI**（`packages/core/src/push/push.ts`）：

- push 从 baseline 读取上次 update/首推记录的 artifact ID，finalize 时携带。
- 收到 `STALE_PUSH` → 退出码沿用冲突类退出码，提示"服务端已有更新的推送，请先同步（git pull + npx hunter-harness update）再推"。
- push 成功输出直接包含新 artifact ID（不再提示"等待审核"）。

**Web**：

- `/proposals` 与 `/proposals/[id]` 改造为**变更历史**：按项目/时间线列出 auto-approved artifact 与 skill/workflow 发布事件；删除 approve/reject 表单。
- 导航文案"审核队列"→"变更历史"。

### 4.2 技能中心：npm 发布（Phase 2）

**服务端新模块** `apps/server/src/npm/`：

- 发布器：用 `libnpmpublish`（程序化、不 spawn shell）；输入 = registry 已发布版本的源文件 + manifest，打包为 npm tarball（`package.json` 由服务端生成：name=`<scope>/<slug>`、version=registry semver、files=源文件+manifest、无 bin/scripts）。
- 配置：env `HUNTER_HARNESS_NPM_SCOPE`（如 `@hunter-skills`）、`HUNTER_HARNESS_NPM_TOKEN` 或 `HUNTER_HARNESS_NPM_TOKEN_FILE`。未配置时 API 返回明确错误，页面按钮禁用并提示。
- 路由：`POST /api/v1/skills/:slug/npm-release`（幂等键=slug+version）；`GET` 状态随 skill 详情返回。
- npm 发布记录写入 registry snapshot：`{ version, publishedAt, status: published|failed|conflict, packageName, error? }`。

**skill-cli**：`install <slug> --from npm`——通过 `pacote` 按 `<scope>/<slug>` 拉 tarball，校验 manifest 后走现有安装路径（SHA-256 校验逻辑复用）。

**Web**：skill 详情页加 npm 状态徽章（未发布/已发布 vX/失败）+ "发布到 npm"按钮（仅最新已发布版本可用）。

### 4.3 External Skill（Phase 7）

**契约**（`packages/contracts`）：`externalSkillSchema`：`{ id, source: { type: 'npm'|'github', ref }, snapshot: { name, description, version, readme, installCommand, license, fetchedAt }, curationNote, tags, updateAvailable, lastCheckedAt }`。

**服务端**：

- fetcher：npm registry API（`GET https://registry.npmjs.org/<pkg>`）与 GitHub API（repo + latest release + README），无认证即可读公开数据；GitHub 可选 env token 提升限额。
- 路由：`POST /api/v1/external-skills`（录入）、`GET`（列表）、`PATCH`（策展笔记/标签）、`POST /:id/refresh`（手动刷新）、`DELETE`。
- 每日定时任务：遍历比对上游版本，设置 `updateAvailable`；只改 snapshot 与徽章，绝不动 `curationNote`。
- 存储：registry snapshot 新增 `externalSkills`。

**Web**：技能中心列表混排 + "外部"徽章 + 来源筛选；"引入外部技能"对话框（粘贴 npm 包名或 GitHub URL）；详情页 = README 渲染 + 官方安装命令复制 + 策展笔记编辑 + "有更新"徽章与 release 链接。

### 4.4 Workflow Family（Phase 3）

**契约**：`workflowFamilySchema`：`{ slug, displayName, description, tags, versions: [{ version, publishedAt, profiles: [{ profile, bundleManifest, artifactRef }] }], draft?, npmReleases }`。

**服务端**：

- 路由组 `/api/v1/workflow-families`：列表/详情/`POST .../draft`（multipart 上传 per-profile bundle ZIP）/`POST .../checks`（bundle 结构完整性校验：manifest 存在、profile 完整、文件哈希）/`POST .../publish`（Direct Publish，整族一个版本号）/版本历史/diff/ZIP 下载。
- **删除**旧 `/api/v1/workflows` CRUD 与 `/api/v1/workflow-packages` 全部路由及对应 store 代码、快照字段（一次性迁移：旧数据不保留——现有 workflow 清单为半成品无生产数据）。
- 项目绑定：`PUT /api/v1/projects/:id/workflow-binding` 改为 `{ familySlug, profile, version? }`。

**上传脚本**：仓库根新增 `scripts/upload-workflow.mjs`——调 `sync:harness` 构建后将 `resources/harness/bundles/<profile>/**` 打 ZIP 推送 draft，一条命令完成"构建→上传"。

**Web**：工作流中心重建为 Family 列表 → Family 详情（版本历史、profile 视图、diff、上传 draft、checks、publish、npm 状态）；删除旧 WorkflowEditor/skill-binding UI。

### 4.5 Public Distribution 拆分（Phase 4）

- 新包 `packages/workflow-data-harness`（发布名 `@hunter-harness/workflow-harness`）：内容 = 两个 profile 的 bundle + manifest，纯数据无代码；版本号与 Family 版本一致。
- `packages/cli`（`hunter-harness`）移除内嵌 bundle（`resources/harness/bundles` 不再进 npm files）；安装时用 `pacote` 解析数据包（默认 latest，`--workflow-version` 钉住），下载到 `.harness/cache/workflow-packages/` 后走现有 bundle 加载路径；SHA-256 校验 manifest。
- 离线兜底：数据包已在 npm cache 时可离线复装；无网络且无 cache 时报明确错误。
- Workflow Family 的 npm Release Action 复用 §4.2 发布器（同 token/scope 配置，包名固定 `@hunter-harness/workflow-<family>`）。
- smoke-pack 更新：两个包分别 pack/install 验证。

### 4.6 语义索引（Phase 5）

**知识合同**：`packages/contracts/src/knowledge.ts`——从 `harness/harness-knowledge-ingest/scripts/harness_knowledge.py` 现产出的 entry JSON 反推 Zod schema（含 `schemaVersion` 字段）；Python 侧在 entry 中写入 `schemaVersion`；合同变更须同步两端。

**push 范围**（`packages/core/src/policy/file-policy.ts`）：

- `.harness/knowledge/entries/**` 与 `.harness/knowledge/index.json` → 受管可推（USER_DIFF 同级策略）。
- `.harness/knowledge/{index.sqlite,cache/,reports/,views/,context-packs/}` → 排除（GENERATED_CACHE 同级）。

**服务端**：

- 新 migration `004_semantic_index.sql`：`semantic_documents`（project_id, kind: knowledge_entry|rule|agent_instruction|archive_record, path, title, status, type, tags, content_text, source_artifact_id, payload JSONB）+ FTS（PostgreSQL `tsvector` GIN；memory 实现用内存全文匹配）。
- 索引构建器 `apps/server/src/semantic/indexer.ts`：artifact 落库后异步触发；解析器按 kind 分发——knowledge entry 直接按合同 parse；rules/CLAUDE.md/AGENTS.md 抽标题与条目；`.harness/archive/**/summary-data.json` 抽变更记录。整表按 project 重建（幂等，删旧插新）。
- 查询路由：`GET /api/v1/projects/:id/semantic/{overview,knowledge,rules,changes,graph}` + `GET /api/v1/semantic/search`（跨项目）。
- graph 数据：节点 = semantic_documents；边 = markdown 内链解析 + frontmatter 标签共现 + 变更记录引用文件，构建期物化到 `semantic_edges` 表。

**Web**：项目详情页五标签：概览 / 知识库（文档树 + markdown 渲染 + 搜索）/ 规则 / 变更史（时间线）/ 图谱（轻量前端渲染库，数据来自 graph endpoint）+ "导出 context pack"按钮。

### 4.7 Semantic MCP（Phase 6）

- `apps/server/src/mcp/`：用 `@modelcontextprotocol/sdk` 的 Streamable HTTP transport 挂在 Fastify（如 `/mcp` 路径），认证复用现有 API token 中间件。
- 工具（全只读，输入输出用 contracts Zod schema）：
  1. `search_knowledge(query, project?, status?, type?, limit?)`
  2. `get_project_overview(project)`
  3. `get_knowledge_entry(id)`
  4. `list_recent_changes(project, limit?)`
- 文档：README 增加 agent mcp 配置片段示例。

### 4.8 CI（Phase 0）

`.github/workflows/check.yml`：push 到 main + PR 触发，Node 24，`npm ci && npm run check`。PostgreSQL 实库测试不进 CI（保持本地手动，避免 CI 泡菜化）。

## 5. 兼容与迁移

- registry snapshot：新增字段全部 optional + 默认值，旧快照可直接读；`proposals`/`workflows`/`workflowPackages` 字段读取兼容但不再写入，迁移任务清空。
- installed state / context index 版本不变（本次不动安装投影格式）。
- e2e：`tests/e2e/harness.e2e.test.ts` 的 review-decisions 步骤改为断言 auto-approve 后 artifact 立即可拉；新增 Stale Push Rejection 用例。
- `apps/server/test/registry-api.test.ts` 删除 skill-proposal 用例，补 npm-release、workflow-family、external-skill、semantic 用例。
- OpenAPI `apps/server/openapi/hunter-harness-v1.yaml` 每阶段同步更新。

## 6. 停止条件（实现中遇到即停，报告后再继续）

1. 发现 `.harness/knowledge` entry 实际结构与设计假设不符、无法定出稳定合同。
2. Stale Push Rejection 与现有事务恢复菜单出现语义冲突。
3. libnpmpublish/pacote 在 Windows + 私有 scope 下有无法绕过的行为差异。
4. 删除旧 workflow 域时发现有未预期的依赖方。
5. 任何需要引入新的持久化系统（图数据库、消息队列）的诱惑——按设计这不应发生。
