# Harness 流程全面调研与中立评估报告

> 日期：2026-09-17
>
> 性质：调研与评估报告（advisory）。本文档**不是实施合同**；其中任何建议若被采纳，须按
> [统一优化实施路线](../roadmap/README.md) 的既有流程立项、评审、实施。
>
> 范围：harness 全流程（Plan → Execute → Review → Submit → Archive + 轻任务入口 +
> 知识/同步/地图支撑环）的结构、环节划分、执行顺序、反馈机制；并抛开当前实现架构
> 给出理想形态参照。
>
> 修订：2026-09-17 补入 Anthropic《The AI-Native SDLC Playbook》（2026-08-21）外部对照
> （§2.3），新增缺口 F10，F2 收益预期按个人场景修正。
>
> 修订 2：2026-09-17 标注实施状态——短期包三项已落地（06B-4 / 09-M4 / 10-M3），
> 详见 §6 状态列与 §4 就地标注。
>
> 修订 3：2026-09-17 标注实施状态——四件套→两件套（11-M3）已落地并推送
> （commit `871c354` + `aef737e`）：渲染层 4md+4json 收敛为 2md+4json，design.md 并入
> Implementation Detail 节、plan.md 并入 Test Scenarios 节，六 target 精确集合跨层一致；
> §2.1/§3.2 的 target 计数同步为 6，F5 与 §4.1/§6 就地标注。
>
> 修订 4：2026-09-17 标注实施状态——执行环增强四件套（15-M1 档位裁决 dry-run、
> 15-M2 quirk 指纹建议、15-M3 失败断路器、15-M4 review 三链状态表）已落地；
> §4.2/§4.3/§4.4/§4.6 与 §6 就地标注；§4.1 残留的 8 target 计数同步修正为 6。
>
> 修订 5：2026-09-17 标注实施状态——plan 侧两件套落地：10-M4（codebase-map 进
> Clarify 静态检查）与 11-M4（plan publish --patch 补丁式修订）；§4.1/§4.6 与 §6
> 就地标注。
>
> 修订 6：2026-09-18 标注实施状态——19-M1（manifest 校准自动化）与 19-M2
> （归档任务级复盘卡）已落地（commit f84fe1a）：calibrate 子命令（report 只读 /
> --apply 仅重录 hashDrift）+ bootstrap 信封 manifestCalibration advisory；finalize
> step 8c 写 retro-card.json 随 core 包并折成知识候选。§4.2/§4.5 就地标注；至此报告
> P1–P3 建议全部落地，仅剩 P0 编排引擎化（D4 暂缓）与 F10 防篡改（已登记暂不立项）。

## 0. 执行摘要

当前 harness 是一条**以脚本为门禁权威、以 LLM skill 提示词为编排层**的五阶段变更流水线，
外加轻任务入口与平台知识闭环。总体判断：

- **业界领先、应予保留的部分**：确定性门禁（非 LLM 裁决）、证据链/账本身份绑定、
  fail-closed、原子发布、worktree 集成事务。与 Anthropic「LLM 门禁只作兜底」、OpenAI
  「护栏分层」的公开最佳实践一致，且在同类方案中做得更彻底。
- **主要结构性短板**：编排靠「LLM 读约 1.3 万行 skill 文档并自觉执行」（提示词即控制流）；
  执行无并行波次；评审非增量；知识回流不在 plan 输入侧闭环；可观测性偏内部记账、缺
  决策级度量。
- **最高杠杆的三个动作**：(1) 编排从 skill 提示词下沉为声明式状态机 + 单一 driver；
  (2) plan 四件套收敛为两件套并让 Execute 支持依赖图并行；(3) 知识查询成为 plan 的
  必走输入而非可选建议。
- **实施状态速览（2026-09-17）**：短期包三项——Clarify 前置步（10-M3）、知识查询
  门禁化（09-M4）、知识候选 JSON 直采（06B-4）——已全部落地并推送；四件套→两件套
  （11-M3，`871c354` + `aef737e`）已落地并推送；执行环增强四件套（15-M1 档位裁决
  dry-run、15-M2 quirk 指纹建议、15-M3 失败断路器、15-M4 review 三链状态表）已落地；
  plan 侧两件套（10-M4 codebase-map 进 Clarify、11-M4 publish 补丁式修订）已落地；
  其余建议状态见 §6 状态列。

## 1. 调研方法与范围

