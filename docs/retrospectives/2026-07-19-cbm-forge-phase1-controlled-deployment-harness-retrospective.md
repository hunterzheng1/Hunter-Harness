# CBM Forge `phase1-controlled-deployment` Harness 持续复盘

> 状态：持续更新（Living Retrospective）  
> 首次记录：2026-07-19  
> 当前完成阶段：最终Test PASS（待 Archive）  
> 复盘对象：CBM Forge `.harness/changes/phase1-controlled-deployment`  
> 维护约定：Run、Test、Review、Submit、Archive 每个阶段结束后，都在本文件追加事实、指标、问题与改进建议；未执行阶段不得预填结果。

## 1. 结论先行

Plan、Run、Test、Review 与特性 Submit 已完成，产品实现可以进入事务合并与远端 CI；但 Harness 执行过程仍不能评价为“高效且事实可靠”。各阶段共同确认：问题不只是提示词过长，而是运行时、worktree、测试画像、ledger、场景状态与风险分类之间缺少同一份机器真相源。最值得优先处理的是把以下容易出错的自然语言步骤收敛成严格、可验证的工具合同：

1. **事件合同必须默认严格**：本次真实失败被记录为 `status=WARN + severity=info`，渲染后显示成绿色 `✅OK`；三条缺少 `name/status` 的 verification 则显示为 `→ —`。日志视觉结论与事实不一致。
2. **运行时与环境能力必须在阶段开始时一次解析**：技能命令统一写 `python`，但实际 Codex PowerShell 的 PATH 中没有 `python`；完整性检查又使用了 Windows PowerShell 5 不支持的 `Test-Json`，形成两次可避免的失败重试。
3. **Plan 需要原子化 finalizer**：目前没有面向 Plan 产物的专用校验器，agent 只能自行拼装完整性脚本，并在 `phase.end` 前后做两遍检查才能处理“execution log 由 phase.end 触发生成”的循环依赖。
4. **风险分级必须读取设计语义，而不只看阶段和文件名**：本 change 明确包含 Docker 镜像、部署流水线和 API 健康合同，但 Plan 分类仍得到 `signals=[]`，`package/apidoc=not-triggered`。
5. **适配器不能生成其他 agent 的 worktree 约定**：Codex 执行结果写成 `.claude/worktrees/...` 和 `worktree/...`，说明模板仍硬编码 Claude 路径，且不符合 Codex 默认 `codex/` 分支约定。
6. **多栈项目不能让 detector 覆盖有效画像**：Run 中自动检测把 FastAPI + Python 包 + Vite 项目识别成 `unknown`，并清空已有命令，直接令 test guard 首次只跟踪 0 个文件。
7. **ledger 与 post-run classifier 对部署 change 仍不可信**：显式传入的 diffHash 被静默丢成 `null`；两个 Dockerfile、Compose、workflow、OpenAPI 真实变化仍未触发 package/apidoc。

建议先完成 P0 的“运行时解析、严格事件合同、Plan finalizer、适配器化 worktree”四项，再扩展更多自动化阶段。否则增加阶段只会放大日志失真和环境偶然性。

## 2. 与既有复盘的边界

以下两份既有文档已经覆盖并行 change 证据丢失、空测试假通过、归档统计失真、sync 版本误报、动态状态所有权等问题，本文件不重复展开：

- [2026-07-18 CBM Forge 从 Plan 到 Submit 的流程复盘](./2026-07-18-cbm-forge-plan-to-submit-retrospective.md)
- [2026-07-18 Hunter-Harness 问题与优化建议](./Hunter-Harness问题与优化建议-2026-07-18.md)

本文件聚焦 2026-07-19 当前版本在 `phase1-controlled-deployment` 中新观察到的问题。若后续阶段再次触发旧问题，将记录为“回归”，并链接原结论，而不是复制旧分析。

## 3. 证据边界与标注规则

### 3.1 主要证据

- CBM Forge change：`E:\MyProject\CBM Forge\.harness\changes\phase1-controlled-deployment`
- 事件事实源：`events.ndjson`
- 渲染日志：`logs/execution-log.md`
- 风险策略：`meta/gate-policy.json`
- 状态快照：`meta/state-snapshot.json`
- 知识查询指针：`meta/knowledge-context.json`
- Plan 四份正文：`spec/*-design.md`、`plans/*-plan.md`、`plans/*-implementation-detail.md`、`plans/*-test-scenarios.md`
- Hunter-Harness 当前源码与技能文档；不以 `.codex-release/` 中的发布副本作为实现事实源。

### 3.2 问题类型

| 类型 | 含义 | 本文处理方式 |
|---|---|---|
| 确认缺陷 | 输入合法或常见，但 Harness 产生错误结果或错误表达 | 给出复现证据、修复入口和回归测试 |
| 设计局限 | 当前合同没有覆盖真实用法，agent 必须临场补齐 | 给出目标合同和迁移建议 |
| Agent 执行失误 | 本次 agent 选择了不兼容命令或漏填参数 | 不甩锅给工具；同时判断工具是否本应提前阻止 |
| 环境差异 | PowerShell、PATH、适配器能力等外部差异 | 要求预检输出能力事实，避免靠猜测 |
| 历史已修复 | 旧复盘中已有结论且当前未复现 | 只链接；若复现则升级为回归 |

## 4. 阶段状态

| 阶段 | 当前状态 | 事实记录 | 本文更新状态 |
|---|---|---|---|
| Plan | 已完成 | 2026-07-19 03:49:39—04:01:29，11m50.1s | 已复盘 |
| Run | 初次及四次 CI fixback | 初次 39m20.5s；CI#1 fix 约3m41s PASS；CI#2 image fix 约32s WARN；CI#3 permission fix 2m29.4s WARN；CI#4 reader/cleanup fix 06:54:59—06:59:24，4m25.0s WARN | 已复盘 |
| Test | 已完成八次 | 初次 9m27.2s；Review 后 4m31.2s；CI#1 fix 约1m48s；image fix 约1m13s；permission fix 1m58.8s；permission post-review 50.2s；reader/cleanup 2m01.9s；cleanup post-review 07:11:44—07:12:35，51.6s WARN | 已复盘 |
| Review | 初审及四次增量 fixback完成（WARN） | 初审 24m46.7s；permission fix 3m35.4s；reader/cleanup fix 07:02:59—07:11:04，8m04.5s；2 new YELLOW当场关闭，最终0 new RED/YELLOW，保留2 advisory YELLOW | 已复盘 |
| Submit | 第四次fixback已提交，待第五轮merge/push | permission commit `f53fec4`→merge `7ad0b63`；reader/cleanup commit `fa34b4b`，07:13:19—07:14:19，1m00.5s PASS | 已复盘，待CI#5 |
| Archive | 未执行 | 不推断 | 待阶段结束后追加 |

## 5. Plan 阶段复盘

### 5.1 可量化结果

| 指标 | 实际值 | 判断 |
|---|---:|---|
| 阶段墙钟耗时 | 11m50.1s | 可接受，但目前无法区分 agent 活跃、工具等待和用户审批等待 |
| 正文产物 | 4 份，合计 41,564 bytes | 内容完整，但存在跨文档重复 |
| 实施任务/切片 | 10 个任务、4 个切片 | 依赖顺序清晰 |
| 测试场景 | 64 个：20 UT、10 API、10 数据兼容、24 集成 | 覆盖面大，但可执行性元数据不足 |
| Plan 技能说明文件 | 4 份，合计 38,313 bytes | agent 输入本身较重，且阶段 8、路径与事件规则有重复 |
| 知识查询 | 159 字查询产生 41,756 字符、753 行 stdout | 信息过载；稳定 context pack 有价值 |
| 知识命中 | 10 条 | 包含 stale/superseded，需二次复核 |
| CodeGraph 调用 | 5 次 | 能找到主路径，但精确范围和排除目录能力不足 |
| 自定义 explorer | 0 次 | `CUSTOM_AGENTS_UNSUPPORTED` 后按规范 inline 降级 |
| 明确失败后重试 | 2 次 | `python` 不在 PATH；`Test-Json` 不可用 |
| 用户确认 | 设计审批 1 次 | 合理，但调用 skill 前已有方案确认，存在上下文重复空间 |

这里的“失败后重试”不是阶段失败；最终产物已经生成。问题在于它们本可通过一次环境预检和专用 finalizer 消除。

### 5.2 做得好的部分

1. **范围边界清晰**：真实敏感数据生产上线、HA、COS 灾备和多副本会话均被明确排除，没有把“能部署”误写成“已具备生产授权”。
2. **方案比较有效**：对 TAT、动态 IP SSH、生产机 self-hosted runner 做了安全面比较，推荐路径有明确理由。
3. **部署顺序具有可操作性**：备份、迁移、应用发布、失败回滚的方向一致，避免承诺自动 schema downgrade。
4. **知识结果没有被直接当作当前事实**：stale/superseded 命中被降级为线索，并重新使用 HEAD 源码和归档限制复核。
5. **失败没有被隐藏**：两个重试事实进入了事件流。虽然严重级别和渲染错误，但原始事件仍可追溯。

### 5.3 P0-01：事件语义宽松导致失败被渲染为成功

**类型：确认缺陷。**

首次 Python 调用失败的事件实际包含：

```json
{"type":"issue","status":"WARN","severity":"info","note":"首次调用系统 python 失败……"}
```

渲染结果却是：

```text
issue: ✅OK(首次调用系统 python 失败……)
```

根因在 [harness_events.py](../../harness/scripts/harness_events.py)：

- `issue` 缺少 `severity` 时只警告并默认补为 `info`，仍然写入事件；
- `issue` 渲染只看 `severity`，忽略误传的 `status=WARN`；
- verification 缺少 `name/status` 同样只警告，仍然写入；
- verification 名称会退回到截断 note，而空状态渲染为 `—`。

本次三条 verification 因此都显示为 `→ —`，阶段 8 的长说明还被截断。换言之，`events.ndjson` 保留了文字，却没有保留机器可判定的验证结论。

**建议合同：**

1. 默认 strict：
   - `issue` 必须有 `severity ∈ {info, warning, error, critical}`；
   - `verification` 必须有 `name`、`status ∈ {PASS, FAIL, WARN, SKIP, REUSED}`；
   - 不属于该事件类型的冲突字段直接拒绝，例如 `issue.status=WARN`；
   - 校验失败不得追加事件，返回非零退出码和稳定错误码。
2. 只为旧事件迁移保留 `--legacy-lenient`，且旧数据必须显式标注 `schemaValidation=legacy`。
3. renderer 只根据结构化字段决定符号，不再从 note 关键词推断成功或失败。
4. 为每类事件定义 JSON Schema，并在 append、render、archive 三个入口使用同一份 schema。

**验收：**

- 缺 severity 的 issue 追加失败，events 文件字节不变；
- `issue --status WARN` 返回 `EVENT_FIELD_NOT_ALLOWED`；
- 缺 name/status 的 verification 追加失败；
- 包含“失败”字样的 warning/error 永远不能显示绿色 OK；
- 旧 schema v3 事件仍可在显式兼容模式渲染，但报告标注兼容降级。

### 5.4 P0-02：技能依赖裸 `python`，没有统一运行时解析

**类型：设计局限 + Agent 执行失误。**

`harness-plan`、`harness-knowledge-query` 等技能示例直接调用 `python`。本次 PowerShell PATH 中不存在该命令，首次事件初始化失败，之后才临时定位到 Codex bundled Python：

```text
C:\Users\WINDOWS\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
```

这个绝对路径只能作为本次补救，不能成为 Hunter-Harness 合同。agent 没有在第一条 Harness 命令前解析运行时，是执行失误；技能把裸 `python` 当作跨适配器前提，则是系统性局限。

**建议合同：**

- 提供唯一入口，例如 `harness <subcommand>` 或 `npx hunter-harness <subcommand>`，技能不再拼 Python 脚本路径；
- 若短期仍使用 Python，提供跨平台 runtime resolver，按明确顺序探测并输出 `runtime-resolution.json`；
- Plan 开始前执行一次 `harness doctor --json`，至少记录：适配器、OS、shell/版本、UTF-8 能力、Python 解释器、Git、CodeGraph、JSON 解析能力、自定义 agent 能力；
- 后续阶段复用同一份能力快照，环境指纹不变时不重复探测；
- 缺失必需运行时应在 `phase.start` 前阻断，而不是先写半条流程再补救。

**验收：**在没有 `python` PATH、仅有 `py -3`、仅有 bundled runtime、PowerShell 5 和 PowerShell 7 五类 fixture 中，技能使用同一入口并产生相同结构的能力快照。

### 5.5 P0-03：缺少 Plan 专用原子 finalizer

**类型：设计局限。**

当前 `harness_preflight.py check --project .` 只能证明项目级准备状态为 `ready/stale=false/issues=[]`，不能证明本 change 的四份正文、worktree JSON、事件字段、占位符和 phase 顺序均合格。本次 agent 只能自行编写阶段 8 检查，第一次还选用了 Windows PowerShell 5 不支持的 `Test-Json`。

此外存在执行顺序上的循环：checklist 要求 `logs/execution-log.md` 存在，但该文件由 `phase.end` append 后触发 render。实际只能先校验除日志外的文件，再写 `phase.end`，最后二次校验日志。

**建议新增：**

```text
harness plan finalize --change phase1-controlled-deployment --json
```

finalizer 在同一把 change 锁内完成：

1. 校验必需文件、frontmatter、JSON schema、唯一 change ID、占位符、测试表结构；
2. 校验 approval receipt、worktree 决策和 gate policy 一致；
3. 生成具名 verification 事件；
4. 仅在所有前置检查通过后追加 `phase.end`；
5. 在临时文件渲染 execution log，成功后原子替换；
6. 二次读取并返回 artifact manifest、hash、计数和稳定错误码。

**验收：**任何步骤失败都不能留下“已结束但日志/产物不完整”的中间状态；重复 finalize 必须幂等，不能生成第二个 phase.end。

### 5.6 P0-04：worktree 路径和分支前缀硬编码 Claude 约定

**类型：确认缺陷。**

本次由 Codex 执行，但 `meta/worktree.json` 仍写入：

```json
{
  "path": ".claude/worktrees/phase1-controlled-deployment",
  "branch": "worktree/phase1-controlled-deployment"
}
```

[harness-plan/reference.md](../../harness/harness-plan/reference.md) 以及 run/review/submit 多处模板直接硬编码 `.claude/worktrees/<change-name>`。这会让适配器身份、实际目录和分支策略相互矛盾。

**建议：**

- 把 `agentAdapter`、`worktreeRootTemplate`、`branchPrefix` 放入 effective config；
- Codex 默认 `.codex/worktrees/<change>` + `codex/<change>`；Claude 默认 `.claude/worktrees/<change>`，其他适配器各自声明；
- `worktree.json` 增加 `adapter`、`configSource`、`resolvedPath`、`resolvedBranch`；
- 所有 skill 读取机器配置，不再复制路径文本；
- preflight 检测“当前适配器与路径约定不一致”并阻断 run。

**验收：**对 Codex、Claude、Cursor 三个 adapter fixture 生成不同但自洽的 path/branch；文档合同测试禁止 canonical skills 出现未参数化的 `.claude/worktrees/`。

### 5.7 P1-01：Plan 风险分类看不到设计能力，条件阶段漏判

**类型：确认缺陷。**

本 change 的设计明确包含：Docker 多镜像、Compose 受控部署、GitHub Actions、TCR、TAT、健康 API、迁移与回滚。实际分类结果却为：

```json
{
  "tier": "full",
  "source": "default-full",
  "signals": []
}
```

事件中进一步记录 `package`、`apidoc` 均为 `not-triggered`。当前 [harness_gate.py](../../harness/scripts/harness_gate.py) 的 Plan 分类主要从计划正文提取风险等级；语义 signal 只在 post-run 根据变更路径关键词判断。因此 Plan 阶段不能可靠安排条件阶段，且文件名关键词无法表达“API 合同变化”“容器产物”“外部部署集成”等业务能力。

**建议采用两阶段分类：**

1. `provisional`：change 创建时给出保守 tier，不声称条件阶段已最终判定；
2. `design-final`：审批后读取结构化 capability tags，例如：

```yaml
capabilities:
  - deployment
  - container-image
  - api-contract
  - database-migration
  - security-boundary
  - external-integration
```

3. policy 由 tags 决定 `package/apidoc/security/integration` 等阶段；
4. post-run 再根据真实 diff 做升级或发现漂移，不能静默降级已批准要求；
5. 最终 gate policy 保存 `classificationHistory`、依据 hash 和人工 override。

**验收：**包含 `container-image` 必须触发 package；包含 `api-contract` 必须触发 apidoc；只有文档且无合同变更才允许 docs-only fast；设计标签与实际 diff 冲突时升级并报告 drift。

### 5.8 P1-02：首次状态快照把“建立基线”表达为“所有段已变化”

**类型：设计局限。**

[harness_state.py](../../harness/scripts/harness_state.py) 在 change 本地不存在 previous snapshot 时直接执行 `changed = list(fresh["segments"])`。这会把“第一次为新 change 建立快照”解释为 profile/rules/map/knowledge/change/code 全部发生变化，容易诱导 skill 重跑 sync、知识重建和代码扫描。

**建议输出三态而不是二态：**

- `baselineCreated=true`：首次采集，不代表任何段发生变化；
- `changedSegments=[]`：相对项目级稳定基线没有变化；
- `unresolvedSegments=[...]`：没有可比较基线，调用方应按需读取，而不是默认全量刷新。

