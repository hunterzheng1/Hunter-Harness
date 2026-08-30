# Changelog

## [0.4.7] — workflow-harness

> Submit / Archive 阶段修复：阶段交接恢复收敛为一条命令，archive 三个阻断
> 报错自带出路，密钥扫描不再误伤 harness 自生成的 recovery_token
>（docs/harness-improvement-roadmap/submit-archive-phase-issues-2026-08-30.md）。
> 纯 workflow-harness 修复，CLI 保持 0.4.8。

### Added — `harness_context.py handoff` 组合命令

- 一条命令补齐缺失的阶段交接：自动补建缺失/过期的 context 租约（prepare 幂等）
  → 写交接收据 → begin 确认。收据已存在时只补 begin 确认，不写重复 receipt。
  此前断链恢复要在 context close / change claim / context prepare / context
  close / context begin / change release 之间试错六条命令（阶段租约本不需动）。
- 来源阶段未关门（无 phase.end）时拒绝执行（`HANDOFF_SOURCE_NOT_CLOSED`）——
  handoff 只补已关门阶段的交接，不能截胡进行中的阶段。
- gate begin 的 `CONTEXT_HANDOFF_REQUIRED` / `CONTEXT_BEGIN_REQUIRED`
  recoveryAction 改为指向该命令。

### Added — `harness_change.py allow-local-release`

- 在 `meta/gate-policy.json` 写入 `candidateVerification.allowLocalRelease=true`
  的正规入口：保留既有策略内容、幂等，替代手工编辑。

### Fixed — archive 阻断报错自带出路

- `PROJECT_RELEASE_POLICY_BLOCKED` / `LOCAL_RELEASE_NOT_AUTHORIZED` →
  nextAction 指向 `allow-local-release --change <cn>`；
- `DIFF_ZERO_WITH_NONEMPTY_COMMIT` → nextAction 给出
  `declare-ownership --product-path` 命令模板；
- `SENSITIVE_EVIDENCE_UNQUARANTINED` → nextAction 展开为含全部 `--file`
  路径的完整 quarantine 命令（一轮修完，不再串行暴露）。

### Fixed — 密钥扫描豁免 harness 系统字段

- `_sensitive_candidates` 豁免 `recovery_token`：plan finalize 发布日志里的
  内部续跑凭证不是用户秘密，此前首轮+修订版两个发布日志会串行各阻断一次
  archive。用户文件里的真实 token/password 赋值不受影响。

## [0.4.6] — workflow-harness

> Review → Fixback 链路修复：解决 sales-insight-agent 实测暴露的 plain close 断链、
> sidecar 手写困难与 fixback 重选自锁问题
>（docs/harness-improvement-roadmap/review-fixback-phase-issues-2026-08-30.md）。
> 纯 workflow-harness 修复，CLI 保持 0.4.8。

### Fixed — plain close 自动交接，断链从根上消失

- **close 缺省 `--to-phase` 时自动派生后继**：上下文状态存在且计划后继唯一
  （排除 fixback 自环）时，gate close 自动派生后继并执行上下文交接，输出与
  stderr 摘要显式标注 `derivedToPhase`/`next=<phase>(auto)`。此前 plain close
  “成功”却静默跳过 handoff，后继阶段 begin 只能撞上无指引的
  `CONTEXT_HANDOFF_REQUIRED` / `CONTEXT_BEGIN_REQUIRED`——这两个错误现在也附
  可直接执行的恢复命令。多后继仍要求显式 `--to-phase`。
- **续跑路径同一规则**：`PHASE_CLOSE_RESUMED` 的自动派生同样排除 fixback 自环
  （execute 的候选 `[review, execute]` 派生 review；fixback 必须显式）。

### Fixed — Review sidecar 骨架生成器

- **`harness_review.py scaffold`**：按当前轮次生成 review-findings /
  fixback-dispositions 的写入骨架，直接喂给 `write-findings --stdin` /
  `write-dispositions --stdin`。runId 缺省从 events.ndjson 最新 review
  phase.start 推断；已有 findings 时输出每条 finding 的 OPEN 处置骨架并复用
  同轮 runId。`REVIEW_OUTPUTS_INCOMPLETE` 的 recoveryAction 改为指向 scaffold。

### Fixed — Fixback 重选分支

- **`_reselect_review_fixback` 放宽**：review→execute 交接已存在即视为修复分支
  已选定（不再要求 trigger 恰为 `review-fixback`）；review 已关门（phase.end
  落盘）但从没写后继分支的 0.4.7 断链产物，现在可以补写 review→execute 的
  fixback 收据完成重选。`FIXBACK_RESELECT_UNAVAILABLE` 附带当前交接状态
  （fromPhase/toPhase/trigger）、reviewPhaseEnded 与按状态分岔的恢复指引。

### Fixed — 评审原因码报错指明结构化字段

- `EVENT_REVIEW_REASON_IN_BODY` 错误消息点名 `--execution-mode` /
  `--decision-reason-code` / `--fallback-reason-code`，不再只说“写入结构化字段”。

## [0.4.5] — workflow-harness

> Execute 阶段 gate close 租约释放顺序修复：解决 sales-insight-agent 实测暴露的
> 「phase.end 已写 + 租约已放 + 阶段未关上」三不管中间态
>（docs/harness-improvement-roadmap/execute-phase-gate-close-lease-issue-2026-08-30.md）。
> 纯 workflow-harness 修复，CLI 保持 0.4.8。

### Fixed — gate close 租约释放顺序与幂等续跑

- **租约释放移至关门末尾**：`harness_gate.py close` 的步骤顺序改为
  handoff → monitor → recovery → scratch → **release** → emit。此前释放在
  handoff 之前，任一中途失败都会留下「phase.end 已写 + 租约已放 + 交接没写」
  的中间态，重试直接死在 `LEASE_ABSENT`，只能人工 `harness_change.py claim` 恢复。
  现在中途失败时租约仍持有，原样重跑同一命令即按 closeTransaction journal 幂等续跑。
- **close 幂等续跑（`PHASE_CLOSE_RESUMED`）**：租约缺失但当前会话的 `phase.end`
  已落盘时，close 自动识别中间态并补跑剩余步骤——交接已记录则跳过；未记录且
  计划后继唯一时自动派生补跑；后继不唯一（execute/review fixback 环）才报
  `PHASE_HANDOFF_PENDING` 并附 `candidateNextPhases` 与可直接执行的恢复命令。
  全程不再需要手工 `claim`。
- **文本模式补打印 recoveryAction**：`--json` 的结构化恢复指引自 0.4.7 就存在，
  但文本模式只有一行错误消息；现在非 `--json` 输出同样附带 `recovery:` 指引行。
- **关门成功一行摘要**：stderr 输出 `PHASE_CLOSED · phase=<p> · status=<s> ·
  next=<n>`，stdout 的 JSON 契约不变。
- `gate close --help` 注明「关门只调本命令，上下文交接由 --to-phase 内联完成」。
- `sweep_scratch` 异常兜底从 `OSError` 放宽到 `Exception`：收尾便利步骤的任何
  失败都只记录、绝不阻断关门。

## [0.4.8] — hunter-harness

> Plan v2 证据包流程体验修复：解决 sales-insight-agent 实测暴露的对抗评审
> 链路断裂、校验报错缺定位信息、边界契约同步等 7 项问题（docs/harness-improvement-roadmap/plan-v2-evidence-pack-issues-2026-08-30.md）。
> CLI 0.4.7 → 0.4.8，workflow-harness 0.4.3 → 0.4.4。

### Fixed — 对抗评审收据链路断裂（P0-1）

- **新增 `plan review-record` 子命令**：CLI 内部重跑质量门确定性与语义层，
  算出权威 `input_hash`，代算 `findings_hash`，把完整对抗评审收据写回
  证据包顶层 `adversarial_review`。编排方只需提供 reviewer_identity 与 findings，
  消掉手拼哈希或二分试错成本。
- **`plan evidence-pack` 顶层透传 `adversarial_review`**：自然输入中已有的
  合法收据在打包时被保留（不再静默丢弃）。
- **`PLAN_REVIEW_REQUIRED` 报错公开自曝期望值**：回显 `expected_review.input_hash`，
  把"先跑一次拿期望值"从 dist bundle 隐藏行为上升为公开契约。

### Fixed — 自然输入校验报错缺定位信息（P0-2 / P1-1 / P1-3 / P1-4）

- **边界提前校验定位**：`tasks[].affected_paths`（文件路径/目录报错）、
  `intent.uncertainties`（未决决策覆盖校验，直接列出缺失的 `intent_uncertainty:<id>`）、
  `approval.content`（各类数组条数上下限与对象键集）、`decision_nodes[]`（键集/枚举/
  `status: "resolved"` 三元完备性）以及 `adversarial_review` 均在边界报出
  `PLAN_EVIDENCE_INPUT_INVALID`（带 `field_path` 与 `problems[]`），不再等冻结
  核心抛出无定位信息的 `PLAN_DECISION_INPUT_INVALID` / `PLAN_ARTIFACT_INPUT_INVALID`。
- **`tasks[].affected_paths` 目录路径提示**：明确说明必须是相对文件路径，
  不接受目录，引导改为列出具体文件。
- **`approval.content` scope 自动继承（P1-4）**：未显式给出 `in_scope` /
  `out_of_scope` 时自动从 `intent` 继承，消除抄写两遍导致的等价性往返失败。
- **`PLAN_RUN_ID_INVALID` 报错优化**：打印实际收到的值和合法正则。
- **错误信封 stage 纠正**：catch 块中优先按 core reason_code 推导阶段，
  避免顶层信封码把所有底层失败泛化为 `stage: "finalize"`。

### Fixed — Python bootstrap-plan 误导提示（P1-5）

- `harness_context.py` 中的 `bootstrap_plan` 检测到 `.harness/` 已存在但
  `changes/` 不存在时自动 `mkdir -p`，不再错误报告 `PROJECT_ROOT_INVALID` 并误导
  已初始化项目去重跑 `hunter-harness init`。

## [0.4.7] — hunter-harness

> 纯 CLI 增量：平台地址提示记住默认值。workflow-harness 与 skills 不随本版变动。

### Added — 平台地址提示记住默认值

- 绑定/重新绑定平台时，地址提示现在带默认值：**重新绑定取当前凭据地址，
  首次绑定取最近一次成功连接的地址**（用户级偏好，存在系统状态目录
  `%LOCALAPPDATA%/HunterHarness/last-server.json` 或 XDG state 下，可用
  `HUNTER_HARNESS_USER_STATE_ROOT` 覆盖）。直接回车采用默认地址，有输入
  则以输入为准；无默认值时保持原「未输入即取消」行为。connect 成功后自动
  记住地址，偏好读写失败静默不影响主流程。

## [0.4.6] — hunter-harness

> 纯 CLI 增量：pi 接入 CodeGraph MCP 合并提示。workflow-harness 与 skills
> 不随本版变动。

### Added — pi 也接入 CodeGraph MCP 合并提示

- 初始化/刷新时，项目已有 `.codegraph/` 索引且 `.mcp.json` 未配置 CodeGraph，
  选择 pi（或 CodeBuddy）都会询问是否合并 CodeGraph MCP 到项目 `.mcp.json`
  ——pi-mcp-adapter 扩展直接读取该标准文件。此前该流程仅 CodeBuddy 触发，
  纯 pi 项目不会生成 `.mcp.json`。
- 顺带修复 `init.test.ts` 的 M1 菜单漂移（pi=5、all 顺移到 6）：该文件在
  CI_ONLY 清单中本地默认不跑，漂移直到本次才暴露；4 个用例的期望已同步到
  5 agent 菜单。

## [0.4.5] — hunter-harness

> 高严重度修复：push/pull（RemoteSync 通道）双向全断。纯 CLI 修复，
> workflow-harness 与 skills 不随本版变动；core 内部版本 0.1.3 → 0.1.4。

### Fixed — push/pull 预览被自家校验器拒绝（scan_performed 契约漂移）

- `readPushPullPreviewOutput` 的 `security_scan` 键集补上 `scan_performed`：
  4458708 停用扫描时 `buildSecurityScan` 已产出 6 键形状（含 `scan_performed`），
  但 CLI 侧校验器仍要求旧 5 键——所有 preview 被 `exact()` 拒绝为
  `PUSH_PULL_CLI_OUTPUT_INVALID: output.unknown`，push/pull（RemoteSync 通道）
  双向全断。新增跨层回归：真实模块产出的 preview 必须过真实校验器。
- `explainPushPullPreviewOutput` 诊断全覆盖：新增顶层键集（缺/多字段点名）、
  `preview_hash`/`base_version`/`display_zh`/`remote_version`、`source_ref` 内容
  漂移（指出具体字段）、push restore 禁令、security_scan 键集/类型/一致性、
  outcome 不一致的检查——不再落到无字段信息的 `output.unknown` 兜底。
- 同步修复 CLI 侧测试 fixture 的旧 5 键形状（正是它掩盖了跨层漂移）。

## [0.4.4] — hunter-harness ＋ [0.4.3] @hunter-harness/workflow-harness（Bundle 0.2.73）

> 高严重度修复：assurance 计划对抗评审收据的时间戳绑定死结（阻断所有
> assurance 级计划发布）+ pi 适配两处补漏；另有测试基建提速（全量 36→19
> 分钟）与 Windows 瞬态 I/O 重试加固。Bundle schema 保持 0.2.73，
> `minimumCliVersion` 0.2.92 不动；core 内部版本 0.1.2 → 0.1.3。

### Changed — 测试再提速：种子化推广到 CLI 层 + 压力深度校准

- `packages/cli/test/seeded-init.ts` 共享种子初始化：push/update/knowledge-query/push-stale
  四个最重文件的 beforeEach 全量 init 改为一次部署+目录拷贝复用（与 core 侧 freshness/
  refresh/migration 同构）；本轮继续推广到 recovery-menu、guarded-default-cli（3 用例）、
  push-scan、update-auth，覆盖全部每用例全量 init 的热路径文件。
- `recovery-v3` 两个压力用例 300→100 次迭代：锁上限 MAX_LOCK_CLAIMS=4096，300 无跨越
  任何语义阈值，100 次对泄漏/耗尽性质等价，全量省约 2/3 压力时间。
- push-pull-commands 生产源身份用例显式超时 30s→120s（含全量 init+git 初始化，本机常态边界）；
  rules-review 单用例补 240s 显式超时（单跑 114s，贴 120s integration 上限会假失败）。
- 机器级：Temp 目录加入 Windows Defender 排除（测试临时文件全在此，I/O 扫描是大头）。
- `push-archive-summary` 移入 integration 档（单用例全量 init，fast 30s 偶发超时）。
- `packages/core/test/mini-resources.ts` 合成 mini bundle（每 profile×agent 2-4 文件，
  覆盖全部断言路径）：initialize 9/10 用例、refresh、freshness 全部改用 mini，
  真实 718 文件 bundle 的端到端保真由“installs all four agents”与
  bundle-content-projection 用例承担。initialize.test.ts 330s→94s、
  refresh 263s→~90s、freshness 165s→~60s。default-recovery-contract 接入共享
  seeded-init（223s→60s）。
- 并行度实测结论：maxWorkers=3 与 2 墙钟持平（1514s vs 1522s），I/O 瓶颈下加并行
  无收益，维持 2 workers。

### Fixed — Windows 瞬态 I/O 错误的系统性重试

- `state/atomic.ts` 的 `atomicWriteFile`：rename 失败后按瞬态错误码（EPERM/EBUSY/EACCES）
  短退避重试——恢复存储、Skill 安装状态、归档等所有原子写路径一并加固。
  真实错误（EINVAL 等）仍立即抛出，语义不变。
- `sync-harness.mjs` 的 `atomicSwapDir` 同步加重试（Windows 杀软/索引持句柄时
  rename 目录偶发 EPERM，prepack 与 bundle 同步共用此路径）。

### Fixed — assurance 计划对抗评审收据的时间戳绑定死结

- `plan-quality` 对抗层（layer3）`input_hash` 不再纳入 layer2 收据的运行期信封
  （`completed_at` / `receipt_hash`）：绑定对象改为语义层内容身份
  `{input_hash, evaluator_invoked, findings, status}`。此前 `completed_at` 取墙钟
  （CLI 无 `--completed-at` 选项），每次 finalize 算出的 `input_hash` 都不同，
  静态 `adversarial_review` 收据永远无法预置匹配——所有 assurance 计划卡在
  PLAN_REVIEW_REQUIRED / PLAN_REVIEW_BINDING_FAILED。修复后静态收据可跨运行
  复现绑定（产物内容不变则哈希不变），收据内 `completed_at` 仅作元数据保留。
- `harness_runtime.py` 的 `_ADAPTERS` 补 `pi`：修复 doctor/run 链路报
  `ADAPTER_UNKNOWN: pi`。
- `.gitignore` 治理补 `/.pi/` 与 `.pi/skills/` 投影前缀：未跟踪的 `.pi/skills/**`
  不再被 evidence-pack 的 git-status 信号误扫描（此前会凭空产生
  migration/delete/shared_state/artifact_protocol 高风险信号）。存量项目在
  下次 `refresh`/`connect` 时自动补齐忽略规则。

## [0.4.3] — hunter-harness ＋ [0.4.2] @hunter-harness/workflow-harness（Bundle 0.2.73）＋ [0.1.5] @hunter-harness/skills

> pi 适配收官：M1 代码（第五个目标 Agent）此前已随 hunter-harness 0.4.1/0.4.2
> 与 workflow-harness 0.4.1 发布；本版补齐本地适配的最后缺口——用户级安装
> 落点、scoped AGENTS.md 投影、doctor override 告警、plan/review 委派 overlay。
> Bundle schema 保持 0.2.73，`minimumCliVersion` 0.2.92 不动（纯增量修正）；
> core 内部版本 0.1.1 → 0.1.2。

### Fixed — pi 技能委派路由补齐 overlay

- 新增 `harness/adapters/pi/skill-overlays/`（harness-plan / harness-review）：
  此前 pi 无 overlay，构建回退到基础文本，`plan.delegate`/`review.delegate`
  段落仍要求 `check-agents` 固定代理预检，但 pi 不安装固定 `harness-*` 角色
  （agentsRoot=null），每次 plan 都会产生虚假的“安装问题”记录。overlay 后
  与 codex/cursor 一致：默认主会话 inline，仅当环境已安装 pi-subagents 扩展
  （提供 `subagent` 工具）才临时委派只读探索/评审。

### Changed — pi 指令治理投影补齐 scoped AGENTS.md

- `renderPi` 与 codex 合并为共享的 AGENTS.md 树投影：除根 `AGENTS.md` 外，
  path 激活的规则同样按 glob 作用域生成 `<dir>/AGENTS.md`（pi 与 codex 一样
  从 cwd 向上发现 AGENTS.md，scoped 文件在同一路径合写，target_agents 双向
  标注）。
- `doctor` 新增 pi 告警：项目启用 pi 适配且根目录存在 `AGENTS.override.md` 时，
  报告 `PI_AGENTS_OVERRIDE_SHADOWS_PROJECTION`（pi 会改读 override 而忽略投影
  生成的 AGENTS.md），status WARN、退出码 5。

### Fixed — pi 用户级安装落点纠正

- pi 的用户级技能根由 `~/.pi/skills` 更正为 `~/.pi/agent/skills`：pi 全局技能
  只发现 `~/.pi/agent/skills/` 与 `~/.agents/skills/`，此前用户级安装落点
  不会被 pi 加载。
- pi 的用户级 subagent 根由 `~/.pi/agents` 更正为 `~/.pi/agent/agents`：
  pi-subagents 全局代理目录是 `~/.pi/agent/agents`（或 `~/.agents`），
  `~/.pi/agents` 从未被读取。项目级落点（`.pi/skills/`、`.pi/agents/`）不变。
- pi surface 登记 `.agents/skills` 为原生发现别名（与 cursor 同语义）；
  `.gitignore` 补上 `.pi/`。

### Fixed — 测试套件去 flaky：冻结 fixture 字节漂移与慢测试超时错配

- `.gitattributes` 对 `packages/contracts/test/fixtures/**` 与
  `packages/core/test/fixtures/**` 补 `-text`：此前 `core.autocrlf=true` 的 Windows
  检出把冻结 fixture 转成 CRLF，字节哈希/字节数断言必挂（平台信息导出、远端上传/
  归档契约、archive-outbox 序列化等 4 个文件长期红灯）。已将所有已跟踪 fixture 恢复为提交字节。
- `sync-process` SYNC-005：最后活动与启动允许同毫秒（`toBeGreaterThanOrEqual`），
  消除高精度机器上的毫秒相等毛刺。
- 恢复存储并发投影用例在高负载下偏发 `nlink !== 1` 边界失败：根因为并发 rename-over 的
  NTFS 瞬态窗口，已在下一节以二次确认修复；`recovery-v3` 两个 300 次循环用例超时 90s→240s。

### Fixed — 恢复存储并发竞态：瞬态链接异常二次确认（遗留处理）

- `recovery-store.ts` 两处 `nlink !== 1` 边界检查改为“短延迟后复检仍异常才失败”：
  Windows 上并发 rename-over 同一恢复文件时，另一事务的 lstat 可能落在 NTFS 替换
  瞬态窗口里误报多链接。真实硬链接攻击在两次 stat 间稳定，fail-closed 语义不变；
  瞬态窗口不再让并发注册误失败。`recovery-v3` 整文件连跑 3 次 29/29（此前约 2/3 概率偶发）。
- 测试卫生：新增共享 `packages/cli/test/recovery-env.ts`，为 7 个注入精简 env 的测试文件
  （push/update/instructions/push-pull-commands/rules-sync/sync-command/knowledge-query，
  共 57 处调用点）透传 `HUNTER_HARNESS_RECOVERY_ROOT`，并为 archive-upload 补齐 3 处遗漏：
  此前这些用例把测试事务写进开发者机器的真实恢复存储（泄漏守卫从 26 条/次降到 7，
  二分定位到 knowledge-query 里的隐藏 init，修复后实证泄漏 0）。

### Changed — 测试提速：重型文件移入 integration 项目 + 种子安装复用

- `vitest.config.ts` integration 名单补入 8 个真实慢文件（migration、push-stale、update-auth、
  push-scan、guarded-project-plan、plan-durable、recovery-v3、managed-block-refresh）：它们在 fast 项目 30s 超时必现假失败，
  120s 档位后全部转绿（push-stale 16/16）。
- `freshness/migration/refresh` 三个测试文件改为“同配置只真实部署一次，后续用例目录拷贝复用”，
  单文件耗时显著下降（refresh 633s→230s），用例语义不变。

### Added — pi 作为第五个目标 Agent（M1 本地适配）

- `--agents` / 交互菜单 / `refresh` 支持 `pi`（交互序号 5，`all` 顺移到 6）；
  安装落点：`.pi/skills/`、指令 `AGENTS.md`、worktree `.pi/worktrees/`（`pi/`
  分支前缀）；不生成规则文件与固定角色（agentsRoot=null）。