| 维度 | 内容 |
|---|---|
| 内部材料 | `harness/README.md`（13 skills 全量流程）、plan/execute/review/submit/archive/task 六个 SKILL.md、[统一优化实施路线](../roadmap/README.md) 及 14 份阶段文档、43 份决策记录、[精简分析](simplification-analysis-2026-09.md)、[审核整改任务书](../roadmap/proposals/review-remediation-execution-2026-09-12.md) |
| 外部来源 | Anthropic《Building effective agents》、Anthropic Claude Code 最佳实践、OpenAI《A practical guide to building agents》、GitHub Spec Kit、AWS Kiro Specs、HumanLayer 12-Factor Agents、SWE-agent（arXiv 2405.15793）、Anthropic《The AI-Native SDLC Playbook》（2026-08，对照见 §2.3） |
| 分析视角 | 流程结构、环节划分、执行顺序、反馈机制；另按「理想形态」独立推演（§5），不受现有实现约束 |

## 2. 业界调研发现

### 2.1 代表性方案对比

| 方案 | 形态 | 阶段划分 | 真相源 | 门禁权威 | 人机边界 | 强项 | 对本项目的参照弱点 |
|---|---|---|---|---|---|---|---|
| GitHub Spec Kit | CLI 脚手架 + 模板 | Constitution→Specify→Plan→Tasks→Implement，含 Clarify/Analyze 检查点 | Markdown 规格 + constitution.md | 无硬门禁（分析器只做一致性检查） | 每个检查点人工 review | 宪法机制显式化不可变原则；Clarify 强制消歧 | 无验证证据链；无审计能力 |
| AWS Kiro | IDE 内 spec | Requirements→Design→Tasks 三件套，EARS 验收语法；任务依赖图**波次并行** | 三份 Markdown | 任务状态机 + 检查点回滚 | 每阶段可编辑确认 | **执行并行化（Wave）是本项目缺的能力**；三档 Spec 匹配任务复杂度 | 无独立验证/评审阶段；无哈希绑定 |
| Claude Code 最佳实践 | 使用范式 | Explore→Plan→Implement→Commit；计划模式只读隔离 | CLAUDE.md + 计划文档 | **Hooks（确定性脚本）强制**，文档仅建议 | 子代理做新鲜上下文对抗评审；要求「出示证据」 | 上下文稀缺资源管理；两层验证环 | 无跨会话持久状态机 |
| OpenAI agents 指南 | 架构指南 | 单 agent→多 agent 渐进；护栏分层 | — | 确定性规则优先，LLM 护栏兜底 | 失败率/人工升级率作护栏 KPI | 护栏分层模型清晰 | 无流程级状态机 |
| 12-Factor Agents | 工程原则 | 无固定阶段 | **事件日志统一状态** | 控制流归代码、不归提示词 | 人可介入任何点 | 「拥有自己的控制流」「工具即结构化输出」直接命中本项目编排层问题 | 原则非实现 |
| SWE-agent | 自治 agent + ACI | 无显式阶段（ReAct 循环） | 仓库状态 | 无流程门禁 | 全自动 | ACI 证明接口设计显著影响成功率 | 面向 benchmark，无合规需求 |
| 本项目 harness | 流程脚手架 + 脚本门禁 | Plan→Execute→Review→Submit→Archive（可裁剪）+ 轻任务单命令 | 结构化 JSON（plan-evidence-input）→ 6 target 哈希绑定（11-M3 两件套后） | **Python/TS 脚本全确定**，LLM 只做提案 | 每阶段 blocking 确认；三人格对抗评审 + 双评估器 | 证据链完整度、身份绑定、fail-closed 对比组最强 | 编排脆弱、串行、评审非增量、人读层冗余 |

### 2.2 跨方案收敛出的共性原则（评估基准）

1. **真相源单一且机器可读**：文档降级为渲染视图。
2. **确定性门禁优先，LLM 只做提案与兜底**：Anthropic/OpenAI/Claude Code 三方一致；本项目已做到，是核心资产。
3. **控制流属于代码，不属于提示词**：12-Factor 核心原则；本项目编排层当前违背此原则。
4. **验证闭环 + 独立第二意见**：Claude Code「自验证 + 子代理对抗评审」与本项目「ledger + 三人格评审」同构。
5. **任务复杂度分档**：Kiro 三种 Spec 对应本项目 fast/standard/full；本项目是唯一由实际 diff 信号而非声明裁决档位的方案。
6. **检查点与可恢复**：Kiro rewind、Claude Code rewind、本项目 journal/lease/recover——本项目恢复语义最完备。

