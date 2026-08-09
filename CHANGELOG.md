# Changelog

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