- Skill 内容走通用 Agent Skills 标准：frontmatter 只保留 `name`/`description`，
  与 codex/cursor/codebuddy 同一套 adapt 管线；`.harness/` 状态、事件流、
  ledger、归档 ZIP 等 agent 无关层零改动复用。
- 契约：`HARNESS_AGENT_ORDER` / `skillTargetAgentSchema` / `registryAgentSchema`
  增加 `pi`；指令治理新增 `pi` 投影。
- 兼容：npm Skill 包 v3 manifest 的 variants 改为部分记录——旧四家（claude-code/
  codex/cursor/codebuddy）保持必填，`pi` 变体可选，存量已发布包在新 CLI 上仍可安装。
- 已知限制：pi 仅在项目被信任后加载 `.pi/skills/`（交互首次确认；非交互需 `-a`）；
  `skill-cli upload` 的服务端发布校验与 hunter-platform 的枚举接受属 M3，本仓先把
  本地安装/上传边界打开。

## [0.4.1] — hunter-harness ＋ [0.4.1] @hunter-harness/workflow-harness

### Changed — 计划产物人类可读化 + 知识候选从 plans/*.md 派生

- plan finalize 派生的 `plans/*.md` 不再把哈希 refs 裸拼成一行：
  requirement/ownership/scope 引用现在带人类可读标签（`[kind] 文本 → \`hash\``），
  evidence refs 用 code span 包裹。机器身份（哈希）仍保留，门禁校验与
  Python 解包不受影响——`content_hash` 是结构化内容哈希，`serialized_sha256`
  由渲染器在发布时重新计算。
- 归档知识候选新增 plans 源：`harness_knowledge_candidates.build_plan_candidates`
  从 design.md（Requirements/Risks/Invariants）、plan.md（Tasks）、
  test-scenarios.md（场景）解析出 requirement/risk/implementation/test-evidence
  候选（confidence 0.85），与 summary 三源合并去重。没有对抗评审的变更也能
  沉淀知识。

## [0.4.0] — hunter-harness ＋ [0.4.0] @hunter-harness/workflow-harness（Bundle 0.2.73）

> 知识沉淀从「只收已裁决 findings/risks」扩展到「设计决策/需求/API 契约」，
> 但守住 spec 的两条底线：**筛选在上游发生**（仅 adopted 成为候选）、**零 LLM**
> （归档只做确定性投影）。契约侧零变更——`knowledgeCandidateEntryTypeSchema`
> 本来就含 decision/requirement/api-contract。

### Added — evidence/decisions.json → 知识候选

- 新增可选产物 `.harness/changes/<change>/evidence/decisions.json`
  （schema_version 1）：plan/execute/review 阶段由人或 agent 写入**已采纳**的
  设计决策、长期约束、API 契约，带 `title/rationale/entry_type/status/path:line/
  keywords/source` 结构化字段与溯源。
- `collect_summary_data` 校验并透传到 summary `decisions[]`（不合 schema 的
  记录丢弃并在 maintenanceNotes 留计数，丢弃不无声）；replay 保留旧归档的
  decisions（golden-stable）。
- `build_knowledge_candidates` 把 `status=adopted` 的记录按记录的 entry_type
  （decision/requirement/api-contract，confidence 0.85 ≥ 提取阈值 0.82）投影为
  候选；proposed/rejected/superseded 留在 summary 做记录但不构成知识。
- `harness/harness-archive/reference.md` 新增 decisions.json 书写规范；summary
  模板携带 `decisions` 键。

### Fixed — 未裁决 findings 导致候选为 0 时显式告警

此前「有 OPEN findings」与「无知识可沉淀」在下游都显示为 ready / 0 results。
现在 finalize 步骤 8b 输出 `droppedUnadjudicated` 计数（机器可读）；未裁决
（OPEN/UNKNOWN）的 RED/YELLOW findings > 0 且候选为 0 时，归档 warnings 显式
提示先完成裁决再 republish。

## [0.3.1] — hunter-harness ＋ [0.3.1] @hunter-harness/workflow-harness（Bundle 0.2.73）

> **修复 2026-10-27 归档 422 事故的全部根因**：工具生成的归档被自己的服务端拒绝
> （`stageStatus` 键集漂移），且 422 零字段定位把修复变成黑盒探针二分（耗时约 10
> 小时）。Bundle 版本保持 0.2.73（内容变化由 content_sha256 跟踪，已随 sync 重算）。

### Fixed — 归档生成器补齐 schema 2.3 全阶段键集

`harness_archive.py` 的 `_stage_status_from_sources` 自 2026-08 run+test 合并为
execute 后只输出 `{plan, execute, review, submit, archive}`，而服务端 CLI schema
2.3 要求 `plan/run/test/review/submit/archive` 六个必需键——standard 档 change
的归档在上传最后一跳必 422。现在生成器输出补齐 `run`/`test`：旧事件仍带
run/test 原名时按原名拆分还原，否则镜像 execute 聚合值；`execute` 键保留
（2.3 为 passthrough，既有消费方与模板文档不受影响）。manualActions 对镜像键
去重。bundle 模板与 reference.md 本来就写着全阶段键集，本次是生成器对齐回
文档契约。

### Added — 归档上传只读预检与字段级 422 定位

- 服务端（hunter-platform 同步发布）：422 响应 details 携带 `issues
  [{path, code, message}]`（如 `stageStatus.run: required`）；新增
  `POST …/archive-package/validate` 端点，跑与 PUT 完全相同的包校验但不落盘、
  不占正式收据。
- CLI：`hunter-harness archive upload --validate` 走 validate 端点做只读预检
  （无需 `--yes`）；上传被拒时 stderr 直接逐字段打印服务端 issues。排障 422
  不再需要 probe-* change key 探针二分。

### Fixed — 同步 4458708 上传扫描停用契约的测试漂移（main 长红 29 例清零）

4458708 在六个子系统停用上传/发布链路的敏感扫描（正确逻辑：上传时不查敏感
信息；扫描器模块本体未动，被停用的是各发布路径对它的调用），但测试未同步，
main 上长红 9 文件 29 例。全部改为冻结停用契约：`preview.security`/
`security_scan` 恒 `disabled-for-publication`、`--skip-sensitive-scan` 与
`confirmSensitiveScanSkip` 为兼容 no-op、finalize 不再携带 skip 键、密钥内容
绝不回显输出、checker 不再产出 SENSITIVE 项。顺带修正一例 reason_code 漂移
（`INSTRUCTION_CURRENT_PROPOSAL_MISMATCH` 身份级拒绝，非扫描）。全量 TS 首次
154 文件全绿。

## [0.3.0] — hunter-harness ＋ [0.3.0] @hunter-harness/workflow-harness（Bundle 0.2.73）

> **双发**：execute 合并、legacy 管线删除与权威切换横跨 CLI 与 workflow bundle，
> 同步升 0.3.0；`minimumCliVersion` 提到 `0.3.0`（完整门禁快照只有 0.3.0 CLI 产出，
> 旧 CLI 降级为工作副本回退）。Bundle 版本保持 0.2.73（2×4 矩阵的 schema 版本，
> 内容变化由 content_sha256 跟踪）。

> 诊断第 5/6/8 项闭环：run+test 合并为 execute（方案 c）、evidence-pack 接通
> 推断与真实 capabilities、legacy 退役补上采纳度度量。另修复一个 main 上长红的
> 测试漂移（`check_status` 内容扫描停用契约未同步）。后续追加两项用户决策：
> legacy 计划管线写侧直接删除（解除采纳度 gating）、PlanProfile 权威切换落地。

### Removed — legacy 计划管线写侧（BREAKING）

`harness_plan_finalize.py` 不再提供 `finalize`/`republish` 子命令与 staging 校验；
新 change 的发布唯一入口为 `npx hunter-harness plan evidence-pack` + `plan
finalize`（v2）。计划修订走 v2 重跑流（`context.attempt` 递增 +
`expected_baseline=present` 带上次 manifest 哈希/generation）。采纳度 gating 由
用户决策解除（样本量记录在 roadmap 14）；`harness_adoption_metrics.py` 保留作
事后审计轨迹。TS 侧 `legacy-lifecycle-projection.ts`（HP-09 events.ndjson 投影）
一并移除。**不移除读侧**：`verify_plan`（legacy receipt 与 v2 事务/journal 双形状，
`gate.validate_plan_handoff` 依赖）、v2 manifest/checkpoints 解包、plan/scenario
表解析——历史 change 的 legacy 产物保持可读。

### Changed — PlanProfile 权威切换：`meta/plan-profile.json` 成为门禁权威

诊断第 5 项权威切换落地。`plan evidence-pack` 发布时把 classify 工作副本
（`meta/gate-policy.json`）的门禁字段（`requiredGateDag`/
`requiredValidationsByPhase`/`tier`/`source`）以白名单键并入 v2 gate_policy
content 并哈希绑定；`harness_paths.load_change_gate_policy` 在
gate/context/phase/archive 各处统一 **v2 优先**：快照完整（含
`mode`/`planned_phases`/`required_gate_dag`/`required_validations_by_phase`）
即以它为准；0.2.92-era 的不完整快照与未发布的 change 回退工作副本。两者并存且
`plannedPhases`（canonical 去重后）不一致 → drift 报告，以 v2 为准——发布后改写
工作副本本身就是异常。TS 侧 `MachineArtifactDerivationInput` 新增可选
`gate_policy_overlay`（白名单并入 + source_hashes 记录）；旧契约 run/test
validations 键并入时归一到 execute 取并集。

### Changed — run+test 合并为 execute（方案 c，review 保留独立阶段）

0.2.92 铺好的迁移层（单一真相源 + 别名表 + 阶段规则表）本轮兑现：合并从"改七处
清单 + 写迁移器 + 重建 fixback 语义"降为"改一张表 + 登记别名"。两条不变量：

- **写边界归一化**：gate begin/close、context prepare/begin/close/configure-plan、
  fixback 入口先经 `resolve_phase_name` 归一，之后系统内只流动 canonical
  `execute`；旧名 `--phase run`/`--phase test` 仍被接受并等价归一，未知名报
  `PHASE_UNKNOWN` 并列出合法名与别名。
- **读侧不迁移**：落盘的 transitions/events/capsule/gate-policy 一律不改写，
  `_payload_hash` 与哈希链校验保持对原始字节；别名只在哈希校验之后的业务比较层
  生效（两侧 resolve 后比 canonical）。在途 change 的租约、capsule（文件名与内容
  身份）、`requiredValidations` 旧键（run/test 取并集）、旧 DAG 节点、旧 manifest
  `ownerPhase=run/test` 都经别名层继续工作。

语义变化（有意为之，升级前请知悉）：

- **C9 场景到期**：`SCENARIO_OWNER_PHASE_ORDER` 变为 `(plan, execute, review,
  submit)`，旧 manifest 中 `ownerPhase=run`/`test` 的场景在 execute 关门时**到期**
  （不再顺延）——execute 关门 = 原 run+test 合并关门，对"只做完原 run 半段"的
  在途 change 会要求 test 侧 ledger 证据齐备。
- **fixback**：旧 `test→run` 折叠为 `execute→execute` 自迁移（attempt 单调连续，
  旧腿与新腿同族计数）；`review→run` 为 `review→execute`。transitions 审计脊柱保留。
- **review 全程不动**：sidecar runId 绑定与 run_id 铸造零改动（方案 c 下"review
  sidecar runId 重定义"问题不存在）。
- **空信号地板对齐**：TS profile 空信号从 quick 改 standard（与 Python
  default-standard 一致）；`docs_only`/`narrow_fix` 仍是 quick。
- 建议**在阶段边界升级**：升级瞬间持有旧名租约/capsule 的在途 change 虽由别名
  回退兜底，但阶段边界处升级路径最简单。

入口与产物：`/harness-execute` 为统一入口；`/harness-run`、`/harness-test` 保留
为别名（frontmatter name 不变、内容照旧，顶部横幅指向 execute，至少保留一个
minor）。`harness/contracts/workflow-policy.json` 的
defaultPhases/requiredValidations（并集）/validationPhases/skills 同步；
TS 的 `PLAN_PHASES`/`MODE_POLICY`/`PLAN_EVENT_PHASES` 同步；
`@hunter-harness/contracts` 新增 `LEGACY_PLAN_PHASE_ALIASES`（与 Python 互为镜像，
各加单测冻结）。兼容测试集中在 `harness/scripts/tests/test_harness_phase_aliases.py`
（11 条在途场景：停在 run/test 的 change、fixback attempt 连续、reselect 写
canonical、`_phase_plan` 去重、旧 DAG/manifest resolve、旧 capsule 冻结、未知名
拒绝、归档折叠）。

### Changed — plan evidence-pack 接通信号推断、真实 capabilities 与 0.6 计划接缝

`reference.md` 钉的两条前置缺陷已接通（接通 ≠ 权威切换，门禁权威仍是 Python
gate-policy）：

- `risk_signals` 不再是纯手填：命令按 `affected_paths`（主源）与 `git status
  --porcelain`（次源）经 marker 表推断，**与手填取并集**（推断是安全地板），逐条
  标注 `declared / inferred / declared+inferred`。
- `capabilities` 由 `plan-evidence/git-probe.ts` 真实探测（execFile，零新增依赖）；
  阶段 0.6 `configure-plan` 落的 `plannedPhases` 被读取（权威形状校验，v2 包装体
  一律回退派生），可选阶段照它取舍，required 缺失保留并告警
  `phase_set_required_retained`。provenance 只进 stdout 与 `pack.context`，不进任何
  哈希身份字段。

### Added — legacy 采纳度采集脚本（roadmap 14 三判据只读度量）

`harness/scripts/harness_adoption_metrics.py`（stdlib、只读）：对一组项目根聚合
roadmap 14 的三条 0.3.0 删除判据（v2 finalize 首次成功率 10 窗 ≥8、证据闭环 5 窗
全净、legacy 回退率 10 窗 ≤1），输出 `pass/fail/indeterminate`（样本不足显式标注，
不从 fixture 推算）。删除本身仍以判据达标为前提。

### Fixed — archive 测试漂移

`test_harness_archive.py` 断言 `publication_content_scan.blocked`，而 status 路径
自上传链路停用扫描后只记录停用契约（ok/scan_performed:false/findings:[]/
message），KeyError 长红。改为冻结停用契约，并移除已无 CLI 依赖的 `_local_cli`
包裹。

## [0.2.92] — hunter-harness ＋ [0.2.86] @hunter-harness/workflow-harness（Bundle 0.2.73）

> **双发**：本轮同时改了 CLI（`plan evidence-pack` 的场景键集与模板、v2 发布的 target 路径）
> 与 harness 脚本，`minimumCliVersion` 提到 `0.2.92`。这不是形式要求——本 Bundle 的
> `_verify_plan_v2` 按 `meta/plan-profile.json` 校验 journal，而 0.2.91 的 CLI 仍会把派生视图
> 写到 `meta/gate-policy.json` 上，既让 verify 报 `RECEIPT_FILES_INCOMPLETE`，也会把 classify
> 写的门禁策略原子覆盖掉。其余错配方向同样 fail-closed，不会静默放行。

流程治理收敛。起因是一份外部诊断——新旧两代状态机、两套租约、两类身份叠加，让普通
任务承担了接近发布系统的复杂度。全程不碰原子写入、并发 fencing、哈希/readback 这些
底层边界。

**Run/Test/Review 合并为 Execute 仍未做**，且是有意推迟的：`target_required_dag` 对历史
`gate-policy.json` 里的旧阶段名硬 raise，TS 侧 partition 等长断言同样硬失败，而仓库没有
任何 change 级 schema 迁移机制——改阶段名会让所有在途 change 当场报废且无回收路径。本轮
先把迁移层与单一真相源做出来，届时合并变成一次可逆的配置改动。

### Fixed — v2 发布会覆盖 Python 门禁依赖的文件（P0）

TS 的八 target 清单里有 `meta/gate-policy.json` 与 `meta/implementation-checkpoints.json`，
FS 端口对 `binding.ownership_paths` 逐个 `writeFileAtomic`——不读旧内容、不合并。而这两个
文件在阶段 0.5 已由 `classify` 写成 Python 形状。阶段 8 的 finalize 把它们换成 TS 的 artifact
包装体（`schema_version` 而非 `schemaVersion`，业务字段埋在 `content` 一层里）。

- `meta/gate-policy.json` → **硬失败**：`gate begin --phase run` 报 `POLICY_LOAD_FAILED`
  （`effective_workflow_policy` 读 `schemaVersion` 拿到 `None` 就 raise）。
- `meta/implementation-checkpoints.json` → **静默失效**：`checkpoint_status` 找 `checkpoints[]`
  数组，找不到返回 `"missing"`，`foundation_gate_blocks` 随即放行。

两者的修法不同，取决于 TS 的 content 里有没有 Python 需要的信息：

- **gate-policy 改名**。TS 的 content 没有 `requiredGateDag`，补它需要把 `VALIDATION_DEPENDENCIES`
  与 `workflow-policy.json` 的 DAG 编译逻辑整体移植到 TS 并长期双写。既然 Python 是这个文件的
  权威写者、TS 那份只是派生视图，就让派生视图换名到 `meta/plan-profile.json`——冲突当场消失。
- **checkpoints 解包**。`content.foundation_gate` 就是要的状态，信息够，所以在**只读侧**归一化：
  `checkpoint_status` 现在同时认 `checkpoints[]`、顶层 `foundationGate`（legacy finalize 写的）
  与 v2 包装体三种形状。`load_checkpoints` 刻意仍返回原样文档——`gate checkpoint approve` 会把
  它写回盘，返回归一化结构会用合成内容覆盖 v2 的哈希绑定产物，造成 `ARTIFACT_HASH_DRIFT`。

**根因是测试形状**：TS 的三个 e2e 从不调用 Python；Python 的 v2 夹具把 `meta/gate-policy.json`
写成字面量 `b"v2-demo:meta/gate-policy.json\n"`——连合法 JSON 都不是，测试照样通过，因为
`verify_plan` 只比对 journal 哈希。现已补上真实链路 e2e（classify → finalize → Python 读策略）
并让那个夹具写真实形状。

### Fixed — review 处置文档完全不校验 runId

`validate_dispositions` 从头到尾不看 `runId`，`write_dispositions` 直接透传，**写 `None` 都能
落盘**，整条 sidecar 的强制力压在 gate 关门时的一行断言上。而那条断言防的是 fixback 循环里的
跨轮重放：sidecar 是 per-change 单文件、不带 runId 后缀，第二轮 review 关门时磁盘上躺着第一轮
那份（finding 全已 `FIXED`）。现在写入端就要求 runId 非空且与 findings 同轮。

### Added — v2 Plan 的场景契约接上了 run/test 门禁

v2 派生的 `meta/scenario-manifest.json` 是 artifact 包装体，键名与门禁消费的不同，缺
`priority`/`requiredEvidenceKind`/`ownerPhase` 与可执行测试三元。结果是 v2 计划能发布成功，
却走不完 run/test 的证据闭环——只能回退 legacy。

不做纯适配器：缺的字段在 v2 数据里根本不存在，靠 `risk_level` 猜 `priority` 是语义伪造，
而解包后"必需场景"会算成空集、C9 返回 `NO_LEDGER_REQUIRED_SCENARIOS`，等于对所有 v2 计划
静默关掉证据门禁。所以在生产端补齐字段：`TestScenarioInput` 加必填 `priority`/`owner_phase`
与可选三元，投影白名单带上它们并派生 `required_evidence_kind`。

解包器 `unpack_v2_scenario_manifest` 落在 `harness_plan_finalize`（它本就定义了 legacy
manifest 的 schema），gate 与 ledger 共用同一份。**逐场景**校验而非取键的并集——并集只要
有一条场景带了 `priority` 就算通过，其余缺字段的会静默落进非必需集。字段不齐仍 fail-closed。

新增跨语言端到端：拿真实 finalize 产出的 manifest 喂真实的 Python 解包器。此前 Python 侧
的 v2 夹具是手写 JSON，生产端字段一变测试不会失效。

### Changed — 阶段清单收敛为单一真相源，并加读时迁移层

阶段清单曾在 `harness_context` 与 `harness_phase` 各写一遍，靠约定同步——直到后者少了一个
`merge`，worktree 变更走到 merge 阶段就硬 raise。权威清单下沉到 `harness_paths`（叶子模块），
两边转引同一个对象。

新增 `LEGACY_PHASE_ALIASES` 读时映射与三态判定（`workflow` / `non_workflow` / `unknown`）。
别名表现在为空，但三态今天就有真实内容：`release`、`deploy`、`sync` 这些名字真实出现在阶段
位置，它们不是拼错的阶段名。`_phase_plan` 不再静默降级——遇未知阶段名以前一律退成 legacy、
阶段计划整个失效而调用方看不出，现在先过映射，仍解析不了才降级并带上原因与具体阶段名。

### Changed — 阶段特化收敛为声明式规则表

`cmd_begin`/`cmd_close` 里散落着八处 `if args.phase == ...`。两个五百行的函数，想知道
"test 关门时到底跑哪几项"要通读全文；更要紧的是 run/test/review 的差异被摊平在控制流里，
看不出它们本可以共用同一套生命周期。改为 `PHASE_GATE_RULES` 查表，行为逐条对齐并测试锁死。

### Fixed — fixback 的 run 事件从来没被打上标记

fixback 靠嗅探 note 里有没有 "fixback" 字样判定，而真正的启动路径写的 note 是"开始处理评审
中确认需要修改的代码问题。"——一个 "fixback" 字都没有。现在 `gate begin/close` 接受
`--fixback` 显式信号，note 嗅探保留为兼容回退。

### Fixed — `merge` 不是一个合法阶段

`harness_phase.PHASE_ORDER` 少一个 `merge`，而 worktree 场景会自动插入它，于是走到 merge
阶段直接 `unsupported reconcile target phase`。

### Changed — Plan 文档去重与 legacy 退役门槛

按 roadmap 11 号实施步骤 8 裁掉 `checklist.md` 里 17 条**已由 finalizer fail-closed 判定**
的勾选项（文件是否齐全、哈希是否一致、身份是否匹配、计数是否对得上），以及两处跨文件复述
（问题预算数值的权威在 `protocols.md`，Plan 结束行为的权威在 `SKILL.md` + `reference.md`）。
checklist 315 → 254 行。保留的是机器判不了的：层序依赖是否合理、维度是否真被覆盖、详略是否
配得上复杂度。新增文档测试锁住"同一事实只在一处维护"。

按 roadmap 12 号事件规则，取消"协议自检通过"必须追加 `verification` 事件的要求——它不改变
任何结论，只增加监控噪声。影响行为的 `decision`/`issue` 照常留痕，机器事件类型一个不删。

roadmap 14 号补上 legacy Plan 路径的**删除点**（workflow-harness 0.3.0）与可执行的采纳度判据。
此前 12 号把排期推给 14 号、14 号只给条件不给排期，而采纳度基线六项全部「待采集」，实际无法
度量。legacy 现标记为 deprecated，新 change 默认 v2；**本轮不删任何 legacy 代码**，历史归档
必须保持可读。