### 2.3 补充对照：Anthropic《The AI-Native SDLC Playbook》（2026-08-21）

Anthropic Applied AI 团队的六阶段（Plan/Design/Build/Test/Deploy/Maintain）落地手册。
**适用性过滤**：该文面向企业团队与 Claude Code 生态，其中 CI/CD 流水线集成、跨角色协作
流（product owner 审批、branch protection、managed settings）、Claude 专属机制
（CLAUDE.md、hooks、Claude Security/Tag 等）与本项目「个人使用、模型无关」的定位不
匹配，不纳入借鉴范围。以下仅提取与场景无关的通用理念。

**印证本文档既有判断的部分**（无新增行动，仅作外部佐证）：

1. 「Skill 是 advisory control，hook 才是其背后的确定性层」「skill 让违规变少，hook 让
   违规近乎不可能」——与 §2.2 原则 2、F1（P0 编排引擎化）同向：提示词层规则必须有
   确定性兜底。
2. 「为每个 artifact 指定唯一真相源，其余只持副本或链接」——与 §2.2 原则 1 及 v2 证据包
   架构一致。
3. 「每阶段提交下一 stage 可读的 artifact，链即审计轨迹」「人工注意力集中在 gate 上」——
   与本项目证据链 + blocking 确认设计同构。
4. 「给 agent 可自检的反馈环 + 新鲜上下文 verifier 复审」——与 §2.2 原则 4 同构。

**增量发现**（文章有而本文档此前未覆盖或覆盖不足，均已就地落入 §3.3/§4 对应条目）：

- **A. 修复轮次的验收测试防篡改缺口**（→ F10、§4.2）：文章要求 bug 修复「先写失败测试
  并提交，再令 agent 在不改动该测试的前提下使其通过，并用 hook 确定性阻断修复任务对
  测试文件的编辑」。本项目仅有文档级 advisory（见 F10 证据），无确定性防线。
- **B. 并行收益的上限判据**（→ §4.2 F2 注记）：文章明言并行会话的实际上限是「一个人能
  评审过来的流数」，且 auto-accept 以门禁/测试成熟为前提。据此修正 F2 收益预期：个人
  场景下 full 档波次并行收益有限，主收益场景为 standard 批量任务。
- **C. 验收目标量化判据**（→ §4.1 Clarify 建议）：「给出可量化目标，使 agent 无需询问
  即可自检」——为 Clarify 前置步的「验收条件不可测」检查补具体判据：验收条件须落到
  命令 + 可判读输出，而非自然语言描述。
- **D. 知识固化触发阈值**（→ §4.4/§4.5 建议）：「评审第二次标记同一错误时，纠正即写入
  CLAUDE.md」——为知识回流（F4）与 quirk 指纹建议补一个可操作的触发判据：同一
  finding 第二次出现即固化为规则/知识条目，而非依赖人工判断沉淀时机。

## 3. 整体流程评估

### 3.1 流程结构（事实陈述）

```
需求 → [完整流程] Plan(材料+知识查询+门禁+evidence-pack) → Execute(收据链+账本+worktree+租约)
       → Review(三人格对抗+双评估器+fixback+ledger) → Submit(复用账本+精确暂存+集成事务)
       → Archive(确定性ZIP+发布门禁+知识候选) → 平台知识库
     → [轻任务] harness_task.py begin/finish（分类裁决档位，full 信号拒绝并转 Plan）
```

### 3.2 总体优势（应予保留）

1. **v2 证据包架构**：单一结构化输入 → 6 个哈希绑定 target（11-M3 两件套后），Markdown 仅为人读层。
2. **账本身份绑定**（diffHash/ownershipHash/productTreeHash + 跨账本引用 + can-reuse 纯函数）。
3. **Review 角色分离**：三人格 + 双独立评估器 + `blockingFor` 精确阻断 + 哨兵反钳制。
4. **轻/重双入口**：fast/standard/full 由 diff 信号裁决，比「用户自选档位」更防误用。
5. **恢复语义**：integration journal、change lease、`status --json` 统一恢复视图。

### 3.3 整体问题清单

