# Changelog

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
