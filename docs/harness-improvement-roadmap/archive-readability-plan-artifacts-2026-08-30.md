# 归档可读性与 Plan 产物投影分层

> 来源：sales-insight-agent 项目 `demo-skeleton` 归档目录（`.harness/archive/2026-08-30-demo-skeleton/`）人工审阅 + hunter-platform 服务端消费面核查
> 日期：2026-08-30
> 报告人：pi（主会话实测分析）
> 版本：hunter-harness 0.4.9
> 关联：前四份阶段问题报告 · [sync 与规则自动采纳](./sync-and-rules-auto-adoption-2026-08-30.md)

## 修复状态（2026-08-30，hunter-harness 0.4.10 / core 0.1.6）

| 条目 | 状态 | 修复点 |
|---|---|---|
| 人读层引用点全量内联哈希 | ✅ 已修 | `renderRequirementRefs` / `renderOwnershipRefs` 改为「一句话标签 + 8 位短哈希」；完整 ID 只在 design.md 注册表出现一次（`harness_knowledge_candidates.py` 的消费格式不变） |
| 元数据标签英中混杂 | ✅ 已修 | plan.md / test-scenarios.md 的元数据标签全部中文化；已核实无机器消费者（knowledge-candidates 只消费 design.md 的 Requirements/Risks/Invariants 节与 plan.md 的 `### T<n>` 标题，均未动） |
| `.publication-staging` 混进归档 | ✅ 已修 | `fs-publication-port` 在 committed / rolled_back 后清理 staging（幂等重放顺带自愈旧残留）；readback 读目标文件，清理不影响校验 |
| implementation-detail JSON 挪 `meta/` | ⏳ 二期 | 牵涉发布契约路径白名单，收益小，暂不混入本次 |

---

## TL;DR

归档的 plans/ 四份 md 中，"人不可读"内容的最大来源不是"该用自然语言却用了机器格式"，
而是**机器锚点被全量内联复制到每个引用点**：同一批 9 条需求（全文 + 64 位哈希）在
plan 的 6 个 task 和 6 个测试场景里各重复一遍，plan.md 约 40% 字节是纯哈希。
正确方向是**单点定义 + 短引用**，而非双份文件或上传前剥离。

## 分析：归档内容的构成

对 `demo-skeleton` 归档实测（字节数）：

| 文件 | 大小 | 纯哈希字节 | 性质 |
|---|---|---|---|
| `*-design.md` | 46 KB | ~4% | 基本全是自然语言（Goal / In scope / Invariants / Tradeoffs / Risks…） |
| `*-plan.md` | 30 KB | ~40% | 54 行 `requirement:` 引用（9 条需求 × 6 task）+ 每 task 整屏 `ownership:<sha256>` |
| `*-test-scenarios.md` | 15 KB | ~29% | 场景描述是自然语言，元数据是英文标签 + 重复需求清单 |
| `*-implementation-detail.md` | 5 KB | ~1% | 主体是 JSON 代码块（机读内容住进 md，二期处理） |

## 分析：分层其实已存在，问题在渲染器

`packages/core/src/plan-artifacts` 早已区分 `HumanArtifactSet`（design/plan/test_scenarios/detail）
与 `MachineArtifactSet`（gate_policy / worktree / implementation_checkpoints /
scenario_manifest，已是 `meta/*.json`），机器侧无需改动：

- **机器读：维持按消费域分文件的多个 JSON**。每个 JSON 有独立生产者/消费时机；
  schema 校验与 content_hash 信任链都建立在 canonical JSON 上，换格式收益为零。
- **人读：保持 4 个 md，改渲染不改结构**。机器校验走结构化内容哈希重算，不 parse
  md 正文，短引用化不损失任何校验能力。

## 分析：归档上传集合已经最小化

客户端打包与服务端（hunter-platform `package-ingest.ts` 的 `ALLOWED_PATHS`）交集仅六类，
全部有真实消费者，无可删项：

| 上传内容 | 服务端消费者 |
|---|---|
| `candidates/knowledge.json` | knowledge-pipeline → 知识条目 |
| `plans/**.md`、`spec/**.md` | semantic indexer（全文进语义索引）+ 展示 |
| `reports/final/summary-data.json` | change-projection-worker / 变更记录查询 |
| `archive-meta.md` | 语义索引 + 归档说明展示 |
| `change-context.json` | 变更身份绑定 |

本地归档目录的 `evidence/`、`meta/*`、`runtime/`、`events.ndjson`、`reports/` 均不上传，
是本地审计链（本次系列排查全靠它们复现），保留。

**唯一真垃圾**：`.publication-staging/`（两份 committed 事务的暂存副本共 282K）。
`fs-publication-port.ts` 此前没有任何 committed 后清理逻辑。

## 服务端视角的附加论据

hunter-platform 的 semantic indexer 把 `plans/**.md` 全文作为 document body 进语义索引——
40% 哈希字节直接污染 embedding。短引用化同时修三件事：人读体验、文件体积、平台搜索质量。

## 方案比较（结论：单点定义 + 短引用）

| 方案 | 结论 |
|---|---|
| 渲染器短引用化（单份文件） | ✅ 采纳：零漂移、人读/机读各取所需、语义索引同步受益 |
| 额外生成人读副本（plan.readable.md） | ❌ 双份文件必然 drift，上传白名单与索引都要扩 |
| 上传前剥离机器码 | ❌ 本地那份人也要读，两份不一致更糟 |

design.md 的 Requirements/Ownership 节保留完整 ID 行——它是"定义注册表"，
且有真实机器消费者（`harness_knowledge_candidates.py` 解析 `- requirement:hash [kind]: text`
与 `  - Mitigation:` 行格式），与代码常量表同理，人读可接受。

## 复现环境

- hunter-harness 0.4.9（仓库源码分析 + sales-insight-agent 归档实测）
- hunter-platform `apps/server/src/archive/package-ingest.ts` / `semantic/indexer.ts` 消费面核查