| # | 问题 | 证据 | 影响 | 优先级 |
|---|---|---|---|---|
| F1 | **编排层是提示词**：13 个 skill 文档合计约 1.3 万行，控制流靠 LLM 读文档自觉执行；大量篇幅是防 LLM 犯错的负向规则 | skill 文档「No Script Trust」式禁令密集；[精简分析](simplification-analysis-2026-09.md) §10.2 | 编排可靠性取决于模型遵嘱度；跨宿主行为漂移风险 | **P0** |
| F2 | **Execute 严格串行**，无依赖图/波次 | execute SKILL 全流程无并行概念；Kiro Wave 已证明可行 | 大 change 周期长 | P1 |
| F3 | **评审全量而非增量** | [审核整改任务书](../roadmap/proposals/review-remediation-execution-2026-09-12.md) §9.2 列为缺失 | token 成本高；大 diff 下评审质量稀释 | P1 |
| F4 | **知识回流不进 plan 输入闭环**：`harness_knowledge.py query` 仅「建议」，失败仅警告 | plan SKILL 检索步骤无强制；roadmap 06/07 仍有知识调用收口问题 | 经验复用率取决于模型自觉 | P1 |
| F5 | **plan 四件套重叠度高**，roadmap 09/11 决议收敛为两件套（11-M3 已实施） | [精简分析](simplification-analysis-2026-09.md) §6.4-3 | 渲染 token 膨胀；四处一致性维护 | P2 |
| F6 | **可观测性面向记账而非决策**：缺周期时长、门禁首过率、评审发现密度、自动度等决策级度量呈现；AI 采用度测量学仍开放 | roadmap 10；`harness_efficiency.py` 有数据无消费场景 | 改进靠感觉 | P2 |
| F7 | **巨型脚本单点**：`harness_archive.py` 曾达 11,717 行；Python 48k+ 行、skill 文档 13.5k 行 | [精简分析](simplification-analysis-2026-09.md) §0 | 演进成本高 | P2 |
| F8 | **轻任务分档裁决边角语义仍在收敛**：R1–R5（分类滞后、abandoned 误提交、CI 收据绑定 HEAD 树等） | [审核整改任务书](../roadmap/proposals/review-remediation-execution-2026-09-12.md) §2 | 信任成本；已有专项在修 | P1（跟踪既有专项） |
| F9 | **submit/archive 能力矩阵复杂**：36 种 runtimeState × 双 executionEnvironment | submit/archive SKILL 与 submission-reference | 排障与学习成本高 | P2 |
| F10 | **修复轮次验收测试防篡改无确定性防线**：修复（含 fixback）可顺带改动测试断言，仅有文档级 advisory，未区分验收测试与一般测试 | execute SKILL「陈旧测试安全修复」为提示词级条件；coding-checklist 对测试文件改动仅 WARN + 人工确认；review 默认不阻塞；SDLC Playbook Stage 4 要求 hook 级阻断（§2.3-A） | 修复轮次证据可信度依赖 LLM 自觉；fast/standard 档无评审兜底时尤甚 | P1 |

## 4. 逐环节分析

### 4.1 Plan

- **设计目标**：一次结构化记录、机器先验后渲染、冻结执行边界。
- **当前表现**：evidence-pack→finalize 6 target 原子发布（11-M3 两件套后）+ 哈希漂移检测；材料读取预算、改动地图钩子、派生渲染均已工程化。
- **差距**：四件套冗余（F5）；无显式需求消歧阶段（Spec Kit Clarify / Kiro Analyze 均有专职步）；知识查询非强制（F4）；人工修订需编辑整份 JSON，无增量修订语法。
- **建议**：
  - [P1] 增加 **Clarify 前置步**：evidence-pack 校验前做确定性静态检查（空 objective、scenario/task 悬空引用、验收条件不可测）+ 一次 LLM 歧义扫描，输出强制确认清单。其中「验收条件不可测」的判据具体化为：验收条件须落到**命令 + 可判读输出**（退出码、匹配串、截图比对），不接受纯自然语言描述。依据：Spec Kit Clarify、Kiro Analyze Requirements；SDLC Playbook「state a target and make it quantifiable」（§2.3-C）。**状态：已实施（10-M3，commit `1618b87`）。**
  - [P2] 实施 roadmap 09：**四件套→两件套**（design+execution、plan+scenarios 合并），JSON 真相源不动。依据：精简分析 §6.4-3。**状态：已实施（11-M3，commit `871c354` + `aef737e`）。**
  - [P1] 知识查询升级为 **plan gate 可配置要求**（fast 豁免，standard/full 必查并写入 `knowledge_refs`）。依据：F4；OpenAI 护栏分层。**状态：已实施（09-M4，commit `bbaba0f`）。**
  - [P3] evidence-input 支持**补丁式修订**（`plan publish --patch`）。**状态：已实施（11-M4，2026-09-17）**：`--patch` 接受 JSON 字面量或 `.json` 文件，RFC 7386 深合并（对象递归、数组整体替换、null 删键）；stderr 在写回前输出合并预览摘要；内存合并先过既有字段级结构校验（evidence-pack HP-13 同源）才写回，违规 fail-closed 不触碰原文件；专属错误码 `PLAN_PATCH_INVALID` / `PLAN_PATCH_TARGET_NOT_FOUND`。

