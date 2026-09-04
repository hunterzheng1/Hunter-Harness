# Hunter-Harness 与 Hunter-Platform 精简/解耦问题分析

> 分析日期：2026-09-03；执行更新：2026-09-04
> 覆盖仓库：
> - `E:/MyProject/AI Related/Hunter-Harness`（harness 本体，分析基线 HEAD `1ffd714`）
> - `E:/MyProject/AI Related/hunter-platform`（平台 server + web）
>
> 目的：评估"精简、解耦、移除冗余与过度复杂的中间产物，让 agent 专注任务"这一方向的合理性，逐条给出证据与建议。
> **§8 记录了 2026-09-03/04 对 harness 侧可执行项的落地结果与新发现；§9 记录 2026-09-04 平台侧三批次的落地结果。两侧可执行项均已执行完毕。**

---

## 0. 总体结论

大方向**基本合理，且有代码证据支持**。两个仓库存在明显过度工程：

| 仓库 | 体量 | 说明 |
|---|---|---|
| Hunter-Harness | 83 个 skill 文档（13,475 行）+ 40 个 Python 脚本（57,646 行，archive 单模块 11,717 行）+ 68 个测试文件（41,753 行） | 另有一批零引用死代码模块 |
| hunter-platform | server 39 个模块（48,964 行）+ web 22,487 行 + 测试 50,453 行 | 部分上传链路在生产路径上是纯死代码 |

但有若干具体判断需要修正，否则会误删仍在服役的链路。逐条见下。

---

## 1. 去掉分支监控 + 本地不再上传事件 —— ✅ 合理，且摘除很干净（本地侧已执行，d255524）

### 1.1 数据生产链（已查清）

```
harness_events_sync.py（本地 best-effort 钩子，whitelist 字段后 POST）
  → POST /api/v1/projects/:id/runs/events:batch + /runs/heartbeats
  → 平台 runs / run_events 表（migrations 011/019/020）
  → 消费：
      · 项目页 monitor tab（apps/web/components/runs-monitor.tsx，1575 行）
      · 首页 dashboard active_runs 面板（dashboard/overview.ts:79）
      · platform-information 的 branch_monitor view（branch-monitor-query/）
```

### 1.2 支持移除的证据

**本地侧 events_sync 是纯侧路**，无任何硬依赖：

- 调用点全部 best-effort，失败只记 warning、永不阻断：
  - `harness/scripts/harness_events.py:44-56`（append 后唤醒）
  - `harness/scripts/harness_gate.py:2181, 3064-3078`（phase begin/close，注释明确 "never block phase begin"）
  - `harness/scripts/harness_archive.py:6179-6191`（归档终态上报）
  - TS：`packages/cli/src/commands/events-sync.ts`、`bin.ts`、`capabilities.ts`
- events_sync 的三个自属文件（`<state>/meta/events-sync-cursor.json`、`events-sync-quarantine.ndjson`、`state/local/events-sync/nudge.json`）全仓 grep **无其他消费者**。
- 本地生命周期（gate / archive / ledger / context）功能无损，损失仅是平台运行监控可见性。

**平台侧可整目录删除**：

- `apps/server/src/runs/`、`apps/server/src/branch-monitor-query/`
- 表 `runs`、`run_events`（011/019/020，可保留无害或加 drop 迁移）
- web：`runs-monitor.tsx`、`api.ts` 中 RunSummary/RunEventSummary 类型与方法（L139-184、L463-482、L1403-1530）、mock-api runs 段、`console.tsx` 的 active_runs 面板
- contracts：`dashboard.ts` active_runs schema、`plan-event.ts`（需复核无其他引用）

### 1.3 注意点

1. 项目页**默认 tab 就是 monitor**（`project-workspace.tsx:624/641`），删除后须改为 `branchFiles`。
2. branchFiles tab 有弱耦合：`project-workspace.tsx:651-662` 用 `listProjectRuns` 把 change_key 映射为分支显示名（已 try/catch 兜底，删代码即可）。
3. 首页 dashboard `overview.ts:63/79` 依赖 `runStore.listRuns`，需同步裁掉 active_runs 指标。
4. `packages/core` 无直接依赖（已 grep 确认），无需改动。