### Fixed — ledger 对 v2 场景清单静默降级（安全）

`harness_ledger.py record --scenario-ids` 探测 `schemaVersion` 时初值是 `0`，而 v2
plan artifact 包装体没有顶层 `schemaVersion`，探测就停在 `0`，`>= 2` 判假，
`--scenario-receipt-file` 的强制要求被整个跳过——证据照常入账，没有执行收据。同一份
manifest，门禁侧 `harness_gate.py` 是 fail-closed 的（`SCENARIO_MANIFEST_V2_UNSUPPORTED`），
ledger 侧却放行，两种姿态互相矛盾，且此前无任何测试覆盖。现在 `record`、
`scenario-receipt-template`、`validate_scenario_execution_receipt` 三处都按同一个码
fail-closed。

### Fixed — 阶段跑过 TTL 就再也关不上门

Context 与 Gate 的租约语义相反：`harness_context.close_transition` 认为过期只说明阶段
超时，照常收尾并记 `leaseLapsed`；而 `harness_change.inspect_lease` 把过期直接当成
租约不存在，`gate close` 随即报 `LEASE_ABSENT`，要求人工 `claim` 一遍再原样重跑。长
阶段因此必然在收尾时卡住。

租约过期而 run-id 仍是本阶段的，恰好**证明**没有第三方抢占过——抢占会重写租约文件把
run-id 换掉。现在 `close` 依此自动用原 run-id 重取并照常关门，在返回体记
`leaseLapsed`。换了 run-id 或阶段仍报 `LEASE_OWNER_MISMATCH`；租约文件损坏时报新的
`LEASE_INVALID` 且**不**自动恢复——损坏的租约证明不了任何事，而"能证明没被抢占"正是
自动重取唯一的安全前提。

新增 `harness_change.inspect_lease_state()`，把「不存在 / 已过期 / 已损坏」三态分开；
`inspect_lease()` 语义不变，继续只返回活跃租约。

### Fixed — 换工具接手被当成 bundle 身份漂移

`validate_identity()` 把 `executor_tool != build.agent` 判为 `BUNDLE_IDENTITY_MISMATCH`，
于是 Codex 换 CodeBuddy 接手同一个 change 会被当成供应链漂移挡下来。可"这个 bundle
可不可信"和"现在哪个工具在跑"是两件事：其余 10 项校验用的全是 bundle 自称的 `agent`，
与当前工具无关。现在工具名降级为审计字段（`executorTool` / `executorMatchesBundle`），
随 `phase.start` 事件留痕；bundle hash、installed manifest、skills-root、build marker
实盘哈希等完整性校验**一项不减**。

Context 侧同步收窄：同一阶段换执行者不再要求 transition receipt（receipt 正是上一阶段
close 才会写的，崩溃场景里根本不存在），跨阶段推进仍必须有证据。接管一律写
`runtime/context-adoptions.ndjson` 留痕——过期租约本来就允许顶替，但此前只在返回体挂一个
`recovery`，退出进程就没了。未过期租约被他人抢占仍报 `CONTEXT_LEASE_HELD`，并发保护不变。

### Fixed — `merge` 不是一个合法阶段

`harness_phase.PHASE_ORDER` 少一个 `merge`，而 `harness_context.WORKFLOW_PHASES` 有，
且 worktree 场景会自动插入它——于是 worktree 变更走到 merge 阶段时直接
`unsupported reconcile target phase`。两处清单现已同源同序，并有测试锁定。

### Changed — 无风险信号默认 `standard`，不再默认 `full`

`classify_risk` 与 `classify_defaults` 都以 `full` 起步，而风险信号推断只在
`--stage post-run` 下跑、生产流程无一处调用它，起步值实际就是终值：每个普通变更都默认
背上 `plan→run→test→review→submit→archive` 六阶段和 apiTest。默认改为 `standard`
（`plan,run,test,submit,archive` + compile/unitTest/unitTestFull），保留测试证据闭环，
去掉默认的 review 阶段与 apiTest。单调升级不变——有风险信号照样升到 `full`，也可用
计划文档的「风险等级: full」或 `classify --tier-override full` 显式升档。

## [0.2.91] — hunter-harness ＋ [0.2.85] @hunter-harness/workflow-harness

- 统一封存归档补传，支持 `--change latest`、dry-run、幂等重试与单次构建。
- 上传和发布链路移除内容敏感扫描阻断，保留路径、凭据、ZIP、schema 与哈希校验。
- 兼容旧敏感扫描参数并提示弃用；独立 `scan-sensitive` 命令继续保留。

## [0.2.90] — hunter-harness ＋ [0.2.84] @hunter-harness/workflow-harness（Bundle 0.2.73）

> **双发**：本次同时改了 CLI（新增 `scan-sensitive`、Push/Pull 输出诊断）与 harness 脚本，
> 因此 `minimumCliVersion` 提到 `0.2.90`——Bundle 的归档发布内容预检要调用
> `hunter-harness scan-sensitive`，0.2.89 上没有这个命令，预检会降级成警告。

依据是 kld-sdd `usage-stats-git-identity` 的一次完整执行记录（5690 行，plan→run→test→
review→fixback→test→submit→merge→archive）。变更本身成功合入 master，但流程代价失衡：

| 阶段 | 工具调用 | 其中 Bash | 错误行 |
|---|---|---|---|
| run（实现整个功能） | 101 | 50 | 11 |
| **run --fixback（改 3 行）** | **121** | **84** | **14** |
| submit + merge | 89 | 66 | 14 |
| archive | 45 | 32 | **29** |

改 3 行 deprecation 分支比写整个功能还贵；归档 45 次调用里 29 行是错误，ZIP 上传最终
422 失败后判定"不可篡改绕过"放弃。根因不是步骤多，是四类工程缺陷。

### Fixed — 门禁没有正规出路时，绕道就是唯一出路

- **fixback 的 review 收据逼调用方销毁审计轨迹**。`register_evidence` 的校验只看
  severity，完全不读 `fixback-dispositions.json`：findings 里只要还有一条 RED/YELLOW，
  收据就永远注册不了。当时唯一能让 `close` 通过的办法是把 `review-findings.json` 写成
  空列表——3 条原始发现 + 2 条复审发现的全部审计轨迹被一次写空抹掉，agent 自己在日志里
  意识到了这点却没有别的路。而 `harness_review.py` 里 `CURRENT_RISK_DISPOSITIONS` 早就
  是正确模型，fixback 没用上。现改为只有 `OPEN`/未登记 的 RED/YELLOW 才阻塞；
  `FIXED`/`NOT_APPLICABLE` 放行；`ACCEPTED_RISK`/`DEFERRED` 放行并记入收据
  `residualRisks` 留痕。findings sidecar 是发现的真相源，处置结论属于另一个 sidecar。

- **本地发布门禁与服务端扫的不是同一批字节，范围完全倒置**。本地跑
  `harness_runtime` 自建的赋值式正则、扫**整棵 change 树**（含从不入包的 `runtime/`）；
  服务端跑 `packages/core` 的 `scanSensitiveFiles`、扫 ZIP 里那 7 个文件。于是 review
  阶段自己 `git diff HEAD >` 生成的 `review-diff.patch`（5068 行，内含被删的旧 token
  代码）把归档整个挡住，而真正会被拒的 `plans/*-design.md` 一个字没查——直到 upload
  收到 422。触发源已复现确认：内网默认地址 `10.29.213.80` 命中 `HH_INTERNAL_ADDRESS`
  （medium，`overridable=true`）。现在发布门禁只扫会被打包的成员，且 `archive status`
  用**同源规则**预检，命中即给出 `rule_id / path / line / column / overridable` 与可粘贴
  的行内标注写法。

- **`archive execute` 把自己的输出写进它即将移走的目录**。结果只走 stdout，而 execute
  会 `shutil.move` 整个 change 目录再删原目录。当时 agent 三次重定向（`/tmp`、`/e/tmp`
  均 FileNotFoundError）后写进 change-dir，文件随目录蒸发，`archive-out3.json` 变成损坏
  文件，`steps` 永久丢失，随后 8 次调用都在考古 `managed_snapshot_push` 跑没跑。现在结果
  自动落在 `<archiveDir>/meta/archive-execute-result.json`；新增 `--output`，指向
  change-dir 内部时**当场拒绝**并给出可用位置。

- **合并到 master 的 verify 是一道空门**。profile 没有 `mergeVerification` 就是空计划 →
  `VERIFY_PLAN_MISSING`，错误不说 `--command` 是 append 型、按 argv 直跑（无 shell，
  `&&` 不成立）。agent 读了六处源码，最后随手传一条 `node <单个测试文件>` 就
  `verify=DONE`——即合并到 master 的"验证"实际只跑了 1 个测试文件，journal 里连跑了
  什么都没记录。真正的 87/87 是 agent 自己在 worktree 里手工补跑的，完全在事务之外。
  现在缺声明时从 profile 既有验证目标推导计划；journal 记录 plan/来源/退出码/耗时；
  单条非 profile 命令标 `verificationDepth: "thin"`；错误带完整 `recoveryAction`。

- **`PUSH_PULL_CLI_OUTPUT_INVALID` 把约 20 个不变量压成一个无字段信息的码**，
  `project_id: null`，dry-run 同败——`--scope branch_files` 因此完全无法定位，归档的
  plan/spec/report 没能上平台。根因已找到并写成回归测试：`.harness/rules/*.md` 这类
  路径**已归属别的 sync scope**，用 `content_kind=branch_file` 提交时 schema 判否，
  整个 preview 被丢弃。新增 `explainPushPullPreviewOutput`，直接点名
  `operations[1] path=… content_kind=branch_file，但该路径归类为 rule`。

### Added

- `harness_fixback.py evidence-template`：从托管会话/审查 sidecar 直接生成**可直接注册**
  的证据 JSON。此前 schema 只存在于 Python 源码里，每条证据都得手写，再靠
  `FIXBACK_*_PROVENANCE_INVALID` 反推缺哪个字段（`sessionId`/`commandHash`/`resultDigest`
  三个字段本来就能从 `session.json` 直接读出来）。对照组是 ledger 的
  `scenario-receipt-template`——它一次就能给对。
- `hunter-harness scan-sensitive`：用发布同款规则扫指定文件，供归档预检与人工复查。
- `harness_runtime.py sweep-scratch`：白名单清理 `runtime/` 顶层过程草稿（diff、临时输入、
  命令输出重定向），证据/报告/运行态一律不碰；`gate close` 自动调用并在 `scratchSwept` 回显。
- `harness_review.py write-findings/write-dispositions --stdin`：免落临时输入文件。
- `--product-identity` 现在可省略（自动推导当前 HEAD 并在 `resolvedProductIdentity` 回显）。
  此前它在 5 个子命令里必填却在全仓 `.md` 中**零命中**，只能 grep 源码猜。

### Docs

- `harness-run/protocols.md` 新增「fixback 证据契约」：命令链、别手写证据 JSON、
  `--product-identity` 取值、RED 必须在修复之前、close 两张收据与
  **不要清空 review-findings.json**。
- `harness-archive/SKILL.md` 新增「发布内容预检与服务端 422」：预检读法、
  `overridable` 与 high 的不同出路、行内标注写法。

### 平台侧（本仓库无法验证）

行内标注 `hunter-harness-ignore: <RULE_ID> reason=<...>` 在**本地**扫描器上确认生效
（finding 转 `overridden`，`blocked=false`）。归档上传端点只收裸 ZIP，没有独立的豁免申报
通道（对比 skills draft 端点有 `SensitiveReviewSubmission`），因此发版时把"服务端是否认
这条标注"标为待验证。

> **发版后已验证**：平台归档入口跑的是同一个 `scanSensitiveFiles`，直接从文件内容解析
> `hunter-harness-ignore`——标注**服务端确实生效**。同时发现两侧扫描器已漂移、却都自称
> `scanner_version 1.1.0`：不带凭据的连接串本地判 `low`/可豁免、平台判 `high`/不可豁免，
> 本次新增的预检在这一条上会主动误导。平台侧修复已提交（hunter-platform
> `fix(archive): 归档 422 给出可执行出路，并收回与客户端漂移的扫描判定`），部署后两侧一致。
> SKILL.md 已按此更正。

`branch_files` 只做到「可诊断」：正确修法是让 branch-file 收集器跳过已属其他 scope 的
路径（`.harness/rules/*` 本来就由 `--scope rules` 推送，放进 branch_files 是重复计数），
属 sync 路径的行为变更，未在本次改动。

### 验证

lint 干净；`tsc -b` 干净；vitest 157 文件 / 2157 用例全过；Python safe profile 61/61 模块、
system profile 2/2 模块全过。归档预检经真实 CLI 端到端验证：命中时报
`PUBLICATION_CONTENT_SCAN_FLAGGED` 并定位到 `plans/demo-design.md:3:29 HH_INTERNAL_ADDRESS`，
加行内标注后转 `PUBLICATION_CONTENT_SCAN_CLEAN`。

## [0.2.83] — @hunter-harness/workflow-harness（Bundle 0.2.72）

> **Bundle 单发**：本次只改 harness 脚本与 skill 文档，CLI 代码未动，仍是 `0.2.89`，
> `minimumCliVersion` 保持 `0.2.89`。

### Fixed（一次 5 小时 run 里，约 2 小时耗在 harness 自己身上）

一次真实的 `/harness-run`（rule-model-consolidation，14:19→19:28，453 次工具调用）。
三处摩擦的解法 harness 内部其实都已经有，只是没有接到调用方。

- **构建裸跑导致 43 个并发 Maven 互相摧毁**：`harness-run/SKILL.md` 从未提过
  `harness_test_runner.py exec`，模型只能用 `powershell.exe` 直接跑 `mvn`；宿主 120 秒超时把
  命令推入后台，50 次 mvn 里 **43 次成了后台任务**，多个 Maven JVM 同时写同一个 `target/`。
  代价：21 次文件占用冲突、7 次 `target/classes` 被清空、63 处"增量编译抖动"、7 次与测试
  无关的 `BUILD FAILURE`，**同一个全量单测被重跑 9 次**（`fulltest` / `full-test` /
  `fulltest2` … `fulltest5`，命名混乱到分不清哪份日志是最终态，收尾时又反复纠结证据取哪个）。
  而 `exec` 早就带项目级互斥锁并托管进程树，且已随全部 8 个 Bundle 部署到该项目——实测嵌套
  调用返回 `TEST_RUN_ALREADY_ACTIVE`、退出码 3，43 个并发里本该有 42 个在第一时间被挡回。
  SKILL.md 现增「构建/测试执行入口」一节强制走 `exec`（含为什么裸跑会导致并发摧毁），
  硬门禁速查表加一行，`PowerShell` 那行收窄为只管 git。

- **`LEASE_ABSENT` 是个裸错误**：`gate begin` 默认 `--ttl-seconds 3600`，而 run 阶段跑了
  3 小时 45 分。租约 15:41 就过期，全程无提示，直到 18:26 关门才报出来——且没有 `retryable`、
  没有 `recoveryAction`、不回显原 run-id。模型花了约 650 行日志才自己摸出唯一解
  （`harness_change.py claim --run-id <原 id>`）。同一代码库里 `test_runner` 的锁有
  `heartbeat()` 续期，阶段租约却没有任何续期触发点，两套锁设计不对称。现在该错误带
  `retryable`、`resumeRunId`（新增 `_latest_open_run_id()`：取有 `phase.start` 而无
  `phase.end` 的最新 run_id）与完整续租命令，并明确警告**不要重跑 `gate begin`**
  ——那会新开 attempt 并丢失本轮 capsule。SKILL.md 同步增「长阶段租约续期」一节。

- **`LEASE_CONFLICT` 不说持有者是否已关门**：plan 阶段 14:19:36 已写 `phase.end OK`，租约仍在
  （`cmd_close` 有 18 处 early-return 而 `release_lease` 在函数末尾，任何 begin-without-close
  都会留下最长一小时的租约）。冲突方只被告知"被别人持有"，只能翻 `events.ndjson` 再逆向
  `_claim_lease_locked`，才敢判断释放是否安全——又是 20 分钟。现在补 `holderPhaseClosed`：
  持有者已写 `phase.end` 就直接给出释放命令；未关门则明确**不**建议释放，避免误杀仍在执行
  的阶段。

`cmd_close` 失败时不释放租约这一点刻意保留：close 失败本就需要原样重试，此时持有租约是正确
行为；真正的缺陷是冲突方无法判断，已由 `holderPhaseClosed` 覆盖。

## [0.2.89] — hunter-harness ＋ [0.2.82] — @hunter-harness/workflow-harness（Bundle 0.2.71）

### Fixed（0.2.88 的补传在真实项目上仍未闭环）

kb-sdd 的一次真实补传证明 0.2.88 的三个修复都生效了（无需 `--project`、本地判定不上传、
`--no-knowledge-injection` 可用），但也暴露出 0.2.88 建立在两个错误前提上：

- **包 manifest 绑的是 live HEAD，不是归档自己的提交**：`_archive_source_identity` 直接读
  `git rev-parse HEAD`。包描述的是一个**封存**归档，绑 HEAD 意味着仓库每提交一次包 sha 就变，
  "确定性 core-v1 ZIP"在第一次提交后就不成立。实测：manifest.source.commit 是当前 HEAD
  `851fafe6`，而归档自己记的 `finalCommit` 是 `ece2be34`。现改为优先取归档记录的提交，
  归档没记时才回退 HEAD（旧归档行为不变）。
- **`--no-knowledge-injection` 的前提是错的**：它被描述成"重建与已发布包一致的字节"，但重建
  永远做不到——manifest 绑提交、封存目录与 harness 本身都会前进。真正的重试对象是**盘上留存的
  那个包**，而 `auto_push_archive_core` 从来都是重建、从不上传留存的 ZIP —— 代码里 6 处
  "已保留 ZIP 与上传回执，可重试同一个 ZIP"的承诺一直是假的。

### Added

- **`republish --retry-retained`**：上传 `.harness/state/local/archive-packages/<key>.zip`
  的原始字节，不重建；先校验同名 `.upload.json` 记录的 sha 与 ZIP 实际字节一致，不一致就拒绝猜。
  留存包与远端已发布包字节不同时（即那是失败尝试的残留）本地判出
  `ARCHIVE_REMOTE_IMMUTABLE_CONFLICT` 并拒绝上传；**字节相同时放行**——那正是
  `knowledgeStatus: failed` 保留 ZIP 想支持的重试场景，拦掉就把唯一用途拦没了。

### Fixed（CLI）

- **提示语挂在了错误的错误码上**：服务端 `package-ingest.ts` 抛的是
  `ARCHIVE_ALREADY_EXISTS`（409），而 0.2.88 的中文说明只在 `ARCHIVE_PACKAGE_CONFLICT` 时触发
  ——后者是 remote-sync 契约里的拼法，这个端点从不返回。于是那句为该失败写的提示从没出现过。
  现在两个码都认。

### 平台侧（本仓库无法解决）

**已发布归档补不上知识条目，需要平台改。** 服务端对同一 change key 只存一个不可变包
（`ARCHIVE_ALREADY_EXISTS`），而知识条目只从包里的 `candidates/knowledge.json` 产生；
0.2.86 之前上传的包根本没有这个文件。平台已有 `retryKnowledgeExtraction(job_id)`，但它是对
**已存包**重跑提取——包里没有候选，重跑仍然是 0 条。要闭环需要下列之一：
补充候选的增量上传入口、归档版本化（同 change key 接受新版本）、或服务端从 summary-data
自行派生候选。

## [0.2.81] — @hunter-harness/workflow-harness（Bundle 0.2.70）

> **Bundle 单发**：本次只改 harness 脚本与协议文档，CLI 代码未动，仍是 `0.2.88`，
> `minimumCliVersion` 保持 `0.2.88`。0.2.88 与本包都尚未发布到 npm，需一并发布。

### Fixed（plan 阶段卡死的三个根因）

一次真实 plan 执行日志里，收尾阶段用掉约 700 行才把 finalize 做成功。根因不在调用方：

- **协议要求的写法本身会把 finalize 弄死**：`harness_gate.py begin` 已经追加
  `phase.start`（且用 `_phase_event_exists` 自我幂等），而 `shared/logging.md` 紧接着让调用方
  再用 `harness_events.py append --type phase.start` 写一次同 run-id 的——`append` 没有那层守卫。
  结果一是两条 `phase.start` 让 `plan finalize` 死在 `PHASE_START_DUPLICATE`；二是手工那次会先
  触发 auto-seal，把**正在开始的 attempt** 封成 `RECOVERED`，事件日志留下一条假记录。
  现在 `append --type phase.start` 按 `(phase, run-id)` 幂等：重复追加是 no-op 并回
  `skipped: phase-start-already-recorded`；换新 run-id 仍照常开新 attempt、照常 auto-seal 悬空的那次。
  `shared/logging.md` 同步改为「phase.start 归 gate begin，note 在那里给」，并写明
  attempt 是按 phase 全局递增、重试必须新 run-id ＋ 下一个 attempt 两者同换。
- **`PHASE_START_DUPLICATE` 不给出路**：只报"found N matching events"，而它上面几行的
  `PHASE_START_MISSING` 反而给了完整补救步骤。现在补上成因与恢复组合。
- **`LEGACY_BOOTSTRAP_REQUIRED` 不说该跑什么**：`harness_context.py` 的注释里早就自己记过
  「两个错误都不给恢复路径，调用方只能读脚本源码自己拼」，其中一个至今还没给。现在直接给出
  `harness_gate.py begin` 的完整命令。

### Changed（租约：保留互斥，去掉误报）

`close` 不再因租约过期而失败。拆开判定链看：别人抢走租约 → owner 变了 → `CONTEXT_LEASE_MISMATCH`；
抢走并已关闭 → 租约文件没了 → `CONTEXT_LEASE_REQUIRED`。**过期 ＋ owner 未变 = 没有任何人抢过**
（抢占会重写 owner），所以 `CONTEXT_LEASE_EXPIRED` 唯一证明的是"这阶段跑得比 TTL 久"——而 plan/run
跑过 1 小时是常态。那次拦截拦不住任何冲突，只是在活全干完、产物都已落盘之后不让记账。

租约真正的价值在 `_claim_lease`：**未过期**且被他人持有时拒绝（`CONTEXT_LEASE_HELD`），这条一字未动。
过期而 owner 相符时 close 照常写收据，并记 `leaseLapsed`（事实保留，不掩盖）。

### Added

- **`harness_context.py renew`**：只延长 `expiresAt`，不重写 current-context，长阶段可以心跳续租。
  此前 TTL 3600s 在 prepare 时一次性发放、全程无法刷新，唯一能刷上的是 `context prepare` 的副作用——
  那不是设计出来的路径。仅 owner 本人可续租，他人续租返回 `CONTEXT_LEASE_MISMATCH`。

### 已知未处理