### 4.2 Execute

- **设计目标**：测试先行、账本记账、逐场景验收、严格顺序。
- **当前表现**：收据链（context→gate）、profile 解析验证命令、diffHash/ownershipHash 绑定、worktree 决策静态化、change lease。
- **差距**：无并行（F2，收益预期见下注记）；失败→修复→重跑无结构化重试策略与断路器；修复轮次验收测试防篡改无确定性防线（F10）；修复回流校准 manifest 是手动步骤。
- **建议**：
  - [P1] **场景级依赖图 + 波次执行**：scenario-manifest 已有引用闭包，扩展为显式 DAG 按拓扑层并发派发（worktree-per-wave 或复用轻任务 WI-3.3 的 write-scope 冲突检测）。依据：Kiro Wave；审核整改任务书 §9.1。**状态：16-M1 已实施（2026-09-18）**：场景级 `depends_on` 契约 + 未知引用/自引用/成环 fail-closed 校验（TS core/CLI 与 Python 三层同步）+ `compute_scenario_waves` 拓扑波次派生，`bootstrap-execute` 信封注入 `scenarioWaves` advisory（降级不阻断）；实际并行派发由 16-M2 落地（2026-09-18）：`compute_wave_dispatch` 派发读模型 + `harness_context.py execute-wave` 只读命令 + bootstrap 信封 `waveDispatch`（完成集从 ledger 派生，testFile 冲突分组，ownerPhase 延后 deferred）；并行作用于同波次无冲突场景的实现/分析分派，验证执行仍走 runner 项目级单实例锁串行。
    > 收益预期修正（§2.3-B）：SDLC Playbook 指出并行会话的实际上限是「一个人能评审过来的流数」，且 auto-accept 以门禁/测试成熟为前提。个人场景下 full 档单 change 内波次并行的周期收益有限（评审带宽即瓶颈），主收益场景为 standard 批量任务吞吐；P1 评级保留，立项时应以 standard 档为首个试点。
  - [P1] **修复轮次验收测试防篡改检测**（F10）：修复/重试/fixback 轮次的 diff 若触碰 plan 声明的验收测试文件，确定性阻断并升级人工确认（实现位置可选精确暂存层或 review 门禁；一般测试文件维持现 advisory）。依据：§2.3-A；SDLC Playbook Stage 4「the loop itself needs protecting」。
  - [P2] **失败断路器**：同场景连续 2 次同类失败即暂停升级。依据：OpenAI 指南「护栏失败升级人工」。**状态：已实施（15-M3，2026-09-17）**：`harness_context.py execute_circuit_check` 按（verification kind, 失败指纹）最近连续 >=2 次 FAIL 判定 open 并阻断 `bootstrap-execute`，`--circuit-ack` 人工确认放行；纯派生不持久化。
  - [P2] manifest 校准自动化（编辑动作后 hook 式触发）。 **状态：已实施（19-M1，2026-09-18）**：`harness_test_guard.py calibrate` 子命令——report 模式只读检出（hashDrift/attributeDrift/missing/untracked 四类），`--apply` 仅对 hashDrift 复用 `record` 重录（同锁同校验，reason 限既有枚举）；attributeDrift（校验器不容 record 旁路）/missing（破坏性）/untracked（新增登记须保留 tdd-created/test-updated 显式意图）只报告不代为决策；hook 式触发落在 `bootstrap-execute` 信封 `manifestCalibration` advisory（每轮 execute 开始自动检出上一轮修复回流造成的漂移并附 `--apply` 提示，失败降级不阻断）。

