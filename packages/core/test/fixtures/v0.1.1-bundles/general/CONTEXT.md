# Harness Skills

Harness Skills 是一组围绕本地变更治理的 agent 工作流。它把外部方法论吸收为原生协议，同时保持 `.harness/changes/<change-name>/` 作为变更过程的唯一真相源。

## Language

**原生协议**:
Harness skill 内部直接执行的流程约束，作为正式行为契约。原生协议可以吸收外部方法论，但不依赖外部 skill 是否安装。
_Avoid_: Adapter Mode, 外部 skill 调用

**外部方法论来源**:
为 harness 规则提供启发的外部 skill 或流程，例如 brainstorming、grill-me、writing-plans、test-driven-development、receiving-code-review。它们是设计来源，不是 harness 的运行时依赖。
_Avoid_: 外部依赖, 必需插件

**人工参考**:
不进入正式流程状态机、只供人或后续规则维护者对标的方法、草稿或外部技能。人工参考缺失不产生降级项；若被采用，应先转写为 harness 原生协议或正式产物。
_Avoid_: 运行时增强, 降级分支, 硬依赖

**变更簇**:
围绕同一业务行为或同一验证目标的一组任务。变更簇是 `/harness-run` 执行 RED→GREEN→REFACTOR 的基本单位。
_Avoid_: 小任务, 单步任务

**自适应执行参考**:
`implementation-detail.md` 的定位。它按变更复杂度提供足够执行上下文，简单变更保持简洁，高风险变更写清顺序、接口、数据、风险和测试策略。
_Avoid_: 超细步骤文档, 可选详细计划

**Fixback**:
由 review 阶段把 RED/YELLOW 问题转成的结构化修复反馈。Fixback 指向问题位置、推荐修复和验证方式，但默认不自动阻塞 submit。
_Avoid_: 修复任务清单, blocking review

**事件唯一源**:
`events.ndjson` 是变更执行过程的唯一实时记录位置，由 `harness_events.py append` 写入。`execution-log.md` 是它的自动渲染产物，禁止手工编辑。
_Avoid_: 日志双写, 手写执行日志

**归档终结（finalize）**:
`harness_archive.py finalize` 在单进程内完成 manifest、移动、collect、渲染、校验、比对、删除原目录的完整归档动作。取代旧的 collect/enrich/validate 三步编排；enrich 不再是有效概念。
_Avoid_: enrich, 多步归档编排

**知识裁决（judge）**:
归档收尾时对知识条目的处置流程：脚本规则先消化机械部分（去重、时间序 supersede、stale 重验），模型批量裁决剩余的真语义冲突与 promote，写入可回滚的 decision log。人工退出常规循环。
_Avoid_: 人工 promote 积压, candidate 待办

**构建档案（build-profile）**:
`.harness/config/build-profile.json`，项目级持久化的机读构建事实：可用命令模板、工具绝对路径、已知预存错误、服务启动模板。preflight 只做秒级校验，新坑由脚本回写。项目专属硬编码归此文件，不进 skill 文本。
_Avoid_: 每次重新探测, skill 内硬编码项目参数

**验证指纹（inputsHash）**:
一项验证（compile/install/unitTest/apiTest）所依赖源文件集合的内容哈希。指纹一致且证据完整才允许 🔁REUSED；无法证明即保守重跑。
_Avoid_: 仅凭 diffHash 复用, 无证据跳过

**服务会话**:
`runtime/service-session.json` 记录的 AI 启动服务生命周期。指纹匹配静默复用、不匹配自动重启、归档收尾统一停止；只有用户自启服务占端口才询问。
_Avoid_: 每轮测试后必杀服务

**交互白名单**:
每个 skill 显式声明的允许 AskUserQuestion 场景清单。白名单外一律取默认值并记 decision 事件。
_Avoid_: 逐决策点询问

**部署合成**:
`harness_deploy.py build` 把通用核心 + shared 片段 + overlay 合成为自包含 SKILL.md 后部署。Vault 源头 DRY，运行时单文件。
_Avoid_: 运行时跨文件拼规则, fork 维护

**Java overlay**:
`overlays/java/` 中只含"任何 Java 项目通用"的差异段落与独有 skill（apidoc/package）。项目专属值写目标项目的 build-profile。
_Avoid_: Java fork, UDP 硬编码进 overlay