同一份日志里有 5 段盲等 Spring 启动的 `sleep`（合计约 10 分钟）。`harness_service.py ensure` 本该
接管，但被 PowerShell 策略挡下（`WinError 5`），fallback 到 `bash + nohup` 后只能猜时长。
改成轮询健康端点是对的方向，但改动面超出本次，单独处理。

## [0.2.88] — hunter-harness ＋ [0.2.80] — @hunter-harness/workflow-harness（Bundle 0.2.69）

> `0.2.87` 已提交并推送 GitHub，但**从未发布到 npm**，因此 registry 上会看到 0.2.86 → 0.2.88
> 的版本跳跃。0.2.87 的全部内容都包含在本版中。

### Fixed（0.2.87 的归档补传在真实项目里仍然失败，本版修根因）

一次 kb-sdd 的真实补传把 0.2.87 的三个缺口一次性暴露出来：

- **项目根被解析成父目录**：`find_project_root` 遍历的是 `p.parents`，**不含目录自身**——它本是给
  change/archive 子目录用的。`republish` 把 cwd 交给它，于是站在项目根里反而跳过项目根一路上爬，
  实测把 `E:/WorkProject/kb-sdd` 解析成 `E:/WorkProject`，命令去找从不存在的归档，用户被迫手加
  `--project`。改用 `resolve_republish_project_root`：显式参数 → 归档自身位置 → cwd 及其祖先
  （**含 cwd**）→ 已部署脚本所在位置。**现在项目根内任意目录直接跑即可。**
- **重建包每次字节都不同**：注入的知识候选带 `created_at=now_iso()`，两次重建必然不同。这既让
  「确定性包」的说法名不副实，也让任何与已存包的比对永远失败。改为从归档自身派生
  （`_archive_created_at`）。
- **明知会被拒绝还要付一次上传**：服务端对同一 change key 只保存**一个不可变包**。0.2.87 直到上传
  完才从服务端拿回拒绝，而 CLI 又把服务端错误码压成笼统的 `ARCHIVE_UPLOAD_FAILED`，真正原因只
  侥幸留在文案里。现在 `republish` 先读 `<key>.remote.json` 在**本地**判定：字节一致 →
  `ARCHIVE_ALREADY_PUBLISHED`（exit 0，不重传）；字节不同 → `ARCHIVE_REMOTE_IMMUTABLE_CONFLICT`
  （exit 1，**不发起上传**），并说明冲突通常来自知识候选注入。
- **`archive upload` 保留服务端错误码**：`ApiError` 的 code 与 HTTP status 进 JSON 输出，
  `ARCHIVE_PACKAGE_CONFLICT` 另附一句中文说明。

### Added

- **`republish --no-knowledge-injection`**：按封存目录原样重建，字节与已存包一致。这是「知识索引
  失败、需要重传同一个包」唯一可走的路——注入候选必然改变字节，此前该场景无解。

### Changed

- 两份 SKILL.md 的命令块**不再用 `<skills-root>` 占位符**，直接写
  `.codebuddy/skills/scripts/harness_archive.py`。`shared/read-protocol.md` 早就记着「三份执行日志
  都猜成 `skills/harness-<phase>/scripts/` 然后报 No such file」，这次是**第四次**——占位符治不好，
  写死路径才治得好。同时写明补传的适用边界与「已发布归档无法从客户端补知识条目」。

### 已知边界（需要平台侧支持）

**已经上传成功的归档拿不到知识条目。** `candidates/knowledge.json` 是 0.2.86 才有的，更早上传的
归档包里没有；而服务端一个 change key 只存一个不可变包，注入候选必然改变字节被拒。客户端至此已
无路可走，需要平台提供**重新索引**或**归档版本化**能力。本版能做的是把这个事实在本地立刻讲清楚，
不再让人多付一次上传和一轮猜测。

## [0.2.87] — hunter-harness ＋ [0.2.79] — @hunter-harness/workflow-harness（Bundle 0.2.68）

> **CLI ＋ Bundle 同发，最低 CLI 版本提到 `0.2.87`**：本 Bundle 的 `harness-push` 与
> `harness-archive` 两份 SKILL.md 按新的敏感扫描策略（默认 `warn`）、新的
> `PUSH_PULL_ARCHIVE_NO_PENDING_CLAIM` 与 `--allow-sensitive` 描述行为。配 0.2.86 会拿到
> 旧的 `PUSH_PULL_SENSITIVE_HARD_BLOCKED` / `PUSH_PULL_ARCHIVE_UNAVAILABLE`，文档与实际
> 对不上。这是降级不是硬失败，但会把人引向错误的排查方向——上一次就是这么丢掉一整批上传的。

### Changed（默认行为变更，升级前请读）

- **敏感内容扫描从"阻断"改为"告警"**：push/pull 与归档两处发布门禁默认 `warn`——命中项照常
  以 `路径:行 规则(严重度)` 打印，但不再拦下上传。用 `HUNTER_HARNESS_SENSITIVE_SCAN` 切换：
  `block` 恢复旧的阻断行为，`off` 完全不扫描（归档侧连整棵变更树的字节读取都一并省掉）。
  归档门禁在非 `block` 模式下把 `SENSITIVE_EVIDENCE_UNQUARANTINED` 等降级为
  `SENSITIVE_EVIDENCE_ADVISORY`，**原始事实原样保留在 `advisory` 字段里**，报告仍然点名每个
  明文文件。改这个默认值的直接原因见下面 `HH_DATABASE_URL` 那条：一个没有出路的 fail-closed
  门禁，最后不是被遵守而是被绕过。

### Fixed

- **不含凭据的连接串被判成 high、且永远无法放行**：`HH_DATABASE_URL` 用
  `\b(?:...|mysql|...)://` 匹配，文档里一句 `jdbc:mysql://host:3312/db` 就命中 high；而
  `overridable = severity !== "high"` 让 high 不可逐条覆盖，CLI 又在任何交互之前就抛
  `PUSH_PULL_SENSITIVE_HARD_BLOCKED`——**完全没有出路**。实测后果：一次归档的 plan/spec/report
  连同项目规则、架构地图整批没能上平台。现按 URL 里有没有 userinfo 判严重度：
  `postgres://user:pass@host/db` 仍是 high，无凭据的连接串降为 low（可覆盖）。
- **敏感阻断只报错误码，不说是哪个文件**：`cliOutput()` 构造 JSON 时把 `security_scan` 整个
  丢掉，`--dry-run --json` 只回一个 `sensitive_confirmation_required`。调用方只能在全仓 grep
  猜文件（实测猜错了：命中的是 `AGENTS.md` 的 JDBC 文档串，不是它以为的明文口令）。现在
  stderr 逐条打印命中位置，JSON 输出也带上 `security_scan.findings`。
- **归档补传无路可走**：上传成功后 ZIP 与回执按设计被删除，旧版本产生的归档从未入 outbox，
  于是 `harness-push --scope archive` 恒定返回 `PUSH_PULL_ARCHIVE_UNAVAILABLE`——读起来像故障，
  实际是"没东西可复用"这个正常状态。新增 `harness_archive.py republish --change <key>`：从已封存的
  `.harness/archive/<key>/` 重建确定性包并上传，`--dry-run` 只列包内容。归档目录是封存的
  （after-manifest 覆盖其每个字节），因此 **不写回归档目录**——缺失的
  `candidates/knowledge.json` 只在内存中按已归档 summary 生成后放进包里，这也是 0.2.86 之前
  归档拿到知识条目的唯一途径。
- **`--scope archive` 的报错换成可执行的出路**：无待发布 claim 时返回
  `PUSH_PULL_ARCHIVE_NO_PENDING_CLAIM`（exit 5）并在 stderr 直接给出 republish 命令；
  `--dry-run` 不再硬失败，改为列出本地可补传的归档目录（仍然不取租约）。
  harness-push SKILL.md 此前只写"outbox"不给路径，调用方去找并不存在的 `.harness/outbox`；
  现在写明 claim 在 `.harness/state/local/archive-outbox/`、ZIP 在 `.../archive-packages/`。
- **知识条目为空无法自证**：`knowledge_status=ready` 只说明服务端处理完了，不代表有条目。
  包里现在带 `knowledgeCandidateCount`，一路进上传回执与归档 operation record，
  "服务端没索引"与"本来就没东西可索引"从此可以分开看。SKILL.md 同时写明
  `--scope all` 把归档文档当 branch_file 上传，**不进**知识管道。

### Performance（归档）

- **少一次全树哈希**：finalize 里 `verify_manifest_byte_coverage` 连着跑两遍，第一遍的结果
  在 20 行内就被第二遍（排除 summary-data.json 的那次）覆盖，只贡献了一次整棵树的重复哈希。
- **`generate_manifest` 与敏感候选扫描不再逐文件 `resolve()`**：两处都在全树循环里对每个文件
  调 `Path.resolve()`（Windows 上每次一个 realpath 系统调用），改为比较相对路径。
- **不再用 `npx` 拉起 CLI**：归档一次要起两个子进程（`archive upload` 与受管快照 push），
  每个都付一次完整 npm 解析。改为先从项目向上找已安装的 `node_modules/hunter-harness/dist/bin.js`
  直接用 node 执行，找不到才回退 npx。
- **`HUNTER_HARNESS_SENSITIVE_SCAN=off`** 顺带省掉归档前对整棵变更树的字节读取。

## [0.2.86] — hunter-harness ＋ [0.2.78] — @hunter-harness/workflow-harness（Bundle 0.2.67）

> **CLI ＋ Bundle 同发，且最低 CLI 版本提到 `0.2.86`**：本 Bundle 的
> `harness_knowledge_candidates.py` 产出带 `entry_type` / `body` / `keywords` 的候选，
> 而 `knowledgeCandidateSchema` 是 `.strict()`——旧 CLI 的 schema 不认识这三个字段，
> 会在 `archive-package-builder` 的候选校验处直接判整个归档包无效。**这是硬失败，不是降级。**

### Added

- **知识候选生成器**（`harness_knowledge_candidates.py`）：补上知识管道一直缺失的入口。
  此前 `knowledge_pipeline_*` 是一套建好但没有输入的子系统——extractor 读
  `archive.knowledge_candidates`，而两个仓库里没有任何代码产出候选（全量搜索 `kc_` 零命中），
  于是提取作业跑完总是 0 候选、`project_knowledge` 恒空。

  只从 `summary-data.json` 的 `reviewFindings` 与 `knownRisks` 生成，映射固定：

  | 来源 | `entry_type` | `confidence` |
  |---|---|---|
  | `disposition = FIXED` | `pitfall` | RED 0.95 / YELLOW 0.85 |
  | `disposition = ACCEPTED_RISK` 或 `DEFERRED` | `risk` | RED 0.95 / YELLOW 0.85 |
  | `knownRisks[]` | `risk` | 0.85 |
  | `severity = OK` 或 `disposition = NOT_APPLICABLE` | 丢弃 | — |

  未裁决的 disposition（`OPEN` / `UNKNOWN`）同样丢弃——没裁决过的发现还不算知识。
  `maintenanceNotes` / `finalStatusReasons` / `manualActions` 经实测评估后排除：
  前者约 1/5 是真决策其余是流程流水，后两者无知识价值或恒空。
  **不涉及 LLM**：每个字段都从真实字段复制或推导，可复现、无发明。

- **`sync --push [scopes]`** 与 **`run-status --wait`**（见 0.2.85 与本次的 Fixed 段）。

### Fixed（修一行 javadoc 耗掉 570 行对话的那次执行）

- **Fixback 证据契约不前置，逼出假 TDD**：`launch-review` 只返回 batch，不说明每个 code 项
  需要"修复前 RED ＋ 修复后 GREEN"的托管会话证据、且需先 `register-evidence`。调用方于是
  先把代码改完，才在 `resolve-issue` 撞上 `FIXBACK_EVIDENCE_MISSING`，再靠 grep 错误码、
  连读三遍实现、打四次 `--help` 拼出契约——而那时代码已改完，只能把修改回退、跑一次假 RED、
  再改回来跑 GREEN。新增 `evidence_contract()` 随 `FIXBACK_STARTED` 一起返回五步顺序、
  四条可直接照抄的命令与证据文件形状，并显式写明"不要先改完再回退来凑 RED"。
- **证据错误码只回显路径**：四个 `FIXBACK_EVIDENCE_*` 统一补上"它要什么、下一步跑什么"。
- **`run-status` 无法判定终态、也无法阻塞等待**：`INCOMPLETE` 是终态却读起来像"还没结束"，
  一个启动即失败（`LAUNCHER_FAILED`、`testProcessStarted=false`）的会话被连等 20s、60s；
  且只能 `Start-Sleep` 猜时长（实测连猜 5s/20s/60s/100s 四轮）。现输出补 `terminal` 布尔值、
  终态附 `terminalHint`，并新增 `--wait` / `--wait-timeout-seconds` / `--poll-seconds`。
  `FINALIZING` 刻意判为非终态——结果已定但 worker 未退出，此时取读数会与清理竞争。
- **8 处 `subprocess` 缺 `encoding`**：`harness_archive`(2) / `check_gate`(1) / `context`(2) /
  `ledger`(2) 及归档核心上传路径。中文 Windows 按 cp936 解码 UTF-8，git 输出与 CLI 回执被
  静默损坏（实测回执里出现 `绫?javadoc 鏈�闅�`）。
- **`powershell-protocol`** 补输出编码一节：`PYTHONUTF8=1` 只管 Python 输出端，
  必须同时设 `[Console]::OutputEncoding`，并说明为何少用 `2>&1`。

### 验证

- 新增 25 个测试（6 run-status ＋ 7 证据契约 ＋ 12 候选生成器）
- `release:preflight` 与 `smoke:pack` 通过；vitest 全过；
  harness Python safe profile 全模块通过（与 vitest 串行执行）

## [0.2.85] — hunter-harness ＋ [0.2.77] — @hunter-harness/workflow-harness（Bundle 0.2.66）

> **CLI ＋ Bundle 同发**。最低 CLI 版本提到 `0.2.85`：本 Bundle 的 `harness-archive/SKILL.md`
> 按收窄后的交付物边界描述，配 `0.2.84` 会多传 `reports/review` 与 `reports/test`，与文档不符。

### Added

- **`sync --push [scopes]`**：`sync` 此前是纯本地元数据体检，要把配置推上平台得另跑一条命令。
  现在体检通过后可顺带推送一次；省略值时推 `config,rules,architecture,instructions`
  （与 `push` 自身省略 `--scope` 时的默认范围一致）。判定抽成纯函数 `planSyncPush`：
  WARN（退出码 5）仍放行——最常见的 WARN 是架构地图略陈旧，卡在这里会让这个选项没法用；
  BLOCKED(7) 与 FAIL(1) 拒推，那说明项目状态本身不可用；`--check` / `--dry-run` 保持纯只读。
  跳过时经 stderr 回显 reasonCode，不静默吞掉。

### Fixed

- **归档交付物边界与归档 ZIP 边界不一致**：`0.2.84` 把 `reports/` 整个目录都算交付物，
  连带把 `review/` 与 `test/` 推上分支文件；而 `harness-knowledge-ingest/SKILL.md` 早已规定
  归档 ZIP 只许含 `reports/final/summary-data.json`、`spec/**`、`plans/**`、`archive-meta.md`、
  `change-context.json`，并明确"测试报告、审查报告……不得进入归档包"。两条通道各说各话。
  现统一：`plans` / `spec` / `docs` 全部，`reports/` 只取 `final/` 的定稿；
  散落在 `reports/` 根下、不在 `final/` 里的文件同样不算。遍历仍放行 `reports/` 本身
  （否则到不了 `final/`），但 `reports/review`、`reports/test` 直接剪枝。

### 验证

- kld-sdd 真实项目 dry-run：**31 → 16 个文件**，正好去掉 review 10 ＋ test 5；
  剩余 16 = plans 11 ＋ spec 2 ＋ reports/final 3，与归档 ZIP 边界严格一致。
- vitest **156 文件 / 2144 测试全过**；两仓库 lint ＋ typecheck 全绿。

## [0.2.84] — hunter-harness ＋ [0.2.76] — @hunter-harness/workflow-harness（Bundle 0.2.65）

> **CLI ＋ Bundle 同发**：本次改动横跨两侧，单发任一侧都不生效。最低 CLI 版本随之提到
> `0.2.84`——Bundle 里的 `harness_archive.py` 用 `harness-push --scope …,branch_files`
> 上传归档交付物，而"交付物算 branch_file"这条分类规则在 CLI 侧，配旧 CLI 会静默上传 0 个文件。

### Fixed（2026-08-18 平台三视图数据流：归档文档与项目资料都收不到内容）

- **归档的 plan/spec/report 永远进不了平台「分支文件」**（`9930707`、`2dcd572`）：
  归档收尾的 `auto_push_managed_snapshot` 一直调 legacy `hunter-harness push`——那是
  proposal 管道，写 `project_files_current`、不产生分支快照，平台两个视图都读不到；
  归档目录下的文档在那条路上还会被 policy-never 全部跳过。这正是 `change_records` 的
  `document_refs` 长期为空的原因。改走 `harness-push`（remote-sync），scope 显式列
  `config,rules,architecture,instructions,branch_files`（不用 `all`，避免含义随其展开定义漂移）。
- **归档树被三道闸串行拦死**（`9930707`）：最先生效的是 `nonScannablePathPrefixes` 里的
  `.harness/archive`——`excludedPathReason` 在任何分类规则之前就把整棵树判为
  `CONTENT_PATH_NON_SCANNABLE_KIND`；其次是 `.harness` 兜底的 `CONTENT_PATH_UNDECLARED`；
  再次是 `branch_file` 分支要求显式 `source_kind` 而工作区遍历没传。现新增
  `isArchiveDeliverableDocument`，只为 `.harness/archive/<change-key>/{plans|spec|reports|docs}/**`
  下的**具体文件**开口，且开口置于 credentials / env / state / runtime / `*.log` 等安全排除**之后**——
  交付物目录里的日志与凭证依然被更早的规则拦下。
- **遍历在归档第一层就被剪枝**（`9930707`）：即便分类放行，`walkFiles` 仍会因目录本身
  non-scannable 而 `continue`，交付物根本走不到分类。新增导出 `mayContainArchiveDeliverables`，
  仅对可能含交付物的归档目录放行下钻。
- **`subprocess.run` 缺 `encoding=` 静默损坏中文输出**（`2dcd572`）：不指定时中文 Windows 按
  cp936 解码 UTF-8，CLI 的中文输出被损坏，并可能让随后的 `json.loads` 失败。

### Changed

- `auto_push_managed_snapshot` 的回执解析改为 `summary.applied`（legacy `push` 用 `submitted`）；
  `unchanged` 改判 `outcome == "no_changes"`——即"仅在有更新时才产生快照"。
- `harness-archive/SKILL.md`：`managed_snapshot_push` 的载荷说明更新为"每个变更目录的
  `plans/`、`spec/`、`reports/`、`docs/`"，并写明走 `harness-push` 而非 legacy `push`、
  哪些过程文件不上传；失败重试命令同步更新。

### 验证

- kld-sdd 真实项目 dry-run：31 个交付物全部判为 `branch_file`，`runtime/`、`meta/`、
  `evidence/`、`logs/`、`fixback/`、`.publication-staging/` 以及 `runtime/staging/plans/**`、
  `.publication-staging/<…>/plans/**` 下的 16 个重复副本全部排除（改动前此处为 0 个文件）。
- vitest 155 文件 / 2137 测试全过；harness Python safe profile 归档相关全过
  （与 vitest 串行执行，避开并行资源争抢造成的假失败）。

## [0.2.75] — @hunter-harness/workflow-harness

> 纯 Bundle 发版：CLI 源码零改动，`hunter-harness` 保持 `0.2.83` 不重发；最低 CLI 版本仍为 `0.2.83`。

### Fixed（2026-08-18 归档阶段的三条死路与两处静默）

- **敏感证据隔离在非系统盘项目上必然失败**（`ce56517`）：`SENSITIVE_EVIDENCE_UNQUARANTINED` 是归档硬阻断，唯一解法是隔离；而默认私有根 `~/.harness/private-evidence` 在 Windows 落 C 盘，项目在别的盘时 `os.replace` 直接 WinError 17 跨盘失败——整条归档路对所有非系统盘项目堵死。新增 `private_evidence_root_for()`：同盘沿用配置/默认值，跨盘退到源所在驱动器的 `.harness-private-evidence`。同时函数自身的校验原本只看 change_root、比归档密钥扫描门禁（按项目根判定）宽，导致"这里过了、门禁再拒"，现已对齐到同一条边界并在错误里点名项目根。
- **隔离没有命令行入口**（`ce56517`）：该必经步骤此前只存在于 `harness_runtime.py` 的内部函数，调用方只能写 `python -c` + `sys.path` hack。新增 `harness_runtime.py quarantine-evidence`（`--file` 可重复，逐条报结果）。
- **`ownership.productPaths` 没有任何写入方**（`ce56517`）：plan 的 `validate_product_ownership` 只校验、缺失时软放行（`PLAN_PRODUCT_PATHS_LEGACY_UNDECLARED`），而归档的 `compute_ownership_diff` 把全部改动判成 `foreignPaths`，`filesChanged=0` 触发 `DIFF_ZERO_WITH_NONEMPTY_COMMIT`。两端口径不一致、中间无工具可补，只能手改契约。新增 `harness_change.py declare-ownership`（规则与 plan 校验一致：只收精确文件或目录前缀，不支持通配）。
- **上传成功后报告不改口**（`d89fcef`）：`summary-data.json` 在归档流程早期以 `ARCHIVED_LOCAL_ONLY` 落盘，ZIP 上传在其后；成功时只改内存 payload、从不回写文件，且把对象覆盖成裸字符串（读 `.status` 取到 undefined）。于是同一次归档"回执 durable / 报告 local-only"，平台与用户读的都是后者。新增 `remote_durable_archive_durability()` 与 `persist_archive_durability()`：保持对象形状、带 `archiveId`/`uploadStatus`/`knowledgeStatus`，并回写 summary（该文件本就排除在归档校验和覆盖外，回写不破坏对账）。
- **受管快照推送失败无迹可查**（`ea00345`）：plan/spec、`.harness/codebase`、`.harness/rules` 全靠这条推送上平台（push 会 walk 每个归档目录的 `spec/` 与 `plans/`）。它是 best-effort，失败只记一句"未能同步到平台…稍后重试"并把 stdout/stderr 整个丢弃——现场就是它挂了（exitCode=1），用户在平台上只看到东西没上去却查不出原因。失败分支改为保留有界诊断（`detail` 取 stderr 末 2048 字符；CLI 输出 JSON 错误信封时提取 `cliCode`）。

### Changed