### 4.3 Review

- **设计目标**：三人格对抗覆盖 + 双评估器兜底 + 精确阻断 + 结构化修复。
- **当前表现**：finding schema、carryover 继承、增量账本复用、`blockingFor` 白点机制，形式化程度高于业界同类。
- **差距**：全量评审（F3，O2 已立项未实施）；三人格与双评估器覆盖面重叠的边际收益未量化；scenario→finding→fixback 闭环状态缺可查询视图。
- **建议**：
  - [P1] 落地 O2 **增量评审**：以本轮 diff + 受影响接口/调用者构建输入，finding 绑定源内容哈希。依据：审核整改任务书 §9.2 验收标准。
  - [P2] 评审收益度量（各 persona/evaluator 独立发现数、确认率、阻断率），为裁剪冗余角色提供数据。依据：roadmap 10。 **状态：已实施（18-M1，2026-09-18）**：`harness_efficiency.py --changes-root` 面板新增 reviewYield 块——dimension 级确认率/阻断候选/独立发现/跨轮重现已出数；persona/evaluator 归因字段 schema 未定义，缺数据时降级输出缺口说明（write-findings 对额外字段透传，产出侧携带 source 即自动入统，无需改 schema）。
  - [P3] `harness_review.py status --change <cn>` 输出三链 join 表。**状态：已实施（15-M4，2026-09-17）**：scenario→finding→fixback join，manifest 缺失优雅降级，finding 关联优先 `scenarioRefs`（declared）否则 path 启发式，fixback 经 `issueId == finding.id` 对齐。

### 4.4 Submit

- **设计目标**：账本复用、精确暂存、worktree 集成事务可恢复。
- **当前表现**：integration worktree + journal + protection refs + 结构化 abandon/recover，恢复语义为各环节中最强。
- **差距**：record-quirk 依赖人工写签名；R4/R5 所涉 CI 证据绑定影响 submit 前置可信度（专项在修）。
- **建议**：
  - [P2] record-quirk 增加**失败指纹自动建议**（人工确认后写入），不改变门禁语义。触发判据采用 §2.3-D：同一 finding 第二次出现即建议固化，替代人工判断沉淀时机。**状态：已实施（15-M2，2026-09-17）**：`record-quirk --suggest` 扫描 ledger validations 与 run-sessions FAIL 收据，按归一化命令 + exitCode + 归一化输出尾部 sha1 前 12 位聚类，>=2 次才建议，只读不写盘。
  - [P1] 跟踪 R4/R5 修复落地。依据：审核整改任务书 §7/§8。

### 4.5 Archive