---

## 2. 项目页只保留 分支文件/项目资料/项目知识 —— ⚠️ 合理，但有一处侦察纠错

### 2.1 各 tab 归属总览

| Tab | 前端组件 | 后端模块 | 去留 |
|---|---|---|---|
| 分支监控 monitor | runs-monitor.tsx | runs/、branch-monitor-query/ | 删（§1） |
| 分支文件 branchFiles ✅ | project-information-panels.tsx + project-workspace 内联 | platform-information (branch_files view)、branch-snapshots/、**branch-version-query/** | 保留 |
| 项目资料 materials ✅ | ProjectMaterialsInformationPanel | project-materials/（读 branch_snapshot_files 派生） | 保留 |
| 项目知识 knowledge ✅ | ProjectKnowledgeInformationPanel | project-knowledge-query/、knowledge-pipeline/、knowledge-bridge/ | 保留（详见 §3.2 决策点） |
| 变更记录 changes | ChangeRecordsInformationPanel | change-records-query/ | 删目录（数据源共享，勿连带删） |
| 版本记录 versions | VersionRecordsInformationPanel (+legacy project-versions-panel) | branch-version-query/（version_records 分支） | **只裁分支，不删目录** |
| API 密钥 apiKeys | project-api-keys.tsx | auth/routes.ts L231-299 四条 CRUD | 删 UI+路由，表与 scope 校验保留 |

### 2.2 关键纠错

**`branch-version-query/` 同时服务 branch_files 与 version_records 两个 view**（`branch-version-query/module.ts:203`：`query.view !== "branch_files" && query.view !== "version_records"` 校验；platform-information/production.ts:16/159 import 其 adapter 装配 branch_files view）。由于 branchFiles 是保留 tab：

- ❌ 不能像 change-records-query 那样整目录删除；
- ✅ 应裁剪其 version_records 分支，保留 branch_files 服务。

**共享存储必须保留**：

- `branch-snapshots/` + migrations/018（`branch_snapshot_*` 四表）——branchFiles、materials 视图与 remote-sync 写入方共用；
- `change_archive_packages`（012 表）——changes tab 只读引用，但**归档上传 + knowledge-pipeline 依赖**，须保留；
- `knowledge_pipeline_*` / `knowledge_ingest_entries`（010/022/023/033）——knowledge tab 生产链；
- `change-projection-worker/`——名字像 changes 专属，实际是 knowledge-pipeline 的 worker，**保留**。

### 2.3 apiKeys 的连锁决策点

删掉 apiKeys tab 后，若 push（分支文件/资料数据来源）与归档上传仍保留，则仍需要 `files:write`/`archive:write`/`progress:write` 等 scope 的 API key 做鉴权（`project_api_keys` 表 + scope 校验是外部 ingest 的鉴权基础）。需要回答：key 从哪来——

- 方案 A：保留一个极简的 key 管理入口；
- 方案 B：CLI 改用登录态鉴权（改动大，不推荐短期做）。

---

## 3. "归档上传不必上传那些文件" —— ❌ 基于误解，需修正

### 3.1 归档 ZIP 实际内容（core-v1 profile，非分支文件）

本地打包权威清单：`harness/scripts/harness_archive.py:_archive_core_file_specs`（L9694-9780）；平台侧 schema：`apps/server/src/archive/package-ingest.ts:30-58,145-164`。

| role | 路径 | 说明 |
|---|---|---|
| summary | `reports/final/summary-data.json` | 必需（缺则打包报错 L9972） |
| spec | `spec/**/*.md` | 设计文档 |
| plan | `plans/**/*.md` | 计划文档 |
| knowledge_candidates | `candidates/knowledge.json` | 可选；**知识沉淀唯一数据源** |
| archive_meta | `archive-meta.md` | 元信息 |
| change_context | `change-context.json` | 变更上下文 |

明确排除：logs、review/test 报告、HTML、缓存、备份、凭据、临时文件、runtime/、evidence/、fixback/（harness-archive/SKILL.md:99, 274-275）。

**归档包本来就不含分支文件**——分支文件走 remote-sync push → `branch_snapshot_*` 表，与归档包是两条独立链路。

### 3.2 真正的关键依赖：知识 tab 吃归档包

"项目知识"数据链（platform-upload 侦察确认）：

```
归档包（candidates/knowledge.json + summary-data.json）
  → POST /archives:ingest（CLI 实际入口，app.ts:3120）
  → acceptArchive 入队 → knowledge_extraction_jobs
  → knowledge-pipeline extractor → knowledge_pipeline_results
  → knowledge-bridge（main.ts:159）→ knowledge_ingest_entries
  → project-knowledge-query → 知识 tab