- `harness-archive/SKILL.md`：结束报告必须**分别**回显 `archive_push` 与 `managed_snapshot_push` 两条上传结果，并说明二者载荷不同、成败无关；硬门禁速查表补上隔离与 ownership 两条阻断的正规出路，明确禁止改 `candidateVerification.requiredValidations` 绕过。
- `shared/read-protocol.md`：写明脚本在 `<skills-root>/scripts/` 共享，不在每个 skill 子目录下——plan、run/test、archive 三份执行日志里都先猜错再靠 Search 找回。

## [0.2.74] — @hunter-harness/workflow-harness

> 纯 Bundle 发版：CLI 源码零改动，`hunter-harness` 保持 `0.2.83` 不重发；最低 CLI 版本仍为 `0.2.83`。CLI 按 `latest` 标签解析数据包，升级 Bundle 无需换 CLI。

### Fixed（2026-08-18 test/submit 阶段两处逼人造假证据的约束）

- **`ledger record` 对 NOT_APPLICABLE 仍强制 `--files`**（`dc002f4`）：门禁 close 要求 `requiredValidations` 每项都有 entry，与"必须有非空文件集"叠加，逼得调用方拿无关文件（执行日志里是两个单元测试文件）给 `apiTest` 凑数，ledger 从此声称该维度的输入是那些文件——工具逼出来的假证据。现在 `--applicability NOT_APPLICABLE` 免 `--files`，改为强制 `--applicability-reason`。
- **`ledger can-reuse` 拒绝复用却不说原因**（`dc002f4`）：紧凑投影只留 `ok/reuse/code`，而原因在 `reason`/`detail` 里被裁掉；profile 未配好那条路径连 `code` 都是空的，调用方只能再跑一次 `--verbose`。现在拒绝复用时保留 `reason`/`executionNeed`/`detail`，允许复用时仍是三键。
- **Java overlay 参考文档 735 处编码损坏**（`dc002f4`）：`harness/overlays/java/harness-run/reference.md` 自 `de4c8aa` 起三字节 UTF-8 序列的第 3 字节被替换成 `0x3f`，随 bundle 部署给 Java 项目的是乱码。按该规则与干净历史版本（`84074ab`）逐字节对齐还原 346 行，余 1 行按上下文人工补 2 字符；`de4c8aa`/`057d104` 的真实内容改动全部保留。

### Added（2026-08-18 给 fail-closed 守卫配正规出路）

- **预存失败豁免**（`8d18970`）：`certify-local` 要求 `unitTestFull=OK`，全量链却卡在与本变更零文件交集的预存失败上，执行者只剩"改 gate-policy 降门禁"或"顺手修范围外的产品 bug"两条路。`knownPreexistingErrors` 早就存在、`preflight record-quirk` 一直在写，却没有任何消费方。现在 `certify-local` 消费它，但只在**声明过且该失败的 ledger 证据里确实出现该签名**时豁免，并把 `{validation, status, pattern, reason}` 写进收据的 `verification.preexistingExemptions` 留痕；证据对不上、或签名短于 8 字符（能匹配一切）的一律照旧阻断，后者还会明确报"签名太宽泛"。
- **`profile detect` 歧义时交出可填骨架**（`8d18970`）：嵌套/多组件仓库返回 `DETECTION_AMBIGUOUS` 时只有一句 "require an explicit profile"，调用方只能反读 `harness_profile.py` 源码去凑 v3 形状（defaultsFingerprint、excludedRoots 默认集、commands/verificationInputs/verificationGraph 的键、requiredCoverage 取值），执行日志里最终手写了 145 行。现在响应带 `profileTemplate` 与 `hint`；骨架**不落盘**——一份占位 profile 看起来"已配好"比没有更糟。
- harness-run / harness-test / harness-submit 文档补全 `prepare`/`begin` 的 `--project`（该缺口在 plan/run/test 三份日志里各出现一次），写明上述两条出路，并明确禁止改 `candidateVerification.requiredValidations` 绕过门禁。

## [0.2.83] — hunter-harness / [0.2.73] — @hunter-harness/workflow-harness

### Fixed（2026-08-18 v2 规划链路的三处断点）

- **`plan evidence-pack --print-template` 输出的骨架必定校验失败**（`9e47281`）：模板与冻结校验器漂移——`evidence_sources` 用 `{kind,ref,note}` 而契约要十键、`tasks` 多 `cluster`/`title` 且缺 `objective`/`affected_paths`、`scenarios` 少 4 个必需键、`worktree_policy` 写了不存在的 `none`；另有只有真跑才暴露的 `run_id`/`change_key` 命名约束、`content_hash` 反全零守卫、`scenarios` 至少 3 条下限。模板重写为可直接通过 evidence-pack 的骨架，并加回归测试冻结"模板不改一个字必须跑通"。skill 此前明令禁止翻 TS 接口与 npx 缓存，等于把调用方推进墙里又堵死唯一出路。
- **evidence-pack 校验失败无定位信息**（`9e47281`）：冻结模块只抛 `PLANNING_EVIDENCE_INVALID` 这类稳定码，调用方唯一出路是反编译 `dist/bin.js` 逐个比对校验器。新增边界前置校验 `PLAN_EVIDENCE_INPUT_INVALID`，带 `field_path` 与 `problems[]`（缺失/多余键、枚举取值、场景数下限、全零哈希）。
- **v2 计划发布后 run 阶段进不去**（`cba771c`）：`plan finalize` 只写 plan-events 与发布 journal，不碰 context 事务存储，于是 `prepare` 必报 `HANDOFF_REQUIRED`、`begin` 必报 `LEGACY_BOOTSTRAP_REQUIRED`，两个错误都不给恢复路径。改为检测到 committed 的 `meta/publication-journals/*.json` 时自动补录 `plan → <phase>` 交接凭证（带 `bootstrapSource`/`bootstrapEvidence` 留痕，可与人工 close 区分）；无该证据仍 fail-closed 且错误里说明该找什么。
- **测试守卫拒绝嵌套包的 test 目录**（`cba771c`）：`_standard_test_path` 只认 `parts[0]` 为 `test`/`tests`，monorepo 与"仓库根 + 同名子包"布局全被 `TEST_PATH_NOT_ALLOWED` 拒，调用方被迫先补 build-profile 才能记一次 stale-test-repair。改为任意层级的 `test`/`tests` 目录段均可；`testing/`、`tests-helper/` 仍不算。
- **`harness_gate.py classify/checkpoint` 不接受 `--project`**（`cba771c`）：其他脚本都把 `--project` 列为必填，只有 gate 例外，按惯例传过来会被 argparse 直接拒。补上并与 CWD 解析同语义（`begin`/`close` 的 `--project` 是执行根语义，未改动）。

### Changed（2026-08-18 规划产物去重与阶段 0 引导合并）

- **v2 路径停止手写 `plans/*.md`**（`9e47281`）：四份 Markdown 由 finalize 派生，手写的会被覆盖；唯一手写产物是 `meta/plan-evidence-input.json`。设计真相源统一为 `plans/<cn>-design.md`，下游回退 `spec/<cn>-design.md` 保 legacy——此前 v2 发布的设计文档没人读、被读的那份不受门禁保护。
- **新增 `harness_context.py bootstrap-plan`**（`9e47281`）：一次完成 doctor + 建 change 骨架 + prepare + capture + classify + 铸 run-id + `phase.start`，重跑复用同一身份；阶段 0 的 5 次子进程降为 1 次。
- **审批包强制展示 `out_of_scope`**（`9e47281`）：只展示"做什么"会让范围误判活到发布之后，代价是整份计划 republish。需求引用外部设计文档章节时，阶段 2 必须确认是否纳入。
- 工作流 Bundle 提升至 `0.2.62`，最低 CLI 版本提升至 `0.2.83`（skills 要求消费 `PLAN_EVIDENCE_INPUT_INVALID` 的结构化诊断）。

### Known Issue

- **v2 派生的 `meta/scenario-manifest.json` 仍喂不了 run/test 门禁**：它是 artifact 包装体，场景只有 `scenario_id/coverage_dimension/execution_level/evidence_requirements/risk_level/task_refs/requirement_refs`，缺门禁判定所需的 `id/priority/requiredEvidenceKind/ownerPhase` 与可执行测试三元。本版**不做**"解包 + 改名"——那会让必需场景算成空集、C9 返回 `NO_LEDGER_REQUIRED_SCENARIOS`，等于对所有 v2 计划静默关掉证据门禁。改为明确返回 `SCENARIO_MANIFEST_V2_UNSUPPORTED` 并列出 `missingFields`。需要 ledger 证据闭环的变更，在 v2 场景契约补齐这些字段前请走 legacy 路径。

## [0.2.82] — hunter-harness

### Fixed（2026-08-18 幻影 durable 索引条目容错）

- **恢复候选对幻影条目容错**（`44c70f5`）：外部清理恢复存储（删事务目录、留 durable 索引）后，bare 启动在恢复菜单的 durable 循环抛 `RECOVERY_NOT_FOUND` 直接崩溃，非交互路径也会选中幻影候选以 BLOCKED 卡住 configure。按"索引近似定位、locateRecovery 完整校验"的分层语义改消费侧容错：菜单与状态视图跳过幻影、自动选择取首个仍可定位条目；显式指定 recoveryId 的报错语义不变。
- Bundle 与 workflow-harness 数据包无变更（保持 `0.2.72` / Bundle `0.2.61`）。

## [0.2.81] — hunter-harness

### Performance（2026-08-18 recovery 索引读路径有界化）

- **`readIndex` 投影复用**（`e5e2e69`）：恢复索引读路径不再逐个打开全部权威条目——写路径每次写入都同步刷新投影，投影覆盖全部条目名时直接复用，仅在投影缺名字（写入者崩溃或并发竞态）时回退全量重建。完整性防线不变：恢复前 `locateRecovery` 仍完整校验 journal 与 mirror。实测 12691 条目下索引读取 ~10s → ~90ms。
- 新增 2 个读路径测试（含"投影不完整必须回退全量读"的崩溃安全网）。
- 测试基建：durable recovery store 与 vitest 临时根隔离（`e5e2e69`、`e9692f5`），CI_ONLY 重型矩阵改为 project 级 exclude 消除 related 传递命中（`6d2d14d`）。
- Bundle 与 workflow-harness 数据包无变更（保持 `0.2.72` / Bundle `0.2.61`）。

## [0.2.80] — hunter-harness / [0.2.72] — @hunter-harness/workflow-harness

### Added（2026-08-17 harness-push/pull 凭据共用与 actor_id 自愈）

- **harness-push/pull 复用 connect 绑定凭据**：RemoteSync 凭据解析改为 env（`HUNTER_REMOTE_SYNC_URL`/`TOKEN`/`ACTOR_ID`）优先、缺失字段逐字段回退 `.harness/credentials.local.yaml`；绑定齐备时不再需要任何环境变量（`d7362d2`）。
- **connect 落盘 actor_id**：key-info 返回的 actor_id 写入绑定文件；重复 connect 按 server+project 保留缓存值（`d7362d2`）。
- **旧绑定 actor_id 自动补全**：url+token 齐备但缺 actor_id 时，push/pull 命令路径懒调 key-info 补全并写回绑定文件（之后不再依赖网络）；env-only 场景仅内存使用、不落盘；补全失败维持 fail closed（`PUSH_PULL_CLI_UNAVAILABLE`）并输出修复提示（`d7362d2`）。
- 工作流 Bundle 提升至 `0.2.61`，最低 CLI 版本 `0.2.80`（harness-push/pull SKILL 前置条件改述凭据回退与自愈行为）。

## [0.2.71] — @hunter-harness/workflow-harness

### Fixed（2026-08-17 存量测试断言收口）

- **java overlay skill 计数断言修正**：base 实际 12 个 + java-only 2 个（`harness-apidoc`/`harness-package`)= 14。`86e897b` 迁移 canonical 工作流源时 README 与 `test_harness_acceptance.py` 断言都写成 12（误以为 base 只有 10 个），长期 fail。
- **`test_harness_multiday_resilience.test_artifact_budget_fails_before_staging_and_blobs_are_reused` 修 mock**：只设 budget 超限、没构造可 archivable 的 change,preflight 就被拦，从未到 budget 门。补 mock `check_status` / `refresh_sensitive_evidence_scan_receipt` / `validate_sensitive_evidence_publication_gate`，让流程直达 budget 断言点；门顺序本身的集成测试由 `test_harness_archive.py` 覆盖。
- `test:harness:safe` 从 29/58 修复到 58/58。
- Bundle 提升至 `0.2.60`,CLI 保持 `0.2.79`（代码无变更）。

## [0.2.79] — hunter-harness / [0.2.70] — @hunter-harness/workflow-harness

### Added（2026-08-17 Plan 发布后修订入口）

- **`hunter-harness plan republish`**：已发布计划的获批修订入口——`--reason` 必填审计留痕、`--run-id` 必须全新、无收据拒绝（首发走 finalize）、内容未变幂等空操作；失败回滚恢复原字节。`PLAN_FINALIZATION_HASH_CONFLICT` / `PLAN_TARGET_CONFLICT` / `PHASE_ALREADY_CLOSED` / `EVENT_ATTEMPT_CONFLICT` / `PHASE_START_MISSING` 错误信息直接给出 republish 命令行（`ba0b472`）。
- **`plan evidence-pack --print-template`**：输出带占位符的完整 v2 输入骨架，agent 不再需要翻 TS 接口猜格式（`ba0b472`）。

### Fixed（2026-08-17 run 门禁分阶段判定 + remote-sync 协议对齐）

- **run 门禁按 ownerPhase 分级**：`_validate_scenario_coverage` 之前不读 ownerPhase，run 关门要求所有 P0/P1 场景都有 receipt——包括需起服务、属 test 阶段的接口场景，形成死锁。改为 run 只要求 ownerPhase 为 plan/run 的场景，test 阶段场景进 deferred 字段、test 关门时强制；未声明 ownerPhase 的老清单沿用旧语义（`64aa2fc`）。
- **remote-sync 协议对齐**（`6cb4f9c`）：
  - snapshot 查询不再携带 `actor_id` / `commit_sha` / `client_id` / `change_key`（服务端 strict 只接受 `expected_revision`，400 被吞成 `REMOTE_UNAVAILABLE`）；
  - snapshot 回包 source 校验收窄到 project/branch/actor；
  - `readBoundedResponseJson` 容忍 `Content-Encoding`（Caddy gzip 使传输字节数 ≠ 解压字节数）；
  - `client_id` 加 `cli_` 前缀（`remoteSyncSourceRefSchema` 要求）；
  - snapshot `manifest_hash` 不匹配降级为 debug 警告（服务端旧格式与 snapshot 端点 files 形状不一致；配套服务端修复见 hunter-platform `880ed52`）；
  - `RemoteSyncError.serverCode` 透传非白名单服务端错误码；
  - 新增 `HUNTER_DEBUG_HTTP=1` 调试开关。
- 工作流 Bundle 提升至 `0.2.59`，最低 CLI 版本 `0.2.79`（bundle 内 harness-plan skill 引用新 CLI 命令）。

## [0.2.78] — hunter-harness / [0.2.69] — @hunter-harness/workflow-harness

### Fixed（2026-08-17 Plan v2 双仓 dogfood 十二项修复 + 门禁版本错配收口）

- **Plan dogfood 全量修复**（详见 `docs/harness-improvement-roadmap/plan-v2-dogfood-findings-2026-08-17.md` 关闭记录）：
  - HP-01 对抗评审收据接入 finalize（缺失 `PLAN_REVIEW_REQUIRED`、篡改 `PLAN_REVIEW_BINDING_FAILED`，均可操作错误）；
  - HP-02 `PlanAttemptEventBundle` 语义拆分（attempt=2 可 finalize，生命周期聚合层仍校验历史完整）；
  - HP-03 高风险 finding ID 稳定哈希派生；HP-04 scope 集合语义统一；HP-05 隐式引用与 validator 共享 canonical comparator；HP-06 detail mode 唯一事实源 = profile.mode；
  - HP-07 `createPlanRunId()` + 边界校验；HP-08 统一结构化错误信封（stage/reason_code/field_path/retryable）；HP-09 finalize 成功向 legacy events.ndjson 幂等投影终态；
  - HP-10 `--change-dir` 真实参与解析；HP-11 边界时间规范化（Z 与 offset 等价）；HP-12 伪 scope_ref 删除 + task↔scenario 引用确定性闭包 + 全量 fan-out 密度警告。
- **run 门禁兼容 v2 收据**：Python `verify_plan` 新增 v2 结构验收（transaction 终态 + journal committed/readback verified + durable targets 字节哈希），0.2.77 v2 finalizer 的 Plan 不再被旧门禁误判 `RECEIPT_MISSING`。
- **平台修复**：项目绑定 API key 可访问无 `:projectId` 路径的项目路由（`projects:resolve`），resolve 结果强制等于 key 绑定项目（hunter-platform `102bdd4`）。
- **archives:ingest 服务端路由落地**（hunter-platform `11620a5`）：06B-3 canonical 发布缝，契约测试 5/5。
- 工作流 Bundle 提升至 `0.2.58`，最低 CLI 版本 `0.2.78`。

## [0.2.77] — hunter-harness / [0.2.68] — @hunter-harness/workflow-harness

### Added（2026-08-16 03 收尾：Push/Pull skill 层补齐）

- **新增 `harness-push` / `harness-pull` skill**：03 承诺的用户侧交互入口落地——意图理解 → 预览展示（分支/提交/远端基线/变化文件）→ 确认收集 → 调 CLI 命令；归档显式 `--scope archive --change`；无变化不上传；本地修改保护与删除恢复绑定 preview hash；未配置 RemoteSync 时 fail closed。
- 工作流 Bundle 提升至 `0.2.57`，最低 CLI 版本 `0.2.77`。

## [0.2.76] — hunter-harness / [0.2.67] — @hunter-harness/workflow-harness

### Added / Fixed（2026-08-16 Plan v2 结构化证据链全链路贯通）

- **Plan v2 发布链路落地**：`hunter-harness plan evidence-pack`（规划自然产出 → 结构化证据包）+ `hunter-harness plan finalize`（三层质量门 → 原子发布八 target → 事件 outbox）两条 CLI 命令；harness-plan 阶段 8 改为 v2 三步流契约，legacy 路径收窄为回退。
- **durable 发布边界修正**：durable-publication snapshot 上限对齐发布载荷边界（2MB/payload），真实尺寸规划文档不再被误拒；quality verifier 证明哈希语义与事务层校验对齐。
- **事件上传闭环**：Python sync 新增 TS PlanEvent 流上报（meta/plan-events.ndjson → 平台 RunStore），独立 ACK 游标与 producer_seq 避让。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.56`，最低 CLI 版本提升至 `0.2.76`。

## [0.2.75] — hunter-harness / [0.2.66] — @hunter-harness/workflow-harness

### Added / Fixed（2026-08-16 远端同步生产闭环）

- **Remote Sync 合同与持久收据**：补齐 lease、push、pull 的严格身份绑定、幂等重放、异常响应 fail-closed 与受界资源校验。
- **事务化 Pull**：使用 Core durable transaction 执行工作区变更，支持恢复、漂移检测、陈旧文件删除和准确的 applied 收据。
- **跨仓契约同步**：Harness 与 Platform 的 Remote Sync/Content Upload/OpenAPI 产物保持字节级一致。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.55`，最低 CLI 版本提升至 `0.2.75`。

## [0.2.74] — hunter-harness / [0.2.65] — @hunter-harness/workflow-harness

### Fixed（2026-08-12 全流程归档、知识分类与平台展示收敛）

- **归档与知识入库**：归档阶段生成确定性 ZIP 并自动上传；服务端负责解包与语义索引，客户端知识入库只查询状态或重试既有包，上传失败时保留 ZIP 和耐久回执。
- **知识边界**：只有显式知识条目进入项目知识；设计、计划与归档资料归入变更历史，Codebase Map 作为项目架构独立展示。
- **受管内容同步**：规则与 Codebase Map 在生成、应用或归档后自动同步；内容未变化时直接短路，避免重复网络传输。
- **阶段交接**：统一 worktree、executionRoot、skillsRoot 与 diffHash 身份推断，修复重复执行、门禁补救和归档后阶段仍计时的问题。
- **平台可读性**：新增项目架构与变更历史查询，归档总结改为中文结构化内容，并修复终态监控投影。
- **快速发布门禁**：为推送、同步、指令审计与事务恢复建立显式聚焦测试映射，避免 `vitest related` 将小范围修改扩散成数十个重复测试文件；完整矩阵继续由 CI 承担。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.54`，最低 CLI 版本提升至 `0.2.74`。

## [0.2.73] — hunter-harness / [0.2.64] — @hunter-harness/workflow-harness

### Fixed（2026-08-11 远端知识查询入口收敛）

- **唯一查询入口**：Plan 阶段直接执行 `npx hunter-harness knowledge query "<用户需求原文>" --limit 10 --json`，不再扫描技能目录或猜测不存在的 `harness_knowledge.py`。
- **失败边界明确**：远端查询失败只记录问题并继续，不建立本地索引，也不切换到其他查询入口。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.53`，最低 CLI 版本提升至 `0.2.73`。

## [0.2.72] — hunter-harness / [0.2.63] — @hunter-harness/workflow-harness

### Fixed（2026-08-11 同步状态、Agent 指令入口与中文后续动作修订）

- **同步不再形成运行历史**：`sync` 不写持久同步报告、change 生命周期事件或监控上传；组件详情只在本次命令输出中返回，旧同步收据也不再充当永久 Git 增量基线。
- **按 Agent 校验指令入口**：始终检查共享 `AGENTS.md`，仅在启用 Claude Code 时要求 `CLAUDE.md`，仅在启用 CodeBuddy 时要求 `CODEBUDDY.md`。
- **CodeGraph 状态降噪**：本地索引存在、无待同步源码但 watcher 无法验证时返回建议状态；只有存在 pending、服务不可达或 watcher 已停用时才返回警告。
- **中文勾选式后续动作**：交互式同步固定使用多选复选框，并说明 Codebase Map 的生成内容、指令审计的用途和是否会修改项目文件；建议命令统一使用 `npx hunter-harness ...`。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.52`，最低 CLI 版本提升至 `0.2.72`。

## [0.1.4] — @hunter-harness/skills

### Changed（2026-08-11 Skill CLI 包名统一）

- **统一安装入口**：Skill 安装与上传命令改为 `npx @hunter-harness/skills ...`，与产品中的 Skills 命名保持一致。
- **可执行文件兼容**：新增规范 `skills` bin，并保留 `hunter-harness-skill` 旧 bin，已有全局脚本无需立即改写。

## [0.1.3] — @hunter-harness/skill-cli

### Security（2026-08-11 生产依赖漏洞修复）

- **ZIP 处理依赖**：将 `adm-zip` 提升至 `0.6.0`，修复生产依赖审计中的高危漏洞。
- **传递依赖锁定**：在保持 `Node >=22.12.0` 兼容范围的前提下，将 `brace-expansion`、`ip-address`、`tar` 与 `undici` 锁定到安全版本；生产依赖审计归零。
- **回归门禁**：新增依赖安全下限测试，后续锁文件更新若重新引入已知漏洞版本会直接失败。

## [0.2.66] — hunter-harness / [0.2.60] — @hunter-harness/workflow-harness

### Fixed（2026-08-10 阶段归属、归档上传与平台展示修订）

- **编码阶段归属**：编码结果只评估 `ownerPhase=run` 的任务和场景；计划交给测试阶段的内容显示为「待测试阶段执行」，不再把已经完成的编码误标为警告。
- **归档身份与证据**：归档只接受 Git 可验证的完整提交身份，避免符号 `HEAD` 或操作编号导致 `filesChanged=0`；未声明数据库能力的项目将数据库兼容性标记为 `NOT_APPLICABLE`。
- **归档准备与耗时**：报告充分性检查失败改为独立准备事件，不再增加归档执行次数；平台兼容旧事件并合并伪归档记录，小于 1 秒的阶段显示为 `<1s`。
- **Windows ZIP 上传**：通过 Node.js 启动 `npx-cli.js`，避免直接执行 `npx.CMD` 触发 `WinError 2`；上传前对 JSON 中的本机绝对路径做脱敏，不修改本地归档原件。
- **结构化归档**：移除 `final-summary.html` 与 HTML 渲染器。未来归档只生成 `summary-data.json` 和确定性核心 ZIP，由 Hunter Platform 展示；受控刷新会删除未修改的官方旧渲染器，并保留用户改过的同名文件。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.49`，最低 CLI 版本提升至 `0.2.66`。