- **设计目标**：事实封存、发布资格裁决、确定性 ZIP、平台 ingest。
- **当前表现**：四种结局建模、发布门禁 fail-closed、outbox 重试、知识候选生成。
- **差距**：知识候选 `build_plan_candidates` 反解析 plans/*.md——Markdown 降级为视图后形成「从渲染物反向解析」的反向依赖（[精简分析](simplification-analysis-2026-09.md) §6.2）；复用端在 plan 非强制（F4）。
- **建议**：
  - [P1] 知识候选改从 **JSON 真相源直接生成**，废弃 Markdown 反解析，释放渲染层自由度（四件套收敛的前提）。**状态：已实施（06B-4，commit `5a63442`）。**
  - [P2] 归档时生成**任务级复盘卡**（周期、attempt 数、门禁首过率、评审统计）喂平台知识库；其中重复出现的失败模式按 §2.3-D 判据（第二次出现）升级为确定性规则或回归用例，而非停留在知识条目。依据：12-Factor「错误压缩进上下文」；SDLC Playbook「a fix ships → add an eval for the incident」。 **状态：已实施（19-M2，2026-09-18）**：finalize 管线新增 step 8c——`reports/final/retro-card.json`（周期/attempts 按阶段/门禁首过率含 per-phase 明细/评审统计/验证统计/未裁决丢弃计数），纯从 summary-data 派生不重新读盘，缺数据段降级 `dataGaps` 说明不虚构；复盘卡随 core 包走（`_archive_core_file_specs` 增 retro_card 条目）并折成一条知识候选（entry_type 取枚举内语义最近的 `implementation`，keywords 标 `retro-card`，source_refs 指包内 retro-card.json，空壳卡不发候选）。

### 4.6 支撑环（入口 / 知识 / 同步 / 地图）

- **入口分层（task vs plan）**：设计正确且业界独有；风险在裁决语义边角（F8，专项在修）。建议 [P2]：档位裁决信号开放 `harness_task.py classify --dry-run`，让升档可解释。**状态：已实施（15-M1，2026-09-17）**：以 `task begin --dry-run` 落地（begin 路径信号与裁决同源，比独立 classify 子命令更少分叉），纯只读零副作用；信号源为 `--write-scope` 声明路径 + 当前脏树（与 finish post-run 同视图），`_dirty_paths` 同步修复为 `--untracked-files=all`（untracked 目录折叠曾漏判 auth marker）。
- **知识闭环**：建议 [P1] 查询结果结构化注入 plan evidence（同 F4）。
- **sync / codebase-map**：定位合理；建议 [P3] codebase-map 产物作为 Clarify 步自动输入。**状态：已实施（10-M4，2026-09-17）**：`harness_clarify.py` 新增 `codebase_map_refs_known` 检查项——`path_scope.type=paths` 时 task `affected_paths` 越出扫描范围给 `CLARIFY_MAP_REF_UNKNOWN` 定位缺陷；`full`/`fast`/`focus` 视为整仓覆盖；manifest 缺失/不可读跳过不失败；`clarify check` 与 plan 关门门禁同源消费。

## 5. 理想形态重构（抛开现有架构）

### 5.1 目标形态：声明式变更状态机（Change-as-State-Machine）

```
┌─────────────────────────────────────────────────────────────┐
│  change.yaml（唯一声明：goal/acceptance/tier floor/scope/deps）│
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Pipeline Engine（唯一编排权威，非 LLM）                       │
│  - 声明式阶段图（可裁剪、可插拔）                                 │
│  - 每阶段 = {输入契约, 执行器, 验证器, 证据产出, 转移条件}        │
│  - LLM 只是某些阶段的「执行器实现」，与脚本执行器同接口           │
└───────┬─────────┬─────────┬─────────┬─────────┬─────────────┘
        ▼         ▼         ▼         ▼         ▼
      Plan     Execute    Review    Submit    Archive
   (Clarify内嵌) (DAG并行)  (增量)   (事务)   (知识直采)
        │         │         │         │         │
        └─────────┴──── Evidence Store（内容寻址 + 签名收据）────┘
                           │
              Observability（度量 / 回放 / 模拟）
```

### 5.2 七条原则与现状映射

| # | 理想原则 | 现状差距 | 迁移可行性 |
|---|---|---|---|
| I1 | **控制流归引擎**，提示词只描述「怎么做事」（12-Factor §8） | F1：skill 文档即控制流 | 高：脚本命令已是结构化 JSON I/O，加 engine 调用层即可 |
| I2 | **声明即真相**：一份声明驱动全流程，阶段产物全部派生 | 已接近（plan-evidence-input），Execute 之后无继续驱动 | 高 |
| I3 | **执行器同构**：LLM、脚本、人工统一 {输入→输出+证据} 接口 | 职责靠文档约定区分 | 中：需定义 executor 契约 |
| I4 | **证据为内容寻址的签名收据**（可离线验证、可跨组织传递） | 已哈希绑定未签名；CI 收据可信来源在修（R5） | 中：现有 receipt 加签名层 |
| I5 | **增量与并行是默认** | F2/F3 | 中：scenario 元数据已有依赖信息 |
| I6 | **知识飞轮闭环在 plan 输入侧** | F4 | 高：平台查询已就绪，只差接线 |
| I7 | **可观测性即一等产物**：可回放事件流 + 决策级指标面板 | F6 | 中：事件流已有，缺聚合呈现 |

### 5.3 分阶段迁移路径（不推翻现有资产）

| 阶段 | 内容 | 对应问题 | 风险 |
|---|---|---|---|
| 短期（1–2 迭代） | Clarify 前置步；知识查询门禁化；知识候选 JSON 直采（**三项均已落地**：10-M3 / 09-M4 / 06B-4，2026-09-17）；跟踪 R1–R5 专项收尾 | F4、F8、知识反解析 | 低，局部增强 |
| 中期（1 季度） | Execute DAG 波次（16-M1 契约+advisory 波次派生、16-M2 派发读模型 execute-wave 均已落地，2026-09-18）；增量评审落地（O2）；~~四件套→两件套~~（已提前落地，11-M3） | F2、F3 | 中：调度器是新组件，先在 standard 档试点 |
| 长期（按需） | 编排引擎化（skill 文档退化为阶段操作手册，新 entrypoint 与 skill 双轨过渡）；收据签名层；~~决策级度量面板~~（已提前落地，17-M1，2026-09-18） | F1、F6 | 高：须保护现有契约测试锚点 |

## 6. 建议优先级汇总

| 优先级 | 建议 | 依据 | 预期收益 | 状态（2026-09-17） |
|---|---|---|---|---|
| **P0** | 编排引擎化立项（长期项启动设计） | F1；12-Factor §8；Claude Code「hooks 强制、文档建议」 | 消除最大可靠性变量；跨宿主一致性 | 未启动（D4 暂缓，待独立立项窗口） |
| **P1** | Clarify 前置 + 歧义确认 | Spec Kit Clarify / Kiro Analyze | 减少「做错需求」返工 | **已实施**（10-M3，commit `1618b87`） |
| **P1** | 知识查询门禁化 + 注入 plan evidence | F4；OpenAI 护栏分层 | 经验复用从「靠自觉」到「被保证」 | **已实施**（09-M4，commit `bbaba0f`） |
| **P1** | 知识候选 JSON 直采，废弃 Markdown 反解析 | 精简分析 §6.2 | 解锁渲染层自由；为四件套收敛铺路 | **已实施**（06B-4，commit `5a63442`） |
| **P1** | Execute 场景 DAG 波次并行（首试点 standard 档） | F2；Kiro Wave；WI-3.3 现成冲突检测 | standard 批量吞吐提升；full 档收益受个人评审带宽约束（§2.3-B） | **16-M1～M2 已实施**（2026-09-18：契约 + 校验 + advisory 波次派生 + `execute-wave` 派发读模型） |
| **P1** | 增量评审（跟踪 O2 专项） | F3；审核整改任务书 §9.2 | 评审 token 与质量双赢 | **已收口**（O2 代码侧完成：WI-3.3 97ace4\ + WI-3.4 \9965bb5\，2026-09-14；逐项证据 2026-09-18 归档于 [审核整改证据汇总](../roadmap/proposals/review-remediation-evidence-2026-09-12.md)；漏审率对照属 O5 未执行项） |
| **P1** | 修复轮次验收测试防篡改检测 | F10；SDLC Playbook Stage 4（§2.3-A） | 修复证据可信度从「靠自觉」到「被保证」 | 已登记，暂不立项（2026-09-17 决策） |
| **P1** | R1–R5 专项落地跟踪 | 审核整改任务书 | 轻任务路径可信度 | **已收口**（R1-R5/O1/O3/O6 完成、O2 代码侧完成、O4 部分随 v1.0 瘦身决策退役、O5 未执行；逐项证据 2026-09-18 归档于 [审核整改证据汇总](../roadmap/proposals/review-remediation-evidence-2026-09-12.md)） |
| **P2** | 四件套→两件套 | roadmap 09；精简分析 §6.4-3 | 渲染/阅读 token 下降 | **已实施**（11-M3，commit `871c354` + `aef737e`） |
| **P2** | 失败断路器、quirk 指纹建议、档位裁决可解释 | §4.2/§4.4/§4.6 | 减少无效 attempt 与人工摩擦 | **已实施**（15-M1/M2/M3，commit `c87a1c3`） |
| **P2** | 决策级度量面板 | F6；roadmap 10 | 后续优化有数据依据 | **已实施**（17-M1，2026-09-18：`harness_efficiency.py --changes-root` 跨 change 聚合周期时长/门禁首过率/评审发现密度/自动度，只读） |
| **P3** | plan 补丁式修订、review 闭环状态表、codebase-map 进 Clarify | §4.1/§4.3/§4.6 | 易用性 | **三项均已实施**（15-M4 / 11-M4 / 10-M4，commit `c87a1c3` / `a8f5ae1` / `7204948`） |

**一句话结论**：当前 harness 在「证据与门禁」维度的工程化程度已超过本次调研的全部公开参照系；
真正拉开差距的是**编排层的实现介质**（提示词 vs 状态机）与**执行/评审的并行与增量能力**；
前者决定可靠性上限，后者决定吞吐上限。