项目级 immutable 指纹可由多个 change 复用；change/code 段仍保留本地所有权。设计可借鉴 Nx 的 affected 思路：先根据基线和依赖图缩小需要执行的任务，而不是对每个新 change 重做全量工作。[Nx 官方文档](https://nx.dev/docs/features/ci-features/affected)

### 5.9 P1-03：知识查询 stdout 过大，历史状态排序不利于决策

**类型：设计局限。**

本次 159 字需求查询返回 41,756 字符、753 行 stdout。稳定 context pack 和 `meta/knowledge-context.json` 很有价值，但控制台结果重复携带较大的 `sourceFiles` 数组，并混入 stale/superseded 记录。agent 必须在大量输出中再次筛选，工具输出还容易被截断。

**建议：**

- 默认 `--format compact`：只输出 query ID、matchCount、top N 的 id/title/status/score/reason，以及 context pack 路径；
- 全量结果原子写 JSON 文件，不把完整数组打印到 stdout；
- `--verbose` 才展开 sourceFiles 和长摘要；
- 排序先考虑 `active/current`，再考虑相关度；stale/superseded 默认分组到“历史线索”；
- sourceFiles 去重并提供计数，超长列表写独立 manifest；
- 增加 `maxChars/maxMatches`，达到预算时返回 `truncated=true` 而不是由终端静默截断。

**目标：**常规 Plan 查询 stdout 控制在 4 KB 以内，同时稳定文件保留完整证据。

### 5.10 P1-04：测试场景覆盖面大，但缺少“能否执行”的合同

**类型：设计局限。**

64 个场景并非天然冗余。问题是现有四类表只有场景、前置、步骤和预期，没有明确表示：自动/人工、运行环境、是否发布阻断、是否需要凭据、证据格式、责任方和超时。TCR、TAT、真实服务器、备份恢复等 24 个集成场景中，多项依赖外部基础设施；如果 harness-test 只按总数消费，后续很容易出现大量 NOT_RUN，甚至再次产生“测试都是 0”或“未执行被当成通过”的报告问题。

**建议每个场景增加机器可读元数据：**

| 字段 | 示例 |
|---|---|
| `executionMode` | `automated-local` / `automated-ci` / `manual-controlled` |
| `environment` | `local` / `ci` / `controlled-server` |
| `releaseGate` | `required` / `conditional` / `advisory` |
| `credentials` | `none` / `TCR_PUSH` / `TAT_INVOKE` |
| `evidenceType` | `junit` / `json` / `log` / `screenshot` / `approval` |
| `owner` | `agent` / `operator` / `platform` |
| `timeout` | `30s` / `10m` |

重复的环境矩阵应参数化为一个场景 + cases，报告仍按 case 计数。Plan finalizer 要计算“本地可执行、CI 可执行、受控环境人工执行”的分层总数；test 只能关闭当前环境可执行的部分，不能用 SKIP 冒充 PASS。

### 5.11 P1-05：已有方案确认与 Harness 审批包存在上下文重复

**类型：效率问题，不是要求取消审批。**

调用 `harness-plan` 前，当前会话已经讨论了 change 名称、部署范围、流水线方向和风险；用户明确回复“可以”。Harness 随后仍重新组织完整设计审批包并再次等待确认。第二次确认对于高风险部署设计有价值，但系统没有识别此前已确认内容，因此只能全量重复。

**建议引入 approval receipt：**

- 将此前用户确认的结构化方案保存为 `{scopeHash, decisionHash, approvedAt, sourceTurn}`；
- Harness Plan 比对当前设计，只呈现新增、变化或未覆盖的决策；
- 若范围、数据边界、外部写入或风险等级变化，必须重新完整审批；
- 若完全一致，只补问 worktree 等尚未确认字段；
- receipt 必须进入 change 目录并被 finalizer 校验，不能仅依赖聊天记忆。

这能减少重复等待，同时不降低高风险操作的明确授权标准。

### 5.12 P2-01：技能说明和生成文档均存在重复事实

**类型：维护与生成质量问题。**

Plan 技能四份说明共 38,313 bytes；生成的设计、计划、实现细节、场景表共 41,564 bytes。阶段 8 检查、worktree 路径、事件追加规则在多份技能文档中重复；生成产物也会反复描述相同范围、部署顺序和风险。

**建议：**

- 技能侧把状态布局、事件、finalize、worktree 等规则收敛为脚本和单一 protocol，SKILL 只保留决策流程；
- 产物侧引入稳定 ID，例如 `REQ-D01`、`DEC-D03`、`RISK-D02`、`SCN-D19`；其他文档引用 ID，不复制整段事实；
- 生成一个机器可读 `plan-manifest.json` 作为 ID 和依赖真相源，Markdown 是视图；
- 增加 duplication lint：同一长段或同一数值在多处出现时，要求引用来源；
- 按风险和变更规模给出文档预算，允许小 change 使用合并模板，大 change 才拆四份。

### 5.13 P2-02：CodeGraph 的范围控制和生成目录排除不足

**类型：效率问题。**

本次 Plan 需要 5 次 CodeGraph 调用并补读配置文件；在本次复盘 Hunter-Harness 时，未跟踪的 `.codex-release/` 还进入了索引结果，产生 canonical 与 release 副本重复。仅在 prompt 中要求排除目录并不稳定。

**建议：**

- CodeGraph 配置支持并默认排除 `.codex-release/`、worktree、构建产物和 Harness cache；
- explorer 请求支持 `includeFiles`、`excludeRoots`、`maxFiles`、`maxChars` 的硬约束；
- 命中同名 canonical/release 文件时优先仓库 canonical，并输出 duplicate warning；
- 配置/Markdown 等索引盲区明确返回 `unindexedFiles`，便于一次定向补读；
- Harness 记录每次探索的 query、命中文件数和输出字符数，便于后续优化，而不是只记录总调用数。

### 5.14 P2-03：Windows UTF-8 和 PowerShell 版本仍依赖 agent 经验

**类型：环境兼容问题。**

本次第一次直接读取中文 SKILL 时出现乱码，改为 `Get-Content -Encoding UTF8` 后恢复；完整性脚本又误用了 PowerShell 7 才有的 `Test-Json`。这两类问题都应由能力快照和官方读取/校验入口消除。

**建议：**

- 所有 Harness 自有文本读写固定 UTF-8，并在 Windows fixture 中覆盖 PowerShell 5.1/7；
- 技能不再要求 agent 自己选择 JSON 校验命令，统一调用 schema validator；
- doctor 输出 `shellVersion`、`defaultEncoding`、`utf8RoundTrip`；
- 日志记录实际编码和工具版本，避免把乱码后的 hash 差异当成业务变化。

### 5.15 P2-04：当前事件有时间戳，但不足以定位耗时和重试

**类型：可观测性设计局限。**

目前只能得到阶段墙钟时间 11m50.1s，无法可靠回答：知识查询耗时多少、用户审批等待多少、失败重试浪费多少、哪类工具输出最大。建议借鉴 OpenTelemetry 的 trace/span 模型：change 是 trace，阶段、attempt、工具调用、用户等待是 span；每个 span 有开始/结束、status 和属性。[OpenTelemetry Traces](https://opentelemetry.io/docs/specs/otel/overview/) 将 span 定义为带起止时间、属性、事件和状态的单次操作。

跨 agent、worktree、CI 和部署工具的关联 ID 可借鉴 [W3C Trace Context](https://www.w3.org/TR/trace-context/) 的 trace/span 传播思想，但不必完整引入遥测后端。最小实现可以继续使用 NDJSON，只需增加：

```json
{
  "traceId": "change-run-id",
  "spanId": "tool-attempt-id",
  "parentSpanId": "plan-phase-id",
  "attempt": 2,
  "startedAt": "...",
  "endedAt": "...",
  "status": "OK",
  "attributes": {
    "tool": "knowledge-query",
    "outputChars": 41756,
    "cache": "miss"
  }
}
```

报告应同时显示 active time、tool wait、user wait、重试次数和 top 3 耗时步骤。详细命令输出属于 log/event，不应全部升级成 span，避免新的遥测冗余。[OpenTelemetry 官方说明](https://opentelemetry.io/docs/concepts/instrumentation/libraries/) 也建议把高详细度信息留在日志或 span event 中，而不是制造大量嵌套 span。

## 6. 建议的目标流程

```text
invoke
  → doctor（一次能力解析）
  → change init（adapter/effective config/trace ID）
  → state baseline（区分 baselineCreated 与 changed）
  → compact knowledge query
  → scoped exploration
  → provisional classification
  → design + capability tags
  → delta approval / approval receipt
  → design-final classification
  → 生成 manifest 与 Markdown 视图
  → plan finalize（严格 schema + 原子 phase.end/render）
```

核心原则是：**agent 负责判断，工具负责合同；一次探测，多阶段复用；正文保留解释，状态必须结构化。**

## 7. 改造优先级

### P0：先解决错误结论和跨环境不可执行

| 编号 | 改造 | 预期收益 |
|---|---|---|
| HH-P0-01 | 事件 JSON Schema + strict append/render | 杜绝失败显示 OK、verification 无结论 |
| HH-P0-02 | 统一 CLI/runtime resolver + doctor | 消除裸 Python、PowerShell 版本和编码猜测 |
| HH-P0-03 | `plan finalize` 原子关门 | 消除临时校验脚本、循环依赖和半关闭阶段 |
| HH-P0-04 | adapter-aware worktree/branch config | 防止 Codex 生成 Claude 路径 |

### P1：提高分期正确性和后续可执行性

| 编号 | 改造 | 预期收益 |
|---|---|---|
| HH-P1-01 | capability tags + 两阶段 gate classification | 正确触发 package/apidoc/security 等条件阶段 |
| HH-P1-02 | project baseline 与 `baselineCreated` 三态快照 | 避免新 change 被误判为全量变化 |
| HH-P1-03 | knowledge compact stdout + 状态排序 | 降低上下文和终端输出开销 |
| HH-P1-04 | 场景执行元数据 + 环境分层统计 | 防止 NOT_RUN、SKIP、PASS 混淆 |
| HH-P1-05 | approval receipt + delta confirmation | 减少重复确认，同时保留授权证据 |

### P2：降低长期维护成本并提高生成质量

| 编号 | 改造 | 预期收益 |
|---|---|---|
| HH-P2-01 | 规则去重、ID 引用、plan manifest | 减少技能和产物重复 |
| HH-P2-02 | CodeGraph 硬范围、生成目录排除、预算 | 减少无关探索和重复源码 |
| HH-P2-03 | Windows UTF-8/PS 5.1/7 兼容矩阵 | 减少乱码和命令不兼容 |
| HH-P2-04 | trace/span 风格的运行指标 | 准确分析耗时、等待和重试 |

## 8. 最小回归测试集

| ID | 场景 | 必须结果 |
|---|---|---|
| HR-PLAN-001 | issue 缺 severity | append 非零退出；事件文件不变 |
| HR-PLAN-002 | verification 缺 name/status | append 非零退出；不能渲染 `→ —` |
| HR-PLAN-003 | issue 传入冲突 status | 返回稳定 schema 错误，不能显示绿色 OK |
| HR-PLAN-004 | Windows PATH 无 python | doctor 找到受支持 runtime 或在 phase.start 前明确阻断 |
| HR-PLAN-005 | PowerShell 5.1 | 不使用 `Test-Json`；中文 round-trip 无乱码 |
| HR-PLAN-006 | Codex adapter + worktree=true | 路径 `.codex/worktrees/...`，分支 `codex/...` |
| HR-PLAN-007 | deployment + container + API change | package 与 apidoc 均 required |
| HR-PLAN-008 | 新 change 首次 snapshot | `baselineCreated=true`，不报告所有段 changed |
| HR-PLAN-009 | finalize 中任一 artifact 非法 | 无 phase.end、无半生成 execution log |
| HR-PLAN-010 | 重复 finalize | 幂等；事件和日志内容不重复 |
| HR-PLAN-011 | 10 条知识命中且 sourceFiles 很长 | stdout ≤ 4 KB；完整 JSON 仍可追溯 |
| HR-PLAN-012 | 受控服务器场景无凭据 | 报告为 BLOCKED/NOT_RUN，绝不能 PASS；本地 gate 不被错误关闭 |
| HR-PLAN-013 | `.codex-release/` 含 canonical 副本 | CodeGraph 默认排除或明确提示重复来源 |
| HR-PLAN-014 | 已有有效 approval receipt | 仅询问 delta；设计变化时强制重新审批 |

事件合同建议使用 [JSON Schema](https://json-schema.org/understanding-json-schema/basics) 的条件结构表达不同 event type 的必需字段，并对 schema 自身增加版本化回归测试。

## 9. 后续阶段固定回写模板

每个阶段结束后追加一节，使用以下结构。没有结构化证据的指标写“不可得”，不得估算。

```markdown
## N. <Phase> 阶段复盘

### N.1 阶段结果
- 状态：完成 / 失败 / 阻断
- 开始与结束时间：
- active/tool wait/user wait：
- 产物与 hash：
- 验证总数：PASS / FAIL / WARN / SKIP / NOT_RUN / REUSED

### N.2 实际执行路径
- 关键步骤、降级路径、重试和人工决策

### N.3 新发现
| 类型 | 证据 | 影响 | 根因 | 优先级 | 建议 | 验收 |

### N.4 对既有问题的验证
- 已修复 / 未触发 / 回归 / 仍存在

### N.5 对下一阶段的约束
- 可复用证据、必须重跑项、剩余风险
```

同时更新第 4 节阶段状态和第 7 节优先级；如果新证据推翻旧判断，应保留旧判断并标记“已修订”，不要静默覆盖历史。

## 10. 后续阶段重点观察清单

### Run

- Codex 是否真的创建 `.claude/worktrees/...`，以及后续脚本能否正确识别；
- 主工作区与 worktree 的 Harness 动态状态是否仍会分叉；
- TDD 事件是否能区分 RED 是预期失败还是基础设施失败；
- compile/test ledger 是否准确复用，是否因首次 snapshot 全 changed 触发冗余刷新；
- Docker/Compose 文件产生后，post-run classifier 是否补触发 package/apidoc。

### Test

- 64 个场景如何映射到真实命令、环境与凭据；
- 本地不可执行的 TCR/TAT 场景是否被诚实标记，而不是计为 0 或通过；
- JUnit/JSON/命令退出码是否成为结构化事实源；
- 服务启动、端口、容器和临时文件是否可靠清理；
- 测试报告总数是否与场景追踪表、ledger 一致。

### Review

- 自定义 reviewer 不可用时 inline 降级是否仍产生等价六维报告；
- review finding 与 fixback 是否有稳定 ID 和关闭证据；
- 只读审查是否误改动态状态；
- 设计的安全边界、镜像供应链、备份恢复是否真正覆盖。

### Submit

- worktree 分支前缀和 integration 流程是否兼容 Codex；
- 提交/合并是否保护其他 change 的未提交 Harness 证据；
- ledger 复用是否基于同一 diffHash、命令和作用域；
- push、merge、cleanup 的失败恢复是否幂等。

### Archive

- 总耗时是否来自真实阶段事件，而不是文件时间或固定值；
- 测试、review、fixback、tool calls 是否能从结构化证据恢复；
- 条件场景的 NOT_RUN/BLOCKED 是否没有被吞掉；
- 归档快照、知识入库和源 change 清理的顺序是否安全；
- 本文最终结论是否与 archive summary 数据一致。

## 11. 当前审批意见

对 `phase1-controlled-deployment` 的 **Plan 产物本身可批准进入 Run**；上述问题主要属于 Hunter-Harness 的流程可靠性和执行效率，不构成否定当前设计内容的理由。

但对 Hunter-Harness 当前 Plan 流程的评价为：**REVISE**。P0-01 至 P0-04 至少应进入下一轮 Harness 修复 change，尤其是事件错误着色和 verification 无状态问题；在它们修复前，后续报告必须以 `events.ndjson` 和原始验证证据交叉核对，不能只相信渲染后的 execution log。

## 12. Run 阶段复盘

### 12.1 阶段结果

- 状态：`WARN`，实现已完成；唯一环境门禁是本机 Docker daemon 不可用，真实镜像/容器/数据库验证已编码为 push 后 required CI job。
- 时间：2026-07-19 04:19:52—04:59:13，墙钟 39m20.5s。Harness 仍未提供 active/tool wait 的可靠拆分。
- 变更规模：commit-invariant diff 统计 43 个文件；新增 6 个受 test guard 管理的测试文件，38 个既有测试未修改。
- TDD：5 个依赖簇均获得业务 RED 后转 GREEN；新增部署合同最终 47 passed、1 Windows POSIX skip，WSL Bash 语法另行通过。
- 回归：backend 在无数据库条件下 93 passed、1 skipped、37 setup errors；37 项均为 `127.0.0.1:5432 connection refused`。地学包 17 passed；前端 53 passed，lint/build exit 0。
- 独立静态校验：controlled Compose 完整展开成功；Actionlint v1.7.12 的 Windows release 按官方 SHA-256 `6e7241...f6e9` 校验后执行，两个 workflow 0 finding。
- 未执行：本地镜像 build、三扩展/空库迁移、controlled stack、备份恢复容器演练、Trivy/SBOM、真实 TCR push 和 TAT invoke。前五项进入 CI；后两项保留人工审批，不得在本地伪造。

### 12.2 实际执行路径

1. `harness-run` 开始时修正 Plan 硬编码的 Claude worktree，实际创建 `.codex/worktrees/phase1-controlled-deployment` 与 `codex/phase1-controlled-deployment`。
2. 一次 CodeGraph 探索返回 127 symbols/30 files，且提示索引来自主 worktree 的旧 HEAD；输出过宽并截断。它帮助确认 auth/session 与测试入口，但部署配置仍主要靠定向 `rg` 和文件读取。
3. 自动 build-profile detector 把多栈根目录判为 `unknown` 并清空命令；test guard 首次快照因此为 0。随后手工建立 `python-node-polyglot` profile，第二次快照才覆盖 39 个测试文件。
4. 按配置健康、引导/manifest、镜像/Compose、主机发布脚本、CI/CD/TAT 五簇执行 RED→GREEN。测试夹具本身出错时先修夹具，再重新取得业务 RED，没有把 import error 或错误断言当成产品失败证据。
5. Docker CLI 与 Compose 可用，但 daemon named pipe 不存在。静态 Compose、Bash、Python、前端与 Actionlint 继续执行；容器项明确外移 CI。
6. test guard 以 6 个新测试、38 个未变测试正常关闭；Run gate 以 WARN 正常释放 lease。

### 12.3 做得好的部分

1. **外部边界没有被突破**：未调用真实 TCR/TAT、未读取生产 credential，也没有为了验证自动启动/恢复用户已明确废弃的 Docker Desktop 虚拟磁盘。
2. **TDD 事实可追溯**：events 中分别记录五个 cluster 的 RED/GREEN；基础设施失败与业务 RED 分开。
3. **Run gate 对 WARN 的表达基本正确**：`harness_gate close` 只把 compile/unitTest 列为 validated，并保留数据库/容器为外部门禁，没有把 ledger 中的 NOT_RUN 自动提升为 OK。
4. **专用工具有明确收益**：Actionlint 一次命令就验证 workflow 语法和表达式；Compose `config --profile ops` 展开比字符串测试更早暴露 secret target、命令数组和 Alembic 工作目录问题。
5. **Agent Memory 搜索比 Harness knowledge stdout 更节制**：5 条摘要足以提醒既有流程结论；相比 Plan 的 41,756 字符知识输出，更适合作为启动线索。

### 12.4 新确认的问题

#### HH-P0-05：多栈 detector 会破坏已有可用 profile

**类型：确认缺陷，优先级 P0。**

`harness_profile detect --project .` 在仓库同时存在 `backend/pyproject.toml`、`packages/cbm_geo/pyproject.toml` 与 `frontend/package.json` 时输出 `projectType=unknown`，并把 commands/verification inputs 清空。其直接后果是 test guard `begin` 只捕获 0 个文件。探测失败不应有破坏性写入。

建议：

- detector 先生成 candidate，只有置信度达到阈值且校验通过才原子替换；否则保留旧 profile 并返回 `DETECTION_AMBIGUOUS`；
- 支持 workspace/component discovery，把 backend、Python package、frontend 和 deployment 作为组成单元合并；
- `detect --dry-run --json` 为默认，`--apply` 才写；
- profile schema 增加 deployment/workflow/Shell 输入类型，不能只关注源码和测试；
- 回归 fixture：Python + Node、多 pyproject、嵌套 package、已有人工 override、探测异常，均不得清空有效命令。

#### HH-P0-06：test guard 的 MANIFEST_INVALID 不提供可执行修复顺序

**类型：确认缺陷，优先级 P0/P1。**

修改一个已登记测试后，在登记新测试时 guard 返回笼统 `MANIFEST_INVALID`；实际必须先以 `test-updated` 重记旧文件，再登记新文件。错误没有列出漂移文件和下一条安全命令，agent 需要阅读实现猜顺序。

建议返回：

```json
{
  "code": "TRACKED_TEST_HASH_DRIFT",
  "files": ["..."],
  "allowedNextActions": ["record --reason test-updated ..."]
}
```

若一次 record 同时包含已登记修改文件和新文件，工具应按文件状态自动拆分原因，或明确拒绝并给出两条有序命令。不得只返回“manifest invalid”。

#### HH-P0-07：显式 diffHash 被接受后静默丢失

**类型：确认缺陷，优先级 P0。**

`harness_ledger diff-hash --repo <feature-worktree> --base 16bd6a5` 成功计算 `sha256:3b3ac6...b395`、43 files。随后 `record --base-commit 16bd6a5 --diff-hash ...` 返回 `ok=true`，但每条记录和响应仍是 `diffHash: null`。同时 canonical change-dir 在主 worktree、代码在 feature worktree 时，带 `--change-dir` 的 diff-hash 又会报目录位于 repo 外。

这使 ledger 的“可复用”身份实际上只依赖 profile inputs；而当前 profile 不包含 Dockerfile、Compose、Shell、workflow、runbook，部署验证可能在关键文件变化后被错误复用。

建议：

- `repoRoot` 与 `stateDir` 分离为一等参数，允许 canonical 状态在主 worktree；
- 显式传入 diffHash 后必须 round-trip 保存并返回；无法保存时非零失败，禁止 ok + null；
- ledger 记录 `ownershipFileCount`、`uncoveredChangedFiles`；存在未覆盖文件时不能复用；
- 为跨 worktree state、untracked 文件、测试 tracking 三者组合增加回归测试。

#### HH-P1-06：post-run classifier 对部署/API 真实 diff 仍漏判

**类型：Plan P1-01 的确认回归，优先级升级为 P0/P1。**

真实 diff 已含：两个 Dockerfile、`deployment/compose.controlled.yml`、两个 GitHub workflow、OpenAPI JSON 和前端 schema。post-run 仍只命中 `artifact-protocol/concurrency/migration`，`package/apidoc=not-triggered`。这证明单靠现有路径/内容信号不足，不能只把 Plan 阶段的漏判归因于“代码尚未生成”。

建议至少把下列路径作为确定性 signal：

- `**/Dockerfile`、`deployment/**`、`.github/workflows/**` → package/security/integration；
- `contracts/openapi/**`、API route 或 schema 生成物 → apidoc；
- compose/migration/database image → database/integration；
- 发布脚本/TAT/CAM → security/external-integration。

分类器应输出每个 signal 的具体命中文件，方便 review 检查误报。

#### HH-P1-07：CLI 文档/入口漂移继续制造低价值重试

**类型：设计局限 + Agent 执行失误。**

- `harness_change.py resolve --project .` 不支持 `--project`；
- events 不支持 `type=warning`，必须用 `issue`；
- ledger `--files` 不展开 glob，metrics JSON 在 PowerShell 的 quoting 也缺少稳定 file-input 形式；
- skill 仍要求 agent 拼脚本子命令，而不是单一 typed CLI。

每个错误单独看都小，但会制造无价值工具调用和事件噪声。建议统一 `harness` CLI，结构化参数优先支持 `--from-json <file|stdin>`，PowerShell/Linux 不再分别处理复杂 JSON quoting；help/schema 与技能示例由同一源码生成并做契约测试。

#### HH-P1-08：lease 刷新返回的 TTL 元数据自相矛盾

**类型：确认缺陷。**

以 `--ttl-seconds 7200` 刷新 lease 后，`expiresAt` 确实延长约两小时，但返回和文件中的 `ttlSeconds` 仍为 3600。消费者若用 ttlSeconds 计算续租，会与真实 expiry 冲突。应明确 `originalTtlSeconds/currentTtlSeconds`，或更新为当前值，并增加 `remainingSeconds`。

#### HH-P1-09：复合 shell 命令会掩盖前序失败

**类型：Agent 执行失误，可由 runner 防护。**

早期将 `docker info` 与 `docker compose version` 放进同一次 PowerShell 调用，前者失败、后者成功，工具总 exit code 为 0。后来读取逐条输出才识别 daemon 不可用。建议 Harness 的验证 command 默认为单一 argv；确需多步骤时使用结构化 step 数组并分别保存 exit code，禁止用“最后一条命令成功”代表整组成功。

#### HH-P2-05：Goal 元技能发布包缺少其声明的 references/scripts

**类型：技能分发完整性问题。**

本轮显式使用 `qiaomu-goal-meta-skill`。SKILL 引用了 `references/default-goal-strategy.md`、`goal-command-playbook.md` 和 lint script，但本机安装目录只有 `SKILL.md`。本轮仍可依照主文件创建 Goal，但无法执行技能声称的完整 lint/参考流程。

建议所有技能发布时生成 content manifest，并在安装/调用前校验引用闭包；缺文件应返回 `SKILL_PACKAGE_INCOMPLETE`，而不是等 agent 逐个发现。此问题也支持为 Harness sync 增加“技能引用闭包校验”，而不只是版本号比较。

### 12.5 CodeGraph、知识库与工具选择的阶段性判断

| 能力 | 本轮实际收益 | 成本/问题 | 建议使用边界 |
|---|---|---|---|
| CodeGraph | 快速暴露 auth/session、health 入口和测试路径 | 单次 127 symbols/30 files、输出截断；索引来自主 worktree 旧 HEAD；对 YAML/Shell/部署文件不敏感 | 只用于“明确符号 + 调用链”的窄问题；worktree/commit 不匹配先拒绝或标 stale；强制 maxFiles/maxChars |
| Harness knowledge | 稳定 context pack 和历史归档可追溯 | Plan 默认 stdout 41 KB，stale/superseded 混排 | 默认 compact top 3–5；长结果只落盘；先按状态过滤再按相关度 |
| Agent Memory | 5 条跨项目摘要快速提醒既有结论 | 不是 change 内证据，不能替代 HEAD/事件 | 适合启动与历史导航；关键结论必须回到项目/归档验证 |
| `rg` + 定向读取 | 对 Dockerfile/YAML/Shell/Markdown 最快且可控 | 不理解动态调用链 | 部署/配置 change 的默认首选；与 CodeGraph 互补，不应强制先跑宽查询 |
| Compose config | 展开 anchors、profiles、secret target、命令数组，直接发现真实配置问题 | 不连接 daemon，不能证明镜像可运行 | Run 静态门禁必备；Test/CI 再补容器门禁 |
| Actionlint | 下载约 2.5 MB，一次检测两个 workflow，0 finding | 需管理工具版本/校验和 | 建议成为 deployment/workflow change 的条件验证；固定版本与官方 checksum |

结论：CodeGraph 和知识库都有帮助，但都不应成为无条件全量前置。最省时间/token 的策略是“先按 artifact 类型选工具”：符号/调用链用窄 CodeGraph，历史决策用 compact knowledge，YAML/Shell/Markdown 用 `rg` + 专用 validator。Harness 应把这个路由固化在 capability tags/doctor 中，而不是要求 agent 每轮自行试错。

### 12.6 可借鉴的社区能力（阶段性，不等于直接引入）

1. **Actionlint**：适合作为 workflow 语法/表达式快速门禁；本轮已验证实际价值。
2. **Zizmor**：适合在 Review/CI 检查 GitHub Actions 的权限、注入和供应链风险；应固定版本并先评估误报，不替代人工威胁建模。
3. **Grill-me / grilling 模式**：最适合 Plan 批准前的高风险设计压力测试，输出应是“问题 + 被推翻的假设 + 是否阻断”，而不是再生成一份长方案。对 docs-only/低风险 change 默认关闭，避免 token 翻倍。
4. **ShellCheck**：应和 `bash -n` 配对；前者查语义/可移植性，后者只查语法。本机缺失时由 CI 执行，报告必须区分 NOT_RUN 与 PASS。
5. **Dependabot/Renovate**：适合维护 Action SHA、基础镜像和 SDK pin，但升级 PR 必须重跑 build/scan/restore；不能自动合并部署供应链更新。

### 12.7 对下一阶段的约束

- `harness-test` 必须以 64 个场景为真相源，分别报告 local PASS、CI_REQUIRED、CONTROLLED_MANUAL，不允许把未执行汇总成 0 或 PASS。
- Docker daemon 缺失已经有事实证据；Test 不应反复尝试启动用户已废弃的 Docker Desktop，也不应重复下载依赖。
- 必须复用 47+17+53 的已执行结果时，校验当前 diff 未变化；由于 ledger diffHash 为 null，不能盲信 ledger reuse，需重新运行低成本批次或计算当前 diff。
- Review 必须重点检查 secret 文件权限、Redis ACL 用户、TAT 参数注入、workflow permission/Action SHA、备份路径穿越和失败回滚。
- Submit push 后应观察 required CI 的真实镜像/数据库/全栈结果；CI 失败必须回到 fix→test→review，不得仅因本地实现完成而归档。

对当前 Run 产物的意见：**允许进入 Test，产品实现无已知本地 RED；Harness Run 流程仍为 REVISE。**

## 13. Test 阶段复盘

### 13.1 阶段结果与真实数字

- Test gate 于 2026-07-19 05:03:07 开始、05:12:34 以 `WARN/CLOSED_DEGRADED` 收口，墙钟 9m27.2s；不以 Docker/PG 不可用伪造全绿。
- 本轮实际执行 119 项确定性测试：118 passed、0 failed、0 errors、1 Windows POSIX skip；同一批 8 个 Shell 脚本已由 WSL `bash -n` 实测通过，因此 skip 没有遗留语法缺口。
- 分项：后端部署专项 48 passed/1 skipped，`cbm_geo` 17 passed，前端 53 passed；前端 build、lint、Python compileall、Compose 完整展开、OpenAPI 冻结/类型再生成均 exit 0。
- 64 个批准场景没有再被汇总为 0：20 个真实前置实测、14 个函数/配置/静态合同实测、28 个 `CI_REQUIRED`、2 个 `MANUAL_GATE`、0 个 FAIL。合同实测没有冒充端到端 PASS。
- API 顶层事实为 `BLOCKED`：0 个 live HTTP PASS、0 FAIL、10 个因受控栈不可用而无法形成端到端证据；其中 9 个已有低层合同证据。
- Run 阶段的完整后端证据仍是 93 passed、1 skipped、37 setup errors，37 个均为 PostgreSQL connection refused。本阶段在环境未变化时没有再消耗约 87 秒重放同一失败。
- test guard 正常收口：44 个既有测试未变化，Test 阶段新增/修改测试文件为 0。

持久化报告：CBM Forge `.harness/changes/phase1-controlled-deployment/reports/test/test-report-20260719-0508.md`。报告包含每个批准场景的证据等级、服务生命周期、四类执行器、准确测试计数和剩余门禁。

### 13.2 本阶段执行路径与效率判断

1. 按 Test skill 完整执行 PowerShell/Node/Python/uv/pnpm/Docker preflight。Docker CLI/Compose 存在，但 daemon named pipe 缺失，8000/8443 均未监听。
2. 根据用户“无人值守且不恢复废弃 Docker”约束，直接选择 `NOT_STARTED`，不生成无法运行的 HTTP runner，不逐条 fallback 到 Playwright/curl，也不请求真实 credential。
3. 重新计算真实 diffHash 为 `sha256:3b3ac6...b395`。由于 Run 后仍有少量代码修正且 ledger diffHash 为 null，没有复用旧 unitTest 结论，改为并行复跑低成本批次。
4. 后端专项、地学包、前端测试/构建/lint、compileall、Bash syntax 和 Compose 展开并行执行。首轮 Compose 仅因 agent 使用了错误变量前缀而失败；读取 env contract 后以 `API_IMAGE/GATEWAY_IMAGE/DATABASE_IMAGE/REDIS_IMAGE` 的合成 digest 一次通过，不将第一次误用记为产品故障。
5. OpenAPI freeze 与前端 schema regenerate 前后分别计算 SHA-256，两个文件字节稳定，避免仅凭 `git diff` 猜“没有漂移”。
6. 对 64 个场景逐项区分“真实前置实测、合同实测、CI_REQUIRED、MANUAL_GATE”；不把静态字符串断言、fake TAT gateway 或函数单测升级成 HTTPS/容器/外部服务实测。

本阶段 CodeGraph 与知识库都没有再次调用，这是有意的工具路由而不是遗漏：代码调用链在 Run 已确认，Test 的主要工作是执行批准场景和专用验证器；再次宽查 CodeGraph 或输出历史 knowledge pack 不会增加证据，只会消耗时间/token。Test 阶段最有效的工具是 pytest/Vitest、Compose config、Bash parser、OpenAPI 生成器和精确 diffHash。

### 13.3 做得好的部分

1. **数字终于与事实对齐**：119 项执行与 64 个设计场景分别计数；不再出现“测试 0”或把条件场景吞成空值。
2. **没有重复已知环境失败**：Docker daemon 缺失只探测一次；历史 37 个 DB setup error 被保留为证据，没有反复跑满 87 秒。
3. **没有错误 fallback**：接口前置不可用时没有用 Playwright/curl 伪造“API 已测”，也没有生成无数据意义的 runner。
4. **并行度合理**：互不修改共享状态的后端、geo、frontend、compile、syntax/config 批次并行，阶段墙钟明显低于逐条顺序执行。
5. **场景诚实分层**：`test_ci_cd_contracts.py` 和 fake TAT gateway 只被标成合同实测；真实 Environment gate/TAT 调用仍是 MANUAL_GATE。
6. **专用工具优先**：Compose 展开和 OpenAPI 字节稳定性提供了比字符串推断更强、成本更低的证据。

### 13.4 新确认的问题

#### HH-P0-08：报告状态与 ledger 状态枚举不能表达同一事实

**类型：确认缺陷，优先级 P0。**

Test 报告按 skill 正确给出 `apiTest=BLOCKED`；但 `harness_ledger.py record` 对现有 verification 只支持 `ok/fail/not_run`，因此同一事实只能写成 `apiTest=NOT_RUN`，即使 metrics 明确是 `scenariosTotal=10, passed=0, failed=0, blocked=10`。下游 gate/archive 若只看 ledger 会把“因环境阻塞”误读成“没有执行计划”，或者再次丢失 blocked 数量。

Gate 源码实际上另有一个**未在 harness-test SKILL/checklist/reference 和 ledger protocol 中说明**的约定：`status=NOT_RUN` 且 evidence 必须以 `DEGRADED:` 开头，才允许 `CLOSED_DEGRADED`。本轮初次 WARN close 因普通 NOT_RUN 被拒，读源码后按该正式实现记录，才正常关闭。这个字符串哨兵解决了 gate 关闭，却没有解决 ledger 语义仍显示 NOT_RUN、API BLOCKED 无法直接表达的问题。

建议：

- verification status 统一支持 `OK/PARTIAL/BLOCKED/NOT_RUN/FAIL/NOT_APPLICABLE`；
- gate、report、ledger、archive 共享同一枚举和转换库，不在 Markdown 模板中另造一套；
- `BLOCKED` 必须包含 blocker code、影响场景 ID、owner（local/CI/manual）和关闭条件；
- 回归测试覆盖 0 PASS+10 BLOCKED、5 PASS+5 BLOCKED、5 PASS+1 FAIL 三种情况，禁止降级为 NOT_RUN。

#### HH-P0-09：场景表没有机器状态层，64 行靠 agent 手工二次分类

**类型：设计局限，优先级 P0/P1。**

当前 approved scenario 表只有 Markdown 行，没有稳定 scenario manifest、execution target 和 evidence link。本轮为了避免最终报告再次出现 0，agent 必须手工把 64 行映射为 20/14/28/2，并自行检查总和。这既耗 token，也容易把静态合同误升为端到端 PASS。

建议 Plan 同时生成 `test-scenarios.json`：

```json
{
  "id": "INT-D19",
  "priority": "P0",
  "executor": "manual-protected-environment",
  "requiredCapabilities": ["tcr", "tat", "credential"],
  "evidenceLevel": "external-e2e",
  "allowedStatuses": ["MANUAL_GATE", "PASS", "FAIL"]
}
```

Test runner 追加 `scenario-results.ndjson`，由 finalizer 自动生成 Markdown 和计数；每个 PASS 必须有 command/event/artifact 引用。静态合同只能关闭 `contract` evidence level，不能自动关闭 `external-e2e`。

#### HH-P1-10：Test skill 指令体量和重复度过高，仍按 Java/远程认证中心设计

**类型：设计局限，优先级 P1。**

本轮必须完整读取 `SKILL.md`、247 行 checklist、276 行 pitfalls 和 829 行 reference；其中命令预检、四类 runner、service lifecycle、credential cache、Java/Maven/profile 规则多次重复。对一个 Python+Node+部署 change，约一千多行说明多数不适用，却必须进入上下文。

建议：

- `SKILL.md` 只保留不可违反的 20–30 条合同和 phase state machine；
- checklist 改成机器可执行 profile/capability manifest，按 `python/node/deployment/live-api` 条件加载；
- Java/Maven、远程 SSO、Playwright fallback 分拆为可选 reference，不作为所有项目的默认输入；
- pitfalls 以规则 ID 建索引，首次只读摘要；出现对应错误码时再按 ID 加载全文；
- 模板、枚举和 CLI help 由源码生成，删除三处重复说明。

#### HH-P1-11：PowerShell 的 JSON 参数合同仍不稳定

**类型：HH-P1-07 的确认回归。**

`--metrics-json '{"total":...}'` 在 PowerShell 5.1 传给 Python 后会丢失内部引号；本轮先后两次得到 `invalid --metrics-json`，必须把每个双引号以反斜线保留给 Windows argv parser 才成功。这是低价值重试，而且 skill 示例没有提供 PowerShell 5.1 可直接复制的可靠形式。

建议所有复杂结构改用：

- `--metrics-file <utf8-json>`；或
- `--from-json <request-file|stdin>`；
- typed PowerShell wrapper 直接序列化对象并调用库函数，不经过命令行 JSON。

CLI 契约测试必须在 PowerShell 5.1、PowerShell 7、bash 三个 runner 上执行。

#### HH-P1-12：UTF-8 Markdown 在 PowerShell 5.1 默认读取会乱码

**类型：环境差异 + 文档可用性问题。**

首次 `Get-Content -Raw` 读取 checklist 得到乱码；显式 `-Encoding UTF8` 后才正确。技能本身大量使用中文，却没有在所有 PowerShell 示例和 reader helper 中统一 UTF-8。Agent 可以修正，但每个阶段都会浪费一次读取并增加误解风险。

建议提供 `harness read-doc` 或统一 helper，以 UTF-8 no-BOM 读取并检测替换字符；所有生成 Markdown/JSON 固定 UTF-8 no-BOM、LF，并在 Windows 回归测试中验证中文可读。

#### HH-P1-13：ledger 显式 identity 在 Test 再次“成功但未保存”

**类型：HH-P0-07 的重复复现。**

Test 以 43 个真实 changed/untracked 文件记录 compile/unit/package/apiTest，并显式传入 baseCommit 与 diffHash。四次 `record` 均返回 `ok=true`，但响应和 ledger 顶层仍为 `diffHash:null`、`baseCommit:null`。这证明不是单次 Run 调用错误，而是 legacy/v3 合同分支的系统性静默丢弃。

修复验收应要求：传入但未持久化的身份字段一律非零退出；legacy ledger 要么原子迁移到新 schema，要么明确拒绝 v3 参数，禁止接受后忽略。

#### HH-P1-14：test guard 的所有权在 skill 与 gate 之间重复且 project root 语义分裂

**类型：确认缺陷，优先级 P1。**

`harness-test` 明确要求 `harness_test_guard begin → close`，随后再调用 `harness_gate close`；但 gate close 内部又无条件调用 test guard close。按文档先显式关闭后，gate 得到 `SNAPSHOT_INVALID`。重新 begin 后若 gate 的 `--project` 传 canonical 主 worktree，它又拿主目录去校验 feature worktree 快照而失败；只有再次 begin，并把 gate 的 `--project` 指向 feature worktree才成功。与此同时 gate 内部 resolve change 仍使用 main project，导致同一个 `--project` 参数同时承担两种不同语义。

建议：

- 明确唯一 owner：推荐 gate close 原子执行 guard close，skill 不再要求 agent 手工 close；
- guard close 必须幂等，已关闭返回 `ALREADY_CLOSED` 成功而不是 `SNAPSHOT_INVALID`；
- CLI 拆成 `--state-project`（canonical change）与 `--code-root`（feature worktree），禁止一个 `--project` 在函数内部时而被忽略、时而代表代码目录；
- worktree 模式回归测试覆盖 main state + feature code + explicit guard close + gate retry。

### 13.5 测试阶段对工具和社区能力的客观判断

| 能力 | Test 阶段结论 | Harness 应如何处理 |
|---|---|---|
| CodeGraph | 本阶段不调用更快；它不负责证明 YAML/Shell/容器运行 | 由问题类型路由，禁止“每阶段固定先查” |
| Harness knowledge | 当前 change 的批准场景已经在本地，重复查询没有新增事实 | 仅 Plan/跨 change/历史决策默认查；Test 只按缺失证据按需查 |
| pytest/Vitest | 最高性价比的行为证据；可并行，输出计数稳定 | profile 应原生支持多组件并行与结构化结果汇总 |
| Compose config | 无 daemon 也能发现变量、profile、secret target 与 YAML 展开错误 | deployment change 的本地必跑门禁 |
| Actionlint | Run 已对未再修改的 workflow 完成，Test 无需重复下载 | ledger 以文件 hash 复用专用验证，不按阶段机械重跑 |
| ShellCheck | 本机/WSL 均缺失；`bash -n` 只能证明语法 | 固定进 CI；本地 doctor 输出 capability，报告记 CI_REQUIRED |
| Zizmor | 更适合下一阶段 Review 的 workflow 安全检查 | 条件触发，不和 Actionlint重复宣称同一能力 |
| Grill-me | Test 不适合；它不能替代可执行证据 | 只在高风险 Plan 批准前，以短问题清单压力测试关键假设 |

### 13.6 宏观流程优化：从“阶段驱动”改为“证据图驱动”

本阶段最明显的低效来自：Run、Test、Review 各自重复读取长说明、重复判断同一环境、重复拼相似命令。更合理的核心不是继续增加 skill，而是建立一张证据图：

1. Plan 为每个 requirement/scenario 声明 evidence level、capability、owner 和 blocking policy。
2. Run 产出实现与低层 unit/contract evidence，写入同一 scenario result store。
3. Test 只执行尚未满足且本环境具备 capability 的节点；Docker 不可用时一次标记所有依赖节点，不逐条重试。
4. Review 消费 changed artifact + evidence gap，集中审查没有被测试关闭的高风险边界。
5. Submit/CI 回填 container/db/security nodes；manual environment 只接收显式 MANUAL_GATE 节点。
6. Archive 从事件与 scenario store 计算真实数字，不从 Markdown 文本或文件时间猜测。

这样能同时减少重复命令、重复上下文、token 和错误升级。建议优先实现 scenario manifest/result store、统一状态枚举、capability doctor、严格 ledger identity 四个基础件，再考虑引入更多社区工具。

### 13.7 对下一阶段的约束

- Review 必须把 14 个合同实测与 30 个未关闭端到端节点作为重点，而不是因为本地 0 FAIL 就给出全绿。
- 重点审查：secret 文件权限与 UID/GID、Redis ACL、TAT 参数/输出截断、GitHub expression/permissions/Action SHA、备份路径穿越、并发锁、rollback/readiness。
- 允许使用 Zizmor/Shell 专用静态分析作为补充，但结果必须区分工具未安装、finding 与 false positive；不得下载后遗留 C 盘缓存。
- Review 若修改代码或测试，必须重算 diffHash、回归相关 119 项子集，并回写 finding/fixback；当前 Test 报告不应被静默覆盖。

对当前 Test 产物的意见：**允许进入 Review；产品本地确定性证据无 FAIL，但受控部署尚未获得容器/数据库/真实 HTTPS CI 证据。Harness Test 流程仍为 REVISE。**

## 14. Review 阶段复盘

### 14.1 阶段结果与真实数字

- Review gate 的权威时间戳为 2026-07-19 05:13:26.631—05:38:13.331，墙钟 **24m46.700s**，最终 `WARN`。`phase.end.note` 被 agent 手工误写成 22m55s；事件流已追加 `REVIEW_DURATION_CORRECTION`，本节和后续归档必须按 start/end 计算，不能复制 note。
- 审查入口为 43 个文件、约 `+2885/-26`；修复、负向测试和 CI 真栈接线后为 47 个文件、`+3522/-29`。
- 初审形成 5 个 RED、7 个 YELLOW：迁移连接串失效、Linux executable mode、tar 链接越界、TAT 执行逻辑与 commit 漂移/任意镜像 namespace、release ID/tag 审计覆盖，以及基础镜像浮动、manifest 审计字段、checkout token、备份二次读取竞争、INT-D23 未接线、SBOM 不完整、dotenv/TAT 输出边界。
- 12 个发现均在 Review 内修复并回归；保留 2 个明确的 advisory YELLOW：数据库 dump 与文件 tar 缺少跨存储共同写屏障，以及 gateway root master 仍可进一步降权。它们没有被包装成“完美”，也没有扩大成本轮真实生产改造。
- Review 修复后实际回归：后端部署专项 50 passed/1 Windows POSIX skip，WSL Bash 已关闭同一语法缺口；`cbm_geo` 17 passed；前端 53 passed、build/lint exit 0；OpenAPI/schema 字节稳定；Compose、compileall、Bash 均通过。
- Workflow 专用审计：Zizmor 修复前 5 个 medium `artipacked`，修复后 auditor/pedantic 均为 0 个可报告 finding；actionlint 1.7.12 返回 `[]`。Zizmor 离线模式仍提示 5 个在线审计项 ignored，因此报告只写“0 reportable/offline”，不写“所有在线审计通过”。
- 产物：`reports/review/review-report-20260719-0536.md` 与 `fixback-20260719-0536.md`；事件、fixback、回归与 phase close 均已落盘。

### 14.2 本阶段哪些工具真正有帮助

| 工具/信息源 | 实际收益 | 实际成本/局限 | 后续路由建议 |
|---|---|---|---|
| 目标 worktree `git diff` + 定向源码 | 找到 5 个会在 Linux/真实发布中直接失效的 RED，定位最可靠 | 需要人工沿 manifest→TAT→host script→Compose 追链 | Review 的默认事实源；先按风险入口缩小 diff，再读完整调用链 |
| CodeGraph | 本轮只证明索引陈旧：返回 186 symbols/52 files，但关键 `main.py` 和部署路径来自主 worktree 旧版本 | 对 feature worktree 给出“看似权威、实际错误”的源码，增加误判/token 风险 | 索引必须包含 `repoRoot+worktreeHead+dirtyHash`；不匹配时 fail closed，不返回源码；Review 不应强制调用 |
| Harness knowledge | Review 未再次调用，反而更快；Plan 已生成的 10 条历史约束和 change 本地设计足够 | 重放 41k 字符 context pack 不会证明当前 diff | 默认只在 Plan、跨 change 设计和历史决策冲突时查询；Review 按 finding 需要查单条 ID |
| Zizmor | 精确发现 5 个 checkout credential persistence 问题，修复验证清晰 | 离线 `ignored` 不解释具体审计项；临时安装仍有下载/cache 成本 | 保留为 workflow security 条件门禁；固定版本和缓存目录，结果结构化保存；在线审计能力单独标注 |
| Actionlint | 快速验证两个 workflow 的 YAML、expression 和语义，输出稳定 `[]` | agent 猜错 Windows asset 名导致一次 404；首次命令错误后 PowerShell 继续产生级联噪声 | 保留；由 Harness tool manager 按 GitHub release asset metadata+digest 安装，`$ErrorActionPreference=Stop`，不让 agent 猜文件名 |
| Registry `imagetools inspect` | 不需要 Docker daemon即可取得 6 个官方 multi-arch digest，直接关闭浮动 tag | 只证明 registry manifest，不证明镜像可启动 | deployment Review 的高性价比工具；结果进入 machine evidence，镜像启动仍由 CI |
| pytest/Vitest/Compose/Bash/OpenAPI | 低成本关闭修复回归，120 个行为测试通过且输出可计数 | 不能替代镜像、真实 HTTPS、TAT | 与 Test 证据按 diffHash 复用；仅重跑受影响组件 |
| ShellCheck/gitleaks/semgrep | 本机均不可用，没有被伪记为 PASS | 临时安装三套工具会增加时间和缓存；ShellCheck 已在 CI | doctor 先给 capability；ShellCheck/gitleaks 适合固定 CI，Semgrep 仅安全高风险/自定义规则时触发 |

结论：CodeGraph 和知识库不是“每阶段必用工具”。Plan 中知识库帮助恢复历史边界；Run 中 CodeGraph 可用于稳定主分支调用链；但脏 feature worktree Review 中，两者的边际收益都低于准确 diff。Harness 应做**问题类型和 freshness 驱动的路由**，而不是为了流程完整机械调用。

### 14.3 Agent 执行失误与工具本应防止的浪费

1. 首次 WSL 命令在含空格路径上引用错误，`cd /mnt/e/MyProject/CBM` 失败；改用 `wsl.exe --cd <Windows path>` 后通过。应由跨平台 command builder 生成，不让每个 skill 手写三层引号。
2. Actionlint 版本本身正确，但 agent 猜成 `windows_x86_64.zip`，实际 asset 是 `windows_amd64.zip`；PowerShell 未设置 stop-on-error，随后 checksum/expand/execute 产生级联错误。官方 GitHub release API 一次查询即可消除这组噪声。
3. 一次多文件 patch 因 env example 的上下文假设错误整体失败；拆成小 patch 后通过。这是 agent 执行失误，也说明大型 fixback 应按独立 finding/文件簇应用，避免一个 context mismatch 回滚所有无关修复。
4. PowerShell `Remove-Item -Recurse` 即使目标已验证仍被执行策略拒绝两次；改用 `git clean -ndx -- .tmp-review` 预演，再对显式路径执行，安全且成功。Harness 应提供 workspace-scoped temp manager/cleanup，而不是让 agent临场选择删除命令。
5. `phase.end` 的 22m55s 是人工心算错误，真实 start/end 为 24m46.700s。这正是用户此前指出“归档时间 1 秒/数据不对”的同类根因：任何已有时间戳可计算的字段都不应再让 agent手填。

### 14.4 新确认的 Harness 问题

#### HH-P0-15：阶段耗时仍允许自然语言手填，与事件时间戳冲突

**类型：确认缺陷 + Agent 失误，优先级 P0。**

Gate 已拥有 phase.start/end 的高精度时间戳，却接受 note 中任意耗时文本。本轮 note 的 22m55s 与真实 24m46.700s 冲突，gate 仍 `ok=true`。Archive 如果解析 note 或复制报告，就会再次生成错误耗时。

建议：

- gate close 返回并持久化 `startedAt/endedAt/wallMs`，note 禁止出现机器指标或只作为说明；
- active/tool/user wait 从统一 telemetry span 计算，缺失写 `null+reason`，不写 0；
- archive/final report 只读取结构化 duration，不解析 Markdown；
- 若事件追加纠错，archive 使用最后的 typed correction 或直接按时间戳重算，并显示 provenance。

#### HH-P0-16：CodeGraph 不识别 worktree/dirty diff，可能返回错误但高置信源码

**类型：集成契约缺陷，优先级 P0/P1。**

项目规则要求先查 CodeGraph，但索引只对应主工作区。Review 在 feature worktree 中新增 47 个文件时，它仍返回旧 `main.py` 和与目标 diff 无关的源码，没有显式 `STALE_INDEX_FOR_WORKTREE`。若 agent不二次核对，会漏掉 TAT/恢复/迁移 RED。

建议查询响应强制包含 `indexedRoot/indexedCommit/indexedDirtyHash/requestedRoot/requestedHead`；任一不匹配只返回 freshness 错误和刷新命令，不返回源码。短期内 Harness Review 应先执行 freshness probe，只有 match 才把 CodeGraph 列为默认工具。

#### HH-P1-17：Review 报告与 fixback 重复表达同一 finding

**类型：token/维护成本，优先级 P1。**

本轮 12 个 finding 在 review-report 和 fixback 两份 Markdown 中重复等级、位置、风险、修复和验证。对人可读，但会增加生成 token、漂移和归档体积。

建议以 `review-findings.json`/NDJSON 为唯一结构化源：report renderer 生成叙述视图，fixback renderer 生成执行视图；finding 修复只更新 status/evidence，不复制文字。可直接计算 initial/open/fixed/residual 计数。

#### HH-P1-18：Review 缺少受控工具安装与缓存管理器

**类型：效率/供应链设计局限，优先级 P1。**

Actionlint、Zizmor、ShellCheck、gitleaks 等工具由 agent自行判断版本、asset、checksum、缓存目录和清理。虽然本轮最终校验了官方 checksum并清理 E 盘 temp，但仍发生 404、级联输出和两次删除策略拒绝。

建议提供 `harness tool ensure actionlint@1.7.12 --json`：维护 OS/arch asset 映射、官方 digest/source、E 盘 workspace cache、TTL/LRU 清理和离线复用；报告记录 tool identity。禁止默认写 C 盘全局 cache，除非用户配置。

#### HH-P1-19：Review stage 的“先 stage 再审”使 index 与 worktree 容易分裂

**类型：流程设计局限，优先级 P1。**

Review 开始时产品实现已 staged；修复后大量文件变成 `AM/MM`。若某个检查使用 `git diff --cached`，另一个使用 `git diff`，会审到不同版本。最终必须重新 `git add -A` 才形成一致快照。

建议 gate begin 创建只读 review manifest：base commit、工作树 blob hash、untracked hash 和 file mode；所有工具读取该 manifest 指向的临时 index/tree object。修复后显式生成 revision 2，不依赖用户 index 作为审查快照。

### 14.5 对社区能力“引进/不引进”的客观意见

| 能力 | 是否建议 | 适用位置 | 理由与边界 |
|---|:---:|---|---|
| actionlint + Zizmor | 建议 | Review/CI，按 workflow diff 触发 | 两者互补：前者语法/表达式，后者权限/注入/供应链；本轮均找到或验证实际问题 |
| ShellCheck | 建议 | Shell diff 必跑 CI | `bash -n` 只查语法；ShellCheck 查引用、管道、可移植性。无需每个 agent临时安装 |
| gitleaks | 建议 | pre-commit/CI，增量 + 全库基线 | 比自然语言 regex 更稳定；命中必须人工确认，禁止把 fixture 默认密码当生产泄漏 |
| Trivy/Syft | 建议保留一种主链 | 镜像 build 后 | 当前 Trivy 已同时覆盖漏洞和 CycloneDX；没有证据表明再加 Syft 会显著增益，先避免重复 SBOM 工具 |
| OPA/Conftest | 条件建议 | 多套 Compose/K8s/IaC 后 | 可把 non-root、digest、port、secret mount 规则代码化；当前仅一份 Compose 时自定义 pytest 已足够，暂不引入运行时负担 |
| CodeQL | 条件建议 | GitHub CI 周期/主分支 | 对 Python/TS 深层数据流有价值，但运行成本高；不应每次本地 Harness Review 重跑 |
| Semgrep | 条件建议 | 有项目专属安全规则时 | 通用规则与 CodeQL/人工审查重叠；没有规则集和误报预算时不应为了“工具更多”而引入 |
| grill-me / grilling | 建议，默认按风险触发 | Plan 审批前 | 对部署、权限、数据模型这类高风险设计，用 5–10 个反事实问题攻击“环境可用、回滚安全、版本可复现”等假设；输出直接回填风险/场景，不再生成第三份长方案 |
| 通用多 agent 审查 | 条件建议 | 可独立的安全/数据/性能子域 | 只有共享快照和 finding 去重后才并行；否则同一 diff 重读三遍会增加 token和互相矛盾，不是自动提速 |

`grill-me` 最适合在 Plan 的“方案选择已形成、用户审批尚未发生”之间插入，且只对 high/critical risk 或关键假设数量超过阈值启用。它不能替代 reviewer，也不应在 Test 后重新审问已确定需求。

### 14.6 宏观优化：以一次采集、多视图渲染替代六阶段重复劳动

结合 Plan/Run/Test/Review 的实际执行，建议 Harness 核心收敛为四类事实源：

1. **Change manifest**：requirement、risk、scenario、owner、capability、evidence level、外部门禁。
2. **Workspace snapshot**：base/head/dirty/untracked/file mode、CodeGraph freshness、知识索引版本。
3. **Evidence ledger**：command、tool identity、input hash、result counts、artifact、blocker、duration span。
4. **Finding store**：severity、dimension、location、risk、fix revision、verification、residual status。

Plan/Run/Test/Review/Submit/Archive 只是在这些事实上的状态转换和不同视图，不应各自重新读取长文档、手工算数字、复制 Markdown。这样可以：

- CodeGraph/knowledge 只按 freshness 和问题类型调用；
- 同 input hash 的 actionlint/pytest/OpenAPI 证据跨阶段复用；
- report/fixback/archive 从同一 JSON 生成，减少 token 和漂移；
- duration/test counts/findings 从结构化字段计算，消除 1 秒、0 测试和本轮 22m55s 等假数据；
- 高风险节点自动触发 grill/reviewer，低风险 docs change 不承担相同流程成本。

### 14.7 对 Submit 的约束

- Submit 前重新确认 staged tree 与 Review 最终 snapshot 一致，不能把 `AM/MM` 的旧 index 提交。
- push 后必须读取 GitHub CI：backend/geo、frontend、contracts、三镜像/三扩展、真实 HTTPS、备份恢复、QL03 Playwright、Trivy/SBOM。失败则回到受影响 fix→test→review，不得先 archive。
- `deploy-controlled` 是 manual Environment workflow，本任务不得为了“验证流水线”自动触发真实 TCR/TAT。
- Submit/Archive 的耗时、测试、finding 和文件统计必须从 event timestamps、CI checks、git tree 和 finding store/报告计算；缺失就是 unknown，不得写 0。

对当前 Review 产物的意见：**允许进入 Submit；产品初审高风险问题已闭环，但发布 readiness 仍取决于 push 后 CI，真实生产授权仍不存在。Harness Review 流程仍为 REVISE。**

## 15. Review 后 Test Attempt 2 复盘

### 15.1 为什么必须回到 Test

`harness-submit` 正确识别到 Review 修改了迁移路由、恢复安全、TAT/镜像信任、发布身份和 CI 真栈，属于行为性/安全性变更，旧 Test diffHash 不能复用。没有为了赶进度直接提交；正式开启 Test attempt 2，时间为 05:40:42.795—05:45:14.008，墙钟 **4m31.213s**，`CLOSED_DEGRADED/WARN`。

本轮新执行后端部署专项 50 passed/1 Windows POSIX skip、compileall、WSL Bash syntax、Compose 展开和 diff check；复用同一最终产品内容在 Review 已执行的 geo 17、frontend 53/build/lint、OpenAPI、actionlint、Zizmor。报告明确区分“本轮新执行”和“同树复用”，没有把 120 pass 全算成本轮重复执行。

64 场景更新为 20 LOCAL_PASS、15 CONTRACT_PASS、27 CI_REQUIRED、2 MANUAL_GATE、0 FAIL；恶意 symlink tar 的真实临时文件系统测试让 COM-D10 从 CI_REQUIRED 提升为合同实测，但没有把它冒充完整数据库恢复。

### 15.2 HH-P0-20：test-tracking 在 staged 新测试上形成无法自愈的状态环

**类型：确认缺陷，优先级 P0。**

Review 前 6 个新测试已进入 index，manifest 保留创建时 `trackedBefore=false`。Review 修改 5 个测试后：

1. canonical diffHash 因旧 hash 返回 `TEST_TRACKING_HASH_DRIFT`；
2. `record --reason test-updated` 本应刷新 hash，却先校验所有 manifest 项的 `trackedBefore == tracked_now`；
3. staged 新文件此时 `git ls-files` 为 tracked，因而 `record` 返回 `MANIFEST_INVALID`，无法更新自己要求更新的 manifest。

实际恢复只能对 6 个精确测试执行 `git restore --staged`（工作区字节不变），重新 record，再由 guard stage。流程最终安全成功，但这是工具状态机死锁，不应成为 agent知识。

建议：

- `introducedTrackedState` 与当前 index 状态分离；`trackedBefore` 只做审计字段，不参与后续 record 有效性；
- record 对目标文件允许 hash/index 状态更新，对非目标文件仍严格校验；
- `record --refresh-existing` 原子完成 validate old identity → update hash → exact stage，不要求 agent先 unstage；
- 回归覆盖 untracked-created→staged→review-modified→record→stage→diff-hash，以及多个目标/一个未修改目标的组合。

### 15.3 Ledger 第三次确认“返回成功但丢 identity”

manifest 修复后 canonical diffHash 为 `sha256:76d33ec88f21f545ace56d460ad6760e1f2b90a68823db8b0ce19e01f43497a8`、47 files、6 tracked tests。随后 compile/unitTest/unitTestFull/apiTest/package 五次 record 均 `ok=true`，inputsHash 和 metrics 已更新，但响应/ledger 顶层仍是 `diffHash:null`，显式 `--base-commit` 也没有落盘。

这已在 Run、Test attempt 1、Test attempt 2 三个阶段重复，属于稳定复现而非偶发。修复优先级应升到 P0：CLI 接受身份参数就必须持久化并回读比对；legacy contract 若不支持则直接 `IDENTITY_UNSUPPORTED` 非零失败，不能“成功但忽略”。

### 15.4 Submit 与 CI 的循环依赖

Build profile 的 `unitTestFull` 是 `uv --directory backend run pytest -q`，需要 PostgreSQL；本地 Docker 已由用户废弃且 daemon 不存在。Submit 协议又要求 `unitTestFull=OK` 才能 commit/push，而完整 DB/镜像/HTTPS 验证只能在 GitHub runner push 后运行。这形成流程循环：**没有 push 就没有 CI full evidence，没有 full evidence 又不允许 push**。

本轮采用用户 Goal 中已批准的保守策略：Test gate 用 `DEGRADED:` 明确 93 pass/37 DB setup errors 的历史事实，push 仅用于获得 CI，不触发受保护 deploy workflow；CI 失败回到 fix→test→review，成功后才 archive。

建议 Harness 把“合并/发布”拆开：

1. `submit-candidate`：本地确定性门禁通过后推送候选 commit/PR 分支；
2. `ci-verify`：回填 required checks、容器 evidence 和 scenario results；
3. `promote/merge`：只有 required checks OK 才合并主分支；
4. `deploy`：独立受保护 environment/manual gate。

当前 worktree transaction 直接 no-ff merge+push 主分支后 CI 才跑，严格来说是“先合并、后发现”。若仓库规模和风险上升，应改为 PR/check-run 驱动；当前无人值守单仓可继续，但必须等待 CI 再 archive。

### 15.5 本阶段效率结论

- 有效：只重跑受 Review 影响的 50 个后端部署测试与低成本静态门禁，geo/frontend 按同树证据复用，4m31s 收口。
- 无效：guard 死锁导致 unstage→record→stage；ledger 三次调用因 cwd/non-ASCII quoted path 又产生两次可避免失败，最终仍丢 identity。
- 新发现的 CLI 问题：`harness_ledger record --project <worktree>` 只用于 profile 展开，`--files` 仍相对进程 cwd；从主目录调用时找不到 `.dockerignore`。同时普通 `git diff --name-only` 把中文路径输出成 quoted octal，作为 `--files` 又找不到文件，必须显式 `git -c core.quotepath=false`。Harness 自己应接受 NUL-delimited file manifest，不应让 agent拼逗号列表和处理 Git 显示编码。

对 Test attempt 2 的意见：**允许进入 Submit candidate；本地产品证据无 FAIL，完整 readiness 仍必须由 push 后 CI 关闭。Harness 的 guard/ledger/submit-CI 边界均为 REVISE。**

## 16. Submit（特性提交）阶段复盘

### 16.1 可核对结果

Submit gate 为 05:47:21.305—05:48:42.629，真实墙钟 **1m21.324s**，状态 PASS。canonical diffHash 在提交前仍为 `sha256:76d33ec88f21f545ace56d460ad6760e1f2b90a68823db8b0ce19e01f43497a8`，47 个文件、6 个显式跟踪测试；`git diff --cached --check` 通过。中文提交 `342fdc069a7c97326ed2cdd61836974442f09ddc` 创建成功，统计为 3522 additions、29 deletions，提交后特性 worktree 干净。

用户 Goal 已明确要求无人值守完整交付，故没有再次制造确认等待；该授权只覆盖 commit/merge/push 候选代码，不覆盖真实 TCR/TAT、生产凭据或部署。真实部署 workflow 仍保持 GitHub Environment 人工门禁。

### 16.2 HH-P0-21：Test guard 的“精确暂存”在 Submit 重放时并不幂等

Submit 技能要求再次执行 `harness_test_guard stage`。Test attempt 2 已正确完成 record→stage→close，6 个新测试此时自然已进入 index；Submit 重放立刻返回 `MANIFEST_INVALID`，原因仍是 manifest 中审计字段 `trackedBefore=false` 与当前 staged 状态冲突。没有文件被改动，索引也未变化，最终提交范围仍由关闭后的 guard 证据、canonical diffHash 和 staged diff 三重确认。

这说明 HH-P0-20 不只影响 Review 后刷新，也影响 Submit 的标准路径：技能要求幂等重放，工具状态机却把成功执行后的合法状态判为非法。修复时应新增完整回归：begin→record(new)→stage→close→Submit stage，第二次 stage 应返回 `ALREADY_STAGED` 或同义成功，并验证 hash，不得要求 unstage。

### 16.3 Submit 协议的合理边界与冗余

- 有效：提交消息落在 change runtime，`git commit -F` 避免 shell 多行/编码陷阱；提交对象、diffHash、文件数和工作区状态均可机器核对。
- 有效：Submit 和 merge 使用独立 gate，能区分“本地候选提交成功”和“已合并推送”，避免把 push 失败写成提交失败。
- 冗余：Test 阶段已关闭且 HEAD/diffHash 未变时，Submit 再次 stage 测试没有新增安全价值。更合适的合同是 `verify-staged --expected-diff-hash --expected-test-manifest-hash`，只读比对后提交。
- 设计问题：`unitTestFull=OK` 作为 push 前硬条件无法表达 CI-required 环境；本轮 `can-reuse` 正确拒绝了降级证据，但流程没有一等的 `candidate` 状态，只能靠 decision event解释。建议实现 `LOCAL_VERIFIED / CI_REQUIRED / PROMOTABLE` 三态，而非 PASS/FAIL 二态。
- 用户偏好已明确“不检查 `.harness` 是否在 `.gitignore`”。该检查不是产品正确性证据，还会与项目选择的 Harness 版本策略耦合；应从通用 Submit 移到仓库初始化/策略审计，仅在策略声明 `harnessArtifacts=ignored` 时检查一次。

### 16.4 对合并与 CI 的约束

下一步事务合并只能以提交 `342fdc0` 为源，并验证目标分支、远端追踪和合并后最小回归；push 后必须等待 GitHub CI 真实结束。CI 若失败，不能以 Submit PASS 掩盖，必须回到受影响的 fix→test→review；只有真实栈、镜像与供应链 jobs 形成可核对证据后才允许 Archive。真实 `deploy-controlled` workflow 不在本轮自动执行范围。

对当前 Submit 阶段的意见：**产品候选提交 PASS；允许事务合并并推送以获取 CI 证据。Harness Submit 流程仍为 REVISE，主要是 guard 非幂等和 candidate/CI/promote 状态缺失。**

## 17. Submit 首轮事务合并与 CI 复盘

### 17.1 事务结果与真实 CI 事实

integration transaction 按 preflight→prepare→no-ff merge→verify→push→cleanup 全部完成：特性提交 `342fdc0` 合并为 `4fe1c3c2df5a6b358176fc57ae5f7e10a47ec595` 并推送 `origin/master`；隔离合并树内专项回归 50 passed、1 个 Windows POSIX skip，耗时 20.541s。事务本身没有冲突或 push 失败。

GitHub Actions run `29662441442` 随后给出首批本地无法替代的 Linux/数据库证据：

- `frontend`：PASS；
- `backend-and-geo`：迁移两次成功，测试 132 passed/1 failed；失败不是产品权限放宽问题，而是 POSIX `tmp_path.write_text` 默认 0644，测试没有先把 secret fixture 设成产品要求的 0600；
- `contracts-and-deployment-static`：OpenAPI PASS；ShellCheck 因动态 source 的 SC1091 返回 1，workflow 应以 `-x` 跟随同仓 source；
- `images-and-integration`：因上游 needs 失败被诚实标为 skipped，没有冒充验证。

merge gate 因“合并/推送成功但 CI 未闭环”关闭为 WARN，而不是 PASS 或 FAIL。两个问题都可在仓库内修复，已进入 fix→targeted test→review→resubmit；未触发生产 deploy workflow。

### 17.2 CI 的价值与本地验证盲区

本轮清楚证明 CI_REQUIRED 不能被静态合同或 Windows+WSL 测试取代：真实 Ubuntu 文件模式暴露了 fixture 漏洞；官方 ShellCheck 的退出语义暴露了本地只做 Bash syntax/下载式审查的差异。CI 首轮从 push 到结论约 74 秒，反馈速度足以支持候选分支先验证、再 promote；当前“先 merge master、后 CI”反而放大修复提交和主分支红灯成本。

### 17.3 HH-P1-22：integration cleanup 名称与行为容易误导

transaction 的 `cleanup=DONE` 只清理隔离 transaction root/保护引用；主工作区仍落后远端两个提交，原特性 worktree 和 `codex/phase1-controlled-deployment` 分支仍存在。该行为本身保守且便于 CI 失败后继续修复，但“cleanup”没有输出 `retainedWorktrees/retainedBranches/primaryHeadState`，agent若按名称理解为全收尾会漏同步或误报已清理。

建议返回显式字段：`transactionArtifactsRemoved`、`sourceWorktreeRetained`、`featureBranchRetained`、`primaryWorktreeUpdated`，并将策略命名为 `cleanup-transaction`；最终 source worktree/branch 清理由 Archive 或独立 finalize 执行，且必须在 CI 通过后。

### 17.4 流程优化结论

推荐提交链改成：push feature candidate→GitHub required checks→transaction no-ff merge verified SHA→push target→验证 target check。对单人仓也能避免 master 首轮红灯；若不引入 PR，至少让 integration 支持 `push-candidate` 和 `promote` 两步。CI 日志应由 Harness 通过 GitHub Checks API 结构化采集 job/step/conclusion/duration，而不是要求 agent阅读大段 ANSI 日志再手工转录。

对首轮事务与 CI 的意见：**事务工具本身按设计完成，但端到端交付尚未通过；产品进入可控修复回路。Harness 需要 candidate-first 和明确 cleanup 语义，结论 REVISE。**

## 18. CI attempt 1 Fixback Run 复盘

### 18.1 修复内容与证据

fixback 没有放宽产品安全边界：POSIX secret fixture 在调用 `read_secret_file` 前显式 `chmod(0600)`，继续验证“只移除行尾、不 trim 密码空格”；workflow 的 ShellCheck 从默认调用改为 `-x -P deployment/scripts`，既允许跟随同仓 source，也明确 source 搜索根。

按 TDD 先把 CI workflow contract 加严，观察到预期 RED，再修改 workflow；随后得到：部署相关后端 50 passed/1 Windows POSIX skip、ShellCheck 0.11.0 零 finding、WSL Bash syntax PASS、Actionlint `[]`、Zizmor 1.27.0 offline 零 reportable。最终只有 3 个文件、+3/-1，影响面清晰。

本轮还纠正了一个 agent 初步判断：仅加 `shellcheck -x` 在 Windows 官方二进制上仍报 `common.sh` 找不到；追加 `-P deployment/scripts` 后才真正通过。说明“根据诊断提示机械加 flag”不足，必须执行工具本体验证。

### 18.2 HH-P0-23：同一 change 跨首个 commit 后，v1 test-tracking 无法继续使用

Run gate close 自动调用 test guard。旧 manifest 中 6 个在首次提交前创建的测试永久记录 `trackedBefore=false`；首个 commit 后这些文件当然已经 tracked，于是任何后续 fixback 的 `record/close/stage` 都返回 `MANIFEST_INVALID`。这不是 staged 状态问题，而是 **change 生命周期跨 commit 后必然失效**，使标准的 CI fixback 无法闭环。

为保留证据，本轮没有覆盖旧 manifest：将它另存为 `test-tracking-attempt2.json`，再让 guard为本次 attempt 重新记录两个已跟踪测试（`trackedBefore=true`），gate 才能关闭。当前运行时已有 schema v2 分支且不再校验 `trackedBefore`，但当前 change 仍走 v1，说明缺少自动迁移/attempt scope。

建议：

1. 所有新执行统一升级 v2；加载 v1 时原子迁移并保留 `migratedFromHash`；
2. manifest 以 `attemptId`/base/head 分层，首次提交不应令整个 change 的测试跟踪失效；
3. `trackedBefore` 只用于“此 attempt 是否新建”，不参与文件当前合法性；
4. 回归必须覆盖 change→commit→CI fail→修改旧测试→Run/Test/Submit 的完整链。

### 18.3 工具成本判断

本轮最有价值的是 GitHub CI 日志、ShellCheck 本体和两个极小 pytest；CodeGraph/知识库对三行跨平台修复没有增益，调用只会增加上下文和延迟，因此按问题规模主动跳过。Actionlint/Zizmor复跑成本低且 workflow 确有变化，保留合理；重新下载工具的成本可通过项目级 E 盘 tool cache 与校验元数据消除。本轮第一次 actionlint 下载还因把资产名猜成 `x86_64` 而 404，随后通过 GitHub release API 发现实际名为 `amd64`——Harness tool resolver 应查询 release manifest，不应在技能或 agent里猜资产名。

对 fixback Run 的意见：**产品修复 PASS，可进入正式 Test/Review；Harness 的跨 commit test-tracking 为 P0 REVISE。**

## 19. Test Attempt 3 复盘

### 19.1 执行结果

Attempt 3 为 06:00:58.502—06:02:47 左右，约 **1m48s**，`WARN/CLOSED_DEGRADED`。本轮新执行修复聚焦 pytest 16 passed、ShellCheck 0 finding、WSL Bash syntax PASS、Actionlint `[]`、Zizmor 0 reportable、diff check PASS；Run 同一 diff 的 50 passed/1 skip作为复用证据明确单列，没有把 66 个通过重复包装成一次执行。

64 场景仍为 20 LOCAL_PASS、15 CONTRACT_PASS、27 CI_REQUIRED、2 MANUAL_GATE、0 current-candidate FAIL。CI attempt 1 的两个失败已修但尚未被 Linux rerun，因此既不保留为当前 FAIL，也不提前升级为 PASS。报告 `test-report-20260719-0601.md` 保留了 job级事实和下一门禁。

### 19.2 Ledger identity 第四次稳定复现

本轮以新的 canonical diffHash `sha256:bee936fecf069763060a0e89579d06e8631928aca73420468df7fa68d2d85d36`、base `16bd6a5` 显式记录 compile/unitTest/unitTestFull/apiTest/package。五次均 `ok=true`，metrics、files、scope 写入成功，但响应仍为 `diffHash:null`。这已经跨首次实现、Review fix、Test attempt 2、post-CI fixback 四种状态复现。

还观察到 Windows PowerShell 向 native Python 传 JSON 时，`'{"k":1}'` 会变成 `{k:1}`，需要传入反斜线保护的 `'{\"k\":1}'`。这次首次 record 因 `invalid --metrics-json` 失败属于 agent/平台参数问题；更好的 CLI 应支持 `--metrics-file` 或 stdin JSON，避免三层 shell quoting 和 token浪费。

### 19.3 Gate 只验证了 unitTestFull 的可解释性问题

Test close 返回 `LEDGER_OK_DEGRADED`，payload 的 `validated` 仅列 `unitTestFull`，没有列 compile/unitTest/apiTest/package。即使这是 policy 设计（只把 required degraded 节点列出），字段名也会让人误以为其他记录未验证。建议返回三组：`checked`、`degraded`、`notApplicable`，而不是用 `validated` 同时表示“全部检查过”或“关键节点”。

此外，gate close 再次报告自动 record 两个测试，虽然本 attempt 已在 Run close 记录。这不影响 hash，但说明 snapshot/attempt 边界不透明；输出应包含 before snapshot id、detected hash delta 与“refresh/unchanged”区分。

### 19.4 效率结论

本轮不到两分钟的 targeted Test 是合理的：变化只有 workflow 参数和 fixture mode，重复全前端/全 geo 没有价值；真正决定 readiness 的是下一次 GitHub CI。CodeGraph和知识库继续不调用是有意的路由选择，不是遗漏。Harness若有 change-aware test selector，可直接根据三文件映射出 pytest contract+ShellCheck+workflow audit，省去 agent手工选择和报告解释。

对 Test attempt 3 的意见：**本地候选允许进入 fixback Review；CI evidence 尚缺，Archive 禁止。Harness Test 仍为 REVISE。**

## 20. CI Fixback Review 复盘

### 20.1 结果

fixback Review 为 06:03:22.842—06:03:49 左右，约 **26 秒**。审查范围严格限定 3 文件、+3/-1；六维结论均 OK，新增 RED=0、新增 YELLOW=0。整个 change 仍保留初审的 2 项 advisory YELLOW，因此 gate 诚实关闭为 WARN。报告没有重新复制初审所有内容，只引用不变风险并解释本 fix 的安全/兼容语义。

关键判断是拒绝两个表面“更快”的错误修法：不禁用 SC1091、不删除 secret mode 校验。真正修复是让 fixture 遵守 0600，并让 ShellCheck跟随受控仓库 source root。工具本体已验证，而不是仅凭日志猜测。

### 20.2 小 diff Review 应采用证据增量，而非完整重演

本轮 26 秒足以完成，因为：

- base、fix diff、CI失败日志和 Test attempt 3 都是结构化/可定位证据；
- 生产代码未变，架构/性能维度可用明确“不受影响”结论，而非重读 47 文件；
- 安全/兼容集中在两行，ShellCheck/pytest提供直接反证；
- 既有 finding 只做状态继承，不复制长篇报告。

这应成为 Harness fixback Review 的默认模式：输入 `parentReviewId + changedSinceReview + failedEvidenceIds`，自动只展开受影响维度。当前仍需 agent手工维持关联，但已经证明增量审查可以从 24m47s 降到 26s，同时不降低质量。

### 20.3 社区工具结论的进一步校准

ShellCheck 在本轮是直接找根因/验修工具，应进入 shell diff 的必选项；Actionlint和 Zizmor 对一行 `run:` 参数变化没有新 finding，但耗时约 1 秒，作为 workflow 安全回归仍划算。CodeGraph、知识库、grill-me 对这个已由 CI 精确定位的三行 fix 不适用：强制调用会浪费 token；grill-me 应留在高风险 Plan 假设审问，而非每次 fixback。

对 fixback Review 的意见：**产品 APPROVED，可重新提交；CI 绿前仍不可 Archive。Harness应产品化增量 Review，结论 REVISE。**

## 21. CI Fixback Submit 复盘

fixback Submit 为 06:04:14.951—06:04:33 左右，约 **18 秒**。本次证明 guard在“按 attempt 重建且两个测试均已 tracked”的状态下可以正常工作：精确暂存两个测试返回 `STAGED`；workflow 用显式 path暂存；最终提交 `928ce3878f49b9c04fd9fc740cc0ee2fb2c7ae4d` 仅 3 files、+3/-1，worktree 干净。

与首次 Submit 的差异具有诊断意义：同一 guard 工具不是普遍不可用，而是 v1 manifest 的 `trackedBefore` 生命周期错误。attempt 重建后 stage 安全且快速，因此不应删除 guard；应修 attempt/schema 和幂等语义。

提交消息继续由 runtime 文件和 `git commit -F` 驱动，中文编码正确，没有 AI footer；用户对完整无人值守交付的原始授权仍有效，无需在同一 Goal 内重复请求确认。下一步只允许合并/push 候选与 CI，不触发真实 deploy。

对 fixback Submit 的意见：**PASS；提交范围和测试跟踪正确。Harness保留 guard，但必须升级 v2/attempt model。**

## 22. 第二轮 Merge 与 CI Attempt 2 复盘

### 22.1 先失败的 transaction：安全门禁正确，基线来源错误

第二轮首次 transaction 以仍停在 `16bd6a5` 的 primary worktree 作为 expected target，尽管 `origin/master` 已是 `4fe1c3c` 且 feature 也包含该提交。preflight/merge/16-test verify 均完成，push 正确报 `TARGET_MOVED`，没有强推；但 `recover` 也因同一 stale expected base 拒绝，integration lock需另用 `harness_change integration-lock release` 解除。

primary 安全 fast-forward 到 `4fe1c3c` 后重建 transaction，base 才正确；生成 merge `497cf52171cdcd40caf6f4db55b53951764c71e5`，验证 16 pass，push/cleanup 成功。问题不是 Git并发，而是 transaction preflight 优先读本地 target ref而非 freshly fetched remote target。

**HH-P0-24 建议：** preflight 必须先 fetch，再把 `remoteTargetHead` 作为 compare-and-swap base；本地 primary仅用于 dirty/branch策略。若二者不等，应明确返回 `PRIMARY_STALE` 并提供安全 sync建议，不能先构造注定无法 push 的 merge。recover应允许在“remote等于当初 observed remote、仅 local expected错”时清 transaction，至少必须释放 lock/临时 worktree而不改变远端。

### 22.2 CI attempt 2 的增量价值

GitHub run `29662859400` 证明上一轮两个修复已经闭环：

- backend-and-geo PASS，包含依赖启动、迁移两次和完整测试；
- frontend PASS；
- contracts-and-deployment-static PASS，说明 `ShellCheck -x -P` 在 Ubuntu apt 版本真实有效；
- images-and-integration 首次实际运行，但 gateway image 在 Dockerfile build-time `nginx -t` 时因 compose service `api` 不存在于构建 DNS 而失败；真实栈、Trivy、SBOM 因此 skipped。

这是新证据，不是上一修复回归。API image和前端 build已经完成到 gateway最终 `nginx -t`，失败定位为 build-time environment contract。下一轮应保留 `nginx -t`，为构建检查提供临时受控 `api`解析，不能删除配置验证；随后再次让 CI跑到 stack/scan/SBOM。

### 22.3 反馈链的客观成本

从第二次 push 到结论约 4 分钟，其中 backend 2m12s、image job 1m43s。当前 workflow以 needs 串行使重 job只有前三项全绿才开始，适合省 runner但延长 fix反馈；gateway Dockerfile这种纯 build failure本可在独立 `build-images` job与 backend并行，更早约 2 分钟暴露。建议拆成：image-build（并行）→stack-integration→scan/SBOM；Docker layer cache按 lockfile/Dockerfile key复用。这样既缩短失败反馈，也不让恢复测试在未构建镜像时启动。

对 CI attempt 2 的意见：**前三门禁 PASS；端到端仍 WARN，必须修镜像构建并跑第三轮。Harness integration 基线/recover 为 P0 REVISE。**

## 23. Gateway Image Fixback Run/Test 复盘

### 23.1 修复策略与结果

没有采用“删除 Dockerfile 中 `nginx -t`”或禁用失败的捷径。最终策略是：先把 runtime Nginx配置复制到 `/tmp`，用 `sed`仅在 build-check副本中把 `http://api:8000` 替换为可解析的 `http://127.0.0.1:8000`，执行完整 `nginx -t`，删除构建证书/临时文件；随后第二次 `COPY` 把原始 runtime配置恢复到最终镜像层。这样语法/TLS配置仍被验证，最终镜像仍使用 Compose DNS `api:8000`。

TDD先增加合同并得到精确 RED，再改 Dockerfile；Run 6 pass。Test attempt 4 fresh 6 pass、Compose config PASS、diff check PASS；CI attempt 2 的 backend 133+geo17、frontend和 contracts作为与 packaging diff正交的证据复用。当前镜像 build/stack/scan/SBOM保持 NOT_RUN，不做假通过。

### 23.2 测试报告的场景回填仍过于人工

CI attempt 2 已关闭不少节点，但本轮仍保守保留 20 LOCAL_PASS/15 CONTRACT_PASS/27 CI_REQUIRED/2 MANUAL_GATE，避免 agent在没有 scenario→job→step 映射时手工猜哪些场景可升级。这个保守策略事实正确，却也说明测试场景表缺少机器关系。

建议每个 scenario声明：

- `evidenceNode`（如 `ci.backend.full`、`ci.image.gateway.build`、`ci.stack.restore`）；
- `invalidatedBy` glob/semantic capability；
- `producer` job/step；
- `requiredConclusion` 与可复用规则。

CI回传后按节点自动更新，当前 Dockerfile只使 gateway build及所有下游节点失效，backend/frontend源码测试不应被整体重跑或手工解释。

### 23.3 小结

Run约32秒、Test约1m13s，说明精确CI日志+两文件diff适合短反馈。CodeGraph/knowledge/grill-me再次不适用；真正稀缺的是 Docker runner。若 Harness支持远端 ephemeral build probe或Dagger/buildx remote cache，可在提交前只构建受影响 gateway image，但不应因此要求本机常驻Docker。

对 image fixback Test 的意见：**本地/合同 PASS，端到端 WARN；允许增量 Review/Submit，必须跑 CI attempt 3。Harness场景证据映射 REVISE。**

## 24. Gateway Image Fixback Review 复盘

审查约 23 秒，范围 2 files、+8/-2，新增 RED/YELLOW均为 0。安全重点不是“Dockerfile语法看起来对”，而是证明 build-only 127.0.0.1不会进入最终 runtime config：临时源被删除、最终原始 config COPY位于 `nginx -t` 后、合同显式校验两次 COPY及顺序。性能只影响 build毫秒级，架构/runtime无变化。

这种 fix仍不能在 Review阶段宣称 build成功；报告明确把实际 build/stack/scan/SBOM留给 CI。Review产物 APPROVED的是实现方案和已得证据，而 gate继续 WARN。这个“代码审查 verdict”和“release readiness”分离应成为 Harness finding model的一等字段，避免 APPROVED被误读为可上线。

对本轮 Review 的意见：**增量审查高效且证据充分；产品允许提交，端到端仍待CI。Harness应区分 review approval与delivery readiness。**

## 25. Gateway Image Fixback Submit 复盘

提交 `afabb02e39187db3837c5535e1630e1ce2dfe302` 成功，2 files、+8/-2。Submit再次暴露 guard的另一个 attempt缺陷：manifest累积前一 attempt已提交且本次未变化的两个测试；stage要求所有 manifest paths都出现在 cached diff，但Git不会为未变化文件生成diff，于是返回 `CACHED_DIFF_MISMATCH`。保留旧manifest为 `test-tracking-attempt3.json`、重建当前单测试manifest后才成功。

这与 `trackedBefore` 缺陷不同：即便所有条目都是 tracked=true、hash正确，**累积manifest + exact cached diff断言本身也不成立**。目标合同应只 stage `currentAttemptTouched`，历史条目保留在 append-only audit，不应进入当前 index期望集。成功返回应同时列 `stagedNow`、`alreadyCommitted`、`unchangedIgnored`。

对本轮 Submit 的意见：**产品提交 PASS；guard安全目标值得保留，但 v1 manifest必须按 attempt隔离，P0 REVISE。**

## 26. CI Attempt 3 与 Secret Permission Fixback Run 复盘

### 26.1 CI 新证据与根因

第三轮主分支 CI run `29663185414` 的 backend-and-geo（3m02s）、frontend（39s）、contracts-and-deployment-static（37s）均 PASS；`images-and-integration` 已成功构建 API、gateway、database 三个镜像，说明上一轮 `nginx -t` build-time DNS 修复闭环。随后真实栈步骤在 Compose 启动前失败：脚本先以 `sudo chown root:10001` 把三个应用 secret 转交给 root，再由普通 runner 执行 `chmod 0440`，Linux 稳定返回 `Operation not permitted`。Trivy 与 SBOM 因依赖步骤失败而正确 skipped，没有假阳性。

根因是宿主文件所有权转换后的权限管理合同缺失，不是 Docker、Compose 或应用问题。修复严格限制为两处：新增一条静态合同，要求 ownership transfer 与 mode transition 都以同一特权边界执行；把生产脚本的一行改为 `sudo chmod 0440`。秘密仍是 root:10001/0440，没有放宽为 0644/0777。

### 26.2 TDD、验证与工具选择

RED 精确失败于缺少 `sudo chmod`；GREEN 单测 1 pass；受影响部署套件 50 pass/1 Windows POSIX-only skip；WSL `bash -n` 与 `git diff --check` PASS。本地没有可调用的 ShellCheck 二进制，未把它伪记为 PASS；此前 Ubuntu CI static job 已证明相同脚本集合和参数可执行，最终仍须由 CI#4 重跑。Run gate 为 06:26:31.333—06:29:00.716，墙钟 **2m29.383s**，因真实 stack/scan/SBOM 尚未重跑而诚实关闭为 WARN。

这轮 CodeGraph 仅一次，用于确认 secret consumer 与权限校验影响面；它未能直接解析 shell 函数和目标行，随后定向读脚本与测试更有效。知识库与 grill-me 对已由 CI 精确定位的一行权限错误无增益，继续跳过。最有价值的工具组合是：GitHub failed-step log → 目标脚本 → 一条 RED 合同 → Linux语法检查。宏观上应让 Harness 根据 `failedJob/failedStep/changedPaths` 自动选择这种最短路径，而不是强制重放完整知识查询或六维审查。

### 26.3 本轮新增 Harness 流程问题

1. **phase lease 与 fixback 起点冲突。** CI 等待期间 merge gate 必须保持打开；失败后要先关闭 merge 才能 begin Run，因此初始诊断/RED天然发生在新 Run gate 之前。目标模型应允许 merge attempt 产生一个关联的 fixback child attempt，或由 `reconcile-ci --fixback` 原子结束旧门禁并开启新门禁。
2. **guard begin 没有检测“测试已修改”。** 首次在修改后 begin 时，它把新测试内容当成 baseline，随后 close 返回 `recordedCount=0`。本轮只能先恢复干净树、重新 begin、再重做 RED/GREEN。begin 应比较 HEAD/index/worktree；若测试路径已有 delta，返回 `SNAPSHOT_AFTER_MUTATION`，不能静默接受。
3. **manifest 仍跨 attempt 累积。** 本次 record 当前测试后，manifest 又带回上一 attempt 的 `test_deployment_contracts.py`；说明保存旧 manifest 并 begin 仍未形成真正 attempt scope。此前 P0 结论再次回归。
4. **gate projectRoot 推断不一致。** `harness_test_guard close --project <feature-worktree>` 成功，但随后 `harness_gate close` 未显式传 `--project` 时从主工作区调用，返回 `SNAPSHOT_INVALID`；追加同一参数后才关闭。gate 已能从 manifest/meta 读 projectRoot，却没有复用，CLI也未提示 expected/actual root。应以 change state 中的 resolved projectRoot 为唯一来源，显式参数只用于一致性断言。
5. **agent执行失误仍应区分记录。** 一次用于本地复现权限的 WSL 嵌套 quoting 命令因 shell层级转义失败，未产生产品副作用；这属于 agent命令构造错误，不应归因 Harness。更好的做法是直接采用 CI 的确定性系统调用证据，或由 Harness 提供临时脚本 runner，避免三层 PowerShell→WSL→Bash 引号。

对本轮 Run 的意见：**产品根因明确、最小修复与本地证据充分；必须提交并跑 CI#4 才能关闭真实栈。Harness 的 fixback child attempt、guard mutation detection、attempt manifest 与 projectRoot解析均为 REVISE。**

## 27. Permission Fix Test Attempt 5 复盘

Test gate 为 06:30:10.446—06:32:09.273，墙钟 **1m58.827s**。没有重复执行刚在 Run 同一内容哈希下完成的 50-test suite；Test 负责把 `content-changeset-2=sha256:66192551...`、父候选 CI#3、当前 delta 和剩余 CI_REQUIRED 节点正式写入 ledger与 `test-report-20260719-0631.md`。场景仍为 20 LOCAL_PASS、15 CONTRACT_PASS、27 CI_REQUIRED、2 MANUAL_GATE、0 current FAIL，避免把父候选镜像构建冒充当前候选完整通过。

本轮证据复用是合理的：CI#3 的 backend 133、geo 17、frontend/static 全绿；当前差异只有 CI shell permission 和其合同，Run 的 fresh 50 pass/1 skip关闭了该 delta。真实 stack/backup/restore/Playwright/Trivy/SBOM 与当前差异同轴，仍保持 NOT_RUN。这个做法比“每个 gate都重跑全部测试”更快，也比“只要父提交绿就整体复用”更严谨。

但 ledger identity 缺陷第五次稳定复现：五个 record 调用均显式传入 base与 `sha256:66192551...`，CLI都返回成功，最终仍显示 `diffHash:null`。同时 `unitTestFull --profile-input` 展开了 100+源/测试文件，却遗漏 `deployment/scripts/**/*.sh`、Dockerfile、Compose和workflow；对 deployment change而言，所谓 full closure输入域并不完整。建议：

1. build profile 的 verificationInputs支持 capability集合，如 `deployment-contract` 自动包含 workflow、Dockerfile、Compose、shell、TAT与相应测试；
2. ledger record 强制回显并读取验证 `baseCommit/diffHash/algorithmVersion`，缺字段非零退出；
3. evidence reuse记录 `parentEvidenceId + deltaEvidenceId + invalidationProof`，不要把自然语言组合证据伪装成单次 full run；
4. Test报告从结构化节点生成计数，保留 `executedThisAttempt` 与 `reused` 两列，避免最终归档把 50、150、64 混为一个“测试数”。

对 Attempt 5 的意见：**测试证据组合与剩余边界诚实，允许进入小范围 Review/Submit；Harness ledger identity与deployment input closure为 P0 REVISE。**

## 28. Permission Fix Review 复盘

Review gate 为 06:32:49.136—06:36:24.501，墙钟 **3m35.365s**。使用 Harness隔离 reviewer只读审查 `afabb02` 后两个文件、+15/-1，初次 verdict为 APPROVED，但测试维度发现 1 个非阻断 YELLOW：合同分别断言 `sudo chown` 和 `sudo chmod`存在，却未锁定先后顺序；未来反序仍会通过合同。

该建议经代码现实核对成立，并在本 gate内闭环：提取两条完整命令、增加 `index(chown) < index(chmod)`；随后受控 mutation把生产脚本两行反序，新断言精确失败；恢复后 5 pass、WSL Bash语法与diff check均PASS。同一 reviewer复核后把 finding标为 CLOSED，最终新增 RED=0、开放新增YELLOW=0，初审两项 advisory YELLOW保持不变。

这一轮说明两点：

1. 增量 reviewer在根因清晰时仍能发现主 agent漏掉的**测试充分性**问题，3.6分钟成本有价值；
2. 仅凭字符串存在的配置合同容易制造“测试绿但语义可反转”，Harness可借鉴 mutation testing（如 mutmut/Stryker 的思想）对高风险顺序、删除、条件反转做少量定向变异，不必全仓启用昂贵 mutation suite。

CodeGraph在 reviewer 环境不可用，reviewer使用固定base Git diff与设计/场景/Attempt5证据完成；对于两文件增量，这一降级没有损害结论。建议 Harness把 `codegraphAvailable=false`作为结构化 capability，而不是自然语言备注；小diff默认 Git diff，只有跨模块调用链才强制 CodeGraph。知识库和 grill-me同样无必要：review输入已包含根因、固定点与继承 finding，重新检索只会增token。

流程上，Review gate允许在发现YELLOW后直接修代码并复核，但这会使 gate从“只读审查”变成“review+fixback”混合阶段。更清晰的状态机应是 `review finding → linked fixback mutation → reviewer recheck`，共享同一父reviewId；最终报告自动显示首次finding和闭环，不需 agent手工拼接事件。

对本轮 Review 的意见：**产品增量 APPROVED，新增finding已闭环；发布 readiness仍等待CI#4。隔离增量审查值得保留，建议引入小范围语义mutation与结构化recheck，而非扩大完整审查。**

## 29. Post-review Test Attempt 6 复盘

Review补强测试后，当前内容哈希从 `sha256:66192551...` 变为 `sha256:2642983a...`。Attempt 6于 06:38:01.019—06:38:51.250完成，墙钟 **50.231s**：复用Attempt5的50-pass部署套件，只把当前5个CI合同、反序mutation结果、Bash与diff证据重新绑定到新 identity，随后更新五类ledger节点和短报告。

这一步在事实层面必要，但不应依赖 agent记住“Review改测试后要回Test”。Harness应让 Review artifact携带 `resultingDiffHash`；Submit preflight若发现最后Test identity不等于当前identity，自动触发 `test-reconcile`，根据changedPaths只运行受影响节点。当前人工 begin→五次ledger record→报告→三事件→close，对三行测试修改仍需约50秒且输出上百个full-input paths，明显冗余。

建议优化：ledger CLI默认只输出摘要（verification/status/inputCount/hash），详细inputs写文件并用`--verbose`查看；一次 `record-batch --from-results <json>`原子写五节点与identity；Test报告由同一结果文件生成。这样可减少本轮约5次进程启动、大段stdout和大量token，同时保留审计性。

对 Attempt 6 的意见：**产品证据已重新绑定当前diff，可进入Submit；Harness需要自动post-review reconcile与batch ledger，当前流程正确但过重。**

## 30. Permission Fix Submit 复盘

Submit gate 为 06:39:23.447—06:40:16.049，墙钟 **52.602s**。guard精确暂存当前测试，脚本显式暂存；cached diff为2 files、+15/-1，diff check通过；中文提交 `f53fec49d9fff1e2dc8c6589e63ede9020949031` 成功，feature worktree干净。

v1 manifest累积缺陷再次需要人工规避：先把含当前与上一attempt测试的manifest保存为`test-tracking-attempt6.json`，再重建只含当前测试的manifest，guard stage才具有正确的cached-diff期望集。这已经连续三个Submit复现，说明不是偶然边界。Harness应把attempt manifest作为独立不可变对象，并维护`currentAttemptId`指针；stage只消费current对象，Archive再汇总历史，不能继续让agent复制/删除JSON。

本轮Submit本身不到一分钟，说明精确stage和`git commit -F`是高效且稳定的，应保留。冗余主要来自修复guard状态，而非Git。下一步只进行transaction merge/push与CI#4，不触发manual deploy。

对本轮Submit的意见：**产品提交PASS；Harness guard attempt隔离P0 REVISE。**

## 31. 第四轮 Merge 与 CI Attempt 4 复盘

### 31.1 事务结果与 CI 事实

permission fix 以 transaction merge `7ad0b63f919b659578708458b4572da27de8f74f` 推送至 `origin/master`；隔离树内最小回归 5 passed，push 与 transaction cleanup 均成功。GitHub Actions run `29664073050` 随后给出新的真实 Linux/Docker 证据：

- `backend-and-geo` PASS，1m12s；
- `contracts-and-deployment-static` PASS，34s；
- `frontend` PASS，39s，并继续报告 7 个既有 lint warning；
- `images-and-integration` FAIL，2m19s，但三个镜像构建、PostgreSQL/Redis healthy、Alembic `001`/`002` 迁移均已通过，失败前进到 `configure-app-role`；
- Trivy 与 SBOM 因集成步骤失败而正确 skipped，仍不能计为 PASS。

这轮证明前两轮修复已经分别闭环：gateway build-time `nginx -t` 不再受 Compose DNS 阻断；宿主 secret 的 `sudo chown`→`sudo chmod` 顺序也不再报 EPERM。新失败是另一个独立合同矛盾：部署说明和 CI 脚本明确把 app、Redis 与首个管理员 secret 设为 `root:10001 0440`，以专用 GID 供非 root 容器读取；`read_secret_file` 却使用 `st_mode & 0o077` 拒绝所有组读位，因此稳定抛出 `ValueError: secret file permissions are too broad`。此外，退出清理直接由普通 runner 删除 PostgreSQL/Redis 创建的 root-owned 临时目录，出现 `Permission denied`。

merge gate 已以 `CI_ATTEMPT_4_GROUP_READ_SECRET_REJECTED` 关闭为 WARN，而不是把 merge/push 成功冒充交付成功。真实 `deploy-controlled` workflow 仍未触发。

### 31.2 设计一致性与安全判断

官方 Docker Compose 文档确认 secret 在容器中以文件挂载；对于 file source，long syntax 的 `uid`、`gid`、`mode` 不能依赖 Compose 实现重映射，因其底层是 bind mount。因此由宿主显式准备 `root:10001 0440` 是当前设计下合理且可验证的边界，而不是应放宽成 world-readable 的理由。正确修复方向是：默认 secret reader 继续只接受 owner-only 安全模式；仅由已知需要专用组读取的部署调用点显式 opt-in 允许 `0440/0640`，仍拒绝 other-read、group-write 和 other-write。

change 设计正文仍把首个管理员 secret 写成 `0600`，与 deployment README、容器 GID 和 CI 实现冲突。这不是 CI 偶然差异，而是设计真相源分裂；本轮需同步设计合同，并用 POSIX 模式矩阵测试锁定允许/拒绝边界。CI 临时目录清理则应只对 `mktemp -d` 返回且通过安全前缀校验的精确目录使用特权删除，不能把宽泛路径交给 `sudo rm -rf`。

### 31.3 CodeGraph、知识与工具效益

本轮 CodeGraph 对跨 Python 调用链有实质增益：一次查询就定位 `read_secret_file` 及 `configure_app_role.py`、`bootstrap_admin.py` 两个调用者，并指出现有测试入口；这比逐文件 grep 更快，也避免只修一个调用点。它对 shell cleanup 没有调用图优势，定向源码阅读更合适。知识库与 grill-me 对这个由 CI traceback、部署 README 和调用链共同确定的矛盾没有新增事实，强制调用只会增加 token；官方 Docker 文档则用于校准 secret mount 与 `uid/gid/mode` 的平台语义，价值明确。

工具路由建议因此进一步具体化：跨模块符号/调用者问题优先 CodeGraph；单文件 shell 行为优先失败步骤日志+定向源码；平台契约只查官方文档；grill-me 保留在高风险 Plan 的假设审问，不进入已具备确定 traceback 的 fixback。

### 31.4 流程优化结论

连续四轮 CI 不是同一根因反复失败，而是重 job 被串行上游故障逐层揭露：静态检查→镜像 build→宿主权限→运行时 reader。产品上可以继续做窄修复；流程上则说明当前 workflow 缺少更早的分层 smoke：

1. 在镜像构建后先运行 `secret-permission-contract`，用与 Compose 相同的 UID/GID/mode 调用两个 bootstrap reader；
2. 将 image-build、stack-bootstrap、backup/restore、browser、scan/SBOM 拆成结构化 evidence nodes，失败时只失效当前及下游节点；
3. 并行构建受影响镜像并启用 BuildKit cache，避免每个一行修复都重付完整构建成本；
4. 总是上传 Compose logs、容器 inspect、临时目录 metadata 与步骤级 JSON 结论，Harness 直接消费而非 agent 重读大段 ANSI；
5. CI cleanup 作为独立 always-step 返回状态，不能让清理错误混在主失败日志中，也不能覆盖原始退出码。

对 CI Attempt 4 的意见：**三个静态/应用 job 与镜像构建已 PASS，但真实栈仍 FAIL，Trivy/SBOM 未运行，禁止 Archive。当前是可窄化修复的设计/实现契约矛盾；产品进入 Run→Test→Review→Submit fixback，Harness 的 staged evidence 与结构化 CI reconciliation 仍为 REVISE。**

## 32. CI#4 Secret Reader/Cleanup Fixback Run 复盘

### 32.1 实现与 TDD 证据

Run gate 为 06:54:59.283—06:59:24.259，墙钟 **4m24.976s**。第一组测试先得到精确 RED：31 项聚焦运行中 3 项失败，分别对应 `allow_group_read` API 不存在、两个部署调用者未显式 opt-in、CI cleanup 没有经过命名目录校验的特权删除；随后实现后变为 20 passed/5 Windows POSIX skip。为避免关键模式矩阵完全等到 Linux，第二个 RED 先以缺失纯函数导致 collection error，再抽出 `_secret_file_mode_is_allowed`，使 Windows 也能覆盖 11 组安全/危险权限组合。

最终本地证据为：部署相关 pytest 65 passed/6 skipped；其中 5 个 skip 是 POSIX chmod 行为、1 个是 Windows Bash语法，纯模式矩阵与 WSL `bash -n` 分别关闭平台无关逻辑和脚本语法风险；Python compileall、Ruff、`git diff --check` 全部 PASS。真实 Linux chmod、Compose bootstrap、备份/恢复、Playwright、Trivy 与 SBOM 仍需 CI#5，因此 Run 正确关闭为 WARN。

实现边界保持窄且安全：reader 默认仅接受 `0400/0600`；只有两个已知受控部署入口显式允许 `0440/0640`；world read、group write、other write 与 `0000` 均拒绝。cleanup 先把 `${TMPDIR:-/tmp}` 解析成真实父目录，以 `mktemp` 创建 `cbm-forge-ci.XXXXXXXXXX`，退出时只在精确父目录+前缀模式匹配后执行 `sudo rm -rf`；异常路径只告警、拒删。设计文档同步为 `root:10001 0440`，消除了 README/CI/reader 三方真相分裂。

### 32.2 工具与 token 效率

CodeGraph 在上一阶段一次性给出的两个 Python 调用者与测试入口被直接复用，本 Run 没有重复查询；这是合理的“调用链结果跨相邻 fixback复用”。shell cleanup 仍以目标文件和失败日志为主。知识库、完整 codebase map、grill-me 与全量 frontend/geo测试均未调用，因为当前 delta 没有触及这些能力；省下的时间没有降低证据强度。

本轮真正有效的最短链是：CI traceback→既有 CodeGraph caller set→3项 RED→最小实现→部署聚焦套件→平台语法/静态检查。建议 Harness 维护带 TTL/commit identity 的 `impact-pack`，内容包括 failed step、相关符号调用者、changed paths、建议测试节点；fixback阶段消费该包而非重新运行知识查询和代码库探索。

### 32.3 新增流程观察

首次 `harness_gate begin` 把描述性文本传给 `--task` 后 argparse 报错，因为该参数实际只接受整数；帮助只显示 `TASK`，没有类型或“计划任务编号”语义。这次属于 agent 参数选择错误，但 CLI 应显示 `--task TASK:int` 或改名为 `--task-index`，另提供 `--task-name`，可避免一次无价值重试。

gate begin 仍返回 `projectRoot=E:\MyProject\CBM Forge`，尽管显式传入 feature worktree；test guard则正确记录 feature路径。此前 projectRoot单一真相问题再次复现，但没有破坏本轮快照，因为所有 guard命令都显式传入 feature worktree。该状态必须在 Harness 中修复，不能长期依赖 agent记忆每个子命令的不同解析规则。

对本轮 Run 的意见：**TDD、权限边界、设计同步与本地验证 PASS；真实 Linux/容器证据待 CI#5，Run 状态 WARN合理。CodeGraph选择性复用有明确收益，知识/grill-me跳过合理；Harness 的 task参数自描述和 projectRoot一致性仍为 REVISE。**

## 33. Test Attempt 7 复盘

Test gate 为 07:00:13.493—07:02:15.394，墙钟 **2m01.901s**。本阶段没有把 Run 中相同 `sha256:51afaaa...` 内容下刚执行的 65-pass套件再跑一遍，而是正式组合：当前 delta 的 pytest/模式矩阵/compile/Ruff/Bash/diff证据，CI#4 对未受影响 backend/geo/frontend/static 节点与镜像/迁移管道的父候选证据，以及仍未执行的 current image、HTTPS、Playwright、backup/restore、Trivy、SBOM。报告保持 20 LOCAL_PASS、15 CONTRACT_PASS、27 CI_REQUIRED、2 MANUAL_GATE、0 current FAIL，避免父镜像被误升格为当前制品。

这次复用节省约一轮完整 CI，但仍满足 invalidation：当前修改会进入 API image并改变 bootstrap scripts，所以 package/API节点保持 NOT_RUN；CI#4 的三镜像build只能证明流程可用，不能证明当前 artifact。相反，frontend/geo及无关 backend行为没有被当前六文件delta失效，允许以父结果+当前delta测试组合。这种“节点复用”比整次run复用更精确。

### 33.1 Ledger 新回归：`--project` 不控制相对 `--files`

五个 record 再次全部返回 `diffHash:null`，是第六次稳定复现。更重要的是，首次传相对 `--files` 并显式传 `--project=<feature-worktree>` 时，返回的 inputsFiles仍位于主工作区；当前主工作区尚未 fast-forward到最新merge，更没有未提交fixback，因此生成了错误 inputsHash。改为六个绝对路径重写记录后才得到正确 `sha256:2050043...`。

这不是证据内容错误，而是 CLI root语义不统一：`--project`看起来只供`--profile-input`展开，却没有成为普通files的解析根，帮助文本也未披露。目标修复应为：

1. 所有相对输入统一相对 resolved project root；
2. 若同时存在 cwd、change projectRoot与显式 project且不一致，非零退出并列三者；
3. record返回`resolvedProjectRoot`与每个输入的`source=explicit/profile`；
4. 先验证文件内容属于当前diff identity，再原子写ledger，不能先写错再靠agent覆盖；
5. `diffHash` 缺失应使 record 失败，而非成功+null。

### 33.2 报告生成仍是手工双写

本轮仍需人工把同一事实写进五次ledger、Markdown报告、三条event与gate note。约两分钟中，大部分是编排/序列化而非测试。推荐一个 `harness test reconcile --result-json`：输入 current identity、fresh evidence、reused node IDs、blocked nodes与scenario mapping；原子生成ledger、report、events并返回一份摘要。详细 inputs写artifact，stdout只给hash/count/status，可显著省进程、输出和token。

对 Attempt 7 的意见：**产品证据边界诚实且足以进入增量Review；测试本身无新失败，release readiness仍等待CI#5。Harness ledger的identity与root解析为P0 REVISE，Test编排应批处理。**

## 34. Reader/Cleanup Fixback Review 复盘

Review gate 为 07:02:59.691—07:11:04.192，墙钟 **8m04.501s**。隔离 reviewer对固定基线`f53fec4`后的六文件增量做六维审查。secret reader默认严格、group-read精确白名单、两个caller显式opt-in和特权删除路径边界均直接APPROVED；初次结论仍为REVISE，因为发现两个相关YELLOW：Bash EXIT trap不会自动把cleanup失败传播成进程失败；当前字符串合同也无法证明删除命令只在guard内、以及清理失败不会假绿。

两个finding在同一gate内按TDD闭环。cleanup现分离`main_status`与`cleanup_status`，compose/sudo/unexpected错误均记录；主流程失败时保留原码，主流程成功时传播cleanup码；`trap - EXIT`避免递归。脚本在source时只定义函数并返回，使POSIX测试能直接执行真实cleanup。合同同时锁定删除命令唯一且位于canonical parent+命名前缀分支。WSL真实结果为`0/7/8/42/42`，unexpected path=`1`且不调用sudo；reviewer复核后关闭两项YELLOW，最终0 new RED、0 open new YELLOW，保留2项继承advisory。

### 34.1 隔离 reviewer 的真实收益

这轮review并非形式重复：主agent最初只关注“能删root-owned目录”和“路径不逃逸”，漏掉了“清理失败仍绿色”的退出语义。reviewer把可靠性和测试充分性两个维度连接起来，避免CI#5即使业务步骤通过仍留下临时secret/数据而报告成功。8分钟成本高于前两次小diff review，但找到了真实问题并完成动态闭环，收益成立。

更好的 Harness 模式不是每次完整重读，而是向 reviewer传入：固定base、changed files、父finding、Test evidence、CI failed step与主agent已验证的不变量。本轮正是这种增量包；CodeGraph在reviewer不可用也没有造成影响，因为调用者集合已在上一阶段固定，风险集中在一个Python函数和一个shell cleanup。

### 34.2 测试与命令失误的区分

第一次尝试通过PowerShell→WSL→Bash三层字符串直接安装EXIT trap probe时，引号构造失败，exit 2；该命令未修改文件、未运行产品流程，属于agent命令错误。随后改为source真实脚本并直接调用cleanup函数，得到确定性退出码矩阵。复盘应保留这次成本，但不能把它计为产品test fail或Harness缺陷；长期可由Harness提供`bash-probe --script-file`，让复杂probe通过临时文件/argv而非多层内联字符串运行。

### 34.3 流程边界

Review gate再次混合了只读finding、代码修复、测试和同reviewer复核。结果正确，但状态机应该显式呈现`finding→fixback attempt→recheck`，并自动要求post-review Test identity reconciliation。当前仍依赖agent手工record测试、再开启下一Test；这是可减少漏步和重复输出的明显入口。

对本轮 Review 的意见：**最终产品增量APPROVED，2项新YELLOW均有动态证据并关闭；CI readiness仍WARN。隔离增量review应保留，Harness应结构化fixback/recheck并提供安全shell probe runner。**

## 35. Post-review Test Attempt 8 复盘

Attempt 8 为 07:11:44.334—07:12:35.950，墙钟 **51.616s**。Review修复使内容哈希变为`sha256:56bf531...`，因此重新绑定ledger/report是必要的；没有重跑刚在同一内容下完成的65-pass套件，而是复用该pytest、6个WSL真实cleanup probe、compile/Ruff/Bash/diff结果，并继续把current image/API/scan/SBOM标为NOT_RUN。

本轮再次证明post-review reconcile可以在一分钟内完成，但人工步骤仍包括diff-hash、五次ledger record、Markdown报告、三条event和gate close；ledger依旧返回null identity。正确目标是Review recheck产出`resultingDiffHash + verificationDelta`，Test只需一个原子reconcile命令，自动保留父证据、失效受影响节点并生成报告。

测试计数也需要结构化分层：pytest为65 pass/12 skip；6个WSL probe是对skip场景的外部平台补证，不能再加成“71 passed”。报告已单列两者。最终archive若只取一个total字段，很容易重现此前“0测试”或重复累加问题；archive应汇总`runner/framework/executedAt/contentIdentity/scenarioNodes`，按唯一evidence ID去重。

对 Attempt 8 的意见：**产品当前identity已正确对账，可进入Submit；CI#5前仍为WARN。Harness应自动post-review reconcile并用evidence ID而非自然语言/单一total聚合测试。**

## 36. Reader/Cleanup Fixback Submit 复盘

Submit gate 为 07:13:19.236—07:14:19.743，墙钟 **1m00.507s**。test guard一次成功精确暂存两个当前测试；四个实现文件显式stage；cached diff严格为6 files、+194/-11，diff check通过；中文提交`fa34b4b`成功，feature worktree干净。与前三次fixback不同，本轮manifest中两个测试都属于当前attempt且都实际变化，因此没有再次触发`CACHED_DIFF_MISMATCH`。

这反向确认guard的核心安全目标有效：当attempt边界正确时，它能防止漏提测试且只需约1分钟；应修的是manifest生命周期，而不是删除guard。commit message通过文件传递，避免PowerShell中文/换行转义，继续是值得保留的低成本做法。

本轮仍看到一个计数/复杂度权衡：为关闭两个review finding，测试文件新增92行、脚本新增29行净变化。规模比运行时修复大，但其中包含真实POSIX退出组合而非重复样板；可接受。若Harness提供通用shell cleanup probe库/fixture，可减少每个项目重复的source、mock compose/sudo和参数矩阵代码，同时提升一致性。

对本轮 Submit 的意见：**PASS。提交边界、测试跟踪和消息均正确；下一步只允许transaction merge/push与CI#5，不触发manual deploy。Harness guard保留，修attempt对象模型。**

## 37. 第五轮 Merge / CI 复盘

第五轮事务把 `fa34b4b` 合并为 `80572e7`，隔离验证、推送与事务清理均成功；GitHub Actions run `29664945516` 随后完成。静态合同、frontend、backend+geo 三个job通过，三个镜像也全部构建成功。受控栈进一步完成数据库/Redis健康检查、两条迁移、应用角色配置、bootstrap、API/worker/beat/gateway启动，说明上一轮修复的 `root:10001 0440` 密钥读取和root-owned临时目录清理已被真实Linux容器链路验证。

新失败发生在栈健康之后的合成E2E造数：`backend/scripts/seed_api_test.py`直接从环境读取无密码`DATABASE_URL`，没有经过应用`Settings`对`APP_DB_PASSWORD_FILE`的解析，最终由psycopg2报`fe_sendauth: no password supplied`。因此Trivy与SBOM节点被跳过。本轮Merge正确关闭为WARN而非把“镜像成功”冒充release-ready；当前修复范围应严格限于让造数入口复用应用配置合同，并用TDD锁定secret-backed URL，不能把密码重新塞回Compose环境。

### 37.1 CodeGraph与渐进式查询的实际效果

CodeGraph一次查询直接定位到造数脚本的模块级`DATABASE_URL`与`Settings.validate_runtime_boundary`的secret注入路径，迅速形成“脚本绕过应用配置”的因果链，价值明确。第二次试图让它同时展开Compose锚点时结果噪声较大，改用目标文件内的小范围`rg`和定点读取更快。建议Harness把查询策略固化为：符号/调用链先CodeGraph；配置键、YAML锚点、日志字面量用`rg`；一次结果超过阈值后自动降级为目标文件切片，不做重复全库探索。

知识库与完整codebase map本阶段没有重新运行：问题由当前CI traceback、已知应用配置符号和两个目标文件即可闭环，额外历史检索不会改变方案。这里的省token不是少验证，而是按信息增益选择工具。长期可让CI失败解析器生成`failure capsule`：failed step、异常末端、首个项目栈帧、相关配置键、上次成功节点、artifact identity；Run直接消费它。

### 37.2 流水线暴露出的宏观流程问题

五轮CI呈串行剥洋葱：只有前一故障修复后，下一段动态链路才被执行。单一巨大integration step让“密钥权限→Nginx build-time DNS→host权限→cleanup→seed配置→scan/SBOM”逐次暴露，耗时和token都被远端反馈周期放大。建议将受控部署验证拆成可缓存、独立显示的阶段：镜像静态/启动smoke、migration+bootstrap、API readiness、seed+Playwright、backup/restore、scan+SBOM；每阶段保存诊断artifact并在后续失败时仍执行不依赖该阶段的扫描节点。这样既缩短定位，也避免业务E2E失败把镜像安全证据完全跳过。

更进一步，Harness应在Submit前根据changed paths和场景图生成“CI preview plan”，明确哪些节点本地可证、哪些必须远端、哪些会被上游失败短路；Merge reconcile则直接消费GitHub job/step JSON，生成场景状态和下一轮impact pack。当前agent必须手工读log、写issue、写复盘、关gate，事实被重复序列化四次。

对第五轮 Merge/CI 的意见：**WARN。上一轮reader/cleanup修复已由真实受控栈关闭；新根因为seed脚本绕过Settings，属于可精确TDD修复的当前change问题。CodeGraph在符号因果链上有帮助，但不应替代配置字面量检索；流水线应拆分动态阶段并生成failure capsule以减少串行重试。**

## 38. Seed Settings Fixback Run 复盘

Run gate 为07:31:27.195—07:34:29左右，约3分钟。测试先在正确的backend venv中得到预期RED：`seed_api_test`不存在`_resolved_database_url`，无法走`APP_DB_PASSWORD_FILE`合同；实现只删除模块级raw env读取，改为通过`get_settings().database_url`创建engine。动态测试用含`@`与`:`的合成密码证明secret文件读取和URL编码/解码正确，并以连接调用合同锁定main使用resolved URL。最终部署聚焦套件59 passed/12 Windows平台skip，compileall、Ruff、diff-check通过；真实容器造数仍留给CI#6。

本阶段出现两类纯执行成本。第一，连续尝试了worktree根`.venv`、主仓根`.venv`和系统`py`，前两者路径不存在，系统环境又缺argon2；第四次才使用`backend/.venv`得到有效RED。第二，Ruff实际只安装在系统PATH而不在backend venv；先尝试venv可执行文件失败后才成功。这些不是产品失败，却说明profile没有提供按命令类型解析后的runtime。Harness应在阶段开始输出一个可直接执行的`runtime lock`：backendPython、geoPython、node/npm、ruff、bash/WSL、docker/compose，每项含绝对路径、版本、来源和最近探测时间；agent不得自行猜venv层级。

ledger问题第七次稳定复现：显式base/diffHash仍返回`diffHash:null`；相对`--change-dir`在`--repo`指向feature worktree时又导致manifest不可见，改为绝对change-dir后才识别1个测试文件。指标JSON在Windows PowerShell传参还需要人为构造反斜杠转义，前两次record因此失败。推荐ledger支持`--metrics-file`/stdin JSON和单次`record-batch`，同时在响应返回`resolvedRepo/resolvedChangeDir/resolvedFiles/diffHash`，把参数引用与身份错误在写入前失败。

一个正向变化是本轮没有显式调用guard close：直接由gate close原子完成guard close、ledger校验、phase.end和lease释放，一次成功，避免此前double-close。技能文档应改成唯一推荐路径，或者让显式close变成幂等；不要同时要求两种互斥序列。

对本轮 Run 的意见：**产品fixback PASS、真实栈待CI所以阶段WARN合理；TDD范围窄且未回填明文密码。Harness应优先提供runtime lock、JSON文件参数和原子gate close，能直接减少6次无价值命令重试与相应token。**

## 39. Seed Settings Fixback Test Attempt 9 复盘

Test gate为07:35:02.783—07:36:14左右，约71秒。当前内容与Run完全一致，因此没有重新执行相同pytest；正式对账59 pass/12平台skip、compile/Ruff/diff，以及CI#5父候选未被seed delta影响的static/frontend/backend/geo和受控栈pre-seed节点。报告仍把当前API image、真实seed/Playwright、backup/restore、Trivy、SBOM保留为CI_REQUIRED，64场景为20 LOCAL_PASS、15 CONTRACT_PASS、27 CI_REQUIRED、2 MANUAL_GATE、0 current FAIL，证据边界诚实。

Test阶段再次暴露guard语义不清：阶段开始前，Run关闭后`test-tracking.json`仍存在；Test执行guard begin后把当前已修改测试纳入baseline，gate close最终报告`files=[]/recordedCount=0`。从“Test没有再改测试”看这是正确的，从“后续Submit必须知道当前未提交测试属于本change”看又丢失了跨阶段ownership。当前只能在Submit前重建manifest。建议把guard分为两个对象：change-level ownership manifest持久化到commit；phase-level mutation snapshot只判断本阶段是否偷改/删除测试。begin/close不得覆盖ownership。

状态快照这次只检测`code`变化、复用profile/rules/map/knowledge/change，符合增量预期；这是快照机制首次在连续fixback边界显示出明确节省。相反，gate begin响应的projectRoot仍错误回到主工作区，即使显式传入feature worktree；所有后续命令继续被迫重复绝对路径。应把`stateRoot`与`worktreeRoot`分别建模，而不是用一个含糊projectRoot。

对Attempt 9的意见：**产品证据可进入隔离Review，阶段WARN合理；增量state snapshot有效。Harness必须分离测试ownership与阶段mutation，否则每次Test都会迫使Submit重建manifest，增加漏提测试风险和冗余命令。**

## 40. Seed Settings Fixback Review 复盘

Review gate为07:36:42.641—07:38:46左右，约2分4秒。复用同一个已完成上一轮审查的隔离reviewer，以固定基线`fa34b4b`和两文件delta继续执行，避免重新创建agent和重复灌入完整项目上下文。六维最终APPROVED：0新RED、0新YELLOW；确认seed真正复用应用Settings、独立进程下不存在旧缓存、特殊字符URL处理正确、resolved URL不回显、测试同时锁住解析结果和main连接路径。两项继承advisory保持不变，CI#6动态门禁不算代码finding。

这轮隔离review成本与增量规模匹配，约两分钟且没有重复全库探索。最有效的输入是failure capsule式消息：固定base、changed files、CI traceback根因、当前测试证据、明确关注点和继承风险去重规则。Harness应把这个格式机器化生成，而不是让主agent手工拼长消息；reviewer输出也应返回结构化`finding IDs/new/inherited/closed/verdict/evidence refs`，由主会话自动生成报告和event，避免再手抄一遍结论。

Review没有要求fixback，因此不需要额外post-review Test。当前流程文档若机械规定“每次Review后都再跑Test”，会产生无变化的重复；正确规则应是只有review阶段产生代码/测试变化，或identity变化时才reconcile。此次直接进入Submit是可验证的最短路径。

对本轮Review的意见：**产品增量APPROVED；隔离复核有价值且成本低。Harness应标准化增量review capsule与结构化结果，并以identity变化决定是否追加Test，而非固定重复。**

## 41. Seed Settings Fixback Submit 复盘

Submit gate为07:39:24.114—07:46:32左右，墙钟约7分9秒；其中大部分额外时间来自Harness最终全量门禁，而不是提交本身。guard按预期精确stage测试，seed实现显式stage，cached diff只有2 files、+46/-6，diff check通过；中文提交`ca008061`成功，feature worktree干净。state snapshot为`changedSegments=[]`并复用全部六段，是理想的零重复刷新。

最终门禁先暴露scope合同矛盾：ledger写入`scope=repository`，`can-reuse`却只接受`module|full`并返回`MISSING_FIELDS`；按profile解析出的命令`uv --directory backend run pytest -q`随后实际运行，先通过70项、skip 12项，再在首个数据库fixture因127.0.0.1:5432无服务而error。Docker CLI存在但daemon没有运行，因此本地无法补起test PostgreSQL。该结果明确记录为test-infrastructure limitation，不冒充产品失败或full pass；当前delta仍由59-pass聚焦套件、APPROVED隔离Review和CI#5未受影响full jobs支撑，CI#6必须跑完整service-backed job。

这揭示profile只描述command/inputs远远不够：`unitTestFull`还需要`requiredServices=[postgres]`、ensure命令、health probe、可用替代executor（local Docker不可用时remote CI）与evidence policy。Harness当前先让agent运行必失败命令，才知道服务缺失；应在gate前解析服务图并返回三态：LOCAL_READY、REMOTE_REQUIRED、BLOCKED。若REMOTE_REQUIRED且已有父full evidence+当前影响集测试，Submit可以结构化WARN继续到CI，而不是强迫一次确定失败。

另一个流程问题是worktree模式的技能文档仍要求“展示后等待用户确认”，与用户明确的夜间无人值守目标冲突。这里基于本轮goal已授权完整提交/推送且要求尽量跳过用户，直接提交是合理的。Harness应在change元数据加入`interactionPolicy=unattended-safe`和授权范围；危险动作（生产deploy/真实TAT/迁移）仍硬阻断，普通commit/CI fixback可按既有授权自动执行并完整留痕。

对本轮Submit的意见：**提交边界PASS；本地full未通过的原因是缺服务，未被伪装。Harness需统一scope枚举、把required services纳入profile，并显式支持受限的unattended-safe授权，减少确定失败和夜间中断。**

## 42. 第六轮 Merge / CI 复盘

本阶段先安全暴露一个transaction基线问题：primary本地master仍为`7ad0b63`，远端已是`80572e7`；preflight/prepare虽然fetch，却仍以本地target建merge，journal base为旧值。主agent在verify/push前识别出最终必然`TARGET_MOVED`，调用精确cleanup后关闭该attempt，随后仅用`ff-only`同步primary并以新run重启。第二次transaction基线正确，生成merge`5365911`，组合态聚焦pytest exit 0、push和cleanup全部成功。

Harness不应依赖agent人工比较journal base与`origin/<target>`。preflight应在持锁后fetch并以remote-tracking target作为唯一base，或者若产品要求本地target必须同步，则在创建任何integration worktree前返回`LOCAL_TARGET_STALE`及safe remediation；prepare不能默默fetch但继续使用陈旧base。这里虽然没有错误远端副作用，但多生成一个无用merge和一组transaction日志。

CI#6 run `29665870013`约3分52秒：frontend、static contracts、backend+geo全部PASS，三个controlled image build PASS；真实栈完成数据库/Redis、迁移、role、bootstrap、全部服务healthy，seed也成功通过secret-backed Settings连接数据库，明确关闭CI#5密码缺失根因。随后seed执行`setval(project_id_seq)`时被`cbm_app`拒绝，因为基线只授予sequence USAGE/SELECT而没有UPDATE。Trivy与SBOM再次因同一巨大step被短路。

这里应修fixture而不是扩大应用角色：`setval`需要sequence UPDATE，但生产应用正常自增只需要USAGE；为合成seed授予UPDATE会破坏COM-D03最小权限。下一轮应移除特权`setval`，用普通sequence消费/默认ID和幂等插入保持固定fixture合同，并新增“seed不得要求sequence UPDATE”的测试。

### 42.1 远端等待与lease模型

原merge run已完成push/cleanup，但CI结果对账发生在一小时TTL之后；gate close返回`LEASE_ABSENT`。主agent只能开启一个新的reconciliation gate，记录同一transaction结果且不重复Git副作用。对长CI/人工审批/监控型阶段，一小时进程lease不应覆盖整个外部等待：建议拆成`merge-transaction`短lease和持久化`remote-check`观察对象，后者可过期续租、跨会话接棒并按run URL/head SHA幂等对账；close应支持带journal proof的`reconcile`，而不是迫使虚构第二次phase。

对第六轮Merge/CI的意见：**transaction最终push正确，CI验证Settings修复成功；新根因是fixture越过最小权限。Harness的remote base解析、外部等待lease和巨型integration step均需REVISE；下一轮产品修复必须保持cbm_app不获得sequence UPDATE。**

## 43. Sequence-safe Seed Fixback Run 复盘

Run gate为10:39:41.340—10:47:28.664，墙钟约7分47秒，但实际命令时间很短，主要时间来自方案权衡。第一层RED直接锁定seed仍含`setval`；初版GREEN尝试用普通`nextval`递归把sequence推进到固定ID之后，虽符合USAGE权限，却仍是fixture手工操纵sequence、增加SQL复杂度和序列空洞。主agent主动收紧测试为同时禁止`setval`、`nextval`和`OVERRIDING SYSTEM VALUE`，得到第二个有效RED，再改成数据库默认ID+`WHERE NOT EXISTS`幂等插入/更新。

最终project在隔离库中按默认序列补齐ID 1/2并显式检查不变量；well用`UPDATE ... RETURNING` CTE实现“存在则更新、不存在则默认插入”；job用默认ID和业务标记幂等插入。角色基线继续只有sequence USAGE/SELECT，不增加UPDATE。聚焦套件59 pass/12平台skip，Ruff/compile/diff PASS；真实PostgreSQL语法、固定ID和重复seed仍由CI#7验证。

这一阶段说明grill-me式对抗提问在何处有价值：不是每轮都运行通用长问卷，而是在“初版已绿但方案是否仍绕过原则”时做一次短自审——为什么fixture必须碰sequence？能否完全用正常应用路径？如果重跑会怎样？它促使方案从“权限上可行”提升为“契约上更简单”。建议Harness在GREEN后针对高风险类别自动生成3～5个delta-specific grill问题，而不是引入独立全量阶段；回答和决策可进入review capsule。

CodeGraph本轮第一次查询返回136 symbols并被import pipeline的大量`seed`同名符号淹没，没有直接给出角色grant；随后目标`rg`在数百毫秒内定位到SQL基线。建议CodeGraph查询支持文件/namespace硬过滤和exact symbol模式；Harness应根据低precision结果自动切换literal search，并把“命中数/相关块数/后续采用率”记录为工具收益指标，而不是笼统宣称用了图谱就提速。

对本轮Run的意见：**产品fixback遵守最小权限且最终设计优于初版GREEN；阶段WARN仅因真实数据库门禁。Harness可引入短式delta grill、CodeGraph precision阈值和自动fallback，提升方案质量而不显著增token。**

## 44. Sequence-safe Seed Fixback Test Attempt 10 复盘

Test gate为10:48:52.025—10:50:20左右，约88秒。与Run同identity，故没有重复执行聚焦套件；正式报告组合59 pass/12平台skip、compile/Ruff/diff和CI#6未受影响节点，继续保留27个CI_REQUIRED和2个MANUAL_GATE，没有把“连接已成功”误当“seed已成功”。

零变化state snapshot再次复用六段；测试执行本身没有新发现。人工成本仍是五次ledger record、Markdown、verification/issue/artifact三事件和gate close。Attempt 10与Attempt 9结构几乎完全一致，仅数字、hash和失败节点变化，说明这正是应该模板化/机器生成的对象。推荐让`harness test reconcile`读取前一报告的scenario graph，应用一个`evidence delta`（close node、invalidate node、new blocker），生成新报告而非重新叙述全量状态。

guard再次在Test begin把已经修改的测试纳入baseline，close显示0 tracked mutation，后续Submit仍需重建ownership；这是第N次同一缺陷，不再增加新的产品风险，却持续制造流程冗余。优先级应保持P0：change-level test ownership直到commit后才清除，phase snapshot只做差异防护。

对Attempt 10的意见：**证据边界正确，可进入Review；Harness最明显收益点已不是更多检查，而是把重复的reconcile/ledger/event/report合为一次原子结构化操作。**

## 45. Sequence-safe Seed Fixback Review 复盘

Review gate为10:51:41.809—11:01:20左右，约9分39秒，是本轮最有价值的一次隔离审查。初审直接给出REVISE：1 RED、2 YELLOW。RED指出seed原有`DELETE FROM project_member`在`cbm_app`无DELETE权限下会成为下一次确定性CI失败，并会破坏bootstrap membership；YELLOW指出移除固定9001后legacy跨项目脚本会把“不存在记录的404”误判为隔离成功，且当前字符串合同没有真实重放证据。

修复保持最小权限：membership改唯一键upsert并验证运行前所有membership仍为结果子集；seed自检expected roles、well唯一和etag-seed job唯一，输出真实project-2 job ID；CI同一栈连续运行seed两次；legacy脚本缺真实ID时BLOCKED，只有实际记录404才PASS。复核后1 RED+2 YELLOW全部CLOSED，最终APPROVED，0开放新finding。

这证明隔离review不能被简单静态lint替代：主agent和聚焦测试两次都没有注意到DELETE权限和“404假阳性”，而reviewer把迁移grant、seed SQL和旧API脚本连成完整因果链。约十分钟成本避免了至少两轮远端CI和一个安全语义退化，收益显著。推荐Harness reviewer默认执行“next-failure prediction”：从当前已修失败点继续顺序模拟至少一个下游阶段，并对每个负向测试问“目标资源是否真实存在”；这可借鉴grill-me的反证风格，但应基于调用链和权限表自动生成。

CodeGraph在这次针对`api_test_batch`的查询明确警告索引来自主worktree而非feature worktree，这是重要的可信度提示；结果仍被同名符号噪声淹没，最终靠目标读取闭环。Harness应把worktree-local index identity设为硬门禁：图谱commit/root与执行root不一致时默认只作为线索，不得标记verbatim authoritative；可在run创建worktree后增量建立轻量overlay index，而非全量重建。

对本轮Review的意见：**最终产品APPROVED，隔离review发现了真实确定性失败和假阳性测试，价值很高。Harness应引入next-failure prediction、真实资源存在性检查和worktree-aware CodeGraph identity。**

## 46. Post-review Test Attempt 11 复盘

Attempt 11为11:02:03.122—11:03:44左右，约101秒。Review产生四文件行为变化，identity由`695df89...`变为`ffa7d91...`，因此post-review Test必要。它复用同一最终内容下刚执行的59 pass/12 skip、Ruff/compile/WSL bash/diff，并重新写入四文件ledger与报告；没有再次运行相同命令。

canonical diff-hash第一次正确返回`TEST_TRACKING_HASH_DRIFT`：Review修改测试后，Run遗留manifest仍保存旧hash。通过guard record刷新精确文件后identity成功。这次是安全护栏真正阻止陈旧证据，不应视为Harness失败；但根因仍是ownership和phase mutation共用一个可变manifest。理想模型是Review fixback更新ownership版本并触发identity invalidation事件，post-review Test自动消费，不需要agent手工修manifest。

本轮报告明确把legacy脚本的BLOCKED与当前Playwright/真实栈NOT_RUN分开，不把“reviewer认为SQL合法”当数据库执行证据。最终archive必须保留这种evidence lattice，而不是只聚合一个passed/failed数字。

对Attempt 11的意见：**产品identity对账正确，可Submit；guard此次有效拦截陈旧hash。Harness应保留hash drift硬失败，同时分离持久ownership和阶段snapshot并自动生成post-review invalidation。**

## 47. Sequence-safe Seed Submit 复盘

Submit gate 为 11:04:27 至本次提交关闭，最终提交 `5f42221`，仅包含 `seed_api_test.py`、`api_test_batch.py`、对应部署合同测试和 CI integration 脚本四个预期文件，共 +124/-48。测试文件由 guard 精确暂存，其余三文件显式暂存；cached diff 名单、stat 与 whitespace check 均通过，中文提交成功。提交证据沿用同一内容身份下的 59 passed/12 Windows 平台 skip、Ruff、compileall、Bash syntax、diff check，以及隔离 Review 初始 1 RED/2 YELLOW 全部关闭后的 APPROVED；真实 PostgreSQL 双重 seed 和完整 E2E 仍明确留给 CI#7。

本阶段操作本身很短，但上下文接续后仍需人工恢复“当前 gate run ID、manifest 状态、待暂存文件、commit message 与下一事务基线”等多个运行时事实。长任务发生上下文整理时，若只有自然语言摘要而没有可执行 checkpoint，agent 容易表现为停顿。Harness 应在每个有副作用的子步骤后写入机器可读 `resume capsule`：当前 phase/run、完成动作、下一条允许命令、精确文件集、Git HEAD/index 状态、未关闭门禁和禁止动作；客户端恢复时应自动执行只读 preflight 并继续，而非依赖模型从长摘要重建状态。

本次 guard stage 一次成功，说明 Review 后刷新过的 hash 可以可靠保护提交边界。需要保留的不是跨 phase 反复重建 manifest，而是“精确测试所有权 + staged diff 校验”这两个安全属性；实现上仍建议把 ownership 固定在 change identity，把每阶段 mutation 快照独立存放。commit message 文件继续有效规避 PowerShell 多行中文转义问题。

对本轮 Submit 的意见：**PASS。提交边界和证据引用正确，下一步可事务合并并等待 CI#7；Harness 应把 resume capsule 提升为长任务和上下文压缩后的一级恢复合同。**

## 48. 第七轮 Merge / CI 复盘

第七轮 transaction 在主分支先 `ff-only` 同步到远端 `5365911` 后开始，preflight 的 base、feature HEAD 与远端一致；合并生成 `5105297`，组合态专项 pytest exit 0（32.918 秒），push 与 cleanup 均成功，没有重现 stale-local-target。CI#7 run `29671713383` 中 static contracts 39 秒、frontend 39 秒、backend+geo 2分50秒全部通过；三个镜像构建完成，受控栈完成数据库/Redis、迁移、最小权限 role、bootstrap 与全部服务健康。最关键的是 `seed_api_test.py` 在同一真实 PostgreSQL 上连续执行两次均输出相同 `project_2_job_id=1` 和用户映射，正式关闭 sequence UPDATE、DELETE membership、幂等重放和虚假 cross-project resource 四个风险。

新失败已进入下一层真实浏览器链路：Playwright 登录成功，但上传后连续三次各等待 120 秒，URL 始终停在 `/projects/1/imports/new`。根因链可以由配置合同直接证明：CI 浏览器来自 `https://127.0.0.1:8443`，而临时 controlled env 写入 `ALLOWED_ORIGINS=https://cbm.example.test`；登录路径明确免 CSRF，所以登录 200，随后 multipart POST 带同源 Origin，被全局 CSRF middleware 以 `Origin not allowed` 拒绝。当前 E2E 没有等待并断言 upload/job response，只等待最终 URL，因此一个即时 403 被放大为 6 分钟重试且日志丢失真实响应体。

这次 failure capsule 的信息质量仍不够：GitHub step 只给最终 URL timeout，脚本 cleanup 没在失败时输出 API/gateway/worker 日志，workflow 也未上传 Playwright screenshot、trace 和 error-context artifact。主agent必须用调用链与配置对照推理根因。建议 Harness/CI 基线要求动态阶段具备三个合同：每个网络动作先断言 response status/body/request-id；失败 trap 输出服务日志末端但做 secret redaction；无论成功失败都上传 Playwright trace/截图和结构化 stage marker。这样能把 8分35秒的黑盒失败缩短成几十秒可定位失败。

CodeGraph 在定位 ImportNewPage → uploadImportFile/createImportJob → FastAPI middleware 的因果链上有帮助，但连续三次查询都返回 worktree mismatch，且其中两次命中 90～118 symbols；目标配置字面量最终仍由 `rg` 更快确认。此处再次支持“调用链用图谱、配置值用 literal search、worktree identity mismatch 自动降级”的策略。

对第七轮 Merge/CI 的意见：**WARN。sequence-safe seed 已被真实数据库双重执行证明正确；当前唯一新阻断是 CI 测试 origin 与受控配置不一致，并被低可观测 E2E 放大。修复应同时校准 origin 合同和让上传响应 fail-fast，不能放宽生产 CSRF 校验。**

## 49. E2E Origin Fixback Run 复盘

Run 以一个部署合同测试先得到精确 RED：`ci-integration.sh` 没有统一的 `e2e_base_url`，临时环境仍写死 `https://cbm.example.test`。实现只在 CI integration adapter 中声明 `e2e_base_url=https://127.0.0.1:8443`，让 `ALLOWED_ORIGINS`、Playwright base URL 与 smoke base URL引用同一变量；没有修改 FastAPI 的 CSRF/Origin 校验，也没有放宽生产受控环境。真实 E2E 同时在点击前注册 upload 和 create-job response promise，分别断言 200 并把响应体带入失败消息，403 将在约30秒内直接暴露，而非三次等待最终 URL。

验证结果：单测试经历1 failed→1 passed；后端部署/配置聚焦为8 passed、1 Windows平台skip，前端 Vitest 53 passed，oxlint与TypeScript通过，WSL `bash -n`和`git diff --check`通过。7条前端警告均为继承基线，不属于本delta。三个文件共 +34/-3；真实浏览器、backup/restore、Trivy与SBOM仍由CI#8关闭。

Harness 在 close 时再次暴露 `projectRoot` 双义：Run gate用主仓存放change状态，test guard却针对feature worktree捕获快照；直接 gate close连续两次以主仓root关闭guard，返回`SNAPSHOT_INVALID files=[]`。显式对feature worktree关闭后，再把gate close的project指向feature才成功，ledger与lease均正常。正确模型应把`stateProjectRoot`、`executionWorktreeRoot`作为两个必填且持久化字段；gate close必须复用begin解析后的execution root，不能由调用者换参数碰运气。

ledger本阶段继续出现两个稳定问题：相对`--files`即使传入feature project仍解析到主仓；改绝对路径才得到当前内容hash。显式`--base-commit/--diff-hash`响应依旧为`diffHash:null`。PowerShell传JSON还需在变量中保留反斜杠引号，前两次metrics写入失败。建议P0实现`record-batch --metrics-file`并在响应返回resolved root/file/diff identity，消灭这类与产品无关的重试。

对本轮Run的意见：**产品fixback PASS，动态门禁待CI所以阶段WARN合理；TDD精确且未削弱安全边界。Harness必须拆分状态根与执行worktree根，并让ledger原生读取JSON文件/批量记录。**

## 50. E2E Origin Fixback Test Attempt 12 复盘

Test 对账没有重复运行同一内容身份下刚完成的命令，正式引用61个实际pass、1个平台skip、0 failure，并继承CI#7未受三文件delta影响的static/frontend/backend、三镜像构建、healthy stack和双重seed证据。报告把CI#7的Playwright节点明确保留为FAIL/当前fixback CI_REQUIRED，把backup/restore、Trivy、SBOM列为NOT_RUN；没有因“镜像已构建”就宣称供应链门禁完成，也没有触发manual deploy/TAT。

为避免归档再次出现错误数字，本次主动不发布一个新的“64场景状态总数”。现有Harness只有Markdown场景表和verification级ledger，没有per-scenario machine state；若主agent根据CI日志人工把27个CI_REQUIRED逐个改数，容易发生重复证明、父证据越界或把一个step覆盖多个未实际执行节点。报告改为列出可审计scenario delta：哪些由CI#7关闭、哪个明确失败、哪些仍NOT_RUN、哪些保持MANUAL_GATE。最终CI全绿后仍应生成逐场景矩阵，再由唯一scenario ID聚合。

这给出archive统计修复的具体数据模型：`scenarioEvidence`至少需要`scenarioId/status/evidenceId/contentIdentity/executor/startedAt/finishedAt/parentEvidence/invalidatedBy`；汇总只对当前identity下每个scenario的最终节点计数。pytest/vitest runner统计与设计场景统计必须是两个不同视图，不能把“61 passed”误写成“61/64场景通过”。

Test gate close以feature worktree root一次成功，ledger只校验`unitTestFull`，guard显示0本阶段mutation/44个preexisting测试。与Run close对比进一步证明：根路径正确时工具行为稳定，问题来自gate没有持久化execution root而非guard算法本身。

对Attempt 12的意见：**证据边界正确，可进入隔离Review；暂不伪造场景汇总是比错误精确数字更可靠的选择。Harness应建立per-scenario evidence graph，让最终report和archive从同一机器状态生成。**

## 51. E2E Origin Fixback Review 复盘

隔离 Review 初审给出 **REVISE：1 RED、2 YELLOW**，直接推翻了主agent第一版“让allowlist与127.0.0.1一致”的修复。RED指出`ENVIRONMENT=demo`的Settings明确拒绝loopback Origin，因此第一版即使字符串合同和本地前端测试全绿，真实API也会在Playwright前启动失败；两个YELLOW分别指出合同测试没有执行受控配置行为，以及create-job waiter在upload早失败时可能遗留未处理rejection。

修复把`e2e_browser_origin=https://cbm.example.test:8443`与`e2e_connect_url=https://127.0.0.1:8443`拆分：前者用于allowlist/浏览器，后者用于smoke；bundled Chromium通过host resolver rule映射域名到loopback，临时测试浏览器继续显式ignore自签名/hostname mismatch，生产TLS和CSRF均未改变。合同测试现在真实构造`Settings(environment=demo)`；create-job与upload两个waiter均在创建时将resolve/reject转换为显式结果。第二轮TDD再次RED→GREEN，后端23 pass/1平台skip、前端53 pass、lint/tsc/bash/diff通过。

复核关闭原1 RED/2 YELLOW后又提出一个低风险YELLOW：click自身早失败仍可能让原始upload waiter拒绝未处理。主agent直接按同一模式修复，最终recheck确认全部finding CLOSED，VERDICT **APPROVED**。mixed EOL保留为非阻塞工程卫生advisory，没有扩范围修改全仓`.gitattributes`。

这是本change第二次证明隔离reviewer的高回报：主agent基于CI现象得出的因果链“Origin不一致”是对的，但第一修复把逻辑地址和连接地址错误合并；普通测试又恰好会false green。reviewer把config安全规则、compose environment、浏览器网络解析和证书SAN连成了完整反例，避免至少一轮确定失败CI。Harness的next-failure prediction应正式包含“把候选修复代入启动时validator/permission policy”，而不只是继续模拟下游业务步骤。

本轮CodeGraph在主agent侧能提供调用链，但持续提示worktree mismatch；reviewer侧CodeGraph MCP不可用并降级手工阅读。Review capsule应记录工具可用性与索引identity，且结论可信度来自源文件证据而不是“是否使用某个工具”。工具应是加速器，不应成为评审硬依赖。

对本轮Review的意见：**最终产品APPROVED；隔离审查发现并关闭了一个确定性启动失败，价值远高于其约数分钟成本。Harness应把validator/policy代入检查、异步未处理rejection检查和worktree-aware工具降级纳入标准reviewer策略。**

## 52. E2E Origin Fixback Post-review Test Attempt 13 复盘

本轮 Test 是必要对账而非机械重复：Review 最终把变更从三文件扩为四文件，并改变了 Origin 合同测试与两个异步 waiter 的行为，canonical changeset 更新为 `sha256:039f7457...ae945`。Test 没有重复运行相同最终内容上的命令，而是复用 Review fixback 后刚产生的 backend `23 passed/1 Windows平台skip`、frontend `53 passed`、lint/tsc/Bash syntax/diff check，以及最终 `APPROVED` 证据；实际 runner 合计明确为 **76 passed、0 failed、1 skipped**，未把 lint 或 CI_REQUIRED 计入通过。

正式报告继续保持 evidence boundary：CI#7 中 static/frontend/backend、镜像构建、healthy stack 和双重 seed 可复用；与 Origin 修复直接相关的真实浏览器上传/建任务/worker、backup/restore、Trivy 与 SBOM 仍为 CI#8 REQUIRED；两个真实部署/TAT 场景仍为 MANUAL_GATE。本轮没有伪造新的“64场景汇总”，而是只记录证据增量。

ledger 本次改用四个 feature worktree 绝对路径，解决了相对路径落到主仓的错误；但显式传入 `--diff-hash` 后，四次 record 响应仍全部返回 `diffHash:null`。这已经是稳定可复现的适配器缺陷：响应合同无法证明它采用了调用方身份。另一个稳定缺陷再次出现：Test begin 时 snapshot 已把 Review 修改后的44个测试视作 preexisting，虽然随后 `guard record` 成功，gate close 仍报告 `recordedCount=0/files=[]`；ownership 事实被 phase snapshot 覆盖，Submit 还得重建一次。

建议把当前五次 ledger record、一次 diff-hash、一次 guard record、报告生成和 gate close 合并为原子命令 `harness test reconcile --from-review <report>`：自动读取最终 changed files、runner summaries、review findings、父CI证据和 scenario invalidation，先校验 identity，再一次写 ledger/report/event。命令响应必须返回 `resolvedExecutionRoot/canonicalDiffHash/recordedScenarioIds/reusedEvidenceIds/blockedEvidenceIds`，从结构上消除 PowerShell JSON 转义、相对路径和人工抄数。

对 Attempt 13 的意见：**WARN 边界正确，可进入 Submit；产品本地证据与隔离 Review 已闭环。Harness 的主要浪费仍是重复人工编排和双根/双manifest歧义，而不是缺少更多测试阶段。**

## 53. E2E Origin Fixback Submit 复盘

Submit 精确暂存 Review 最终确认的四个文件，共 `+76/-3`；两个测试文件由 guard stage，CI adapter 与 Playwright 配置显式 stage，cached name/stat/diff check 均符合预期。提交 `ef550ab` 成功，feature worktree 随即干净；提交信息保留 76 pass/1 platform skip、最终 Review APPROVED 与 CI#8 边界，没有把未执行的真实浏览器、备份恢复、扫描或 SBOM 写成通过。

本阶段再次需要在 Test close 清空/丢失 ownership 后先执行 guard record，再执行 guard stage。安全属性是有用的，但“每个阶段重建一次相同两文件所有权”是纯流程开销。建议 Submit gate 直接消费最新通过 Test/Review 的 immutable change identity 与 ownership manifest；只有 staged blob hash 不一致才要求重新record，而不是按phase生命周期无条件清零。

另一个小但稳定的适配问题是 `harness_gate begin --task` 的帮助文本没有说明类型，实际解析为整数；传入自然语言任务名会失败。随后即使 `--project` 指向 feature worktree，响应 `projectRoot` 仍回主仓。CLI schema 应明确 `task` 是 task ordinal 还是描述，并在结果同时输出 state root 与 execution root，避免调用者从一个模糊字段推断副作用目录。

对本轮 Submit 的意见：**PASS。提交边界准确，下一步可事务合并并触发 CI#8；Harness 应让 immutable identity 跨 Test→Review→Submit 传递，移除重复 ownership 编排。**

## 54. 第八轮 Merge / Transaction 复盘

主仓先从本地 `5105297` 前的状态安全 `ff-only` 同步到远端，transaction preflight 正确锁定 base=`5105297`、feature=`ef550ab`。首次 prepare 因 Windows 路径过长失败：Harness 的 temp root 同时重复拼接长 change name 与完整 run UUID，checkout 到历史 `.harness/archive/...` 时超过 Win32 路径限制。仓库级启用 Git `core.longpaths=true` 后，同一 transaction recover 成功 prepare/merge，生成 merge commit `bc772de`。

这里发现一个 **P0 证据安全缺陷**：`recover` 在没有收到任何 verify command 的情况下，把 verify 在约31ms内标成 `DONE`，journal 的 `verifyResults=[]`，随后直接进入 push。主agent在 push前识别该异常，独立在 integration worktree 执行组合态专项 pytest，得到 `23 passed/1 platform skip` 后才允许继续；但 transaction journal 仍把空验证写成 DONE。`recover` 必须持久化 preflight/verify 计划，若验证命令不存在或结果数组为空，应返回 `VERIFY_PLAN_MISSING` 并硬阻断 push，绝不能把“未执行”序列化为成功。

第一次 push 又遇 GitHub TLS `unexpected eof`，远端仍为旧head；同一 transaction 的 push 子命令幂等重试成功，远端更新到 `bc772de`，cleanup精确完成。该网络错误是可安全重试的瞬时故障，工具行为正确；但最终 verification ledger 没有写入技能文档要求的 `mergeFinalHash`，close只返回`LEDGER_NOT_REQUIRED`。archive必须暂时从transaction journal/pushedHead取真值，Harness则应让cleanup或merge close原子写账本。

Windows路径问题也有更简单的结构性修复：temp root使用短目录（例如`.harness-txn/<12-char-id>`），journal保存完整change/run身份即可；不要在物理目录中重复两遍长ID。启动时检测Windows longpaths并给出结构化remediation，比checkout半途生成数十条`Filename too long`更快、更干净。

CI#8 已由 `bc772de` 自动触发：run `29672840975`。对本轮transaction的意见：**最终 merge/push PASS，但 transaction verify/recover 合同必须列为P0 RED；若没有主agent额外核验，它会把空验证当成功并推送。**

## 55. CI#8 动态门禁复盘

CI#8 run `29672840975` 的 contracts/static（40秒）、frontend（42秒）、backend+geo（2分16秒）全部通过；三镜像也在约60秒内成功构建。真实栈完成数据库/Redis、迁移、角色配置、bootstrap、全部服务healthy，并再次连续两次 seed 成功。Origin fixback 已被真实浏览器证明有效：E2E顺利登录、上传、创建任务、解析13条候选、进入校对并点击审批，原CI#7的上传403已关闭。

新失败发生在更深一层：点击“确认批准”后页面未在180秒内出现“已写入”，单次失败3.1分钟，Playwright自动重试两次，总计把一个未知的审批/worker状态放大到9分13秒。当前E2E没有捕获 approve response，也没有在job进入`failed`时快速失败；workflow没有上传截图/trace，CI cleanup又静默丢弃容器日志和数据库`job_attempt.error`。所以日志只能证明失败边界在approve→commit worker→committed之间，不能严谨判断是approve非200、任务failed还是任务卡在approved/committing。

这次不能凭猜测直接改pipeline。下一fixback应先把可观测性作为最小变更：审批response必须断言status/body；按真实job id主动轮询并在`failed`立即抛出；失败trap输出脱敏后的API/worker尾日志和仅含job状态/attempt error的SQL诊断；真实栈测试禁用无差别重试或至少只对明确瞬时错误重试。这样下一轮失败可在几十秒内给出一阶根因，而不是再消耗九分钟仍只有UI locator timeout。

Harness/CI需要一个标准failure capsule artifact：stage markers、关键HTTP响应、服务健康、最后N行脱敏日志、业务状态行、Playwright截图/trace。当前“Playwright生成了trace路径”但workflow未上传artifact，等同于证据在runner销毁时丢失。对CI#8的意见：**WARN/继续fixback；产品已越过Origin并到达审批，当前新阻断必须先补可观测性再按事实修复。**

## 56. CI#8 诊断 Fixback Run 复盘

本轮坚持“先证据、后业务修复”。一个部署合同测试先精确RED，要求CI失败清理前保留服务日志和`job_attempt`，并要求真实E2E捕获approve response、主动轮询job终态、禁止180秒locator盲等和三次无差别重试；实现后单测试GREEN。最终本地 backend `24 passed/1 Windows平台skip`、frontend `53 passed`，tsc/lint/Bash syntax/diff check均通过，合计77 pass/1 skip。

实现的failure capsule不输出secret：只在失败时打印compose ps、API/worker/beat/gateway最后200行，以及数据库中import job的id/status/failure_stage/attempt_no/outcome/error；管理员密码只在数据库容器内从Docker secret读取且未启用shell trace。E2E现在用真实create response中的job id锁定approve与轮询；approve非200立即带body失败，job进入failed/rejected/cancelled立即带最后响应失败，pending超过60秒则明确报告最后状态。

禁用该单条真实栈test的retry是重要的效率/事实修复：这是有持久副作用的stateful workflow，每次retry都会新增source/job并改变数据库，不能视作相同无副作用重放。真正的瞬时基础设施错误应由外层按failure taxonomy选择性retry；业务终态失败不应重复三次。Harness可以借鉴pytest-rerunfailures/Playwright retry的分类思想，但默认只有`NETWORK_TRANSIENT/RUNNER_TRANSIENT`允许重试，`HTTP_4XX/BUSINESS_FAILED/DB_CONSTRAINT/PERMISSION`必须fail-fast。

本轮再次显示CodeGraph的合适边界：它快速确认ReviewPage→approve API→Celery dispatch→JobPage polling调用链，但第一次查询漏掉后端endpoint/worker，第二次因95 symbols截断；精确`rg`和目标读取更适合配置与错误路径。推荐工具路由器依据问题类型选择：调用链先CodeGraph，字面量/配置/日志先rg，返回symbol>50或worktree mismatch时自动降级。

对本轮Run的意见：**WARN仅因真实根因需CI复现；诊断切片本身PASS且显著缩短下一轮反馈。Harness应把failure capsule与副作用感知retry policy做成CI模板，不靠每个change临时补。**

## 57. CI#8 诊断 Fixback Test Attempt 14 复盘

Attempt 14 对同一最终内容身份执行证据对账，没有重复Run刚完成的77项本地pass。canonical changeset更新为`sha256:b366252e...d4e7d`；父CI#8的static/frontend/backend与镜像构建可复用，但approve→commit、backup/restore、Trivy和SBOM明确保持CI_REQUIRED。报告没有把“E2E已到审批”外推为worker通过，也没有把诊断能力本身算作业务通过。

Test阶段仍需要人工执行guard record、diff-hash、五次ledger record、报告与close；五次record继续统一返回顶层`diffHash:null`。由于本轮只是3文件小delta，流程编排时间已接近实际测试时间。`harness test reconcile`的优先级应提升：输入上一个CI run和当前git identity，自动提取job/step结论、应用影响图、生成typed metrics与scenario delta，只有冲突或证据越界才要求agent介入。

本轮scenario事实尤其适合DAG表达：CI#8的E2E节点依赖login→upload→create→parse→review→approve→commit；前六个已关闭，commit失败会invalidate后续well/export/backup/scan/SBOM，但不会invalidate并行的static/frontend/backend/image-build。当前Markdown人工描述能保持正确，却很难稳定聚合；机器DAG可以天然避免“上游部分成功被整步FAIL吞掉”或“父step PASS越界覆盖子节点”。

对Attempt 14的意见：**WARN边界准确，可进入隔离Review；Harness应把CI step解析为scenario evidence DAG，并用单个reconcile命令替代重复ledger编排。**

## 58. CI#8 诊断 Fixback Review 复盘

隔离Review初审为`REVISE`：0 RED、4 YELLOW。四项都不是业务pipeline问题，却会让昂贵的下一轮CI继续丢证据：诊断声称脱敏但未过滤；create-job先JSON后status且id无运行时校验；approve waiter未接管早期rejection；“survives cleanup”仍主要靠字符串假绿。主agent全部修复后，最终复核`APPROVED`，0开放finding。

修复把诊断从“看起来安全”提升到可执行合同：48位hex redactor与`openssl rand -hex 24`一一对应；SQL输出收窄为type/message/cleanup_errors；fake-compose在Linux实际验证`ps→logs→exec→down→sudo`、main=37不被down=9覆盖、secret不出现在输出。前端把HTTP/JSON/id/status验证和job状态分类抽为可注入fetch/wait/clock模块，4个Vitest实际被discovery发现并执行，总数从53增到57。

这次Review再次证明“测试存在”不等于“测试被runner执行”：主agent初版把`real-stack-support.test.ts`放在`src/test/e2e`，Vitest exclude导致测试数仍为53；从输出数字异常识别后移到domain目录，才得到11 files/57 tests。Harness应把test discovery manifest作为门禁：新增测试文件必须出现在runner collected list或明确skip reason，否则`TEST_NOT_DISCOVERED`硬失败。只看exit0会让未收集测试假绿。

Reviewer侧CodeGraph MCP不可用但不影响结论；这再次说明CodeGraph是调用链加速器，不应是review强依赖。Review capsule应记录`tool unavailable → manual source evidence`，以证据完整性而不是工具品牌判定可信度。

对本轮Review的意见：**最终APPROVED且四项fixback均实质闭合。最高价值新建议是新增测试的discovery门禁，以及默认验证“安全声明与实际过滤行为一致”。**

## 59. CI#8 诊断 Fixback Post-review Test Attempt 15 复盘

Review把三文件初版扩为五文件最终identity，canonical changeset更新为`sha256:dc6f0d7f...fd9c05`，因此post-review Test必要。最终backend 24 pass/2 Windows平台skip、frontend 57 pass，合计81 pass/2 skip；Ruff/tsc/lint/Bash/diff均通过。报告明确指出新增POSIX行为测试在Windows skip、将在Linux CI执行，没有把skip算pass。

guard本次出现一个有价值的自动扩展：主agentrecord了backend合同、domain测试和real-stack spec三个显式测试，close最终列出四个文件，把被测试导入的`real-stack-support.ts`也纳入test ownership。这说明依赖闭包能力存在，但CLI响应没有解释“第四个文件为何加入”；建议返回`ownershipEdges=[{file,reason,discoveredFrom}]`，让agent区分自动依赖、快照残留和误收集。

重复问题仍在：五次ledger record全部输入绝对路径和canonical hash，响应仍返回`diffHash:null`；Test close只校验unitTestFull，不校验api/package的NOT_RUN是否与报告一致。最终archive必须从diff-hash命令、CI run和报告交叉取值，不能盲信ledger顶层。P0修复仍是typed identity与scenario DAG，而不是增加更多自然语言摘要。

对Attempt 15的意见：**WARN边界准确，可Submit；最终诊断identity、测试discovery和Review已闭环，远端只负责产生真实业务根因。**

## 60. CI#8 诊断 Fixback Submit 复盘

Submit最终精确暂存5文件，共`+255/-5`；四个测试/测试支持文件由guard stage，CI integration脚本显式stage，cached name/stat/diff check均正确。提交`71a0202`成功，feature worktree干净。提交信息只宣称诊断与行为测试通过，真实job根因、backup/restore、scan和SBOM继续留给CI#9。

本阶段出现一个低成本但可完全消除的路径错误：在feature worktree中用相对`.agents/skills/scripts/...`调用guard失败，因为adapter只安装在主仓；改绝对skills-root后立即成功。Harness gate已经知道bundle identity和skillsRoot，却没有为后续命令输出可复用的resolved command capsule。建议每次begin返回`commands.guardStage/ledger/gateClose`绝对可执行命令或设置稳定环境变量`HARNESS_SKILLS_ROOT`，防止worktree cwd改变导致适配器丢失。

精确stage再次证明manifest能安全覆盖新增未跟踪测试支持文件；无需`git add -A`或force-add。要优化的是路径解析与ownership生命周期，不是移除guard本身。

对本轮Submit的意见：**PASS；提交边界、测试所有权和证据引用正确。下一步事务合并应使用更短temp root并保留显式组合态验证，规避上一轮长路径和空verify缺陷。**

## 61. 第九轮 Merge / Transaction 复盘

本轮事务以主分支 `bc772de` 和 feature `71a0202` 为输入，主动把临时物理根缩短到 `E:\MyProject\CBM Forge\.codex\it`，成功生成 merge commit `414f137`。prepare、merge、verify、push、cleanup 全部完成，远端 `master` 已精确更新到 `414f1371bf38869737b6946793c430b13975173a`，CI#9 run `29673988564` 随即触发。

与第八轮不同，本轮没有接受“步骤状态为 DONE”作为验证事实，而是向 transaction 显式提供并实际执行组合态命令：`uv --directory backend run pytest tests/unit/test_deployment_scripts.py tests/unit/test_config.py tests/unit/test_controlled_health.py -q`，结果 exit 0、耗时 18.401 秒，journal 的 `verifyResults` 非空。该事实证明短根目录和显式 verify plan 都能在现有工具不改代码的前提下规避两项高风险缺陷；Harness 应把它们升级为默认不变量，而非依赖 agent 记忆。

短物理根的收益不仅是避免 `Filename too long`：它还减少 transaction prepare 的失败输出、重试和半成品清理成本。建议目录名只保留短 run-id，完整 change/run/branch identity 全部进入 journal；preflight 同时校验预计最长 checkout 路径。verify 则必须采用 fail-closed 合同：命令缺失、结果数组为空、命令没有运行、结果无法解析，任一情况都不得进入 push。

本轮 transaction 的产品结果为 **PASS**，但 Harness 层仍有两个待修缺口：其一，`mergeFinalHash` 仍应由 transaction 原子写入统一 ledger，而不是让 Archive 从 journal 和远端 head 交叉推导；其二，主工作区本地分支尚落后远端两个 merge commit，这是隔离事务正常副作用，但后续阶段应有显式 `sync-primary --ff-only` 收口，不应靠 agent 手工判断何时同步。

对本轮 Merge 的意见：**PASS；显式非空验证和短事务根有效，远端已触发 CI#9。Harness 应将 `short temp root + persisted verify plan + non-empty verifyResults + ff-only primary reconciliation` 固化为事务默认合同。**

## 62. CI#9 动态门禁复盘

CI#9 run `29673988564` 在约 1 分钟内结束：frontend 与 backend-and-geo 均通过，静态 job 在 `Verify deployment contracts` 失败，因此 images-and-integration 被依赖图正确跳过。失败不是产品运行时或新增行为测试，而是 ShellCheck `SC2016`：`ci-integration.sh` 中传给数据库容器 `sh -ec` 的单引号程序包含 `$(cat /run/secrets/postgres_admin_password)`，该表达式必须留到容器内展开，ShellCheck 无法跨进程边界推断而返回非零。

这次失败暴露的是 agent 自身验证缺口，而不是 Harness/环境偶然性。上一轮在 Windows 本地只执行了 `bash -n` 和 pytest；新增 POSIX 行为测试也因平台正确 skip。虽然报告诚实标为“Linux CI required”，但 Submit 前仍可通过临时 Linux ShellCheck 容器或预装独立二进制补齐精确静态验证，避免消耗一轮 CI。改进建议：profile 对每条命令声明 `requiredPlatform` 和可复现 `toolImage@digest`；本机缺工具时，Harness 自动选择固定镜像执行，而不是只留下 CI_REQUIRED。

CI 本身的依赖 DAG 行为正确，早失败节省了镜像/集成成本；但一个 info 级规则导致整个 integration 不运行，也说明应把静态工具版本与规则配置锁定为工程合同。不能简单把所有 info 降级，否则会隐去真实问题；本例应使用最窄的行级抑制并解释跨 shell 展开的原因。

对 CI#9 的意见：**FAIL，但根因精确且低风险；frontend/backend 仍为 PASS，integration 为 SKIPPED/NOT_RUN，绝不能沿用 CI#8 或推断业务栈结果。**

## 63. CI#9 ShellCheck Fixback Run 复盘

Run 只增加相邻两行：一行说明展开属于数据库容器内 shell，一行 `shellcheck disable=SC2016`；没有修改命令、SQL、secret 路径、清理顺序或退出码传播。相关 pytest 得到 `15 passed, 8 skipped`，8项均为 Windows 上的 POSIX 行为 skip；`git diff --check` 通过。本机 WSL 没有 ShellCheck，因此精确 Linux closure 仍明确留给 CI#10，阶段状态为 WARN 而非虚假 PASS。

本轮再次复现三项 Harness 结构缺陷。第一，`harness_state capture` 即使传入 feature worktree，仍记录主工作区 head `bc772de`，而 feature 实际 head 为 `71a0202`；state snapshot 的 code identity 不可信。第二，先在 feature root 成功 close test guard 后，用主 root 关闭 gate 仍返回 `SNAPSHOT_INVALID files=[]`；改 gate project 为 feature root 才成功，说明 state root 与 execution root 仍未分离持久化。第三，`harness_ledger record --metrics-json` 在 PowerShell 下两次丢失 JSON 引号，改从文件读取仍失败；去掉 metrics 才写入，同时响应继续是 `diffHash:null`。原始 `15/8/0` 计数已保留在独立 evidence，避免为过门禁伪造结构化数字。

这里有一个可以直接提速的适配器改法：所有结构化参数同时支持 `--metrics-file`、`--note-file`、`--files-from`，CLI 内部读取 UTF-8 JSON/文本；PowerShell 不再承担嵌套 JSON 转义。gate begin 应返回并持久化 `stateRoot/executionRoot/head/base` 四元组，后续 guard/ledger/close 全部消费该 capsule，调用方不得再次传入模糊 `--project`。

对本轮 Run 的意见：**WARN；产品修复边界最小、现有相关合同全绿，但精确 ShellCheck 只能由 CI#10 关闭。Harness 的双根、snapshot head 和结构化参数问题均稳定复现，应列为 P0/P1。**

## 64. CI#9 ShellCheck Fixback Test Attempt 16 复盘

Attempt 16 没有机械重跑 Run 在同一未提交 identity 下刚完成的 pytest，而是复用其原始输出：15 pass、0 fail、8 Windows平台skip、pytest 2.71秒、进程实测4.298秒；`git diff --check`通过。测试报告逐 job 写明 CI#9 的 static=FAIL、frontend=PASS、backend=PASS、integration=SKIPPED，并把真实栈、浏览器、backup/restore、Trivy、SBOM全部保留为NOT_RUN。这样既避免重复计算，也没有把父流水线成功或旧CI证据越界覆盖新identity。

本轮 gate close 暴露新的证据身份问题：当前只为 fixback 记录了聚焦 `unitTest`，而 close 响应却声称 `validated=[unitTestFull]`。它显然复用了旧 ledger 中的全量结果，但响应没有给出被复用证据的diffHash、base/head、inputsHash或失效分析；与此同时当前 state snapshot head 又错误指向主工作区 `bc772de`。在这种组合下，`unitTestFull` 的绿色标签不能证明它覆盖一文件未提交delta。报告因此只引用实际15/8聚焦证据，不把 gate 的 `unitTestFull` 标签扩大解释。

Harness 的复用响应必须返回 `reusedEvidenceId/sourceIdentity/currentIdentity/invalidationDecision`，并要求 current diff 的影响图证明旧全量结果仍适用。若 state head 与 execution worktree head 不一致，所有跨identity复用应 fail-closed，而不是只看verification key存在。对注释/静态指令类delta，可以有显式 `NON_RUNTIME_STATIC_FIX` 分类：复用业务测试，但必须执行对应静态工具；没有工具时保持WARN。

对 Attempt 16 的意见：**WARN且证据边界准确，可进入Review；聚焦测试可复用，但 Harness 对旧 `unitTestFull` 的无身份绿色标签不可作为最终通过依据。**

## 65. CI#9 ShellCheck Fixback Review 复盘

隔离六维Review得到`APPROVED`、0 RED、0 YELLOW。Reviewer核对了ShellCheck directive的真实作用域：它只覆盖紧随其后的完整`compose exec ... | redact_ci_diagnostics`命令，不会关闭文件或函数级规则；当前命令只有数据库容器脚本这一处SC2016，因此局部抑制不会吞掉其他位置未来新增的同类问题。

安全核对比“注释没有运行时影响”更重要：外层单引号确保`$(cat /run/secrets/postgres_admin_password)`不在CI host展开，字符串进入database容器后才由`sh -ec`执行；改成宿主端双引号或预展开反而会扩大secret暴露面。Reviewer同时确认没有改变psql stdin heredoc、redactor、cleanup或exit status。六维结论全部OK，未生成空fixback。

这类两行delta说明Review不必按文件数固定消耗大上下文。更好的reviewer capsule应由风险分类驱动：`static-suppression`类型自动要求“规则作用域、被抑制实例计数、安全语义等价、替代方案风险、精确工具重验”五项，而架构/性能只需明确无运行时delta。这样既保留对抗性，又能减少无关代码阅读和token。

本轮CodeGraph不适合主要取证：配置/脚本查询返回81个symbol且提示worktree mismatch，精确diff与CI日志信息密度更高。Reviewer仍能基于当前diff和shell语义完成可靠审查，进一步支持工具路由原则：调用链问题优先CodeGraph，单脚本静态诊断优先diff+目标源码+工具输出。

对本轮 Review 的意见：**PASS / APPROVED；局部抑制范围、安全语义和替代方案均已核对，可进入Submit并由CI#10完成精确ShellCheck。**

## 66. CI#9 ShellCheck Fixback Submit 复盘

Submit精确暂存`deployment/scripts/ci-integration.sh`一个文件，cached diff为`+2/-0`，name/status/stat/diff check均符合预期；提交`a6b0052`成功，feature worktree随后干净。提交信息只声明局部静态抑制、15 pass/8平台skip与Review APPROVED，没有把未执行的Linux ShellCheck或integration写成通过。

这轮没有调用test guard stage，因为delta不包含测试文件且现有manifest中的四个测试文件已被HEAD跟踪、无未暂存变化；直接精确`git add -- deployment/scripts/ci-integration.sh`比重复重建ownership更清晰。Harness submit可以据`git diff --name-only`与manifest交集自动选择：交集为空则跳过stage并输出原因，交集非空才运行guard stage，减少无效的46文件snapshot扫描。

持续存在的CRLF advisory没有阻断提交，也没有扩大修改整文件；但工具每次`status/diff/add`都重复输出同一warning。建议profile一次检测`.gitattributes/core.autocrlf`，把稳定继承警告聚合为单条environment advisory，而不是让高频Git命令反复污染日志和token；只有blob hash或可执行位实际变化才升级失败。

对本轮 Submit 的意见：**PASS；提交边界为一文件两行，feature commit `a6b0052`可进入事务合并。**

## 67. 第十轮 Merge / Transaction 复盘

第一次preflight及时暴露主工作区仍停在`bc772de`，而远端已是`414f137`；transaction没有先fetch/ff-only，仍把陈旧本地HEAD写成base。主agent在prepare前终止并cleanup，记录FAIL事件，然后显式`fetch + merge --ff-only origin/master`，未触碰主工作区未跟踪Harness证据。第二个transaction才以正确base `414f137`、feature `a6b0052`开始。

重试事务prepare/merge成功，生成merge commit`5f397d1`。显式组合态verify实际执行聚焦pytest，exit0、38.011秒、`verifyResults`含一条真实命令；push把远端master更新到`5f397d14c8f4892f0f1ef59e1ce55fe0a9fc714a`，cleanup完成。CI#10 run `29674819749`随即触发。

这再次证明transaction preflight当前读取的是primary local branch，而不是已fetch的target remote ref；对持续CI fixback流程，这是确定性陷阱。P0改法应是preflight内部先fetch目标远端，比较`localTarget/remoteTarget/upstream`：local落后且可ff时在隔离上下文选remoteTarget为base，并输出`primaryReconciliationRequired=true`；若local分叉则硬失败。不能让调用者在每轮合并前手工记住sync步骤。

本轮还显示transaction physical root虽然已缩短temp parent，但最终仍拼接完整change和run名；这次未超长只是run-id较短。应真正使用短目录`<temp>/<12-char txid>`，完整身份只进journal。验证则保持上一轮已验证的正向改进：没有命令或空结果不得push，本轮journal可审计地包含command、cwd、exitCode、started/finished/duration。

对本轮 Merge 的意见：**最终PASS；第一次因陈旧primary被主动安全中止，第二次正确合并、验证、推送和清理。Harness应把remote-aware preflight/ff-only reconciliation内置为P0。**

## 68. CI#10 动态门禁复盘

CI#10在约4分钟内给出精确结果：static 44秒PASS、frontend 43秒PASS、backend-and-geo 1分9秒PASS、三个受控镜像构建PASS。真实浏览器登录、上传、创建job、parse到13个候选、进入review全部成功；approve响应在4.9秒内直接返回500，E2E立即失败，没有再进行三次180秒盲等。

failure capsule明确给出根因：`run_approve()`删除旧`CANDIDATE_%`验证问题时，PostgreSQL拒绝`cbm_app`对`validation_issue`表的DELETE；baseline只授予全表SELECT/INSERT/UPDATE，并刻意没有全局DELETE。job 2保持`review_required`，parse attempt=1/outcome=ok，证明解析和worker没有失败。正确修复不是扩大为`DELETE ON ALL TABLES`，而是给pipeline恢复/重校验实际需要的`validation_issue`与`parse_candidate`两个表最小DELETE权限，并用新Alembic migration覆盖已存在数据库。

诊断还发现独立部署缺陷：Beat继承`read_only: true`，却使用默认相对路径`celerybeat-schedule`，因此反复报`[Errno 30] Read-only file system`并重启。`/tmp`已由app-common提供64MB tmpfs，故Beat应显式使用`--schedule=/tmp/celerybeat-schedule`。这不是approve 500的直接根因，但属于同一真实栈暴露且可安全修复的受控部署合同问题。

本轮failure capsule价值很高：从“审批后9分钟locator timeout”提升到“4.9秒HTTP 500 + API traceback + DB状态表”，一次CI就把不确定边界缩成一条缺失权限。代价也明显：日志把beat同一traceback打印近200行，`gh`输出26k tokens并截断关键中段；建议按service分别tail并先提取ERROR/traceback指纹、再附每个fingerprint首尾上下文，完整日志作为artifact，不在主控制台重复堆栈。

扫描和SBOM因integration上游失败仍为NOT_RUN；不能因镜像已build就宣称供应链门禁通过。对CI#10的意见：**FAIL但诊断目标达成；根因是最小权限遗漏，另有Beat只读文件系统缺陷，两项均可在当前change内TDD修复。**

## 69. CI#10 权限 / Beat Fixback Run 复盘

Run先写两个精确合同并分别得到RED：Compose没有`/tmp/celerybeat-schedule`；`003_app_pipeline_delete_grants.py`不存在。实现新增独立Alembic migration，只对`validation_issue, parse_candidate`授予DELETE并提供对称REVOKE downgrade；全局表权限仍是SELECT/INSERT/UPDATE，`audit_log`等不可删表边界未放宽。migration head、Settings默认值、controlled env、CI临时env和相关测试统一推进到`003_app_pipeline_delete_grants`。Beat命令只增加`--schedule=/tmp/celerybeat-schedule`，复用已有64MB tmpfs。

最终聚焦测试55 pass、0 fail、7 Windows平台skip；changed-file Ruff/compile、Alembic唯一head、Bash syntax、Compose config和diff check都通过。更宽的本地unit run收集164项，得到114 pass、13 skip、37 setup error；37项全部是本机PostgreSQL未运行导致`Connection refused`，没有代码断言失败。报告保留了这些数字而没有把setup error写成skip或把114 pass冒充全量绿色；真实migration/grant仍由CI#11验证。

test guard再次暴露“同一test二次修改不可记录”：旧manifest中的`test_deployment_scripts.py` hash变化后，`record`先整体校验旧manifest再尝试更新目标，因此无论相对或绝对路径都返回`MANIFEST_INVALID`；CLI又没有reset/rotate。主agent用apply_patch保留`test-tracking-attempt16-pre-reset.json`审计副本、移除当前manifest，再由guard原生命令重建，最终close自动发现4个实际变化测试、recordedCount=4。正确产品能力应是`guard begin --rotate-manifest`，旧manifest自动不可变归档，新attempt从snapshot重新跟踪；不应让agent直接操作证据文件。

ledger继续即使显式传入canonical hash也返回`diffHash:null`；state snapshot则在传入feature root后仍记录主HEAD `414f137`而非feature `a6b0052`。这些不是偶发问题，而是在每个fixback稳定增加命令、误报和人工身份对账。优先级应高于新增更多自然语言报告模板。

对本轮 Run 的意见：**WARN；最小权限与Beat只读修复均TDD闭环，本地可执行合同通过；真实PostgreSQL角色、迁移和完整栈须由CI#11关闭。**

## 70. CI#10 权限 / Beat Fixback Test Attempt 17 复盘

Attempt 17复用同一identity下Run刚产生的55 pass/7 Windows skip聚焦证据，并逐项保留Alembic head、targeted Ruff/compile、Bash syntax、Compose config与diff check。报告单列更宽unit run的114 pass/13 skip/37 PostgreSQL setup error，没有把收集到的164项写成全绿，也没有把setup error混入产品failure。CI#11需要关闭真实`cbm_app`权限、Beat稳定、审批提交、备份恢复和供应链门禁。

gate close出现一个必须升为P0的**假绿**：尽管本attempt明确记录本地“全量unit 37 setup errors”，当前只向ledger写入聚焦`unitTest`，close响应仍返回`validated=[unitTestFull]`。旧`unitTestFull`条目显然没有按当前canonical identity和当前失败证据失效，且close没有显示reuse来源。若Archive直接信该字段，最终报告会把实际失败/未完成的全量测试写成通过——这正是用户此前发现“最终report测试都是0/数据不对”的同源问题。

修复要求不是在报告里加免责声明，而是让ledger成为append-only evidence DAG：每条execution记录identity、scope、result和environment；新的current identity出现或更宽验证失败时，旧节点只能标`stale/superseded`，不得继续满足gate。`unitTest`永远不能升级成`unitTestFull`；setup error的全量execution必须以`ENVIRONMENT_ERROR`节点存在，并阻止相同identity下旧full PASS复用，除非后续同范围同环境成功节点明确supersede。

test guard在Test begin后把当前4个已改测试又视为46个preexisting，close返回recordedCount=0；Run阶段保留的manifest仍存在，但close响应没有引用它。这再次说明ownership不应随phase snapshot清零。建议以change identity而非phase作为manifest生命周期，Test只验证Run manifest hash，不重建所有权。

对 Attempt 17 的意见：**报告WARN边界正确，可进入Review；但Harness gate的`unitTestFull`结论是错误的，不得用于Submit/Archive事实统计，必须引用原始runner证据。**

## 71. CI#10 权限 / Beat Fixback Review 复盘

隔离六维初审给出 `APPROVED`、0 RED、2 YELLOW。两项都不是已确认的产品缺陷，而是“静态合同强度不足”：Beat 测试只确认 schedule 字符串，没有把它依赖的 app-common 继承、non-root、只读根和可写 `/tmp` 锁成同一个契约；migration 测试只搜索 GRANT 文本，没有证明 migration 与角色配置完成后的 PostgreSQL 有效权限。由于两项都能在当前范围内低风险增强，主 agent 没有把 advisory 误写成硬阻塞，但仍在 submit 前按 TDD 全部关闭。

权限增强先让测试因缺少 `verify_app_role_privileges` 真实失败，随后在 CI integration 的 `migrate → configure-app-role` 之后、bootstrap 与完整栈启动之前增加管理员侧权限矩阵：`validation_issue`、`parse_candidate` 必须可 DELETE；`audit_log`、`job_transition` 必须不可 DELETE。`set -Eeuo pipefail` 与 `psql -v ON_ERROR_STOP=1` 令任一不变量 fail-closed；secret 仍只在 database 容器内展开，断言输出只含角色和表名。Beat 合同则同时锁定 YAML merge、`10001:10001`、`read_only: true`、64 MiB `/tmp` tmpfs和 schedule 路径。聚焦测试最终55 pass/7 Windows skip，Ruff、compileall、Alembic head、Bash syntax、Compose config 与 diff check 全绿；复审得到 `APPROVED`、0 开放 finding。

这轮体现了 Review 最有价值的用法：不是重复通读所有文件，而是把一个实现假设拆成“源代码声明”和“最终运行状态”两层证据。Harness 可以把这种模式产品化为 risk-specific reviewer recipe：权限迁移自动要求 `effective privilege matrix`，Compose 继承自动要求渲染后配置或等价结构合同，新增测试自动确认 runner discovery。这样 reviewer 无需每次自然语言重新发明检查清单，也能减少只靠字符串断言的假绿。

同时，当前 fixback 仍需要主 agent 手工完成“审查 finding → fixback 文档 → RED/GREEN → 复审 → report → gate close”六次编排。建议提供 `harness-review fixback` 子命令：接受 finding JSON，生成可追踪任务，记录初始和最终 identity，运行指定验证，并由同一 reviewer 对增量复核；最终响应直接给出 `closed/open/newFindings` 和证据引用。它既能减少漏写 fixback，又能避免把初审 `APPROVED + YELLOW` 误解成无需改进或硬阻塞。

对本轮 Review 的意见：**PASS / APPROVED；两项 YELLOW 均实质闭环，下一步应做 post-review Test，并由 Linux CI 对真实 PostgreSQL、Beat 与完整发布链给出动态事实。**

## 72. CI#10 权限 / Beat Fixback Post-review Test Attempt 18 复盘

Attempt 18 对 Review 后最终 9 文件 identity 重新执行聚焦测试，结果仍为55 pass、7 Windows/POSIX skip、0 fail；Ruff、compileall、Alembic唯一head、WSL Bash syntax、controlled Compose render和diff check均通过。canonical changeset由ledger的独立`diff-hash`子命令计算为`sha256:901ec030...d342139`，并正确包含未跟踪migration。报告没有把本机缺失的ShellCheck、PostgreSQL、real-stack、backup/restore、Trivy与SBOM伪装成通过，阶段因此保持WARN，等待CI#11。

本轮产生了一个清楚的路径解析缺陷：第一次`harness_ledger record --project <feature-worktree> --files <relative-paths>`返回成功，却把四个inputs解析到主工作区`E:/MyProject/CBM Forge/backend/...`，而非feature worktree。只有改为绝对路径重新record后才得到正确inputs。这个行为会令inputsHash描述错误文件，同时CLI不发warning。P0修复应把相对`--files`严格相对于显式`--project`解析；若解析结果离开executionRoot或命中同名主工作区文件，必须fail-closed。响应也应返回`stateRoot/executionRoot/resolvedFiles`供调用者一次核对。

旧问题再次稳定复现：`diff-hash`刚给出非空canonical identity，但两次`record`响应仍为`diffHash:null`；gate close再次无视当前只记录incremental `unitTest`和CI#10 integration失败的事实，返回`validated=[unitTestFull]`。这已经不是“报告展示不佳”，而是可直接污染Archive最终事实的P0状态机错误。最终归档必须绕过该标签，使用runner原始计数和CI run DAG；Harness修复则必须让record持久化显式identity，并禁止任何scope widening。

test guard同样表现矛盾：Test begin后`record`明确返回两个测试文件`RECORDED`，最终close却返回`files=[]、recordedCount=0、unchangedPreexisting=46`。原因是begin把已经相对HEAD变化的测试一律视作preexisting，随后record不能改变其分类。对于Run→Review fixback→Test的正常链路，测试ownership必须跨phase延续，并允许同一文件的新hash形成新revision；close应报告`recordedThisPhase`与`ownedByChange`两个集合，而不是把它们压成一个容易假零的计数。

对 Attempt 18 的意见：**WARN且可Submit；产品聚焦验证保持全绿，报告边界可靠，但ledger的路径解析、diffHash丢失、scope假升级和guard零计数均应列为Harness P0。**

## 73. CI#10 权限 / Beat Fixback Submit 复盘

Submit先调用profile resolve取得真实`unitTestFull`命令`uv --directory backend run pytest -q`，`can-reuse`这一次正确返回`reuse=false / insufficient-evidence`，没有接受旧ledger里的repository scope伪证据。实际全量命令在收集到74 pass/13 skip后，首个数据库fixture因本机`127.0.0.1:5432` connection refused停止；这是与Attempt 17一致的环境setup error，不是新的断言失败。流程保留原始exit 1，不把它写成pass；同时依据已通过的55项聚焦合同和下一轮真实容器CI继续提交，避免为“本机无数据库”伪造scope或再次阻塞用户。

暂存边界由test guard精确加入4个manifest测试，主agent再显式加入5个生产/配置文件；没有使用`git add -A`或全局force-add。cached diff最终严格为9文件、`+90/-12`，新增migration被正确纳入，diff check通过。中文提交信息通过runtime文件传给`git commit -F`，feature commit为`5ccca16d78a778d40c303a6ea8c84b4400d2f74d`，worktree提交后干净。用户此前已明确授权单change完整执行、提交/合并/推送且要求尽量跳过需要其参与的地方，因此本轮把该授权作为一次性submit message确认，没有再次停下制造无意义等待。

这里暴露一个流程合同冲突：submit文档把`unitTestFull reuse=false`写成必须全量成功才能继续，却没有定义“该full suite依赖仅CI提供的数据库，而聚焦测试和待触发CI形成闭环”时的合法状态。agent只能在硬停与违反指引之间二选一。应增加typed结果`ENVIRONMENT_UNAVAILABLE + ciReplacementGate`：必须证明失败发生在setup、提供等价CI job与待触发commit identity、禁止写入OK ledger，但允许提交到受保护CI分支；若CI失败则自动fixback。这样既不降低门禁，也不把本地基础设施偶然性变成永久阻塞。

另一个优化点是commit确认所有权应可持久化。用户早已对“当前单change的提交、合并、推送”给出明确授权，但skill仍在每个fixback写死“不可跳过确认”。Harness应在change state记录`authorization.scope/operations/grantedAt/expiresAt`，submit只在scope变化、staged文件越界或message语义偏离时重新询问；否则展示摘要后自动继续。这能减少睡眠期间自动任务在安全范围内反复停顿，同时不扩大授权。

对本轮 Submit 的意见：**PASS；暂存和提交身份精确，feature commit已生成。全量本地数据库setup error被诚实保留，下一步进入隔离事务合并并由CI#11执行替代动态门禁。**

## 74. 第十一轮 Merge / Transaction 复盘

合并前主工作区本地master仍停在`414f137`，而远端已是CI#10基线`5f397d1`。由于transaction preflight此前已两次证明不会自动以remote target协调陈旧primary，主agent先显式fetch并`merge --ff-only origin/master`，只快进已提交业务历史，不触碰未跟踪Harness证据。事务随后以base`5f397d1`、feature`5ccca16`开始，preflight、prepare、`--no-ff` merge、verify、push和cleanup全部成功；merge/pushed head为`cb26b02e12f8a6d4a2803e1391860490ac35bc0f`。

组合态verify不接受空结果，实际在隔离integration worktree运行四文件聚焦pytest，exit 0、耗时21.693秒；journal包含完整command argv、cwd、started/finished/duration和verification identity。push后远端`refs/heads/master`精确指向`cb26b02`，integration root按journal登记的唯一允许路径清理完成。feature worktree暂时保留到CI动态门禁关闭，便于失败时继续fixback；另一个更早的stale integration worktree也暂不在CI运行前混入清理动作。

事务的evidenceIdentity再次揭示ledger并未升级到skill宣称的v3：`schemaVersion/repositoryId/baseCommit/currentHead/diffHash/ownershipHash`全部为null；cleanup后也没有可用命令把`mergeFinalHash`写入顶层ledger，gate只返回`LEDGER_NOT_REQUIRED`。当前只能用transaction journal、remote ref和CI commit三方交叉确认。Harness应让transaction在push原子成功时拥有唯一写入`mergeFinalHash`的内部接口，且若ledger schema低于要求，preflight应明确`LEGACY_LEDGER`并关闭复用，而不是输出一组null后继续让Archive猜测。

本轮验证首次安装integration worktree依赖耗时约22秒，测试本体实际只需约1秒。transaction可以复用由lockfile与Python ABI决定的只读uv cache/venv layer，或在prepare时把依赖准备与测试命令分开计时；journal应报告`environmentSetupMs/testExecutionMs`，避免最终report把依赖安装时间误当成测试耗时。这也直接对应用户此前发现“归档时间1秒/测试为0”的计量问题：阶段应从事件时间戳和子步骤durations聚合，不能填默认值。

对本轮 Merge 的意见：**PASS；远端已更新到`cb26b02`并触发CI#11，组合态验证和清理均有非空journal证据。Harness仍需内置remote-aware preflight、typed ledger migration和push原子写入mergeFinalHash。**

## 75. CI#11 动态门禁复盘

CI#11把前两轮的产品运行风险全部关闭：contracts/static、frontend、backend-and-geo、受控镜像构建均通过；真实栈在50秒内完成migration 003、应用角色四表权限矩阵、Beat启动、浏览器upload→parse→review→approve→committed、smoke、backup与isolated restore。API和gateway镜像的可修复Critical扫描也通过。由此可以确认CI#10的权限和Beat修复不是静态假绿，failure capsule定位正确且实现可落地。

唯一失败发生在database镜像Trivy门禁：Debian 11层的`libgnutls30 3.7.1-5+deb11u7`有两个Critical，仓库已有`deb11u10`修复；继承的`gosu 1.18.2`由Go 1.18.2构建，scanner报告四个已修复stdlib Critical。因为database scan失败，三份SBOM步骤全部SKIPPED/NOT_RUN；整体CI必须保持FAIL，不能因为业务栈全绿就提前归档。

这一轮显示供应链门禁放在integration之后虽然保证了镜像真实性，却让一个纯基础镜像CVE消耗了真实浏览器和备份恢复成本。更优DAG应在build后并行执行`scan(api/gateway/database)`与real-stack：scan和integration都成功后才汇合到SBOM/发布资格；任一失败不会取消另一条已开始的证据，但总关键路径取两者最大值而非相加。若扫描结果可按image digest缓存，只有对应Dockerfile/base digest变化时重跑，CI fixback会明显更快。

Trivy日志同样过于冗长：`gh --log-failed`输出约11k tokens，大部分是action setup/cache/env模板，真正根因只有目标摘要和六行CVE表。Harness CI collector应优先使用Trivy JSON/SARIF artifact，提取`target/package/installed/fixed/CVE/severity`形成typed failure capsule；原始日志保留artifact，不进入agent主上下文。这能降低token、减少截断，也便于自动生成Dockerfile更新任务。

对CI#11的意见：**FAIL但业务与数据动态门禁已全部通过；唯一根因是database镜像6个可修复Critical，SBOM仍未运行。下一步应保持扫描策略不变，升级`libgnutls30`并用已修复Go工具链重建gosu，再触发CI#12。**

## 76. CI#11 供应链 Fixback Run 复盘

Run把扫描事实转成一个两文件变更簇。测试先因Dockerfile缺少固定Go builder真实RED（1 fail/6 pass），随后实现三阶段镜像：固定digest的Go 1.25.7 builder从gosu 1.19对应完整commit重建静态二进制；pgvector stage保持原样；PostGIS final只升级已安装的`libgnutls30`并以新gosu覆盖旧Go 1.18.2二进制。构建阶段显式用`go version -m`核验Go 1.25.7并运行`gosu --version`，Go proxy也能把完整commit解析到唯一pseudo-version，避免依赖浮动tag。

本地聚焦四文件suite最终55 pass/7 Windows skip，Ruff与diff check通过；test guard本轮终于给出正确的`recordedCount=1`。由于本机Docker daemon不可用，报告保持WARN并把镜像构建、运行、Trivy和SBOM留给CI#12，没有将Dockerfile字符串测试冒充供应链通过。Run期间一次命令误在主工作区执行，额外创建了被忽略的`backend/.venv`并跑到旧HEAD的53项结果；主agent立即识别cwd错误，在feature worktree重跑得到真实55项，并不引用前一结果。这个失误也已纳入流程改进而不是从记录中删除。

cwd失误揭示Harness的`stateRoot/executionRoot`问题不仅影响ledger，也容易影响普通验证命令：guard命令必须从主root调用state，但紧随其后的pytest必须在worktree，单个多命令tool call很容易继承错误cwd。应由gate begin返回并导出不可变`HARNESS_STATE_ROOT`与`HARNESS_EXECUTION_ROOT`，所有脚本接受其中一个typed root；执行产品命令时wrapper强制`cwd=executionRoot`，状态命令强制`stateRoot`，并拒绝在另一个root发现同名文件后静默继续。

同时，gate close返回`validated=[compile,unitTest]`，但当前Run没有构建database镜像；`compile`来自旧identity，仍属于跨identity假复用。报告因此只认可本轮unitTest，不认可compile标签。P0规则应是gate响应的每个validated项附`evidenceId/diffHash/inputsHash/finishedAt/reuseDecision`；缺任一字段时不能展示为validated。

对本轮 Run 的意见：**WARN且可进入Test/Review；实现边界最小、TDD有效，本地合同通过，但唯一决定性证据仍是CI#12的真实镜像扫描与SBOM。**

## 77. CI#11 供应链 Fixback Test Attempt 20 复盘

Attempt 20在最终两文件identity上独立重跑55 pass/7 Windows skip、Ruff和diff check；报告明确区分上游源码identity解析、Dockerfile静态合同与尚未执行的镜像构建/Trivy/SBOM，没有把CI#11旧镜像业务通过外推成新镜像通过。安全矩阵同时确认没有修改Trivy severity/exit-code、没有新增ignore/VEX、没有放宽基础版本契约。阶段保持WARN并进入Review。

test guard再次出现“record成功、close归零”：begin后对同一测试调用`record --reason test-updated`返回`RECORDED`和精确路径，close却返回`files=[]/recordedCount=0/unchangedPreexisting=46`。Run阶段同一文件能正确count=1，Test阶段因为begin把其当前hash纳入preexisting而无法表达“复用change-owned test”。这个输出不只是难看：Submit若只看最新close会认为没有owned test，从而漏走guard stage。正确模型应把ownership manifest独立于attempt snapshot；record对已有ownership追加revision，close分别返回`changedThisAttempt=0`与`ownedByChange=1`。

gate又返回`validated=[unitTestFull]`，尽管ledger刚写的是incremental `unitTest`、镜像build未运行、CI#11总体FAIL。这是连续第三次同形P0假绿，已足以建立确定性回归用例：准备旧full OK→改变identity→写入新incremental OK→写入更宽环境失败或CI failure→close test；预期不得返回full。Harness项目修复时应先落这个端到端用例，再重构ledger复用。

此外，Test阶段为只需约6秒的验证仍运行begin snapshot、record、ledger record、guard close、gate close和Markdown报告等多次命令；流程开销明显大于测试本体。可增加`harness test reconcile --reuse-run-evidence --identity <hash>`：当Run后代码未变时只校验原始runner evidence hash、补报告和关闭阶段，不重复runner；若代码变化再执行profile。这样能省时间/token，同时不牺牲事实边界。

对Attempt 20的意见：**WARN且可Review；产品测试证据准确，Harness gate的`unitTestFull`与guard零计数均不得用于最终归档统计。**

## 78. CI#11 供应链 Fixback Review 复盘

隔离初审给出`APPROVED`、0 RED、2 YELLOW。第一项指出final Debian stage只运行了builder中的`gosu --version`，尚未证明复制后的静态二进制能在目标文件系统解析`postgres`用户并实际降权；第二项指出`apt --only-upgrade`仍依赖构建时仓库快照，不能提供跨时间字节级复现。主agent没有把两项建议一概忽略或一概阻断，而是按当前change可控边界区分：降权语义能以一个无副作用构建期冒烟立即关闭；同digest制品提升需要改变CI/CD架构，保留为后续advisory。

降权补强严格走TDD：测试先因缺少`gosu postgres sh -ec`真实得到1 fail/6 pass；Dockerfile随后在final stage复制gosu后执行`test "$(id -un)" = postgres`。它不只是字符串标记，还令镜像构建本身验证目标环境可执行、用户解析、降权和子命令执行。单文件恢复7 pass，原四文件suite保持55 pass/7 Windows skip，Ruff和diff check通过；同一隔离审查者复核最终diff后确认YELLOW已关闭、无新增RED/YELLOW，并同意apt复现项作为后续制品流改进而非当前Critical修复的阻断项。

本轮再次显示结构化finding应携带`fixability/scopeExpansion/dynamicGate`。当前reviewer只返回severity，主agent仍需自然语言判断“能否在本change低风险关闭”。Harness可以让review报告为每项输出`disposition=fix-now|defer-advisory|block`、`requiredEvidence`和`affectedGate`；fixback runner自动为`fix-now`建立RED/GREEN节点，为`defer-advisory`生成后续issue候选，并禁止将其误算成open finding。这样既能提高修复率，又避免Review把局部安全补丁无限扩张成平台重构。

另一个细节是canonical diff-hash在测试契约更新后立即报`TEST_TRACKING_HASH_DRIFT`，只有重新执行guard record才能恢复。这种fail-closed方向正确，但错误响应没有直接给出建议命令、当前hash和manifest hash。建议返回机器可执行remediation或提供`guard reconcile --changed-owned-tests`，在保留人工reason审计的同时减少一次诊断往返。

对本轮Review的意见：**PASS / APPROVED；0开放finding，可进入post-review Test与Submit。数据库镜像真实build、Trivy复扫和SBOM仍必须由CI#12关闭。**

## 79. CI#11 供应链 Fixback Post-review Test Attempt 22 复盘

Attempt 22在最终两文件identity上重新执行同一四文件聚焦suite，得到55 pass、7 Windows/POSIX skip、0 fail；changed-test Ruff和diff check通过，范围保持`+22/-1`。报告把Review fixback的RED→GREEN链与本轮独立回归分开记录，也继续把Docker build、runtime、database Trivy和三份SBOM标成CI_REQUIRED。canonical identity更新为`sha256:3af7fb07...f0f2ceba`，没有沿用Review前旧hash。

阶段开始本身又发生一次可避免重试：第一次`harness_gate begin`因未显式提供`--skills-root`返回`BUNDLE_IDENTITY_REQUIRED`，而前序所有阶段已经使用同一已解析adapter identity。gate不应要求每个调用者重复传递稳定路径；change runtime应在首次begin固定`skillsRoot/bundleHash/adapter`，后续省略时复用并验证磁盘identity，只有bundle变化才要求refresh或显式确认。这能减少命令长度、路径转义和无人值守任务中的失败点。

同一次编排中，gate begin失败后guard begin仍成功写入snapshot，形成“phase lease未取得但子状态已变化”的半事务状态。原因是两个命令由agent顺序调用却没有共同事务。Harness应提供原子`phase begin --with-test-guard`：先验证bundle和lease，再创建guard snapshot；任一步失败则不产生可见子状态，或用同一operation id回滚。这类原子性比单纯增加重试更能减少状态漂移。

本轮测试墙钟约8.28秒，其中pytest自报4.10秒；Harness的阶段耗时应同时保留runner duration和orchestration duration，Archive不能只用event首尾秒差，更不能把测试计数从错误的`unitTestFull`节点汇总。最终归档将以runner原始`55/7/0`和CI job结构为事实源，并显式检查生成summary是否再现“测试为0、归档1秒”等历史错误。

对Attempt 22的意见：**WARN且可Submit；当前本地identity可提交，唯一剩余门禁是CI#12真实镜像构建、0 Critical扫描与三份SBOM。**

## 80. CI#11 供应链 Fixback Submit 复盘

Submit对最终identity调用`can-reuse unitTestFull`，正确得到`reuse=false / insufficient-evidence`；流程没有把旧ledger中的repository full伪证据当成本轮通过，也没有为已知本地无PostgreSQL重复消耗一次注定setup error的全量命令。精确暂存后cached diff只有Dockerfile和对应契约测试，`+22/-1`、diff check通过；中文feature commit为`95cf56a67b7cbcf73ab9f9f2a709ad3b4daea1e2`。用户已有当前单change提交、合并和推送的明确预授权，因此没有再次暂停。

test guard stage却暴露新的所有权错误：manifest保留四个历史change-owned tests，当前只有`test_deployment_contracts.py`变化；`stage`尝试处理整份manifest后以`CACHED_DIFF_MISMATCH`返回另外三个未变化文件，导致真正已变测试也没有被stage。主agent只能用精确`git add -- <one-test>`完成暂存。正确语义应是manifest表示“允许/拥有集合”，stage只加入其中当前`working-tree != index`的文件；未变化owned files不得构成mismatch。返回值还应区分`eligible/changed/staged/unchanged`，而不是把unchanged当错误。

本轮也验证了“重复执行全量”不是事实可靠性的唯一手段。当前delta仅改变Dockerfile和静态契约，决定性动态证据是CI镜像build/scan/SBOM；本地full又依赖未启动数据库。Harness应让Submit根据change classifier生成required gate DAG：`incremental tests → review → merge → image build/scan`，而非无条件要求同一个`unitTestFull`。未满足的节点仍阻止Archive，但不必阻止触发能够满足它的CI。

对本轮Submit的意见：**PASS；feature commit边界和身份准确。guard stage需修复“owned但未变化文件导致整体失败”的P0缺陷。**

## 81. 第十二轮 Merge / Transaction 复盘

主工作区先从`5f397d1`安全快进到远端CI#11基线`cb26b02`；未跟踪Harness证据未被触碰。随后事务以base`cb26b02`、feature`95cf56a`运行preflight、prepare、no-ff merge、verify、push、cleanup，最终merge/pushed head为`55934125e7a8b8a561fa9ca05a0b602533b2a200`。组合态四文件pytest exit 0，journal记录runner duration 23.406秒；临时integration worktree仅在push成功后按登记路径清理，CI#12 run为`29676917359`。

integration verify仍只记录command/exit/duration，不保存stdout摘要，因此事务本身无法证明55/7计数；本轮必须用同identity的Test runner报告补足。建议verify解析常见测试器的JUnit/JSON artifact，journal至少保存`passed/failed/skipped/setupErrors`和artifact hash；stdout可以截断保留，不能让最终Archive根据exit 0猜测测试数量。这正是用户此前发现final report“测试都是0”的上游数据缺口之一。

事务preflight继续输出ledger schema、repositoryId、baseCommit、currentHead、diffHash和ownershipHash全为null，却不标记legacy或禁止后续Archive复用。remote、journal和CI三方仍是当前事实源。Harness应在push成功时原子写入typed`mergeFinalHash`与`ciExpectedHead`；Archive只接受这组值与remote/CI一致，legacy ledger则显式`MIGRATION_REQUIRED`，不能用null继续。

对本轮Merge的意见：**PASS；远端`5593412`已触发CI#12。下一步等待真实database镜像0 Critical与全部SBOM，不绿不归档。**

## 82. CI#12 最终动态门禁复盘

CI#12 run `29676917359`在远端merge head`55934125...`全绿，端到端墙钟约382秒。四个job分别为contracts/static 39秒、frontend 46秒、backend/geo 124秒、images/integration 252秒。可数测试不是0：deployment contracts 82 pass；backend 165 pass；cbm_geo 17 pass；frontend 11 files/57 tests pass；Chromium real-stack 1 pass，合计322 pass、0 fail。真实栈再次执行migration 003、最小权限矩阵、Beat健康、seed replay、upload→parse→review→approve→committed、smoke、backup和isolated restore。

CI#11唯一失败根因已关闭：database镜像在当前制品上通过可修复Critical扫描，API和gateway扫描也保持通过；随后三份CycloneDX SBOM均实际生成并由非空文件门禁确认。扫描策略没有增加ignore/VEX，也没有降低severity或exit-code。由此本change的本地静态/TDD、隔离Review、组合态verify、真实业务、灾备和供应链证据形成完整DAG，可以进入最终Test对账与Archive。

流水线仍有非阻断维护信号：checkout action面向Node 20而runner强制Node 24；Trivy 0.70提示0.72可用；六个Trivy action post hook竞争同一日期cache key，只有一个保存成功，其余输出reservation提示。后者不会影响本轮结果，但增加尾部耗时与日志噪声。建议把Trivy setup/cache提升为job级单实例，三个scan与三个SBOM直接调用同一binary/cache；或至少按image/operation拆cache key并只允许一个save owner。这既节省网络和约15秒post cleanup，也减少日志token。

CI的322 pass计数目前必须由agent从日志正则提取，`gh run --json jobs`只给step结论和时长，不给测试指标；Archive若只读jobs就会再次生成0。Harness CI collector应优先下载JUnit/Vitest/Playwright JSON或在workflow写统一`ci-metrics.json` artifact，schema包含`runner/suite/passed/failed/skipped/setupErrors/durationMs/headSha`。最终report只能从该artifact或显式typed event汇总，不得将缺失值默认为0。

对CI#12的意见：**PASS；所有设计动态门禁关闭，允许最终Test、清理与Archive。维护warning应进入后续优化，不阻断当前change。**

## 83. Final Test Attempt 25 与清理复盘

最终Test把CI#12原始输出结构化回写：unitTestFull记录contracts/backend/geo/frontend共321 pass，apiTest记录Chromium real-stack 1 pass，package记录3 images built、3 Critical scans和3 SBOM；最终报告合计322 pass、0 fail、0 CI skip，并单独保留本地55 pass/7 Windows skip，避免重复相加。四个CI job时长39/46/124/252秒与总墙钟382秒也已落盘，归档若再输出0 tests或1秒即可机械判错。

ledger `record`即使显式传入full change canonical `sha256:e2662494...`，响应仍继续返回`diffHash:null`；但至少最新unitTestFull/apiTest/package的metrics、inputs、evidence和duration已写入。gate close现在返回unitTestFull有效，与CI事实一致，但它仍没有把apiTest/package列入validated，说明phase gate的required verifications与deployment risk classifier没有真正接线。Archive必须检查三个最新节点和CI evidence，而不能只看`validated=[unitTestFull]`。

从feature worktree切回合并后主工作区时，test-tracking manifest固定了旧`projectRoot`，final `diff-hash`先报`TEST_TRACKING_MANIFEST_INVALID`；CLI又拒绝用新project record，返回`MANIFEST_PROJECT_MISMATCH`，没有正式的ownership handoff命令。主agent只能保留四文件及hash历史、将root校准到主工作区后再由guard重算当前checkout hash。Harness应提供`test-guard rehome --from <worktree> --to <primary> --expected-head <merge>`，验证两个head内容一致后原子更新root/hash并写handoff event，而非要求人工编辑证据。

清理方面，feature commit已确认是master祖先、worktree干净；旧integration branch经`git cherry master`确认没有独有patch。两个worktree登记和分支均清理，主工作区误建`.venv`也用精确git clean删除。feature路径因Windows残留文件导致`git worktree remove --force`报告目录非空；生成的node_modules、venv、build和cache已用显式work-tree clean删除，释放主要空间，但宿主安全策略拒绝最终递归删除剩余小型tracked-file目录。流程未绕过策略，meta如实标记残留。Harness cleanup应在worktree remove前先清理已知heavy ignored roots，再删除登记，减少这种“登记已失效但路径非空”的半成功状态；响应也不应在报错后继续让agent误以为全部完成。

对Final Test与清理的意见：**PASS / 可Archive；产品、CI和测试数据真实闭环。Harness仍需修复deployment required-gates、diffHash持久化、manifest rehome和worktree残留清理。**

## 84. Archive、失败恢复与最终统计复盘

Archive预检在补齐精确远端最终提交`55934125e7a8b8a561fa9ca05a0b602533b2a200`后达到0 blocker、0 warning，且该提交与`origin/master`、CI#12 head完全一致。首次finalize在source-consistency阶段失败：9条历史artifact event分别含空路径、仓库前缀路径或worktree目录，归档器无法把它们解析为change内文件。当前event schema没有supersede/correction能力，只能在`evidence/legacy-artifact-event-path-migration.md`记录迁移理由后，将9条artifact字段校准到真实存在的change相对路径；ID、时间、说明和结果均保留。该做法可审计但破坏了严格append-only，Hunter Harness应提供`event.correction{targetEventId,oldHash,newValue,reason}`，聚合时应用修正投影而不改历史行。

第二次finalize在`archive-manifest-before`自校验失败。根因是失败尝试生成的before manifest、cutoff和summary又被下一轮纳入输入，随后同名文件被重写，天然造成自身checksum不一致。失败恢复只移动目录，却未清理本轮生成的派生产物。移除这三项失败派生文件后，第三次finalize成功：source consistency、renderer、summary validator、archive-meta和after-manifest全部通过，原始归档共75个文件，并写入knowledge maintenance outbox。正确的事务边界应是先在archive外临时目录生成所有mutable derived artifacts，验证后一次rename发布；失败恢复应按operation id删除本次派生物，而非让它们进入下次before manifest。

成功并不等于汇总可信。归档后机械对账发现原始`reports/final/summary-data.json`仍输出unitTests.run=0、API total=0但passed=1、Archive=FAIL、34条历史问题全部算当前风险；这正是用户此前指出的“测试为0”类缺陷。根因共有四个：unit聚合器不识别`{passed,failed,skipped}`；API聚合器不从结果桶反推total；阶段状态先读取最后`phase.end`、随后又用所有历史issue永久降级；knownRisks也没有“后续成功已关闭”语义。修复严格走TDD：4个用例先全部失败，再支持passed-only计数、API total反推、后续成功关闭历史issue，4/4转绿。

第一次版本化repair生成`derived/v1`且双validator通过，却又把归档文件数从75变成0；根因是repair重新collect时没有加载冻结的before/after manifest。新增第5个失败用例后，repair显式重载两个manifest并调用同一compare reducer，`derived/v2`恢复`68 moved + 5 generated = 75 total / checksum OK`。继续检查又发现`activeExecutionMs=236923`与`minutes=0.01`互相矛盾，且后续合法重试被算成late events：canonical reducer用“第一次start到最后一次end”冒充活跃执行，late reducer则从第一次end开始计数。第6个失败用例锁定后，活跃执行改为各闭合attempt之和，墙钟保留首次事件到末次事件，late只计算最终`phase.end`之后的事件；6/6回归全部通过。

最终权威派生版本为`derived/v3`，`derived/authoritative.json`精确指向v3且summary SHA-256与repair record、文件实际hash三方一致；source和renderer validator均0 error、0 warning。v3的可核对事实为：unit 321/321、API real-stack 1/1、0 failure；Plan/Test/Review/Submit/Archive=OK，Run=WARN；归档75文件、checksum OK；Archive三次attempt的活跃执行624ms、墙钟236923ms、late=0。遗留`minutes=0.01`是活跃执行的两位小数分钟值，不是全流程墙钟；renderer应并列展示`activeExecution`与`wallClock`并明确口径，不能只突出一个“耗时”。v1/v2作为不可变失败派生版本保留，权威指针保证消费者不会误读。

最终状态保守保持`CONDITIONAL_OK`，唯一原因是冻结ledger没有独立`dbCompatibility`节点。CI#12和最终Test报告已经明确证明migration 003、app role权限矩阵、backup和isolated restore均PASS，但聚合器不能把Markdown自然语言或API成功自行猜成typed DB gate；因此本轮不伪造`dbCompatibility=OK`。正确修复点在harness-test/CI collector：检测到migration/restore场景时写入显式`dbCompatibility{status,total,passed,failed,evidenceHash}`，Archive只消费结构化节点。当前3条known risk均为仍未由Run成功事件关闭的Harness警告（`--task`帮助不清及两次`diffHash:null`）；早期CI、Review和两次Archive失败已从“当前风险”移回历史timeline。

本阶段还暴露一个协议顺序错误：finalize在source/manifest/renderer验证前先写`phase.end=OK`，失败后才追加issue，因此事件事实源曾短暂声明成功。应改为`phase.start → commands/artifacts → validators → phase.end(final status)`；失败直接`phase.end=FAIL`并附结构化错误，不再用“OK后追加issue”表达失败。阶段状态必须以attempt为单位闭合，而非靠聚合器猜测后续成功是否覆盖旧问题。

对Archive的意见：**产品归档完成，权威v3统计可审计；原始summary有缺陷但未被覆盖，版本化repair正确保留审计链。当前change可提交归档证据，Hunter Harness需把上述6个回归用例和修复迁回正式源码。**

## 85. 本change最终流程结论与优先级

本change从Plan到Archive的产品结果为PASS：实现提交`95cf56a`，合并/推送提交`5593412`，CI#12全绿，322个runner测试通过、0失败，真实栈、备份恢复、供应链扫描和SBOM均有原始证据。Harness结果不是“流程完美”：它帮助建立了设计、TDD、隔离Review、事务合并和审计归档的完整骨架，但大量重复begin/close/record、双根路径、空identity、弱typed metrics和失败恢复缺口显著增加了调用次数、token、重试和误报。

按收益/成本/风险排序，建议正式修复顺序如下：

1. **P0 事实正确性**：typed CI metrics、`diffHash/base/head/repositoryId`非空约束、required gate DAG、issue关闭语义、repair manifest重载、attempt timing reducer、DB compatibility节点；把本轮6个归档回归和前述ledger假绿场景做成端到端golden tests。
2. **P0 事务与身份**：统一`stateRoot/executionRoot/skillsRoot`capsule；phase begin+test guard原子化；merge remote-aware preflight；push后原子写`mergeFinalHash/ciExpectedHead`；worktree rehome/cleanup显式事务。
3. **P1 减少冗余**：提供`harness phase reconcile`单命令完成证据复用、报告和关闭；按diff风险DAG只跑必要节点；CLI支持`--metrics-file/--files-from`；聚合重复Git/CRLF/bundle提示；所有响应默认机器可读且仅输出差异。
4. **P1 可观测性**：采用OpenTelemetry span/Trace Context表达phase、attempt、tool和wait；同时保留runner、orchestration active、wall clock、user wait四种时间，禁止混用。JUnit/Vitest/Playwright/CI统一输出JSON artifact，Archive不再解析人类日志。
5. **P2 工具取舍**：CodeGraph保留给跨模块调用链和影响面，不用于单文件脚本diff或CI日志诊断；知识库只在Plan/相似故障和Archive入库各查询一次，命中低时停止扩展读取。优先采用稳定的JSON Schema、OpenTelemetry和现有runner报告，不急于引入Bazel/Nx/Dagger等重型编排；当前仓库用Taskfile/just风格的薄命令目录即可减少平台差异。grill-me式对抗审问适合Plan高风险边界，可作为限时可选gate，不应成为每个fixback的固定token开销。

本次实际对比再次表明：CodeGraph在跨服务权限、部署调用链定位时有帮助，但对`harness_archive.py`精确聚合缺陷返回了过宽上下文，最终是目标源码+6个微型测试更快、更省token；知识库对延续历史约束有价值，但本轮后半段事实已集中在change events和CI，重复查询不会增加置信度。宏观原则应是“事实源就近、结构化优先、一次解析多阶段复用、失败产生最小可复现capsule”，而不是让agent反复读长Markdown来重建状态。

## 86. 归档提交、字节保真与 CI#13 收尾

归档暂存时Git在Windows上对全部文本提示LF→CRLF，若直接提交，未来checkout可能改变manifest所记录的字节。新增`.gitattributes`规则`.harness/archive/** -text`后，使用`git add --renormalize`重新暂存，并逐文件比较`git hash-object --no-filters`与index blob；86个归档/派生文件全部精确一致。归档中10处既有Markdown尾随空格/末尾空行没有被“顺手格式化”，因为归档后改写会破坏冻结证据；只对新增`.gitattributes`执行并通过whitespace check。建议Archive finalizer在提交前主动检查目标路径attributes，缺少exact-byte策略时直接给出可执行修复，避免agent到最后才发现跨平台checksum风险。

归档及字节规则以中文提交`bf2dd4cc7b382471060c09402b8b2e9388df7447`推送到`origin/master`。推送触发CI#13 run `29677920251`，没有沿用CI#12结论：在`bf2dd4c`上重新执行contracts/static 44秒、frontend 40秒、backend/geo 92秒、images/integration 267秒，四个job全部`completed/success`；最后一项再次完成受控镜像、真实栈、backup/isolated restore、API/gateway/database fixable Critical扫描和三份SBOM。CI链接为`https://github.com/hunterzheng1/cbm-forge/actions/runs/29677920251`。

最终新鲜验证还包括：6个Archive聚合回归全部通过；两个适配器脚本py_compile通过；归档内所有JSON均可解析；权威v3 source/renderer validator均0 error、0 warning；指针、repair record、实际文件SHA-256三方一致；敏感凭据高置信标记0命中；活动change目录不存在；本地HEAD、远端master均为`bf2dd4c`且工作树干净。本轮验证临时创建的`backend/.venv`约151MB已按精确项目内路径清理，未留下新的依赖缓存。

对最终收尾的意见：**PASS。产品实现、合并、归档提交、远端CI和证据字节均闭环；唯一保守项仍是归档ledger缺typed dbCompatibility，已明确留给Hunter Harness正式修复，不影响本change产品门禁已通过的事实。**