## [0.2.65] — hunter-harness / [0.2.59] — @hunter-harness/workflow-harness

### Changed（2026-08-09 本地 Agent 目录忽略策略简化）

- **顶层目录忽略**：初始化与刷新直接忽略 `.claude`、`.agents`、`.cursor`、`.codebuddy` 四个本地 Agent 工作目录，不再逐项生成 Harness 文件规则。
- **自动迁移旧规则**：刷新时移除旧的 `generated-projections` 文件清单，保持 `.gitignore` 简短且可重复执行；已被 Git 跟踪的投影文件仍会给出安全迁移提示。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.48`，最低 CLI 版本提升至 `0.2.65`。

## [0.2.64] — hunter-harness / [0.2.58] — @hunter-harness/workflow-harness

### Fixed（2026-08-09 验证复用、评审回流与监控阶段准备修订）

- **验证身份闭环**：项目技术栈变化后自动刷新 build profile；`record` 与 `can-reuse` 从同一 target 推导范围、覆盖级别、规范命令与输入闭包，并明确区分首次执行、证据失效、记录不完整和可复用。
- **Windows 命令解析**：safe runner 在不启用 shell 的前提下按 `PATH/PATHEXT` 解析 `.cmd` 与 `.exe`，支持含空格路径；启动失败返回结构化中文错误。
- **评审事实与修复动作**：Review 事件强制使用稳定的委派/回退字段；发现项必须区分代码修复、人工验收与流程建议，关门前校验发现和处置 sidecar 属于同一轮评审。
- **单命令 Fixback**：新增评审修复高层入口，先筛选真正需要改代码的项目，再完成分支重选、上下文确认、门禁和已填充批次创建；无代码项不写状态，启动失败撤销未开始的目标上下文。
- **准备状态可观测**：Fixback 上报独立的准备开始、准备结束和启动受阻事件；准备耗时不再计入产品编码轮次，平台可显示“正在准备修复”“修复未启动”和受阻次数。
- **工作区降噪**：Harness 投影与安装状态归入工具维护，不污染产品测试结论；对已经被 Git 跟踪的生成文件提供一次性安全迁移提示。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.47`，最低 CLI 版本提升至 `0.2.64`。

## [0.2.63] — hunter-harness / [0.2.57] — @hunter-harness/workflow-harness

### Fixed（2026-08-09 Windows 后台同步终端弹窗修订）

