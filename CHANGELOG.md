# Changelog

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