```

因此正确的问题不是"归档少传哪些文件"，而是**产品决策**：知识 tab 还值不值得保留整条自动沉淀链（knowledge-pipeline + worker-host + change-projection-worker + bridge + semantic 投影 + 对应 jobs 表）？

- 若保留知识 tab：归档包内容基本砍不动，知识管线整套保留。
- 若知识 tab 也可去掉：平台最大的一块精简空间出现（归档上传、知识管线、changes 数据源可整套拆除，只剩"文件/资料浏览器 + 登录/项目/技能管理"）。

### 3.3 平台现有死代码（可先行删除，无需等决策）

- `remote-sync-archive-http/` + `remote-sync-archive-pg/` 整组 + 表 `remote_archive_v2_records`——v2 归档回执登记，无任何 SELECT 消费方，CLI 也不调用（实际归档走 `archives:ingest`）；
- `remote-content-upload` 的 `content-upload`（purpose=`remote_archive`）路由——CLI 无调用方（仅契约/测试）；
- `POST /api/v1/projects/:id/knowledge/ingest`——Hunter-Harness 侧找不到调用方（疑似无生产调用）；
- legacy `GET /changes/:changeKey/archive[/content]`——旧 proposal 文件面（未验证 dashboard 是否调用，删除前复核）。

---

## 4. 中间产物过度设计 —— ✅ 实锤，有明确清单（§4.1/§4.2 可删项已全部执行）

### 4.1 疑似死产物（写了但无自动化读取方）—— ✅ 已全部处理（§8.1）

| 产物 | 位置 | 判定依据 | 处置 |
|---|---|---|---|
| 正式层快照 | `.harness/cache/change-snapshots/<cn>/` | submit M6.5 写入；全仓 grep 仅写入函数与两份 skill 文档 → 纯备份，零读取方 | ✅ 已删（fb75945） |
| durable 内容寻址库 | `--durable-root`（objects/sha256/...） | 可选分支（durable_root=None 整条不启用，archive L8389-8391），无默认消费方 → 准死分支 | ✅ 已删（bd31bbf）；远端 durable 回执（`.remote.json`）是另一条活链路，保留 |
| 独立效率 JSON | `harness_efficiency.py --out` | 无读取方，仅给人（库路径被 archive 消费，属活） | ✅ 已删（ec5b953） |
| legacy 计划收据 | `meta/plan-finalization.json` | v1 停止写入；只读兼容层（roadmap 14 退役候选） | 保留（§4.3 管辖） |
| legacy CI 收据 | `evidence/product-candidate-ci.json` | 仅 `migrate_legacy_candidate_evidence` 迁移路径消费 | 保留（§4.3 管辖） |
| events-sync 三文件 | cursor/quarantine/nudge | 自产自销（§1.2） | ✅ 已随侧路摘除（d255524） |
| before/after manifest | `evidence/archive-manifest-{before,after}.json` | 仅 archive 内部一致性/封存校验；合理但属"流程内中间产物" | 保留（封存校验依赖） |

### 4.2 疑似死代码模块（除自身与测试外零引用，已逐一 grep 验证 .py/.md/.ts）—— ✅ 已删 7/8（98a79d7）

| 模块 | 行数 | 证据 | 处置 |
|---|---|---|---|
| `harness_plan_aggregate.py` | 249 | 无任何调用方/文档引用 | ✅ 已删 |
| `harness_retry.py` | 175 | 零引用 | ✅ 已删 |
| `harness_orchestration.py` | 344 | 零引用 | ✅ 已删 |
| `harness_headless.py` | 37 | 零引用 | ✅ 已删 |
| `harness_test_cleanup.py` | 175 | 仅测试引用 | ✅ 已删 |
| `harness_sync.py` | 407 | roadmap 自证：`docs/harness-improvement-roadmap/04-sync-maintenance.md:28` "没有生产调用方"；sync skill 走 TS 且明确不写 sync runtime | ✅ 已删 |
| `harness_check_gate.py` | 113 | 与根 `scripts/check-gate.mjs` 功能重复；实际 pre-push 钩子用 .mjs 版 | ✅ 已删 |
| `harness_adoption_metrics.py` | — | roadmap 14 一次性验收度量工具（半死，验收后可退役） | 保留（§4.3 管辖） |

### 4.3 只读兼容层（有意保留，删除时机受 roadmap 14 管辖）

- `harness_plan_finalize.py` 的 legacy `plan-finalization.json` 读取；
- `harness_archive.py` 的 legacy `product-candidate-ci.json` → v2 迁移；
- `harness_adoption_metrics.py`（即 roadmap 14 决定"何时能删 legacy 读路径"的度量工具）。

### 4.4 其他张力

- **`.harness/knowledge/` 双轨矛盾**——⚠️ 复核结论：**文档漂移，非代码矛盾**（详见 §8.3）。`update.ts` 不写 knowledge 目录（测试引用是策略边界断言）；rules-sync 是只读审计；仅 `packages/cli/README.md:17` 描述过时，已修正（2949fef）。
- **测试/源码比例**：40 个 .py vs 67 个 test_*.py ≈ 1:1.7；archive 单模块占 6 个测试文件。测试不建议砍，真正该砍的是 §4.2 死模块连带测试（已随删）。

---

## 5. 仓库冗余清理 —— ✅ 有明确目标（harness 侧已执行，98a79d7）

| 路径 | 判断 |
|---|---|
| `dev/null`（15KB，**已被 git 跟踪**） | 垃圾：Windows `> dev/null` 重定向误产物，从跟踪中删除 |
| `release-lock-0.2.70/`（136K）、`.codex-release/`（4.3M）、`.release-artifacts-0.4.13/`（5.9M）、`.sync-staging/`（5.5M） | 发布/运行残留，均 gitignored，可删 |
| `resources/skills/` | 6 月英文旧版 skill 镜像，含已删除的 harness-run/harness-test/harness-package 等，与 `harness/` 中文版严重漂移 |
| `requirements/` | 2026-06 历史需求输入文档，与当前代码无接线，可归档 |
| `dev/`（仅 `dev/null` 一个被跟踪文件） | 整目录可删 |
| `docs/harness-improvement-roadmap/` | 现役路线图档案；已 RESOLVED 批次的旧 issue 文档可精简归档 |
| `CHANGELOG.md`、`CONTEXT.md`、`program.md`、`scripts/`、`docs/adr/` | 现役，保留 |
| `tests/` vs `harness/scripts/tests/` | **不是重复**：前者 Vitest 测 TS/CLI 与仓库脚本，后者 unittest 测 Python harness；两套工具链不同，都保留 |

---

## 6. plan 文档"引用式" vs 纯文字 —— ⚠️ 不建议回退，建议改渲染层（第 1 条已落地）

### 6.1 格式演变事实（git 历史）

| 时间 | Commit | 事件 |
|---|---|---|
| 2026-08-16 前 | — | 旧格式：agent 手写四份叙事 Markdown（模板现仍留于 reference.md「仅作内容清单参考」） |
| 2026-08-16 | `10b149b` | 渲染器首次出现，64 位全哈希逐引用点内联 |
| 2026-08-21/22 | `b23c16c` → `654ff20`（0.3.0） | 手写路径删除，派生渲染成为唯一产出 |
| 2026-08-25 | `8255404` | 补救 1：ref 带人类可读标签 |
| 2026-08-30 | `e211e38` | 补救 2：短哈希化。commit message 自证：*"实测 demo 归档 plan.md 约 40% 字节是纯哈希、同一批需求在 15 个引用点全量内联"* |

**用户可读性抱怨与官方实测一致**。当前格式（HEAD）：每个任务除 objective 一句话外，其余是 `负责阶段/影响路径/依赖任务/决策引用/关联场景/需求引用(requirement:a1b2c3d4)/归属文件(ownership:...)` 清单；且文本经 `markdown()` 全量转义（`\[`、`\\`、`<br>`）进一步伤可读性。

### 6.2 关键事实：机器硬契约在 JSON，不在 Markdown

- 门禁/账本只读 **meta/scenario-manifest.json / implementation-checkpoints.json / plan-profile.json**（gate L2285-2296、ledger L1705/1766，经 `harness_plan_finalize.unpack_v2_scenario_manifest` 解包）；
- plans/*.md 被定位为**人读层**（e211e38 commit message 原话）；
- 唯一解析 Markdown 的机器消费者：`harness_knowledge_candidates.py:795 build_plan_candidates()` 从归档 `plans/*.md` 解析回知识候选。

### 6.3 效率判断

- 引用式对"门禁确定性/防漂移"有价值（单一真相源 + 内容哈希绑定），但对"agent 执行效率"的提升有限——门禁不依赖它；
- 代价是明确的：叙事密度低 + token 膨胀 + 人读性差；
- **回退手写纯文字的代价**：丢哈希绑定/防漂移，断知识候选回解析，与整条 v2 证据链冲突 → 不建议回退。

### 6.4 建议做法：改渲染层而非格式 —— ✅ 第 1 条已落地（2949fef）

渲染器集中在 `packages/core/src/plan-artifacts/publication/module.ts:127-310`（renderDesign/renderPlan/renderScenarios/renderCompatibility），改动局部；测试锚点 `packages/core/test/plan-artifact-publication.test.ts`（断言中文标签，改格式需同步）。

1. ~~全空的引用行直接省略（现在渲染"决策引用：无"这类噪声行）~~ ✅ 已落地：空 refs 返回 `""` 并在 join 前 filter；已验证 `harness_knowledge_candidates.py` 解析器只读 `### ` 标题与 objective 文本，不受影响；
2. 引用清单折叠或移至文末附录，正文恢复叙事段落（背景/动机/验证方式——旧手写模板有、派生版丢了）——未做；
3. 更进一步：四件套（design/plan/implementation-detail/test-scenarios）内容重叠高，可评估收敛为两件套——未做。

---

## 7. 补充建议与执行顺序

> 2026-09-04 状态：第 1、2、5 条的 harness 侧部分已执行（§8.1）；平台侧三批次已全部执行（§9）。

1. ~~**先删已确认死代码**（零风险热身）：平台 `remote-sync-archive-*` 整组 + `remote_archive_v2_records` 表；harness 死模块清单（§4.2）+ `dev/null` + 发布残留（§5）。~~ harness 侧 ✅（98a79d7）；平台侧 ✅（22783e4）。
2. ~~**砍监控链**：本地 events_sync 调用点（4 处）~~ ✅（d255524）+ 平台 runs/、branch-monitor-query/ + 对应 web 组件——平台侧 ✅（bd3f8a2）。
3. ~~**砍 tab 按"视图分支"而非"目录"**：change-records-query 可整删；branch-version-query 只能裁 version_records；platform-information 裁 view；apiKeys 需先定鉴权方案（§2.3）。~~ 平台侧 ✅（d7352be；apiKeys 按用户决策保留）。
4. **知识管线去留单独拍板**（§3.2）：平台最大精简空间，取决于知识 tab 是否保留自动沉淀。→ **用户决策：整组保留，不精简。**
5. ~~**plan 文档改渲染器**，不回退格式~~ ✅ 第 1 步已落地（2949fef）；同步精简 skill 文档自身（13.5k 行，含大量 `<!-- @include -->` 与交叉引用，agent 每次加载都付 token 成本）——未动。

---

## 8. 执行结果（2026-09-03/04，harness 侧）

> 平台侧结果见 §9。以下记录 harness 侧已落地项、复核纠错、以及执行过程中的新发现。

### 8.1 已落地项

| 实验 | 内容 | 提交 | 净变更 |
|---|---|---|---|
| exp1 | §4.2 七个死模块 + 连带测试 + §5 仓库残留（dev/null、resources/skills、requirements/、发布残留） | 98a79d7 | -3,373 行 |
| exp2 | §1 本地 events-sync 侧路摘除（4 个调用点 + 3 个自属文件 + TS 命令面） | d255524 | -2,734 行 |
| exp3a | §4.1 `harness_efficiency.py --out` 死旗标 | ec5b953 | -5 行 |
| exp4+5 | §4.4 README rules-sync 描述修正 + §6.4-1 渲染器省略空引用行 | 2949fef | -33 行 |
| exp6a | §4.1 正式层快照（snapshot_change_formal_layer + M6.5 步骤 + 测试） | fb75945 | -118 行 |
| exp6b | §4.1 本地 durable 内容寻址库分支（write/restore/CLI 旗标/子命令 + 孤儿 helper） | bd31bbf | -481 行 |

**合计**：56 文件，+160/-6,723（净 -6,563，不含评估器脚本）；`repo_python_loc` 50,556 → 48,741（-1,815，-3.6%）；死模块计数 8 → 0（保留 adoption_metrics 属 §4.3 管辖）。

**验证基线**：Python 安全档 58/58 模块全绿（多轮）；TS 2,241/2,242（1 例为预存环境失败，与本批无关）。

### 8.2 复核纠错（分析文档自身的过时判断）

- **§4.4 双轨矛盾不成立**：逐文件复核发现 `update.ts` 并不写 `.harness/knowledge/project-local`（update.test.ts 中的路径引用是"客户端不得生成"的策略边界断言，不是生产行为）；rules-sync 实际是只读审计，候选落在 `.harness/state/local/rule-candidates.json` 由 rules-review 消费。唯一过时的是 `packages/cli/README.md:17` 的描述。**教训：执行前必须逐条对当前代码复核，分析快照会漂移。**
- **durable 有两个同名概念**：本地内容寻址库（死分支，已删）与远端归档 durable 回执（`.harness/state/local/archive-packages/<key>.remote.json`，republish 冲突检测依赖，活）。删除时必须区分，本次保留了后者及 `remote_durable_archive_durability`/`persist_archive_durability` 整条远端耐久性投影链。

### 8.3 新发现：评估基础设施竞态（执行副产物，已修复）

执行采用 AutoLoop 会话（每实验 pre → eval → keep/discard），评估器跑全量安全档测试做护栏。过程中暴露并修复了 4 个负载敏感的基础设施缺陷——它们此前把"环境噪声"误判为"代码回归"，是全量测试偶发红的根因：

| 缺陷 | 症状 | 修复 |
|---|---|---|
| STARTING 会话用稳态宽限期判心跳丢失 | detached worker 冷启动 >2s 被误判 HEARTBEAT_LOST（~1/7 概率） | STARTING 改用 startup_grace（10s）（caee9e7） |
| launcher 失败测试中 workerPid/workerIdentity 从未持久化 | 10s STARTING 窗口后轮询校验空身份 → WORKER_IDENTITY_MISMATCH | worker-handoff.json sidecar（caee9e7） |
| AssignProcessToJobObject 负载下瞬时失败直接杀子进程并抛异常 | 整个测试 runner 中止（IDENTITY_UNVERIFIABLE） | 5 次重试 + 20ms 退避（caee9e7） |
| 短命子进程在 job 分配前退出仍走失败路径 | `python -c` 型子进程偶发崩溃 | 识别良性竞态，直接放行无 proof 返回（73aa530） |

修复后：runtime 模块 20/20 压测全绿（修复前 1/7 概率红）；全量套件连续两轮 58/58（修复前连续 3 轮失败）。

另确认一类环境噪声签名：子进程退出码 `0xC0000409`（STATUS_STACK_BUFFER_OVERRUN，3221225794）在系统负载高时成批出现（曾同时有 24 个 stale vitest/node 僵尸进程抢占资源）。**判定模式：模块单独跑 N/N 通过、仅在全量 runner 上下文失败 → 环境问题，不是代码回归。**

### 8.4 执行耗时分析（为什么这么久）

纯代码变更量不大（净 -6,563 行），但端到端耗时数倍于预期，主因：

1. **全量评估的单价高**：安全档 58 模块串行 + BELOW_NORMAL 优先级 + 每模块 600s 超时，一轮约 8 分钟。环境噪声导致同一实验反复重评（exp2 因评估器误报重跑了 3 轮才定位到是基础设施问题而非代码问题）。
2. **基础设施调试绕行**：§8.3 的 4 个竞态不在原计划内，每个都需要"稳定复现 → 定位 → 修复 → 压测验证"的完整循环（20x 压测本身就要跑 20 轮 runtime 模块）。这部分时间约占全程三分之一，但产出是永久性的评估可靠性提升。
3. **基线卫生开销**：AutoLoop baseline 会记录工作树现状，实验代码必须 stash/restore 循环以保证基线干净；期间还发生过 stash 误吞评估器脚本（后改为 git 跟踪提交 c1cb7cd）。
4. **工具链边角**：`autoloop keep --commit` 在工作树有变更时偶发不建提交（改为手动 git commit）；`finalize` 要求干净树（需先 stash）；一次全量验证因命令链超时被杀（日志截断在第 20 模块，重跑确认 58/58）。

### 8.5 遗留事项

- §4.3 只读兼容层（plan-finalization / product-candidate-ci / adoption_metrics）——受 roadmap 14 管辖，未动；
- §6.4-2/3（引用清单折叠、四件套收敛）——渲染层增强，未动；
- §8.3 的 4 个基础设施修复已提交但建议后续在 roadmap 中登记为正式 issue 归档；
- ~~平台侧全部条目（§2/§3/附录 B）——待平台仓库单独执行。~~ → 已执行，见 §9。

---

## 9. 执行结果（2026-09-04，平台侧）

> 仓库 `hunter-platform`，AutoLoop 会话 `platform-simplification-batch1`（3 实验 kept / 0 discarded，已 finalize）。
> 指标 `platform_loc` = apps/server/src + apps/web 生产源非空非注释行数。基线 64,688 → 57,778（**-6,910，-10.7%**）。

### 9.1 已落地批次

| 批次 | 内容 | 提交 | platform_loc |
|---|---|---|---|
| Batch 1（§3.3 死代码） | remote-sync-archive-http/-pg 模块与路由、content-upload 路由（保留 file-upload）、`remote_archive_v2_records` 表（migration 036）、contracts 导出与 OpenAPI 路径/模式、GC liveness probe | `22783e4` | 64,688 → 64,020 |
| Batch 2（§1 监控链平台侧） | runs/、branch-monitor-query/ 模块、dashboard active_runs、legacy change archive 读取端点、web 运行监控页签与 mock | `bd3f8a2` | 64,020 → 59,315 |
| Batch 3（§2 页签裁剪） | change-records-query 全模块（5 文件 + 3 测试 + 2 fixtures）；branch-version-query 只裁 version_records 投影/diff（**branch_files 服务保留**，push 链路依赖）；contracts/openapi schema 收窄（View/ContentType/Sort + 5 个 item/detail schema 删除）并重算 sha256 冻结；web 工作台收敛为 分支文件/项目资料/项目知识/API 密钥 四页签 | `d7352be` | 59,315 → 57,778 |

### 9.2 用户决策记录

- **知识管线（§3.2）整组保留**：知识 tab 依赖归档包自动沉淀，是平台核心价值，不在精简范围；
- **apiKeys 页签保留（§2.3 跳过）**：外部 ingest 鉴权基础，方案 A（极简 key 管理入口）即现状。

### 9.3 验证收据

- 每批次：lint + typecheck + 受影响测试文件全绿；
- Batch 3 全量 fast 套件：5 文件失败均为已知负载 flake（PDA / platform-information-export-local-cas / remote-content-upload-pg / external-skill-detail / bounded-rendering 超时）——失败集合漂移、仅超时无断言错误、单独跑通过、与改动无导入依赖；
- docker build（server + web）成功，三容器 healthy；
- harness CLI 冒烟对本地实例（3002）全过：push（ok）、archive upload（durable + knowledge ready）、knowledge query（remote receipt）；
- 活体验证：`change_records`/`version_records` 视图返回 400（已从枚举移除），`branch_files`/`project_knowledge` 正常返回；
- web 编译产物确认页签为 `{分支文件, 项目资料, 项目知识, API 密钥}` 四项（语义总览面板中的"变更记录"文案属另一域，保留）。

### 9.4 平台侧新发现

- **guardian 负载 flake 恶化**：满负载下 export-local-cas 单独跑也 8/19、5/19 漂移失败（guardian powershell 冷启动 13-20s vs 30s testTimeout），与 harness 侧 §8.3 同类环境噪声签名。根治方向：guardian 进程池预热或该类测试单独提高 testTimeout（独立基础设施提交）；
- **残留临时目录**：一次满负载运行后 `hunter-vitest-*` 临时目录累积 33 个（EBUSY rmdir 是 guardian 竞态，非孤儿进程锁定）；
- **autoloop keep --commit 同款问题**：工作树有变更时偶发不建提交，平台侧同样改为手动 git commit + `autoloop eval` + `autoloop keep`。

### 9.5 平台侧遗留事项

- guardian 负载 flake 根治（进程池预热 / 单独 testTimeout）——独立基础设施提交；
- §4.3 只读兼容层与 §6.4 渲染层增强——同 harness 侧，受 roadmap 管辖。

---

## 附录 A：关键文件索引

平台侧（2026-09-04 更新：标注删除的条目已随 §9 三批次移除）：

- `apps/server/src/app.ts`（2638-3290, 4502-4516）——全部上传路由与注册点
- `apps/server/src/archive/package-ingest.ts`（30-164, 835-1115）——core-v1 包 schema/白名单/入库
- `apps/server/src/remote-sync-pg/http-service.ts` + `push-files.ts`——push commit → branch snapshots
- ~~`apps/server/src/change-records-query/pg-source.ts`（271-380）——变更记录 tab 消费~~ → 已删（`d7352be`）
- `apps/server/src/project-materials/pg-source.ts`（200-290）——资料 tab = branch_snapshot_files 派生
- `apps/server/src/knowledge-bridge/index.ts`——pipeline results → knowledge_ingest_entries
- `apps/web/components/project-workspace-shell.tsx`（L9-15 sections）与 `project-workspace.tsx`（L917-1028 slots）——sections/slots 已收敛为四页签（`d7352be`）

harness 侧：

- `harness/scripts/harness_archive.py`（_archive_core_file_specs L9694；build_archive_package L9950）
- `harness/scripts/harness_events_sync.py`（调用点 §1.2）
- `harness/scripts/harness_plan_finalize.py`（只读兼容层）
- `packages/core/src/plan-artifacts/publication/module.ts`（plan 文档渲染器）
- `packages/cli/src/push-pull-adapter/remote-http.ts`——唯一生产上传调用方

## 附录 B：遗留未验证项

> 2026-09-04 更新：前四项已在平台 Batch 3 执行中逐条复核并处理；第五项随 Batch 2 监控链移除一并消解。

- ~~`packages/contracts` 中 change_record/version_record schema 是否被 export 交叉引用（删除前 grep 复核）~~ → 已复核并删除（Batch 3，`d7352be`）；
- ~~`apps/web/app/projects/[id]/` 下旧版页面文件是否仍被路由引用~~ → 已复核，无残留引用（Batch 3）；
- ~~legacy `GET /changes/:changeKey/archive[/content]` 是否被 dashboard 调用~~ → 已随 Batch 2 删除（`bd3f8a2`）；
- ~~平台 `POST /knowledge/ingest` 是否有运维脚本调用~~ → 知识管线整组保留（用户决策），端点仍在役；
- ~~branch-monitor / runs ingest 的外部真实调用方（推测为本地 harness events-sync，未在 Hunter-Harness 源码中逐行验证完整链路）~~ → 本地侧已摘除（d255524），平台侧 runs/branch-monitor-query 已删（bd3f8a2），链路两端均已消解。