- **绕过虚拟环境跳转器**：Windows 后台事件同步优先直接启动基础运行时的 `pythonw.exe`；缺少该文件时，使用基础 `python.exe` 配合无窗口创建标志。不会再经由 Hermes/uv 虚拟环境的转发程序二次启动控制台解释器。
- **进程链回归**：新增基础解释器与 venv 转发器并存、基础 `pythonw.exe` 缺失两类测试，防止再次退回 `pythonw.exe → python.exe → Windows Terminal` 链路。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.46`，最低 CLI 版本提升至 `0.2.63`。

## [0.2.62] — hunter-harness / [0.2.56] — @hunter-harness/workflow-harness

### Fixed（2026-08-09 阶段编排、归档结局与监控可读性修订）

- **按计划推进阶段**：Plan 持久化本次实际阶段清单；Run、Test、Review、Submit 与 Archive 只消费该计划。快速流程默认支持 `plan → run → archive`，不再把 Test、Review、Submit、Merge 或打包当作固定下一步。
- **Fixback 与验证复用**：同一 Fixback 幂等恢复已有批次、运行和轮次，只失效受影响的验证；账本命令、Profile 输入和项目根身份统一规范化，避免安全回退被误判为配置漂移后重复全量测试。
- **门禁恢复可见**：所有权范围在 Plan 阶段拒绝通配和明显遗漏；跨阶段门禁以原子方式记录失败原因、恢复动作和尝试次数，避免关门时再手工修补路径、散列或 Profile。
- **归档与发布解耦**：无 Git、无 upstream、跳过 Submit 或仅本地提交均可完成事实归档；支持正常完成、主动废弃、被其他方案替代和发布候选四类结局，并继续生成确定性核心 ZIP 及远端上传回执。
- **评审优先隔离执行**：Review 优先使用独立 reviewer；不可用、启动失败或结果无效时才回退主会话，并结构化记录中文可读原因。
- **Windows 静默同步**：后台事件上传改用无窗口 Python 运行时，不再短暂弹出终端。
- **监控语义增强**：事件携带实际阶段计划、轮次、下一步、结局、耗时和文件类别；Platform 可区分产品文件与流程证据，并将内部英文码保留在技术详情而非主摘要。
- **发布版本绑定**：工作流 Bundle 提升至 `0.2.45`，最低 CLI 版本提升至 `0.2.62`。

## [0.2.61] — hunter-harness

### Fixed（2026-08-09 发布包脚本定位修订）

- **事件同步可执行**：`events-sync` 现在能从公开 workflow 包的 Bundle 目录解析同步脚本，不再只在源码仓库布局下可用。

## [0.2.60] — hunter-harness / [0.2.55] — @hunter-harness/workflow-harness

### Fixed（2026-08-09 阶段收尾与实时监控修订）

- **单命令阶段收尾**：`harness_gate.py close` 可同时完成 test guard、阶段结束事件、租约释放、上下文交接与远端补传；中途失败可用原命令幂等续跑。
- **收据路径兼容**：阶段交接统一接受绝对路径、项目相对路径和 change 相对路径；歧义、越界与链接逃逸会给出明确错误。
- **结束事件及时上报**：gate 写入事件后立即唤醒后台同步，并在关门返回前执行一次有界补传，避免任务结束后页面仍显示执行中。
- **发布版本绑定**：工作流包版本写入 family 清单并由测试校验；Bundle 提升至 `0.2.44`，最低 CLI 版本提升至 `0.2.60`。
- **监控文案降噪**：运行摘要不再把 SHA-256 当正文展示，机器值保留在可展开的技术详情中。

## [0.2.59] — hunter-harness / [0.2.54] — @hunter-harness/workflow-harness

### Fixed（2026-08-09 运行监控与归档恢复修订）

- **运行状态与阶段轮次**：阶段开始、结束和修复回流使用明确轮次；已结束阶段不再显示为进行中，重复执行会保留次数、耗时和待重新验证状态。
- **稳定的实时刷新**：事件流结束后自动切换为轮询并重连；页面定时核对事件游标，手动刷新会同时更新运行记录和事件时间线。
- **阶段级上报状态**：活动阶段持续发送心跳；等待下一阶段和流程结束使用中性状态，避免将正常静默工作误报为离线。
- **归档自动上传**：支持 HTTPS 与本机回环 HTTP 地址；归档完成后自动上传核心 ZIP。失败时保留 ZIP 和回执，主菜单可查看并重试待上传归档。
- **跨阶段自动协调**：build profile 变化时，test guard 在当前阶段更新基线并保留既有测试来源；产品路径支持尾部 `/**`，未声明数据库能力的项目生成类型化「不适用」证据。
- **独立评审优先**：Review 优先使用隔离 reviewer，并记录委派或回退原因；平台时间线展示执行方式。
- **工作流 Bundle**：内容版本提升至 `0.2.43`，最低 CLI 版本提升至 `0.2.59`。

## [0.2.57] — hunter-harness / [0.2.53] — @hunter-harness/workflow-harness

### Fixed（2026-08-09 本地文件降噪与平台联调修订）

- **完整忽略 Harness 投影**：初始化与刷新除忽略 `.harness`、`.worktrees` 和 `harness-*` 目录外，还会根据已安装清单精确忽略共享脚本、协议、契约等 Harness 生成文件，并忽略这些脚本运行时产生的 `__pycache__`；不会扩大为忽略整个 Agent 配置目录。
- **保留用户 Git 语义**：已跟踪文件不会被自动移出索引，用户的反向忽略规则继续优先；卸载工具后会移除对应的自动生成忽略项，避免长期隐藏同路径下的用户文件。
- **项目连接与终端状态**：交互首页显示 CLI 版本和项目名称，按真实终端宽度处理中文与 emoji；连接输出统一过滤终端控制字符。
- **运行监控自动上报**：每次写入变更事件后自动触发有界后台同步，补齐并发锁、游标恢复、拒绝事件隔离及服务端时间状态判定。
- **远端知识查询**：项目密钥新增 `knowledge:read` 权限，CLI 查询固定使用项目级远端语义接口，不启用本地索引或离线回退。

## [0.2.53] — hunter-harness / [0.2.51] — @hunter-harness/workflow-harness

### Changed（2026-08-08 归档、知识与指令职责服务端化）

- **确定性 core-v1 归档包**：archive finalize 生成带 manifest 与 SHA-256 的单一 ZIP，只包含最终摘要、spec、plans、archive-meta 和 change-context；新增 `archive upload` 上传并等待远端耐久/知识状态。
- **知识服务端权威**：归档上传后由 Hunter Platform 安全解包、重建知识索引；`knowledge query` 改为纯远端查询，移除当前发行包中的本地 SQLite、entries、context-pack 和离线 fallback。
- **指令提案工作流**：新增 `instructions audit/apply`，结合项目类型、codebase map 与近期 change 总结生成默认中文、无 marker、带 base hash 的审阅提案；规则候选永不自动应用。
- **消费仓降噪**：初始化、refresh、sync 不再向 AGENTS/CLAUDE 文档注入 Hunter marker，也不再生成或要求消费仓 `.gitattributes`。
- **工作流 bundle**：版本提升至 `0.2.39`，最低 CLI 版本提升至 `0.2.53`。

## [0.2.52] — hunter-harness / [0.2.50] — @hunter-harness/workflow-harness

### Added（2026-08-08 平台缺口 CLI 侧 C1–C4）

- **归档可选辅助档随 push**：除核心四件套外，`reports/review/*`、`reports/test/*`、`meta/archive-meta.md`、`meta/change-context.json` 一并上传（仍不传 evidence/events/logs 等诊断类）。
- **project_id 漂移防护**：`connect` 改绑需 `--rebind`（或交互确认）；`push` 新建项目需确认 / 非交互 `--yes`。
- **change 生命周期钩子**：gate begin 启动 `events-sync`；archive finalize 后终态上报（best-effort，失败不阻断）。
- **技能文档对齐**：knowledge ingest/query 标明远程优先与离线回退；run/archive 注明自动上报钩子。
- **工作流 bundle**：版本提升至 `0.2.38`，最低 CLI 版本提升至 `0.2.52`。

## [0.2.51] — hunter-harness / [0.2.49] — @hunter-harness/workflow-harness

### Changed（2026-08-07 已初始化项目交互主菜单）

- **主菜单重构**：健康已初始化项目不再先走「配置项目 / 回滚 / 清理」五选一；默认进入带状态框的主菜单。
- **一键刷新**：直接按已安装工具与配置刷新，无需重选 Agent / 通用|Java。
- **管理工具**：保留新增/换配置；新增移除一个或多个工具（至少保留一个）；核心 `refreshProject` 支持 `removeAgents`。
- **平台连接**：主菜单内绑定/重绑/清除地址与密钥（未配置可跳过）。
- **中文文案**：交互界面统一用「通用」等中文标签，不再混用 `general`。
- **事务与恢复**：回滚/清理/查看事务收入子菜单；未完成事务仍优先拦截恢复。
- **工作流 bundle**：最低 CLI 版本提升至 `0.2.51`（bundle 内容版本仍为 `0.2.37`）。

## [0.2.50] — hunter-harness / [0.2.48] — @hunter-harness/workflow-harness

### Changed（2026-08-07 门禁默认 lenient + 文档对齐）

- **门禁默认 `lenient`**：`gate_severity_mode` 在无 env / `gate-policy.json` 时默认 `"lenient"`；可再生 soft site（plan-handoff / capsule / scenario-coverage / test-guard）失败记 WARN 收据而不阻断阶段。发布阶段（submit/merge/archive/release/deploy）与 3 类硬不变量仍 fail-closed；可用 `HUNTER_HARNESS_GATE_MODE` 或 `severityMode` 强制 `strict`。
- **文档对齐**：README 生命周期 skill 标为手动触发；archive SKILL / README 明确 `final-summary.html` 可选，支持 `finalize --no-html`。
- **工作流 bundle**：版本提升至 `0.2.37`，最低 CLI 版本提升至 `0.2.50`。

## [0.2.49] — hunter-harness / [0.2.47] — @hunter-harness/workflow-harness

### Added（2026-08-06 Harness/Platform 协同优化 P1–P5）

- **阶段边界更清晰**：生命周期 skill 改为手动触发；单阶段结束后停止，不再自动接续 archive；门禁仅对 3 类硬不变量 fail-closed，并用 `doctor --fix` 重建可再生状态。
- **过程产物按需**：execution-log / 阶段报告按需渲染；归档不再强制 final-summary HTML。
- **平台连接**：新增 `hunter-harness connect`，支持账号 session 与项目级 scoped API Key。
- **远端知识模式**：已绑定凭证与 project_id 时，知识写入走服务端 ingest，跳过本地 sqlite/outbox。
- **Run 进度同步**：新增 `events-sync` 与 `harness_events_sync.py`，将 `events.ndjson` 批量上报 Platform；归档 finalize 后自动 push 核心四件套（设计/计划/summary-data/knowledge）。
- **Headless 契约**：补齐阶段命令 JSON envelope，并新增编排基础设计文档（不实现 orchestrator）。
- **工作流 bundle**：版本提升至 `0.2.36`，最低 CLI 版本提升至 `0.2.49`；CLI 能力增加 `progress-sync@1`、`headless-stage@1`。

## [0.2.48] — hunter-harness / [0.2.46] — @hunter-harness/workflow-harness

### Fixed（2026-08-04 初始化 partial-state 误判）

- **初始化 cache 自污染修复**：workflow 资源解析在项目状态检测前生成的 `.harness/cache` 不再被当作成熟 Harness 证据；空项目和 cache-only 项目可以继续初始化。
- **安全边界保持**：archive、changes、project-local knowledge、恢复事务、adapter build marker 和 managed instruction marker 仍然在缺少 `project.yaml` 时失败关闭。
- **工作流 bundle**：版本提升至 `0.2.35`，最低 CLI 版本提升至 `0.2.48`。

## [0.2.47] — hunter-harness / [0.2.45] — @hunter-harness/workflow-harness

### Fixed（2026-08-02 归档敏感证据收据一致性）

- **可重试的敏感证据收据**：归档 finalize 在源树和隔离暂存树各执行一次即时重扫与摘要刷新；失败事件追加、`events.ndjson.lock` 排除不再造成确定性摘要漂移。
- **隔离审计保持**：刷新保留既有 quarantine entries、private path、原始摘要与 ACL 元数据；损坏收据或后来出现的明文敏感候选继续失败关闭。
- **真实消费回归**：新增 runtime 与 archive 集成场景，覆盖多次刷新、非法收据、明文重现和带 lock 的 record-only finalize。
- **工作流 bundle**：版本提升至 `0.2.34`，最低 CLI 版本提升至 `0.2.47`。

## [0.2.46] — hunter-harness / [0.2.44] — @hunter-harness/workflow-harness

### Fixed（2026-08-01 托管执行与环境验证编排）

- **托管执行与服务身份**：新增运行会话、进程身份、服务会话与退休收据契约；Windows 进程树、端口和服务所有权均按可核验身份治理。
- **受保护的 CLI 运行闭环**：默认运行、服务模式、恢复/继续与配置刷新共享安全前置条件，缺少或漂移的执行证据会失败关闭。
- **环境与验证编排**：验证任务按资源锁分 wave 调度，支持环境会话复用/重置、执行回执、失败分类与候选身份一致性校验。
- **Windows 发布门禁**：恢复边界拒绝恢复根自身与内部组件的链接，同时以 canonical `realRoot` 隔离父级 junction；契约测试覆盖 runner 路径别名，并对被终止子进程的 cwd 句柄释放执行有界清理重试。
- **工作流 bundle**：版本提升至 `0.2.33`，最低 CLI 版本提升至 `0.2.46`。

## [0.2.45] — hunter-harness / [0.2.43] — @hunter-harness/workflow-harness

### Fixed（2026-07-31 CBM Forge 生产数据 Harness 执行效率复盘修复）

- **可重连运行会话**：长时命令具备独立 session、心跳、日志游标、超时/取消和 Windows Job Object；launcher、测试失败、超时与失联使用不同 terminal 状态和原因码。
- **安全验证调度**：验证 DAG 按资源锁分 wave，未分类重任务默认串行；复用/跳过带稳定原因与解释，冻结候选身份漂移立即阻断。
- **环境会话双模式**：支持 change-session 内容指纹复用与 ephemeral 每次重置；prepare/reuse/reset/cleanup 自动写脱敏回执，跨 change writable volume 继续 fail closed。
- **Fixback 合批**：相关审查/测试问题可在同一批次完成 RED→GREEN，只触发一次 affected verification 与一次 review；开放问题或缺证据阻断 freeze，安全问题自动扩展门禁。
- **效率事实报告**：归档自动汇总墙钟、活动执行、资源等待、失败分类、环境动作、重复命令与 wrapper；历史不足时不生成 ETA。
- **可恢复 CLI**：裸命令根据 absent/valid 状态自动 init 或 refresh；新增只读 `status` 及按 recovery ID 精确执行的 `recover` / `resume`，避免误回滚其他事务。
- **事务 journal v3**：记录恢复 ID、计划/快照哈希、产品/CLI/Bundle/ownership 身份、已完成/待执行操作、原因码与安全动作。
- workflow bundle 提升至 `0.2.32`，最低 CLI 版本提升至 `0.2.45`。

## [0.2.44] — hunter-harness / [0.2.42] — @hunter-harness/workflow-harness

### Fixed（2026-07-31 Lark Channel Bridge Sync / Knowledge 复盘修复）

- **可信 CodeGraph 状态**：`sync` 优先读取 `codegraph status --json` 的权威 pending，
  fallback 仅扫描可索引源码并排除 Adapter/Markdown；watcher 日志不再冒充索引完成时间。
- **只读检查与紧凑输出**：新增严格零写入 `sync --check`（`--dry-run` 兼容）、默认紧凑
  stdout、`--verbose` 组件详情、版本身份和结构化 `remediations[]`。
- **单一能力入口**：能力握手内置到 `sync` 并在任何 Python/项目工作前 fail closed；
  workflow 不再重复启动 `capabilities` 进程，契约升级为 `sync@2`、
  `knowledge-sync@3`、`codegraph-status@2`。
- **安全修复契约**：支持 `--apply safe`、`--fix <id>`、显式确认、写入范围与事务 before
  snapshot；修复预览保持只读，Adapter 多目标 drift 聚合成一项可执行建议。
- **知识 freshness/health 解耦**：索引一致性与 lifecycle/review/publication/validation
  四维健康分开；待评审规则或知识以 `ADVISORY` 表示，不再伪装成过期或失败。
- **知识抽取与语义治理**：优先显式 `knowledgeCandidates[]`，过滤 process observation；
  Unicode/标点/空白归一化去重，冲突要求共同实体、范围与双方 evidence。
- **裁决与发布门禁**：judge 返回完整总量、有界 preview 和 quarantined 数；blocked 条目
  不进入裁决，defer 绑定证据指纹；knowledge publication 与 archive release status 独立，
  legacy gate 只在 summary/hash/source commit 可证明时自动修复。
- **有界可恢复产物**：judge/rollback 报告内容寻址并维护 latest 指针和保留上限，回滚快照
  gzip 压缩；validator 明确报告 eligible/selected/applied/remaining/unavailable。
- workflow bundle 提升至 `0.2.31`，最低 CLI 版本提升至 `0.2.44`。

## [0.2.43] — hunter-harness / [0.2.41] — @hunter-harness/workflow-harness

### Fixed（2026-07-31 本地状态耐久性与执行证据闭环）

- **局部状态 fail closed**：项目检测扩展为 absent/partial/invalid/valid/recovery-required；archive、change、project-local knowledge、managed block、Adapter marker 或恢复事务任一残留时，普通 configure/refresh/rules 操作都会给出 `PARTIAL_HARNESS_STATE_DETECTED` 或恢复诊断，不再把成熟项目静默重置为首次安装。
- **受保护根事务收据**：事务 journal 记录 `.harness/archive`、`.harness/changes` 与 `.harness/knowledge/project-local` 的文件/目录/字节/Merkle inventory；未声明写权限的增减或改写会失败并回滚，保留可审计的前后身份。
- **耐久归档**：归档新增工作区外内容寻址存储、写后回读、retention policy、durable receipt 与无覆盖恢复；仅本地归档明确标记 `ARCHIVED_LOCAL_ONLY`，取得耐久收据后才标记 `ARCHIVED_DURABLE`。
- **场景到执行证据闭环**：计划中的 required scenario 必须绑定精确 test ID、文件和标题；runner receipt 与 Ledger 分别记录 declared/selected/collected/executed/passed/skipped，Gate 独立拒绝漏收集、过滤、跳过、同名跨文件冒充或失败 attempt，最终摘要展示覆盖关系。
- **Windows 服务树所有权**：launcher 使用 kill-on-close Job Object，service session 记录 job、launcher/root PID、可执行文件、命令哈希、启动时间、父链和端口；stop 仅终止身份完全匹配的树，并同时确认进程与端口释放，无法确认时保留 session 和 `UNCONFIRMED` 结论。
- **环境内容与动态变量**：正式环境收据强制记录 instance/start、migration、seed、API build、Redis、database index、隔离前缀与 canary；租约绑定内容指纹并在漂移时返回 `STALE_CONTENT`，runner 只从脱敏收据注入声明字段，缺失时在测试启动前返回 `VERIFICATION_ENVIRONMENT_INCOMPLETE`。
- **跨 PowerShell 参数协议**：复杂 argv 改用 UTF-8 JSON argument file，runtime receipt 记录 PowerShell edition/version 与 argv hash，不持久化原始敏感参数；持久服务命令从有界 test runner 中拒绝并要求正式 service mode。
- **迁移与异常收尾**：Ledger v2 或显式 identity 的 legacy 写入先原子迁移到 v3，保持 evidence identity 并嵌入 migration receipt，失败返回确定性重录命令且不改原文件；测试锁和环境租约具备精确 owner、heartbeat、expiry、分类、安全回收和 closeout receipt。
- workflow bundle 提升至 `0.2.30`，最低 CLI 版本提升至 `0.2.43`。

## [0.2.42] — hunter-harness / [0.2.40] — @hunter-harness/workflow-harness

### Fixed（2026-07-31 Sync 指令图与发布收据修复）

- **指令引用强度**：反引号中的裸 `.md` / `.json` 文件名若不存在，按说明文字保留诊断边但不再触发 `INSTRUCTION_REFERENCE_MISSING`；带目录的 inline 路径、`@ref`、Markdown link 与 JSON 指令字段继续严格校验，避免 `build-profile.json` 等配置名误阻断 sync。
- **Dry-run 收据真实性**：Adapter 投影预览不再写入 `partialEffects.persisted`，改为明确的 `notPersisted` preview；dry-run 保持零持久化且汇总不再声称变更已经落盘。
- **发布可复现性**：修正 workflow family 的受跟踪内容哈希；pack smoke 在 workflow prepack 改写 family manifest 时 fail-closed，防止发布 tarball 与候选 Git 提交静默不一致。
- **跨平台 Bundle 摘要**：`coreHash` 统一按 POSIX 相对路径排序并使用实际文件 SHA-256，不再因 Windows/Linux 路径排序或 Git 元数据是否存在而漂移；Windows 与 Linux 生成的 854 个 workflow 文件逐文件一致。

## [0.2.41] — hunter-harness / [0.2.39] — @hunter-harness/workflow-harness

### Fixed（2026-07-30 CBM Forge generic-job-status-api Harness 复盘上游修复）

- **阶段闭合**：`phase.start` 写入路径在发现同阶段开放尝试时先写 `phase.auto_sealed`（原因含 executor_lost / user_wait / external_wait / superseded / unknown）；`recoveredMs` 与有效执行时间分离，CLI/gate 共用同一保证。
- **归档身份**：base 解析改为 ledger → archive-boundary state-snapshot → phase-context → merge parent/merge-base；adequacy 拒绝 base=feature tip、no-ff 仅 merge delta、ownership 与报告 diff 显著缩小等“内部自洽但截断”的边界。
- **Sync 指令路径**：根相对 inline code 优先按项目根解析，Markdown link 使用 target 而非显示文本，并保留越界拒绝与 resolution trace。
- **Knowledge Sync 事务**：`sync_status` 在索引最新后推进 maintenance outbox；索引成功但 outbox 未清时返回 `ok=false`/`WARN` 与非空 `nextAction`；崩溃残留的 stale `running` 可恢复。
- **验证复用**：以 productTreeHash + 命令集/环境/工具链/DB 身份为复用键；feature tip 与 no-ff merge 产品树相同时可复用 Full/API/Browser/Package，仅补跑 merge integrity/smoke。
- **服务生命周期**：service-session 记录 worktree/change 所有权；cleanup 先停 owned 服务再删 worktree，并写 cleanup receipt；非 Harness 进程只报告不误杀。
- **报告语义**：DB compatibility 只认类型化证据（区分 NOT_RUN / NOT_APPLICABLE / UNKNOWN / EVIDENCE_MISSING）；测试统计增加 unique/rerun；报告展示 checkpoint→product→feature tip→merge 身份链。
- **Knowledge 真增量**：archive delta 分类；online near-dedupe/freshness 排除 stale/superseded；SQLite dirty upsert 同步 lifecycle 状态变更（promote/conflict）。
- **CodeGraph / Adapter / UX**：Review 对 worktree 根不匹配返回 `IDENTITY_MISMATCH`；Adapter 冲突聚合为可提升 proposal 且禁止盲覆盖；Sync 输出 `partialEffects` 与组件级可执行 `nextAction`；Archive `auto-gate` 满足时可无确认执行。
- workflow bundle 提升至 `0.2.29`，最低 CLI 版本提升至 `0.2.41`。

## [0.2.40] — hunter-harness / [0.2.38] — @hunter-harness/workflow-harness

### Fixed（worktree 发包源码绑定补丁）

- CLI bundle 不再通过 `node_modules` workspace Junction 解析私有包，而是显式绑定当前 checkout 的 `packages/core/src` 与 `packages/contracts/src`，避免 linked worktree 发包时静默打入主工作区旧源码。
- esbuild metafile 新增 fail-closed 完整性检查：私有 workspace 输入缺失、来自其他 checkout，或落到旧 `dist` 均直接终止打包。
- pack smoke 现在从真实 tarball 安装 CLI，并创建含 Windows 绝对路径的 512 KiB `__pycache__/*.pyc`；要求敏感发现为 0 且 proposal 不含缓存路径，覆盖本次 `0.2.39` 发布产物失配。
- Push 不再上传可从知识条目重建的 `knowledge/index.json`，也不上传非活动的 `entries/stale` / `entries/superseded` 投影；active、candidate、conflicted 与 project-local 知识仍按原治理策略处理，避免大型项目命中单文件 10 MiB / proposal 50 MiB 门禁。
- workflow bundle 提升至 `0.2.28`，最低 CLI 版本提升至 `0.2.40`。

## [0.2.39] — hunter-harness / [0.2.37] — @hunter-harness/workflow-harness

### Fixed（Push 运行时缓存过滤补丁）

- `push` 在递归 adapter working copy 时会在读取前排除 Python 运行产生的 `__pycache__`、`.pyc`、`.pyo`、测试缓存和本地虚拟环境，避免二进制缓存误入敏感扫描与 proposal manifest。
- FilePolicy 同步将这些路径归类为 `generated_cache / push_policy=never`，保护直接 proposal builder 与 baseline 路径；真实用户 skill 文本仍照常扫描。
- symlink 安全检查继续先于缓存过滤，缓存目录名不能绕过 `UNSAFE_SYMLINK`。
- 新增真实大体积 `.pyc`、常见缓存路径、真实 secret 与 junction 的回归测试；workflow bundle 提升至 `0.2.27`，最低 CLI 版本提升至 `0.2.39`。

## [0.2.38] — hunter-harness / [0.2.36] — @hunter-harness/workflow-harness

### Fixed（知识维护终态与状态文件一致性补丁）

- 自动 supersede 产生的终态条目现在进入 preserved closure，同一 archive 未变化时不再被增量缓存中的旧状态覆盖。
- 条目状态变化会按稳定 ID 迁移持久化文件，并移除其他状态目录中的旧副本，避免验证重载阶段出现同 ID 不同载荷碰撞。
- 工作流时间分区改用整数微秒换算毫秒，消除浮点边界偶发产生的 `conservationDeltaMs=-1`，确保分类总和严格等于墙钟。
- Build Profile v2→v3 兼容投影保留旧 `verificationInputs`，同名 v3 command 派生值仍优先，避免 linked worktree 的 Ledger 输入闭包失效。
- CLI 提升至 `0.2.38`，完整承载最新主线的全局工程效率治理能力；workflow harness 的最低 CLI 版本同步提升至 `0.2.38`。
- 新增自动 supersede 保留与跨状态文件迁移回归测试，并用真实归档知识库完成冷重建和 maintenance outbox 恢复验证。

## [0.2.37] — hunter-harness / [0.2.35] — @hunter-harness/workflow-harness

### Fixed（release-candidate 身份自洽补丁）

- 本地候选认证收据现在把唯一验证环境写入 `subject.environmentHash`；多个验证环境则写入稳定聚合哈希，使候选认证与归档身份校验使用同一不可变环境身份。
- 本地可复现候选若缺少 subject 级环境身份将被明确拒绝，避免“候选认证成功、release-candidate 归档失败”的矛盾终态。

## [0.2.36] — hunter-harness / [0.2.34] — @hunter-harness/workflow-harness

### Fixed（完整修复 2026-07-29 Harness 流程与最终报告复盘）

- **事实模型可信化**：统一产品提交/树/环境身份，选择同一目标的最新终态验证；当前结果、历史尝试与发布资格分层，record-only 明确为“未请求发布”，未采集成本与存储不再伪装为绿色零值。
- **执行结果页重构**：Node 与 Python fallback 统一为中文、决策优先、技术明细折叠的执行结果页；按后端、Geo、前端、浏览器、API 分组，并补齐桌面浅色、桌面深色和 390×844 移动端视觉回归。
- **Sync 有界可靠**：显式指令图取代路径猜测，生成目录禁止递归；子进程具备墙钟/停滞超时、心跳、输出上限和分级终止，失败只更新 last-run，成功才更新 last-success。
- **知识增量与规模治理**：Git freshness 批处理、单次 archive 扫描、SQLite dirty set 真正 no-op；相似度候选采用稀有词分桶和比较预算，避免近似平方增长。
- **计划、Profile 与验证账本升级**：新增 aggregate scale/冲突/DAG/父子提交闭包分析，Profile v3 的模块图与命令图，affected consumer closure，以及动态 verification targets 的严格身份复用。
- **跨工具续跑**：新增 prepare/begin/close/view 上下文协议、租约与哈希链 handoff receipt；Review/Test fixback 只失效验证目标，不删除历史证据。
- **精确时间守恒**：分段毫秒取整残差归入未归因时间，报告墙钟分区保持严格守恒。

## [0.2.32] — hunter-harness / [0.2.30] — @hunter-harness/workflow-harness

### Fixed（可信同步、能力契约与增量知识）

- **单一同步入口**：新增 `sync`、`capabilities`、`doctor` 与 `config show --origins`，在重操作前完成 CLI/workflow 能力握手与 Python runtime 解析；stdout 保持紧凑，完整组件收据写入带哈希的报告。
- **状态事务一致性**：Adapter verification 改为计划后视图并覆盖全部已安装 Adapter；codebase map 从真实 manifest/hash 重算；薄指令入口按有界引用图验证。
- **严格 managed block**：完整解析 sibling block，明确拒绝 duplicate、nested、unclosed 和 mismatched marker；多 ID full-file artifact 按 ID 安全合并，不再生成 legacy 嵌套 wrapper。
- **真正增量的知识同步**：entry ID 使用完整规范正文，路径迁移复用内容 cache；Git 查询按 commit 缓存，near-dedupe 缩小候选集，并增加阶段 heartbeat、耗时、比较量、写入量及三层 ID 一致性断言。
- **有界仓库感知**：Git 基线优先取上次成功 sync receipt，再退到 upstream merge-base；只报告 shortstat、分类和 Top 目录，不再固定 `HEAD~5`。
- **安全生命周期**：change 目录采用 ACTIVE、ARCHIVED_LEFTOVER、RECOVERABLE、ORPHAN、INVALID 五态；清理先 dry-run，并核验 archive receipt/hash。
- **发布门禁**：workflow manifest 声明最低 CLI 与必需能力；npm pack 后从实际 Skill 文档抽取命令并逐一核验打包 CLI。

## [0.2.29] — @hunter-harness/workflow-harness

### Fixed（Windows 测试资源安全与进程生命周期）

- **默认低负载档位**：新增 `safe` / `system` / `full` 测试资源档位；默认只运行 `safe`，资源密集型档位必须显式确认。
- **逐模块隔离**：Python `unittest` 按测试文件串行、独立解释器执行，禁止单进程整库 discovery 长时间累积线程、端口和子进程。
- **硬资源边界**：同项目单实例、低调度优先级、worker 上限 2、逐模块超时、失败即停；内部并发回归也服从统一 worker 预算。
- **Windows 精确清理**：普通模块使用 kill-on-close Job Object；detached-service 测试使用精确 PID 血缘跟踪，正常、失败、超时和中断均回收本轮后代进程，不按进程名误杀用户服务。
- **工作流合同化**：`harness-test` 技能、检查清单、参考文档和 workflow policy 同步强制安全 Runner、确认门与资源生命周期关门检查。
- **项目安全入口**：仓库新增 `test:harness:safe/system/full` 命令，完整验证可拆为 safe + system，避免再次制造桌面资源峰值。

## [0.2.28] — @hunter-harness/workflow-harness

### Fixed（多日执行发布真实性、状态机与成本治理）

- **发布资格唯一化**：`remote-claimed` 仅允许 record-only；发布必须同时满足归档完整性、报告充分性、候选证明、Git/环境身份、项目策略、终态 attempt 和最终状态。
- **最终顺序状态机**：项目 `finalSequence` 编译为可执行 DAG；review、freeze、assertion-bearing Full、delta review、submit、远端候选与 archive 严格按同一冻结身份推进。
- **失败闭合与根目录**：phase close 失败持久化为可恢复事务，不再产生虚假 `CLOSED/OK`；begin 可从 capsule 或当前 linked worktree 自动恢复 execution root。
- **时间与环境执行**：attempt/session 使用 typed terminal；active、wait、pause、unattributed 与 workflow wall clock 守恒；环境准备失败不再冒充 Full。
- **并行与生命周期**：aggregate candidate 验证 child membership/coverage；`isolated-multi-active` 强制隔离 worktree、port、DB、temp root 和 writer lease；Windows worktree 清理统一检查 capsule、Agent root、junction 和 registration。
- **投影、重试与制品**：degraded projection 阻断发布阶段；同候选无新信息重试返回 `NO_NEW_INFORMATION`；归档在复制前执行预算检查，并提供内容寻址复用与 runtime/staging TTL 审计。
- **报告可观测性**：Current Outcome、claim/attestation、Archive Integrity、Release Eligibility、History Quality 分栏；新增时间守恒、远端 runner/queue/artifact 成本及本地新增/复用/清理字节。
- **切片计划门禁**：slice plan 必须声明 candidate type、aggregate parent、证据复用策略与 artifact budget。

## [0.2.31] — hunter-harness / [0.2.27] — @hunter-harness/workflow-harness

### Fixed（规则审阅、运行闭合与 Windows 归档）

- **交互式规则审阅**：新增 `rules-review`，Agent 可把归档候选推荐为公共规则、项目知识、回归测试、CI 任务或 Harness 缺陷；用户确认、修改或拒绝后持久化决策，并以 candidate revision 与目标 SHA 防止覆盖新版本。
- **规则语义同步**：Cursor frontmatter 与规则正文分离比较，正文一致不再误报冲突；公共正文更新时保留 Agent 元数据。`harness-sync` 在交互模式展示候选与差异，非交互模式只报告待审数量。
- **事件与时间闭合**：并发拒绝记录完整 `BLOCKED` attempt；阶段前 decision 不再制造孤儿 attempt；并行阶段墙钟按区间并集统计，保留 active-only 与 workflow wall-clock 的明确区分。
- **审查与 API 证据**：无结构化 sidecar 的 review 不再误报零 RED，而是以 `ADVISORY_UNSTRUCTURED` 投影可见计数；API 汇总兼容大小写指标键。
- **Windows 集成与归档**：integration 自动使用短 transaction id 和短临时根；archive staging 使用短目录、复制前停止 Harness 服务，并排除 `node_modules`、虚拟环境、缓存与锁文件。
- **Artifact 路径**：同一 change 的 `.harness/changes/<id>/...` 仓库路径在最终报告中自动规范为 change-relative 路径。

## [0.2.29] — hunter-harness / [0.2.26] — @hunter-harness/workflow-harness

### Added（规则收敛与经验学习）

- **多 Agent 规则收敛**：新增 `rules-sync` 命令，扫描 Claude、Cursor 与 CodeBuddy 用户规则；全局一致内容归一到 `.harness/rules/`，同名异义只报告不覆盖，带路径范围的规则保留为 Agent 专属。
- **幂等受管投影**：复用 rule projection receipt，已生成且未修改的投影不再作为导入源；手工修改进入明确冲突，重复同步不产生迁移或询问。
- **历史规则候选**：从结构化 review findings、测试失败与 archive summary 提炼 `.harness/knowledge/rule-candidates.json`；仅重复问题或高严重度证据进入候选，疑似提示注入和敏感内容被拒绝，候选不会自动激活。
- **harness-sync 集成**：同步流程调用 `rules-sync`，统一报告迁移、Agent 专属规则、分歧与候选数量。

## [0.2.28] — hunter-harness / [0.2.25] — @hunter-harness/workflow-harness

### Fixed（公共规则、集成证据与归档事实）

- **公共项目规则**：新增 `.harness/rules/` 唯一规则源；首次安装迁移 Claude 自定义规则，init/refresh/update 幂等生成 Claude、Cursor、CodeBuddy 与 Codex 投影，并用本地 receipt 保护 agent 目录中的人工修改。push 只上传公共源，语义索引同步识别。
- **CodeBuddy 幂等同步**：已一致规则不再重复询问；缺失目标才提示，内容冲突保留目标并给出明确警告。
- **集成验证证据**：每条 merge verification 命令持久化 stdout/stderr、退出码、时长和 journal `logPath`，失败与超时同样可追溯。
- **归档身份与产物**：显式区分 `featureMergeHash` 与 `releaseTipHash`；仓库相对业务产物复制到 `artifacts/product/` 后再归档，缺失文件前置阻断。
- **报告指标**：API 通过率排除 blocked，并新增执行率；单测展示 deselected；性能验证进入结构化 summary 与 HTML。

## [0.2.27] — hunter-harness / [0.2.24] — @hunter-harness/workflow-harness

### Fixed（子 agent 路由与 Windows 发布稳定性）

- **Inline 优先路由**：代码探索默认由主会话执行；evaluator 仅显式 adversarial/高风险启用；reviewer 仅发布候选或高风险变更考虑隔离委派。
- **Codex/Cursor 静默降级**：不再执行固定 `harness-explorer` / `harness-reviewer` 预检；使用宿主原生临时隔离能力或主会话，不再把正常 inline 显示成“subagent 不可用”。
- **能力状态统一**：预检新增 `executionMode=inline|delegated|unavailable` 与 `fallbackPolicy=inline-no-retry`；缺少宿主能力清单返回 `INLINE_BY_ADAPTER`，真实定义/工具契约损坏才报告不可用。
- **防止重复执行**：spawn 失败、空返回、0 tool uses、仅 Done/元数据时立即由主会话接管，不 retry、不重复整轮探索或审查。
- **Windows 原子交换重试**：bundle staging 遭遇短暂目录锁时进行有界毫秒级重试，持久锁仍明确失败，避免整轮 8-bundle 同步因 `WinError 5` 返工。
- **有界 pre-push**：默认仅执行 lint + typecheck，完整候选测试交给远端 CI；无 CI 项目继续使用绑定 tree hash 的本地完整 check 收据，避免提交阶段重复全量测试拖垮机器。

## [0.2.26] — hunter-harness / [0.2.23] — @hunter-harness/workflow-harness

### Fixed（测试性能与候选发布证据）

- **资源受控测试**：默认测试与 Next.js 静态构建并发限制为 2；构建链移除重复 TypeScript 编译；集成命令去重、统一 30 分钟超时并修复 Windows `.cmd` 解析与后台进程锁误回收。
- **扫描与复用性能**：依赖、缓存、构建产物及嵌套 worktree 不再进入测试扫描；默认 profile 变更可自动判旧；ledger 输入哈希改为项目内稳定相对路径，提升跨 worktree 复用率。
- **打包缓存隔离**：smoke pack 使用仓库级 npm cache，避免多个项目争用全局 cache 引发 EPERM，并复用已下载依赖加速后续打包。
- **提交验证复用**：pre-push 改用随 Node.js 运行的 check marker 门禁，不再依赖系统 `python` PATH；同一提交树 10 分钟内的绿灯证据可直接复用，避免 `harness-submit` 推送时重复跑完整检查。
- **测试规划成本契约**：Harness 生成测试场景时必须声明执行层级、预计时长、资源预算、超时和可复用证据，affected/module/candidate 分层执行。
- **无 CI 项目候选证据**：新增 `local-reproducible` 本地候选凭据，绑定产品提交/树、命令、工具链、环境、依赖、日志与 ledger 哈希，复用既有完整验证而不重复跑全量测试。
- **CI 证据迁移与防降级**：旧 `product-candidate-ci.json` 自动迁移为 `remote-claimed`；存在远端 CI 历史时禁止静默降级为本地凭据；`remote-attested` 必须提供证明摘要。
- **归档语义拆分**：分别输出 `archiveIntegrity`、`candidateVerification`、`releaseEligible`；允许 `record-only` 留档，但不会被误标为可发布。

## [0.2.25] — hunter-harness / [0.2.22] — @hunter-harness/workflow-harness

### Fixed (Wave-A — retro-20260723-cbm-ia-harness-hardening)

- **产品 CI 门禁**：归档补齐 `productCommit`/`productTreeHash`/`archiveCommit`；产品候选 CI 未绿灯或漂移时 fail-closed / reopen。
- **timing 完整化**：未闭合 attempt 记为 `INCOMPLETE`；`render-summary` 展示活动时长与 `reportCutoffAt`。
- **Manifest 覆盖**：覆盖顺序与排除规则稳定化，避免虚假覆盖。
- **环境租约**：新增 `environmentHash` fingerprint 与 change lease 获取/释放（`harness_environment.py`）。
- **checklist / 测试**：同步 archive/submit/test checklist；补 Wave-A 单测（含 CI runUrl+commit、lease 过期、tree-hash 截断）。

### Fixed (web — monorepo)

- **DocumentBrowser 翻页 flake**：知识库分页仅在 selection-id 变化时自动跳页，避免过滤数组 identity churn 与手动翻页竞态（Ubuntu CI）。


## [0.2.24] — hunter-harness / [0.2.21] — @hunter-harness/workflow-harness

### Added (Wave-2 — retro-20260721-harness-hardening-w2)

- **H-7 migration head**：harness_migration_head.py check + canonical .harness/config/migration-head.json；run checklist 联动。
- **H-9 verification graph**：ledger record 后 upsert evidence/verification-graph.json；invalidationCode 别名；mergeVerification.requiredOnMerge 进入 integration verify；submit checklist 复用约定。
- **H-15 batch events**：atch_append_events + CLI atch-append --file（全量校验后单锁写入）。
- **H-16 model routing**：protocols/model-routing-protocol.md + CONTEXT glossary（economy/balanced/frontier）。
- **H-17 force-managed**：
efresh --force-managed 无 --yes/--confirmed 时 fail-closed（FORCE_MANAGED_REQUIRES_CONFIRM）。


## [0.2.23] — hunter-harness / [0.2.20] — @hunter-harness/workflow-harness

### Fixed (Submit worktree friction)

- **eslint**：`eslint.config.mjs` 忽略 `.worktrees/**`，避免 pre-push 对兄弟 worktree 双扫。
- **ledger profile 分层**：`expand_profile_input_files` 经 `load_profile`/`common_root` 解析 `build-profile.json`；不可读时保留 `unreadable:` 诊断。
- **submit checklist**：M5 push × eslint/worktree 硬门禁说明。

## [0.2.22] — hunter-harness / [0.2.19] — @hunter-harness/workflow-harness

### Fixed (Wave-1 — retro-20260721-harness-hardening-w1)

- **H-8 artifact path**：`--type artifact` 必须带非空 `--path`；预览/说明改用 `issue`/`decision`，禁止 pathless `kind=informational`。
- **H-11/H-12 report adequacy**：`summary-data` 同步顶层 `baseCommit`/`diffStat` 与 `gitFacts`；`base≠final` 且 `filesChanged=0` 记 `DIFF_ZERO_WITH_NONEMPTY_COMMIT` error。
- **H-13 passRate**：单元测试 `passRate` 分母排除 `skipped`。
- **H-4/H-14 archive**：最小 blocker 为 plan/events/ledger；缺 test/review 证据降为 warning；informational/hygiene issue 不把 OK stage 降为 WARN。
- **paths / ledger / integration / submit**：配套 ownership、cleanup 与测试夹具对齐（含 archive preflight COM-003）。

## [0.2.17] — @hunter-harness/workflow-harness

### Fixed (P2 — 2026-07-20 phase1b 复盘续 3)

- **5.8 Plan verify 子命令**：`harness_plan_finalize.py` 新增 `verify` 子命令，基于正式产物、receipt 和 `events.ndjson` 做只读验证，不依赖 staging。返回 `artifactsHash`/`phaseEndCount`/`frontmatter`/`gatePolicyConsistent`/`receiptConsistent`。解析错误非零退出。覆盖中文 NDJSON 场景。
- **5.9 审批协议宿主无关**：将 25 个文件中的 `AskUserQuestion` 替换为宿主无关术语 `blocking user confirmation`，adapter 按映射表映射到具体工具（Claude/CodeBuddy → AskUserQuestion，Codex → request_user_input，Cursor → 普通对话）。finalizer 只校验 approval receipt/decision 顺序和内容，不校验交互工具品牌。`CONTEXT.md` 增加宿主无关审批映射说明表。
- **5.17 Skill include/wiki link 闭包校验**：`scripts/sync-harness.mjs` 的 `assertSupportFilesPresent` 扩展，校验 `[[shared/xxx.md|...]]` wiki link 和未展开的 `<!-- @include shared/xxx.md -->` 引用。任一悬空引用 fail closed（`SUPPORT_FILE_MISSING`/`DANGLING_SHARED_REF`）。`harness_deploy.py` 的 `expand_includes` 清理 wiki link 为 alias 文本。
- **5.22 API batch/request 分层耗时 schema**：`harness-test/reference.md` 和 `checklist.md` 区分 `batchDurationMs`（runner wall-clock）、`scenarioDurationMs`（聚合场景）、`requestDurationMs`（单 HTTP 请求）。聚合合同套件场景只记录 batch reference/coveredTests，禁止均摊生成伪请求耗时。超时规则分别针对 runner wall-clock 与真实请求耗时。
- **5.23 受控 cleanup helper**：新增 `harness/scripts/harness_test_cleanup.py`，子命令 `cleanup` 输入 execution root 与 profile 声明的 cleanup roots，内部 realpath containment、拒绝 symlink/reparse escape、列出精确计数后删除，输出结构化 receipt（`CLEANUP_COMPLETE`/`PATH_ESCAPE_REJECTED`/`SYMLINK_ESCAPE_REJECTED`/`ALREADY_ABSENT`）。
- **5.30 Windows worktree remove 半成功状态**：`harness_integration.py` 的 `cleanup_target` 中，当 `git worktree remove` 返回非零但注册已删除时，返回 `REGISTRATION_REMOVED_RESIDUAL_PRESENT` 状态，再走 allowlisted residual cleaner。receipt 分别记录 registration、disk path、branch 三个结果。

### Known Limitations

- 无（0.2.16 的 P2 已全部修复，复盘 §5 完全闭合）。

## [0.2.16] — @hunter-harness/workflow-harness

### Fixed (P1 — 2026-07-20 phase1b 复盘续 2)

- **C5 CLI 默认 compact 输出**（§5.7）：`harness_knowledge.py` query 子命令默认返回 compact JSON（无 matches 数组），`--verbose` 展开全量；`harness_ledger.py` record/can-reuse 默认 compact（ok/action/verification/status 或 ok/reuse/code），`--verbose` 展开；`harness_integration.py` 新增 `journal` 子命令（compact: transactionId/currentStep/status）。
- **C7 common profile 与 execution-root 分层**（§5.8）：`harness_paths.py` 新增 `common_root()`，通过 `git rev-parse --git-common-dir` 解析主项目根；`harness_profile.py` `load_profile` 先读 common_root 再叠加 execution root override；`resolve_command` 支持 `{commonRoot}`/`{executionRoot}` 占位符替换。
- **C8 Plan task phase ownership**（§5.9）：`harness_plan_finalize.py` 解析 plan.md 任务表 `ownerPhase`/`implementationDoneWhen`/`verificationPhase` 列；校验 `ownerPhase` 值（plan/run/test/review/submit）；写入 `meta/implementation-checkpoints.json`。
- **C9 scenario manifest + 测试 ID 绑定**（§5.17）：`harness_plan_finalize.py` 解析 test-scenarios.md，输出 `meta/scenario-manifest.json`；`harness_ledger.py record --scenario-ids` 绑定场景 ID 到 ledger entry；`harness_gate.py close` 校验所有 P0 场景都有对应的 ledger entry（`_validate_scenario_coverage`）。
- **C11 reviewer 有界等待与降级**（§5.27）：`harness_review.py` 新增 `dispatch_review()`（返回 reviewTaskId/deadline/heartbeatAt）、`collect_partial_findings()`（超时后收集已完成维度）、`degradation_matrix()`（subagent 超时 → 主会话；主会话失败 → ADVISORY）。
- **C12 CodeGraph identity 校验**（§5.29）：`harness_review.py` `validate_codegraph_identity()` 校验 repositoryId/indexedHead/indexedAt；identity 不匹配时记 `CODEGRAPH_IDENTITY_MISMATCH` warning，降级为 Grep/Glob + Read；`harness-review/reference.md` 声明 identity 合同。

### Known Limitations

- 无（0.2.15 的 P1 deferred 已全部修复）。

## [0.2.15] — @hunter-harness/workflow-harness

### Fixed (P1 — 2026-07-20 phase1b 复盘续)

- **C1 custom agent 预检三字段**（§5.3）：`harness_preflight.py` check-agents 拆分 `definitionPresent`/`hostCallable`/`toolContractValid` 三字段；`reasonCode` 细化（`UNKNOWN`/`DEFINITION_NOT_FOUND_HOST_CAPABLE`）；`_read_host_capabilities` 从 `runtime.json` 读取宿主声明。
- **C2 capability reclassify**（§5.4）：`harness_plan_finalize.py` finalize 发布前 reclassify design frontmatter capabilities；drift 时更新 `staging/meta/gate-policy.json`。
- **C3 change rename/UUID**（§5.5）：`harness_change.py` 新增 `rename`/`ensure-identity` 子命令；`change-identity.json` 稳定 UUID4；`change.rename` 事件类型（`harness_events.py` 扩展 `append_event` 支持 `renamed_from`/`renamed_to`/`change_uuid`）。
- **C4 状态快照三态语义**（§5.6）：`harness_state.py` capture 增加 `comparisonAvailable`/`baselineStatus`/`unresolvedReasons`；首次 capture 不再填充 `unresolvedSegments`。
- **C6 worktree argv 模板修正**（§5.11）：`harness-run/reference.md` worktree argv 模板修正为 `git worktree add -b <branch> -- <path>`（`-b` 必须在 `--` 之前）。
- **C10 端口 lease ID + 子集释放**（§5.16）：`harness_change.py` lease-port 返回 `leaseId`（UUID4）；release-port 增加 `--port`/`--lease-id` 子集释放；mismatch payload 列全部 conflicting owners。
- **C13 remote probe typed error**（§5.28）：`harness_integration.py` `GitRunner.remote_probe` typed result（`exitCode`/`stdoutHash`/`redactedStderr`/`category`）；`RemoteProbeFailedError` 与 `TargetMovedError` 分离；`None` 不再进入 found head 字段；stderr 凭证 redact。
- **C14 archive preflight 集成**（§5.31）：`harness_archive.py` check_status 集成 `artifact_preflight`；cmd_finalize 集成 `artifact_preflight` + `validate_report_adequacy`；blocking 项 fail closed。

### Known Limitations (P1 deferred — 已在 0.2.16 修复)

- C5 CLI compact 输出、C7 profile 分层、C8 task ownerPhase、C9 scenario manifest、C11 reviewer 有界等待、C12 CodeGraph identity 校验 — 已在 0.2.16 修复。

## [0.2.20] — hunter-harness / [0.2.14] — @hunter-harness/workflow-harness

### Fixed (P0 — 2026-07-20 phase1b 复盘)

- **C1 bundle 逐文件 manifest + 安装事务**（§5.1/5.25）：发布 bundle 生成逐文件 manifest（relpath/sha256/size/mode/adapterTransformationId）；install 在原子切换前逐文件校验 staging，mismatch 时 fail closed 不更新元数据；context-index 增加 `installedContentHash`/`verifiedAt`/`verificationStatus`/`mismatchDetails`；`harness_deploy.py` 新增 `generate-manifest`/`verify-installed` 子命令。
- **C2 并发模式合同**（§5.2）：effective config 声明 `concurrencyMode`（`single-active` 默认 / `isolated-multi-active`）；`harness_gate.py begin` 在 single-active 下阻断第二个 active change；`harness_preflight.py` 输出 `concurrencyMode`/`activeChanges`/`allowedParallelLevels`。
- **C3 execution-root 合同**（§5.10/5.21）：`harness_test_guard.py close` 在 projectRoot 不匹配时返回 `EXECUTION_ROOT_MISMATCH`（优先于 `SNAPSHOT_INVALID`）；close 交叉校验 manifest active entries vs recordedCount=0，不一致时 fail closed。
- **C4 失败态 gate close**（§5.14）：`validate_ledger_for_phase_close` 新增 `phase_status` 参数；`close --status FAIL` 允许 validation FAIL/NOT_RUN，写 `LEDGER_OK_FAIL`；`close --status OK` 在失败 ledger 上必须失败；`validate_ledger_entry_v2` 动态 status 值提示。
- **C5 archive status preflight**（§5.31）：`harness_events.py` artifact 按 `kind` 区分 `file-backed`/`informational`，file-backed 必须有 path；`harness_archive.py` 新增 `artifact_preflight` 分类 informational/canonicalizable/blocking；新增 `append_event` 可编程 API。
- **C6 archive report adequacy**（§5.32）：`harness_archive.py` 新增 `validate_report_adequacy`，检查 diff=0+commit 非空、typed metrics 缺失、stageStatus 与 event reducer 矛盾，阻断全绿归档。

### Known Limitations (P1 deferred)

- T4 信任根脚本自校验未实现（避免加载时循环依赖）
- T8-T11 snapshot v2 schema 升级、CLI `--main-project`/`--execution-root` 拆分、phase capsule 持久化为较大重构
- T13 promotion gate 分离、T14 `abort` 命令未实现（`close --status FAIL` 已可用）
- T20 独立 source projection、T21 typed sidecar、T22 duration 互斥、T23 `repair` 命令为较大重构
- `artifact_preflight` 尚未集成到 `cmd_finalize` 前置（需手工 correction artifact path）

## [0.2.17] — hunter-harness / [0.2.10] — @hunter-harness/workflow-harness

### Fixed

- Test tracking v2 在 submit stage 正确分派 schema 校验器，只暂存 `commitScope=current-change`，同时保持 v1 兼容。
- Change ownership 严格执行 `productPaths` / `staticEvidencePaths`，归档 changed files 不再混入并发或未声明路径。
- split-v1 runtime state 在归档 cutoff 前冻结并合并，越界 `runtimeRoot` fail closed，失败时恢复 contract/state 分离布局。
- archive source consistency 增加 cutoff hash、review sidecar、risk/manual action、phase timing、manifest checksum、artifact URI 与 ownership projection 对账。
- Knowledge publication gate 校验 authoritative summary 的 `finalStatus` 和 source consistency，支持 hash 有效的 versioned repair，拒绝 DEGRADED/UNVERIFIED。
- integration transaction 增加 journal revision CAS、target 二次校验、ownership scope、event/artifact/ledger identity 与 verification identity。
- harness-review 和 harness-sync 正式接入结构化 sidecar及受管 runtime 的 reap/begin/finally finalize 生命周期。
- refresh freshness 输出真实 post-adaptation `adapterHash` / `installedAdapterHash`，用于区分正式投影与本地漂移。

## [0.2.16] — hunter-harness

### Added

- `push` 纳入 `.harness/archive/*/reports/final/summary-data.json`（仅 summary，非整棵 archive 树），file-policy 标为 `generated_reviewable` / `full-diff-proposal`，使控制台「变更总结」可从真实归档同步。
- 项目控制台：知识库状态筛选分页；版本记录展开变更集（相对上一版本）；关系探索改为「当前中心」一跳邻域工作台（列表为主、示意 ego 图为辅）。

### Changed

- 去掉仅展示内部 ID 的「技术详情」块；知识预览改为「来源 · path」。

## [0.2.15] — hunter-harness / [0.2.9] — @hunter-harness/workflow-harness

### Changed

- 归档报告管线：修复 summary-data 测试计数失真、archive 阶段 0 秒、`archive-meta` 漂移；补充 ledger `--metrics-json`、knownRisks 过滤与 finalize 敏感文件清理。
- 事件渲染：`harness_events.py` 改善 issue/verification/command 空字段降级；`report-pipeline-protocol` 补充事件语义表。
- 门禁政策：`foundation-gate` 缺失不阻断；`classify` 结果持久化到 `meta/gate-policy.json`；ledger 支持 DEGRADED 通道。
- Skills 文档：强化 Feign 路径核对、测试覆盖诚实标注、CLI 快速参考与 PowerShell 5.1 兼容指引；新增 `harness-test/pitfalls-java.md`。

### Fixed

- 归档 finalize 在 `phase.end` 前写入 artifact/decision，避免报告阶段统计被截断。
- 事件流中无 severity 的 issue 不再渲染为 `None`/`issue` 字面量。
- gate `classify_risk` 去重逻辑与 workflow-policy DEGRADED 语义说明。

## [0.2.12] — hunter-harness

### Added

- 交互式 Agent 选择菜单增加 `5. 全部` 选项；既有项目菜单行标注 `（已安装：<profile>）`。

### Fixed

- `update` 命令鉴权与 `push` 对齐：环境变量优先，`.harness/credentials.local.yaml` 回退；缺 token 时给出中文配置指引。
- `push` 在已绑定项目上于敏感扫描/提案确认前做版本预检；`PROJECT_VERSION_CONFLICT` 映射为与 `STALE_PUSH` 一致的友好 `update` 指引。
- 仓库 vitest 全局临时目录隔离与清理，避免 Windows 上 `hunter-*` fixture 泄漏占满系统 Temp（仅影响本仓库开发/CI，不进 CLI bundle）。

## [0.2.10] — hunter-harness / [0.2.5] — @hunter-harness/workflow-harness

### Changed

- run/test 可在契约唯一确定时安全修复陈旧测试，并把本轮新增、更新或修复的测试写入精确 test-tracking manifest；有业务歧义时以 `BLOCKED_PREEXISTING` 停止。
- submit 仅对 manifest 中通过路径与内容校验的测试执行 exact force-track，worktree 合并后确认测试已跟踪再清理，避免 `.gitignore` 导致测试随 worktree 丢失。
- diffHash 升级为 `content-changeset-2`，正式 change 通过 `--change-dir` 纳入 ignored tests，保持 checkpoint commit 前后复用稳定。
- Java profile 增加 `testTracking`，服务启动可在测试独立通过后跳过重复测试编译，测试标识符约束与实际数据契约统一。

### Fixed

- 修复 test guard 并发暂存覆盖、manifest junction 越界、并发 record 丢条目、常见 Node 测试路径缺失和 profile check 错误退出码。
- 禁止通过 `.bak`、改名、删除、禁用注解、构建 exclude 或 skip-tests 临时绕过陈旧测试。

## [0.2.9] — hunter-harness / [0.2.4] — @hunter-harness/workflow-harness

### Changed

- `harness-plan` 先建立 change 事件流再查询知识，新增语义歧义优先、简单修复探索预算与精简产物规则，避免沿错误理解深挖和重复生成大段计划。
- 知识查询收敛为单次 `query`，由命令内部执行一次 ensure-current；移除 plan 前的 `sync → sync --update → query` 重复编排。
- 全部计划/执行规则统一为 `events.ndjson` 单一事实源，`execution-log.md` 仅在阶段边界渲染，避免手工日志在结束时被覆盖。

### Fixed

- 修复 plan 的 agent 预检命令缺少 `--skills-root` 导致首次必然失败并重试。
- 修复设计审批阶段编号冲突及 approved 设计文档早于用户确认落盘的问题。
- 修复 archive 调用者与 finalize 重复追加 `phase.start` / `phase.end`，可能产生重复阶段或原路径幽灵目录的问题。
- 新增通用/Java Claude bundle 的 explorer/evaluator/reviewer 完整性回归检查，以及日志、知识查询、审批顺序和归档所有权契约测试。

## [0.2.5]

### Fixed

- `latest` 工作流数据包：解析前对比 npm 与 `.harness/cache/workflow-packages/` 缓存版本，npm 有新版时自动失效并重拉，避免 refresh 显示「0 文件更新」却仍是旧 bundle。

## [0.2.1] — @hunter-harness/workflow-harness

### Changed

- harness-knowledge-ingest：`auto` 默认写回 validator；首建 config 启用 autoDemote / autoDemoteActive / judge 上限；SKILL 要求 Agent judge 闭环。
- harness-sync：标明知识闭环主入口为 `/harness-knowledge-ingest auto`。

## [0.2.4]

### Fixed

- Windows 上经 npm workspace junction / `npx` 调用时，CLI 入口不再因 `import.meta.url` 与 `argv` 实路径不一致而静默退出；monorepo 可用 `npm run hh` dogfood。

## [0.2.3]

### Fixed

- 工作流数据包获取失败时改为分类提示真实原因（pacote 缺失 / 网络 TLS / 404），不再笼统写成「无网络且本地缓存不存在」。

## [0.2.2]

### Fixed

- 重新发布 CLI：`0.2.1` 因本地 `tsc`/`esbuild` PATH 问题打进了未重建的旧 bundle；`0.2.2` 含完整敏感扫描误报修复。

## [0.2.1]

### Fixed

- 敏感扫描不再把相对路径、SHA/commit hex、知识条目 ID 误判为高熵 secret；`.harness/knowledge/**` 下的本地 `projectRoot` Windows 路径不再阻断 push。

## [0.2.0]

### Added

- 项目级 Harness 安装支持 Claude Code、Codex、Cursor 与 CodeBuddy 的任意组合，并提供 `--agents` 与 `--codebuddy-surface` 参数。
- 离线资源改为 2 profile × 4 Agent Bundle 矩阵；刷新支持安全 Agent 集合切换、v3 installed state 与 legacy Claude-only 迁移。
- Push/update 文件策略覆盖四种 Agent 的 working copy、规则与 CodeBuddy managed block。

## [Unreleased]

### Breaking Changes

- **移除 canonical Skill IR 数据模型与编译链**：删除 `SkillIr` schema 与 `compileSkill`/`findSkillIr`/`mergeSkillIr`/`normalizeSkillIr`/adapters 等编译链。skill 源文件（`sourceFiles`，含 `SKILL.md` entry）成为唯一源；安装 = 上传的原生文件夹（"上传什么 → 存什么 → 装什么"）。
  - `packages/contracts`：删 `skill-ir.ts`；`registrySkillSummarySchema`/`DetailSchema`/`VersionSchema` 去 `ir`（保留 `ir?: unknown` legacy 容忍）；新增 `skillFrontmatterSchema`（`.passthrough()` 容忍额外字段，避免合法 SKILL.md 被拒）；summary 新增 `kind` 字段（从 frontmatter 反范式化）。
  - `packages/core`：删 `skill-ir/{compiler,adapters/*,overlay,normalize,extract,bundle}.ts`；新增 `skill/{frontmatter,meta,errors,checker,fixer}.ts`；`initializeProject` 改复制 `resources/skills/<name>/` + 写 `source_hash`（取代 `source_ir_hash`）。
  - `apps/server`：`store.ts` 18 处 IR 调用重写为 sourceFiles 驱动；`buildArtifactFor` zip 全部 sourceFiles + manifest `source_sha256`（取代 `source_ir_sha256`）+ `target_path` 文件夹根；dashboard `kind` 从 frontmatter 反范式化。
  - `apps/web`：catalog/mock-api/组件去 ir，改 sourceFiles 模型；fix degraded UX 展示（buildFixPatch 返回 degraded 项时明确提示"建议手动改"）。
  - `packages/cli`：`init` 复制 `resources/skills/`（仅 claude-code adapter，cursor/codex 暂抛错）；managed block `source_ir_hash` → `source_hash`。
  - `packages/skill-cli`：install 解 folder zip 保留目录结构（修复多文件 skill 安装丢失 references/scripts 痛点）；manifest 兼容 `source_sha256`（新）与 `source_ir_sha256`（旧 zip）。
  - `resources`：12 个 `bootstrap-ir/skills/*.yaml` → `resources/skills/<name>/SKILL.md` 文件夹模型；删 `resources/bootstrap-ir/`。

### Behavior Changes

- **cli init 仅支持 claude-code adapter**：source-file 模型下，cursor/codex 等 adapter 的 `.mdc` 编译能力随 `compileSkill` 移除，init 抛 "adapter not yet supported"（仅 claude-code 复制 SKILL.md）。
- **dashboard skill 分类分布**：`kind` 从 SKILL.md frontmatter 反范式化到 detail（取代旧 `ir.kind`），新 skill 分类按真实 `kind`。
- **上传 SKILL.md-only 文件夹不再 422**：修复原痛点（旧 `findSkillIr` 只认 skill.yaml，SKILL.md 被拒）。

### Fixed

- 上传普通 Claude Code Skill 文件夹（仅 SKILL.md）被 422 拒绝（`SKILL_VALIDATION_FAILED / no canonical Skill IR file found`）。
- 多文件 skill（references/scripts）安装丢失：旧 `buildArtifactFor` zip 只含 2 文件（编译 SKILL.md + manifest），references/scripts 不进制品。

### Known Issues

- 🟡 `harness-skill-optimizer` skill 文案仍提及 "Skill IR"（按原 YAML 逐字迁移，保证 INT-002b 语义完整性）；IR 已移除，skill 内容待后续更新为 source-file 模型语义。
