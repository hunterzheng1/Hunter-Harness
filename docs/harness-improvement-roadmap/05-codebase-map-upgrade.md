# 阶段 05：升级 Codebase Map

## 目标

把 `harness-codebase-map` 从“定期重写七份说明文档”升级为可验证、可增量维护、可按任务消费的项目结构资料。

本阶段继续保留现有七份文档，避免破坏已有 Skill、Sync 和 Platform 契约：

- `STACK.md`
- `INTEGRATIONS.md`
- `ARCHITECTURE.md`
- `STRUCTURE.md`
- `CONVENTIONS.md`
- `TESTING.md`
- `CONCERNS.md`

升级重点不是增加更多文档，而是提高证据质量、刷新准确性、执行效率和下游使用效率。

## 依赖与并行边界

依赖阶段 01 的 `architecture` 内容分类、canonical 路径和快照身份。本阶段的本地 Inspect、Collect、Map 和原子发布可与阶段 02、06A 和 08 并行。

本阶段拥有 Map manifest、七份文档的生成和主题证据 Interface，不拥有 Sync 编排、规则生命周期、Plan 上下文或 Platform 页面。为支持并行，优先冻结以下只读 Interface：

```text
inspectMap(input: MapInspectionInput) -> MapHealth
refreshMap(projectRoot, scope, confirmation) -> MapReceipt
selectMapEvidence(projectRoot, topics, budget) -> MapEvidenceBundle
```

`MapInspectionInput` 是阶段 05 拥有的最小输入 Interface，包含项目与 worktree 身份、当前提交、上次映射提交、dirty/untracked 变化、受影响路径和功能开关。阶段 04 的 Adapter 负责从 `SyncContext` 和共享变化证据映射该输入；阶段 05 不依赖 Sync 的内部类型。

阶段 07、09 和 13 只消费 `MapEvidenceBundle` 或已发布快照，不读取 Mapper 暂存区，也不依赖内部 Agent 数量。

### 与 Sync 的 Interface

`inspectMap()` 是阶段 04 使用的唯一 Map 检查入口。它必须满足以下约束：

- 只读取 `MapInspectionInput`，不再运行独立的 Git 差异扫描。
- 不调用模型，不写入地图，也不上传远端。
- 返回适用性、Manifest 版本、源提交、输入指纹、受影响文档、冲突和建议动作。
- 项目从未采用 Codebase Map 且未启用自动检查时，返回 `not_applicable`。Sync 可以展示可选的「生成地图」动作，但不能把缺失地图视为失败。
- `refreshMap()` 成功后，Sync 只重新调用 `inspectMap()`；不得再次读取并拼接七份文档执行另一套判断。

Map Provider 不拥有 Sync 的计划 ID、用户多选和上传确认。Sync 也不得复制 Map 的漂移分类、Manifest 校验和模型路由。

```text
MapHealth = {
  schema_version,
  applicability,
  status,
  input_fingerprint,
  manifest_version?,
  manifest_hash?,
  source_commit?,
  affected_documents[],
  conflicts[],
  suggested_actions[],
  reason_codes[]
}

MapReceipt = {
  schema_version,
  operation_id,
  input_fingerprint,
  previous_manifest_hash?,
  manifest_hash,
  changed_documents[],
  preserved_documents[],
  execution_policy,
  verification,
  completed_at
}
```

## 上游调研结论

调研日期：2026-08-12。

