# 流程调研报告短期建议采纳决策记录

日期：2026-09-17 决策
状态：已立项（工作包描述见对应阶段文档），待实施

本文档记录对 [Harness 流程全面调研与中立评估报告](../research/2026-09-17-harness-flow-review.md) 的采纳结论。报告 §5.3 定义了短期包（1–2 迭代）：Clarify 前置步、知识查询门禁化、知识候选 JSON 直采、跟踪 R1–R5 专项收尾。经评审，采纳前三项并立项为工作包 10-M3、09-M4、06B-4；R1–R5 由 [审核整改任务书](../roadmap/proposals/review-remediation-execution-2026-09-12.md) 跟踪，不重复立项。

## D1 采纳 Clarify 前置步（立项 10-M3）

- 背景：报告指出 Plan 环节缺显式需求消歧阶段（报告 §4.1 差距、§6 P1 建议）；Spec Kit 的 Clarify 与 Kiro 的 Analyze Requirements 均有专职消歧步。现有 `harness-plan` 的歧义检查靠 Skill 提示词约定（「歧义优先检查」），无确定性产出物，歧义是否被处理不可审计。
- 决策：在 evidence-pack 校验/finalize 之前增设 Clarify 前置步：确定性静态检查（空 objective、scenario/task 悬空引用、验收条件不可测）fail-closed，外加一次 LLM 歧义扫描生成强制确认清单，确认完成前阻断 finalize。工作包描述见 [阶段 10](../roadmap/stages/10-plan-decision-frontier-and-approval.md) 10-M3。
- 后果：Plan 前置多一道可审计的消歧门；与阶段 10 既有决策树（面向*设计决策*）分工明确，不重复其语义。LLM 歧义扫描每次 plan 至多一次，成本有界。

## D2 采纳知识查询门禁化（立项 09-M4）

- 背景：报告指出知识回流不进 plan 输入闭环（F4）：`knowledge query` 在 plan SKILL 中仅「条件触发」，经验复用率取决于模型自觉。但 2026-09 审查实测「无条件查询的自然语言原文 8/8 零命中」（见 `harness/harness-plan/SKILL.md` 阶段 1 与 CHANGELOG），说明原文直查无收益。
- 决策：将知识查询升级为 plan gate 的可配置要求——fast 档豁免并记录跳过原因；standard/full 档必须执行查询并把 `KnowledgeQueryReceipt` 锚点与 `knowledge_refs` 落盘，缺有效收据时门禁默认 fail-closed，可配置降级为警告。门禁的对象是「执行结构化查询并锚定证据」，不是「必须命中结果」。查询构造使用阶段 09 已冻结的 `IntentContract` 结构化线索（目标、领域词、模块、约束），不是自然语言原文直查——8/8 零命中只否定后者，不构成对结构化必查的否定。工作包描述见 [阶段 09](../roadmap/stages/09-plan-intent-knowledge-and-evidence.md) 09-M4。
- 后果：经验复用从「靠自觉」变为「被保证」；同时保留 fast 档零摩擦。`knowledge_refs` 字段落在 plan-evidence-input 产物 Schema，定义权归阶段 11，09-M4 只定义门禁语义与收据锚定，跨阶段字段须登记契约注册表。

## D3 采纳知识候选 JSON 直采（立项 06B-4）

- 背景：报告 §4.5 指出知识候选 `build_plan_candidates` 反解析 `plans/*.md`——Markdown 已降级为渲染视图，从渲染物反向解析形成反向依赖（[精简分析](../research/simplification-analysis-2026-09.md) §6.2），且阻碍四件套收敛（渲染层不能自由调整）。
- 决策：计划类知识候选改从 `meta/plan-evidence-input.json` 真相源与机器 sidecar（scenario-manifest 等）直接生成，废弃 Markdown 反解析。`KnowledgeCandidate` 共享 Schema（阶段 01 冻结）不变，只换提取源；已产出归档不追溯重算。工作包描述见 [阶段 06](../roadmap/stages/06-archive-and-knowledge-automation.md) 06B-4。
- 后果：渲染层获得调整自由度，为 roadmap 11 的四件套→两件套收敛移除前置阻塞；候选 ID 与内容指纹的稳定性由迁移矩阵验收（一个旧 fixture 反解析产物 + 一个当前 fixture JSON 直采产物）。

## D4 暂缓其余建议

- 背景：报告另列 P0 编排引擎化（F1，长期项）与其余 P1（Execute DAG 波次、增量评审 O2、R1–R5 跟踪）、P2（四件套→两件套、失败断路器、quirk 指纹、档位裁决可解释、决策级度量面板）、P3（补丁式修订、review 闭环状态表、codebase-map 进 Clarify）。
- 决策：本批不立项。P0 编排引擎化属长期重构，待独立立项窗口启动设计；Execute DAG 波次、增量评审（O2）、R1–R5 缺陷修复已由 roadmap 与审核整改任务书跟踪，不重复立项；四件套收敛是 roadmap 11 既有决议，待 06B-4 解除前置阻塞后按阶段 11 推进。
- 后果：短期包保持小爆炸半径（三个工作包均不触碰共享 Schema 与 frozen Interface）；报告其余建议不失效，仍按各自既有渠道跟踪。

## 验收状态

立项文档（本记录 + 10-M3、09-M4、06B-4 工作包描述 + roadmap README 索引更新）待评审确认后，三个工作包按 [统一优化实施路线](../roadmap/README.md) 的并行实施规则各自排期实施。验收以工作包描述中的聚焦测试与汇合门禁为准。