最初参考的 [`gsd-build/get-shit-done`](https://github.com/gsd-build/get-shit-done) 已于 2026-06-26 归档，并迁移到活跃仓库 [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core)。本次分析以活跃仓库为准，而不是继续对比旧仓库。

调研时的稳定版本为 [`v1.10.0`](https://github.com/open-gsd/gsd-core/releases)，发布于 2026-08-08；`next` 分支检查点为 `4a0b5e26b4ffb0d71dced6d6ebc0deac3db71ac4`。Codebase Mapper 相关文件在该稳定版本与检查点之间没有实质差异。

当前 GSD 的主要变化包括：

- 完整映射仍由四个并行 Mapper 生成七份文档。
- `--fast` 改为单个轻量 Mapper，默认聚焦 `tech+arch`，而不是仍按完整模式运行。
- `--paths` 支持范围化刷新，并记录 `last_mapped_commit`。
- 增加结构漂移检测，可识别新增目录、路由、迁移、聚合导出等变化；规划前只提醒，执行后可按配置触发重映射。
- 增加可选 Intel 能力，保存文件、API、依赖、架构和技术栈的结构化数据。
- Mapper 默认使用较轻模型，失败或高难度场景再有限升级模型。
- 架构输出加强了组件职责、文件与行号证据、数据流、约束、错误处理和横切关注点。

主要来源：

- [Map Codebase Skill](https://github.com/open-gsd/gsd-core/blob/next/skills/gsd-map-codebase/SKILL.md)
- [Map Codebase Workflow](https://github.com/open-gsd/gsd-core/blob/next/gsd-core/workflows/map-codebase.md)
- [Codebase Mapper Agent](https://github.com/open-gsd/gsd-core/blob/next/agents/gsd-codebase-mapper.md)
- [配置说明](https://github.com/open-gsd/gsd-core/blob/next/docs/CONFIGURATION.md)
- [结构漂移实现](https://github.com/open-gsd/gsd-core/blob/next/src/drift.cts)
- [Intel 能力定义](https://github.com/open-gsd/gsd-core/blob/next/capabilities/intel/capability.json)

## 当前实现的问题

### 1. 过期判断与文档描述不一致

当前 Core 主要按 `generated_at` 是否超过七天判断过期。Skill 文档中提到的提交差异、文件变化阈值和分类刷新没有真正成为判定依据。

直接后果是：

- 项目没有变化也可能因时间到期而重跑。
- 一天内发生大规模架构变化仍可能被认为是最新。
- 分支或 worktree 切换后可能继续复用另一版本的地图。

### 2. `--paths` 可能丢失未扫描内容

当前 Mapper 可只扫描指定路径，但最后仍重写完整文档。局部扫描缺少的信息可能被误判为不存在，导致未受影响章节被删除或降级。

### 3. 多 Agent 直接写最终文件

多个 Mapper 直接修改正式目录。一旦部分 Mapper 失败，可能形成跨代际混合结果：部分文件来自新扫描，部分文件仍来自旧扫描，manifest 却无法准确描述该状态。

### 4. 下游加载过重

指令审计等消费者可能一次读取七份文档并拼接大块文本。对只涉及 UI、测试或某个 API 的任务，这会增加无关上下文和模型成本。

### 5. 观察事实与治理规则混合

`CONVENTIONS.md` 会从代码观察中生成 Agent 规则。观察到的习惯不一定是项目希望长期执行的规则，不应未经审阅直接升级为权威约束。

### 6. 职责边界不清

Codebase Map 内部自动执行 Push、生成运行报告或上报生命周期事件，会与阶段 03 Push、阶段 04 Sync 的职责重复，也让一次本地分析被远端网络状态拖慢。

## 取舍

### 建议吸收

- 基于提交和结构变化的漂移检测。
- 真正保留未受影响内容的增量刷新。
- 单 Mapper 的快速模式和较轻模型路由。
- 文件、符号、配置和数据流的可核验证据。
- 生成失败时不污染正式地图的原子发布。
- 按任务类型选择地图内容，并设置严格上下文预算。

### 不建议照搬

- 不引入 GSD Intel 作为第三套代码索引。
- 不引入 Graphify 作为另一套依赖图。
- 不自动提交 Git。
- 不允许多个 Agent 直接写正式文件。
- 不在 Codebase Map 内自动上传远端。
- 不因固定天数到期而无条件完整重建。

Hunter 的职责应明确为：

| 能力 | 职责 |
|---|---|
| CodeGraph | 符号、调用、依赖和影响范围查询 |
| Codebase Map | 稳定、可审阅、面向人和模型的项目结构说明 |
| Platform | 保存并展示按项目、分支和版本区分的地图快照 |

这一取舍也与其他工具的成熟做法一致：[`Aider Repo Map`](https://aider.chat/docs/repomap.html) 使用依赖排序和令牌预算选择最相关符号；[`Continue Context Providers`](https://docs.continue.dev/customize/deep-dives/custom-providers) 强调文件概要、顶层签名和目录范围；[`Repomix`](https://github.com/yamadashy/repomix/blob/main/README.md) 提供基于 Tree-sitter 的压缩与令牌统计；[`Sourcegraph Code Navigation`](https://sourcegraph.com/docs/code-navigation) 将精确符号索引绑定到代码版本。Hunter 应吸收其“按需选择和版本绑定”，而不是重复建设它们的索引能力。

## 目标流水线

```mermaid
flowchart LR
    A["Inspect：确定版本、漂移和受影响文档"] --> B["Collect：收集确定性证据"]
    B --> C["Map：生成结构化修改建议"]
    C --> D["Render：在暂存区渲染七份文档"]
    D --> E["Validate：校验引用、覆盖和敏感输出"]
    E --> F["Publish：原子替换地图与 manifest"]
    F --> G["Sync / Push：由用户选择是否上传"]
```

### Inspect

不调用模型，完成以下判断：

- 当前仓库身份、分支、提交、worktree 和工作区状态。
- 上次地图绑定的源版本。
- 变化文件及其所属类别。
- 需要重建、局部刷新、保持不变或发生冲突的文档。
- CodeGraph 是否可用；不可用时只降级证据来源，不自动建立索引。

### Collect

使用确定性工具收集：

- 目录和模块边界。
- 包清单、构建配置、CI、部署、测试和入口文件。
- CodeGraph 返回的符号、调用和依赖证据。
- Git 变化范围或非 Git 项目的输入指纹。

禁止读取 `.env`、包管理器认证文件、私钥、凭据文件和其他明确的敏感内容。最终输出仍需做敏感信息扫描，因为地图可能上传到远端。

### Map

- 快速模式默认只使用一个轻量 Mapper，聚焦 `STACK`、`STRUCTURE` 和 `ARCHITECTURE` 的受影响部分。
- 完整模式只在首次映射、大规模结构漂移或用户显式要求时使用多个 Mapper。
- Mapper 输出结构化事实和文档补丁，不直接写正式文件。
- 只有校验失败或存在高风险歧义时，才允许有限升级模型并重试一次。

### Render、Validate 与 Publish

- 在独立暂存目录渲染完整结果。
- 检查七份文档、摘要、引用路径、manifest、内容大小和敏感输出。
- 任一文档失败时保持正式地图完全不变。
- 校验全部通过后，一次性替换文档、摘要和 manifest。
- 发布成功只返回变化范围，不自动 Push。

## Manifest v2

`map-manifest.json` 至少记录：

- `schema_version`、`generator`、`generator_version`。
- 仓库身份、分支、源提交和 worktree。
- 运行模式、聚焦范围和路径范围。
- 每份文档的输入类别、证据来源、输入指纹、内容哈希、令牌估算和状态。
- `map-summary.md` 哈希。
- 警告、降级原因和最终状态。

最小机器结构如下：

```text
MapManifestV2 = {
  schema_version: 2,
  generator: { name, version, prompt_version? },
  repository_identity,
  branch_name?,
  source_commit?,
  worktree_identity?,
  mode,                         // quick | incremental | full
  scope,
  path_filters[],
  input_fingerprint,
  documents: [{
    path,
    topics[],
    evidence_sources[],
    input_fingerprint,
    content_hash,
    estimated_tokens,
    status
  }],
  summary_hash,
  warnings[],
  degradation_reasons[],
  status,
  published_at
}

map document status = current | refreshed | unchanged | conflicted | failed
map status = ready | partial | conflicted | failed
```

兼容 Reader 可以把旧 manifest 投影为 v2 读取模型，但新写入只生成 v2。无法证明的旧字段保持 `unknown`，不能补造提交或 worktree 身份。

只记录时间不能证明地图仍然有效。时间年龄保留为提示信息，不再作为主要刷新条件。

`MapEvidenceBundle` 至少包含 `schema_version`、`manifest_hash`、`source_commit`、请求主题、证据片段、来源路径、置信度、已使用预算和截断原因。消费者可校验版本并按主题读取，不再自行拼接七份文档。

### 模型执行策略

Mapper 的模型与资源选择由一份可测试的 `MappingExecutionPolicy` 决定：

```text
MappingExecutionPolicy = {
  mode,
  model_tier,
  max_parallel_mappers,
  max_model_attempts,
  timeout_ms,
  token_budget,
  escalation_conditions[]
}
```

快速模式默认使用轻量模型和单 Mapper；增量模式按受影响主题有界并行；完整模式只在首次生成、广泛结构漂移或用户显式选择时启用。每次执行把实际 Provider、模型、耗时、预算消耗、重试和升级原因写入 `MapReceipt`，但不写入七份长期正文。模型超时或预算耗尽时保持旧地图不变，并返回可重试的机器原因。

## 漂移与增量刷新

### Git 项目

以 `last_mapped_commit`、当前提交和工作区差异确定影响：

| 变化类型 | 优先刷新 |
|---|---|
| 包清单、运行时和构建配置 | `STACK`、`INTEGRATIONS` |
| 模块、入口、路由和目录结构 | `ARCHITECTURE`、`STRUCTURE` |
| 测试目录、测试配置和质量门 | `TESTING`、`CONVENTIONS` |
| CI、部署和外部服务配置 | `INTEGRATIONS`、`STACK` |
| 广泛重构或无法分类 | `ARCHITECTURE`、`CONCERNS`，必要时完整刷新 |

### 非 Git 项目

按输入组保存内容指纹。只有相关输入指纹变化时才刷新对应文档。

### 冲突处理

- 地图文件有未识别的本地修改时，不静默覆盖。
- 展示“保留本地、使用新结果、查看差异”三个动作。
- `--paths` 只更新路径对应的结构化分区，未受影响内容必须保持原样。

## 文档质量规则

- 关键架构结论必须带文件路径；数据流和调用关系尽量带符号或行号证据。
- 明确区分“已验证事实”“合理推断”“待确认问题”。
- `CONCERNS.md` 为每项问题记录置信度、证据、`last_seen` 和状态；失效问题应关闭或移除。
- `CONVENTIONS.md` 只记录观察到的约定。需要成为治理规则的内容，应作为候选交给阶段 07 的 `InstructionGovernanceModule` 审阅，不能直接写入 canonical 规则。
- 七份长期文档之外不再增加永久报告。运行诊断使用短期状态或命令输出。

## 按任务消费地图

消费者应先读 `map-summary.md`，再按任务选择文档：

| 任务 | 默认内容 |
|---|---|
| UI 或交互 | `CONVENTIONS`、`STRUCTURE` |
| API | `ARCHITECTURE`、`CONVENTIONS` |
| 数据库 | `ARCHITECTURE`、`STACK` |
| 测试 | `TESTING`、`CONVENTIONS` |
| 集成或部署 | `INTEGRATIONS`、`STACK` |
| 重构或风险分析 | `CONCERNS`、`ARCHITECTURE` |
| 符号、调用或影响范围 | 直接查询 CodeGraph |

每个消费者设置硬性字符或令牌预算。不得默认拼接全部七份文档后再让模型自行筛选。

## 分步实施

本阶段按以下顺序逐项完成，每项形成独立提交和聚焦测试：

1. **05.1 契约与 Manifest v2**：定义版本身份、输入指纹、文档状态、模型执行策略和兼容读取。
2. **05.2 Inspect 与漂移检测**：实现 Git、非 Git、分支和 worktree 的确定性判定。
3. **05.3 证据收集**：统一文件、配置和 CodeGraph 证据接口，落实敏感文件禁读。
4. **05.4 增量生成与原子发布**：结构化补丁、暂存校验、失败回滚和局部内容保留。
5. **05.5 消费路由与预算**：改造 Plan、Sync 和阶段 07 规则治理等消费者的按需加载，并输出稳定的主题证据接口。
6. **05.6 Skill 收敛**：快速模式、模型路由、中文提示，并移除自动 Push、报告和生命周期上报。
7. **05.7 迁移与验收**：兼容旧 manifest，完成全场景回归和 Platform 分支快照验证。

完成一项后再开始下一项，避免同时修改生成协议、消费协议和远端展示。

## 验收条件

- 首次完整映射稳定生成七份文档、摘要和 Manifest v2。
- 无代码变化时不调用 Mapper；仅时间超过七天不会触发完整重建。
- 结构变化能准确指出受影响文档。
- `--paths` 不删除范围外内容。
- 一个 Mapper 或校验步骤失败时，正式地图保持原版本。
- 分支和 worktree 切换不会复用错误地图。
- 非 Git 项目可按输入指纹增量刷新。
- CodeGraph 可用和不可用两种情况均有明确、可验证的降级行为。
- 快速模式只启用一个轻量 Mapper；模型升级有次数上限。
- 消费者按任务读取所需文档，并遵守上下文预算。
- 敏感文件不被读取，敏感输出不能发布。
- Codebase Map 不自动 Push；生成后由 Sync 或 Push 提供确认入口。
- 规则候选不会未经审阅写入权威指令文件。
- Sync 与独立 `harness-codebase-map` 对同一项目返回一致的 `MapHealth`，不会重复扫描仓库或重复计算地图新鲜度。
- 地图未启用时不产生全局 WARN；地图已启用但 Manifest 损坏、源身份不匹配或文档缺失时才报告需要处理的问题。

## 非目标

- 不替代 CodeGraph。
- 不建立本地语义知识库。
- 不把设计、计划或变更总结归类为可复用知识。
- 不在本阶段修改 Platform 页面布局；远端展示由阶段 13 处理。

## 实施记录

### 05-M1：Manifest、Inspect、Evidence 与 Publication 纯 Module

状态：已关闭。当前产物保留在本地工作区，未提交、推送、合并或发布。

已冻结的 v2 Interface：

- `projectMapManifest(input)` 严格读取 v2，并把 legacy manifest 投影为兼容读取模型；无法证明的项目、仓库、分支、worktree、生成器和指纹保持缺失并记录 degradation，不能被判为 `current`。
- `inspectMap(input)` 只消费类型化输入，确定性返回适用性、版本、指纹、漂移、冲突、受影响文档和建议动作；不执行 Git、文件、模型、网络或上传操作。
- `assessMapEvidencePath(path)` 是 Collect Adapter 的读取前准入决策；它复用阶段 01 canonical 分类并补充包管理认证、私钥和精确 credential 配置 basename。`selectMapEvidence(input)` 复用同一决策，按主题、置信度、code-point 稳定顺序和字符/token 双硬预算选择证据。
- `selectMappingExecutionPolicy(input)` 固定 quick、incremental、full 的轻量/标准模型、有界并行、超时、预算和最多两次模型尝试。
- `planMapPublication(input)` 只形成完整 staging 与原子替换计划。它要求调用方冻结 `published_at`，输出完整 manifest 与 canonical payload；七份文档、摘要、manifest、stage hash、plan hash 和 Reader 回读使用同一内容。
- publication 在产生操作前复用 canonical 敏感扫描器，扫描七份文档、摘要和 manifest；ARCHITECTURE 与 CONVENTIONS 中的治理命令被阻断，不能未经阶段 07 审阅成为规则。
- canonical Map 文件本地修改返回精确受影响文档和 `keep_local`、`use_new_result`、`view_diff` 三种机器动作；失败计划保持旧 manifest hash 且 `operations=[]`。

完成证据：

- 最终 Map 聚焦测试扩展至 `146/146`；与既有 Map、Remote Sync 和 canonical scanner 的联合关闭复核为 `421/421`，未跳过测试。
- 稳定工作树上的 Core 全量曾达到 `614/614`；后续并行 07A/08 的预期 RED 不计为本包失败。最终关闭以 Map 聚焦、联合回归、Core 类型检查、构建、限定范围与根级 ESLint、diff check 为准，均通过。
- 路径矩阵覆盖 `.env*`、`credentials.local*`、package auth、private key、`client_secret`/`client-secret` 的 bare、单段和多段后缀，以及必须允许的 lookalike。
- token 预算对 ASCII、CJK、emoji 和混合文本使用 UTF-8 byte upper bound，返回的 `used_budget` 不低估实际保守成本，且字符/token 任一上限均不会突破。
- Reader 拒绝空白数组成员和非 RFC 3339 时间；合法 `Z` 与 offset 时间、完整 publication payload、所有 stage-write hash 和时间篡改敏感性通过闭环测试。
- 稳定哈希、Evidence、Manifest 投影和 canonical scanner 的协议排序均使用 code-point 比较，不依赖系统 locale。共享 scanner 的最小整合由 T0 测试先行完成，并同时通过 Remote Sync 回归。
- 最终独立复审为 Ready，Critical、Important 和 Minor 均为 `0`。
- 修改范围仅为新的 `packages/core/src/codebase/map-v2/**`、聚焦测试、legacy fixture，以及 T0 负责的 canonical scanner 排序收尾；未修改既有 Map、CLI、Skill、canonical 文档或 Platform。

05-M1 关闭后仍未接入的 Adapter：

- Collect 与 Mapper Adapter：按 pre-read policy 收集确定性证据，执行模型策略并产生结构化文档修改建议。
- 文件系统 Publication Adapter：创建独立 staging，校验完整 payload，并在 CAS 前提下原子替换七份文档、摘要和 manifest；失败时验证旧地图保持不变。
- `harness-codebase-map` Skill 与 CLI Adapter：收敛 quick、paths、模型路由和中文提示，移除自动 Push、永久报告和生命周期上报。
- 阶段 04、07、09 的消费者 Adapter：只读取 `MapHealth` 或有预算的 `MapEvidenceBundle`，不拼接全部七份文档。
- Platform 分支快照与阶段 13 页面 Adapter，以及阶段 14 的真实首次/增量/回滚和性能验收。
