# harness-skills — 通用 AI 辅助开发 Skill 集合

## 迁移说明

本包为通用 harness-skills，技术栈无关：构建/测试/打包命令按目标项目技术栈解析（Java=Maven、前端=npm、Python=pytest 等，详见项目 CLAUDE.md 或 `.harness/config/`）。文中 Java/Maven、Mapper/Controller/VO、Spring Boot、jar/war 等措辞仅为示例，不影响流程骨架的通用性。

环境、CodeGraph 等外部增强检查应在 `npx hunter-harness` 初始化阶段完成。Superpowers / grill-me 等外部技能只作为方法论来源与人工参考；`harness-plan`、`harness-run`、`harness-review` 已内化关键能力，不再运行时依赖外部 skill。


> 一套完整的 AI 辅助开发 Skill，覆盖从上下文同步到代码提交的全流程。
> 统一前缀 `harness`，在 Claude Code 中通过 `/harness-<能力>` 调用。
> 设计遵循 [Skill 最佳实践](技术知识库/01-AI开发工具/Claude-Code/ClaudeCode-Skill最佳实践.md)：pushy description + 原理说明 + 具体示例 + 避坑规则。

## 设计理念

- **为什么是 10 个核心 skill（Java overlay 再 +2）**：每个 skill 对应一个明确阶段，可以独立调用；Java 项目通过 `overlays/java/` 追加 apidoc/package，避免维护独立 fork
- **为什么每个 skill 都要有"为什么"部分**：skill 的使用者是 AI，理解"为什么这样做"比记住"必须这样做"更有效
- **为什么测试场景表要在编码前生成**：来自实践教训——编码后再写测试，遗漏率远高于编码前设计
- **为什么产出文件统一到 .harness/ 下**：集中管理 AI 开发产出，便于回溯、归档和清理；变更名机制让跨 skill 传递零成本
- **为什么同一时间最多一个未归档变更**：这样其他 skill 不需要指定变更名，自动扫描即可定位当前工作变更
- **为什么所有 git/构建命令必须通过 PowerShell**：Windows 中文路径项目下 Bash 工具会被 hook 直接拒绝（`Denied: non-ASCII path in Bash`），且 Bash 在中文路径下经常超时。统一通过 `powershell.exe -Command "..."` 执行，规避路径编码问题
- **为什么所有"成功"必须绑定证据**：来自实践教训——AI 容易把"命令被拒绝"误报成"成功"，把"静态验证"美化成"测试通过"，导致后续阶段基于错误结论继续。证据化报告强制把每个结论绑定到构建成功证据（Java 的 BUILD SUCCESS / 前端 build 成功 / exit 0）、git 实际输出、文件实际存在或 exit code 0

## 共用规则文件（强制约束）

跨 skill 共用的强制约束规则全部集中在 `protocols/` 下（8 个 protocol；其中 report pipeline 用于结构化事件、summary-data 生成和 final-summary 校验），各 skill 通过相对路径引用：

| 文件 | 作用 |
|------|------|
| `protocols/powershell-protocol.md` | Shell 执行安全策略：Windows/中文路径下禁止普通 Bash，所有 git/构建命令必须通过 `powershell.exe -Command "..."` 执行；命令被拒绝时不得回退普通 Bash；所有"成功"必须有明确证据（构建成功 / git 输出 / 文件存在 / exit code 0） |
| `protocols/sensitive-info-protocol.md` | 敏感信息脱敏：token、密码、Authorization header、Cookie、API key、access/secret key 不得明文出现在 execution-log、报告、commit message、final-summary 中；引用时统一替换为 `<TOKEN_REDACTED>` / `<PASSWORD_REDACTED>` / `<SECRET_REDACTED>` |
| `protocols/evidence-based-reporting-protocol.md` | 证据化报告：所有 skill 输出必须区分 ✅ 真实成功 / 🟡 静态验证或用户跳过 / ❌ 失败或被拒绝；禁止把"静态验证"写成"测试通过"，禁止把"命令被拒绝"写成"成功" |
| `protocols/ledger-protocol.md` | 验证账本：每个变更目录维护 `verification-ledger.json`，记录 compile/unitTest/apiTest 的结果+证据+diffHash+作用范围；后续阶段先读 ledger 判定是否可复用，避免跨阶段重复编译/测试；post-test 变更按 7 类分类，决定是否重跑 |
| `protocols/state-layout-protocol.md` | 状态目录分层：`.harness/changes/<cn>/` 下按 `meta/`、`logs/`、`evidence/`、`reports/`、`scripts/`、`backups/` 子目录分层写入；读取时先读新路径再兼容旧路径 |
| `protocols/submit-protocol.md` | 固定提交交互：提交方式与 commit message 确认使用固定选项模板，禁止 AI footer |
| `protocols/archive-report-protocol.md` | 归档报告：`summary-data.json` + 模板渲染 `final-summary.html`，含 manifest/checksum 真实性规则 |
| `protocols/report-pipeline-protocol.md` | 报告流水线：`events.ndjson` + `harness_archive.py finalize/replay` + final-summary 一致性校验 |

每个 skill 的 SKILL.md 关键规则章节都通过相对路径引用这些 protocol（`../protocols/powershell-protocol.md` 等）。

## allowed-tools 与 disallowed-tools 配置策略

由于 Claude Code 的 `allowed-tools` **不是白名单而是免确认通道**，harness-skills 使用 `allowed-tools` + `disallowed-tools` 双重策略实现 PowerShell-first：

- **`allowed-tools`**：`Bash(powershell.exe:*)` 预批准 PowerShell 调用（免确认），不限制其他工具
- **`disallowed-tools`**：禁止普通 Bash 的 git/构建/ls/find/grep/cat 等命令（激活期间硬限制）
- **不禁止 `Bash(powershell.exe:*)`**——这是 PowerShell 调用的免确认通道

| Skill | allowed-tools | disallowed-tools |
|-------|---------------|------------------|
| harness-plan | `[Read, Glob, Grep, Edit, Write, Agent, Bash(powershell.exe:*)]` | `Bash(git *)`, `Bash(mvn *)`, 等 14 项普通 Bash 命令 |
| harness-run | `[Read, Edit, Write, Glob, Grep, Bash(powershell.exe:*)]` | 同上 |
| harness-submit | `[Bash(powershell.exe:*), Read, Write, Edit, Glob, Grep]` | 同上 |
| harness-archive | `[Read, Edit, Write, Glob, Grep, Bash(powershell.exe:*)]` | 同上 |
| harness-test | `[Read, Glob, Grep, Write, Edit, Agent, Bash(powershell.exe:*)]` | 同上 + `Bash(node *)` |
| harness-review | `[Read, Write, Edit, Glob, Grep, Agent, Bash(powershell.exe:*)]` | 同上 |
| harness-sync | `[Read, Glob, Grep, Edit, Write, Bash(powershell.exe:*)]` | 同上 |
| harness-codebase-map | `[Read, Glob, Grep, Write, Edit, Agent, Bash(powershell.exe:*)]` | 同上 |
| harness-knowledge-query | `[Bash(powershell.exe:*), Read, Write, Edit, Glob, Grep]` | 同上 |
| harness-knowledge-ingest | `[Bash(powershell.exe:*), Read, Write, Edit, Glob, Grep]` | 同上 |

> **blocking user confirmation 不预批准**：各 skill 需要向用户确认时通过普通权限提示调用 `blocking user confirmation`（adapter 映射到 `AskUserQuestion`/`request_user_input`/普通对话），不在 `allowed-tools` 中预批准（遵循 skill-optimizer 规则）。`harness-codebase-map` 额外预批准 `Agent` 用于派发并行 mapper。

> **codegraph 命令**：原 `Bash(codegraph *)` 改为 MCP 工具调用（`mcp__codegraph__codegraph_explore` 等），不再通过 Bash。
>
> **推荐强治理模式**：详见 [claude-code-settings-recommendation.md](claude-code-settings-recommendation.md)——可通过 `permissions.deny` 和 PreToolUse Bash hook 进一步阻止普通 Bash。

## 产出目录结构

所有 skill 的持久化产出统一放在项目根目录的 `.harness/` 下（**全部不提交到 git**）：

```
.harness/
├── config/                          # 项目级配置（不提交）
│   └── harness-test-config.md       # 测试配置
├── archive/                         # 归档的历史变更（不提交）
│   └── YYYY-MM-DD-<change-name>/    # 已归档的变更（日期前缀便于排序，保持分层结构）
│       ├── meta/
│       │   └── archive-meta.md      # 归档元信息
│       ├── spec/
│       ├── plans/
│       ├── sqls/
│       ├── evidence/
│       ├── reports/
│       │   ├── test/
│       │   ├── review/
│       │   └── final/
│       │           ├── summary-data.json
│       │           └── final-summary.html  # 最终报告（代码量+产出清单+测试/审查摘要）
│       ├── events.ndjson                   # 结构化事件层（新流程推荐；历史 archive 可缺失）
│       └── backups/
├── <change-name>/                   # 当前未归档变更（最多 1 个，不提交）
│   ├── meta/                        # 元信息（harness-plan 写入 worktree 决策）
│   │   ├── change-context.json      # 变更路径上下文（见 protocols/state-layout-protocol.md）
│   │   ├── worktree.json            # Worktree 决策状态（plan 写入，run 执行）
│   │   └── manifest.json
│   ├── logs/
│   │   └── execution-log.md         # 执行日志（所有 skill 的时间线+指令+结果）
│   ├── spec/                        # 设计文档（harness-plan 产出）
│   │   └── <change-name>-design.md  # 技术方案设计，含 frontmatter（change-name/created/status/source）
│   ├── plans/                       # 计划文件（harness-plan 产出）
│   │   ├── <change-name>-plan.md              # 任务拆分简表，run 默认读取（含 frontmatter）
│   │   ├── <change-name>-implementation-detail.md  # 自适应详细执行参考（harness-plan 原生产出）
│   │   └── <change-name>-test-scenarios.md    # 测试场景表（4维度覆盖）
│   ├── evidence/                    # 验证证据
│   │   ├── verification-ledger.json # 验证账本（compile/unit/api 可复用结果）
│   │   └── run-task-status.md       # 任务执行状态（harness-run 持久化产出）
│   ├── reports/                     # 报告
│   │   ├── test/
│   │   │   └── test-report-YYYYMMDD-HHmm.md  # harness-test 产出（时间戳区分多次运行）
│   │   └── review/
│   │       ├── review-report-YYYYMMDD-HHmm.md  # harness-review 产出（时间戳区分多次运行）
│   │       └── fixback-YYYYMMDD-HHmm.md        # RED/YELLOW 修复反馈（按需）
│   ├── sqls/
│   │   └── V<version>__<desc>.sql   # 数据库迁移脚本（harness-run 产出）
│   ├── scripts/                     # 固定脚本和本次运行脚本
│   ├── runtime/                     # 运行时临时文件（不提交）
│   │   ├── api-test-runner.mjs      # 接口测试执行器脚本（harness-test 产出）
│   │   ├── api-test-results.json    # runner 输出的结构化结果
│   │   └── credential-cache.json    # 认证凭证缓存（旧名 token-cache.json 兼容读取）
│   └── backups/
│       └── uncommitted-tests/       # 未提交但用于验证的测试文件
```

**变更名规则**：
- 由 harness-plan 阶段1根据需求自动生成（kebab-case），无需用户确认
- 示例：`contribution-module`、`indicator-management`、`fix-duplicate-submit`
- 后续 skill（run/test/review）通过扫描 `.harness/changes/*/plans/`（排除 `.harness/archive/*/`）自动定位变更名
- 同一时间最多一个未归档变更，归档后运行 harness-archive

**.gitignore 建议**：
```gitignore
.harness/              # .harness 下所有文件都不提交到 git
```

## 执行日志与结构化事件机制

每个关联具体变更的 skill 只维护一个实时事实源：

- `.harness/changes/<change-name>/events.ndjson`：程序化事件层；人类可读上下文、降级原因和解释性文字写入事件 `note`。
- `.harness/changes/<change-name>/logs/execution-log.md`：由 `harness_events.py` 在 `phase.end` 自动重建的人类审计投影，禁止 Write/Edit。

渲染后的 `execution-log.md` 阶段格式统一：

```markdown
### [<序号>] harness-<skill> — YYYY-MM-DD HH:MM
- **触发指令**: <用户输入的原始指令>
- **开始**: YYYY-MM-DD HH:MM:SS
- **结束**: YYYY-MM-DD HH:MM:SS
- **耗时**: X分Y秒
- **结果**: ✅OK成功 / 🟡WARN(降级原因) / ❌FAIL(失败原因)
- **摘要**: <一两句话描述主要产出或问题>
```

- harness-plan 确定 change-name 后先追加 `phase.start`，脚本自动建立事件文件
- 后续每个 skill 开始时追加 `phase.start` 事件，结束时追加包含耗时/结果的 `phase.end` 事件
- **任何代码修改前必须先追加 `phase.start`**（不得等执行完才补记录）
- **降级时必须记录明确原因**（如"Agent 不可用，降级为主会话只读探索"），不可仅写"完成"
- **禁止末尾一次性补写**——各阶段实时 append 结构化事件，渲染日志不得直接编辑
- **Bash 拒绝、PowerShell 重试、降级、跳过、用户确认都必须记录**
- 日志状态统一使用 `✅OK / 🟡WARN(原因) / ❌FAIL(原因)`
- harness-archive 归档时从日志汇总：时间线、总用时、Skill 调用统计
- `harness_archive.py finalize/replay` 优先从 `events.ndjson` 汇总命令、验证、artifact、问题和决策；旧 archive 缺少 events 时才回放 execution-log/ledger/manifest
- sync 默认不关联具体变更目录，仅在已有变更目录时追加日志和 events
- archive 是例外：finalize 内部负责且仅负责一次 `phase.start` / `phase.end`，调用者不得重复追加阶段边界

## Skill 目录结构

```
harness-skills/
├── README.md                   # 本文件
├── CONTEXT.md                  # harness 原生协议与外部方法论术语表
├── agents/
│   ├── harness-explorer.md     # 只读代码探索（plan 预检后委派）
│   ├── harness-evaluator.md    # 计划对抗评审（仅 --adversarial / 显式要求）
│   └── harness-reviewer.md     # 6维度审查（review 预检后委派）
├── harness-sync/
│   ├── SKILL.md                # 元数据同步（10 项检查：7 核心 + 3 辅助）
│   └── reference.md            # 10 步检查的详细状态判断表格和输出示例
├── harness-codebase-map/
│   ├── SKILL.md                # 代码库地图生成（7 类文档 + summary + manifest）
│   ├── checklist.md            # 执行前后检查清单
│   ├── reference.md            # 模式选择 + manifest schema + mapper prompt
│   └── templates/              # 7 类文档 + map-summary + map-manifest.schema 模板
├── harness-plan/
│   ├── SKILL.md                # 需求规划→任务拆分→测试场景表
│   ├── checklist.md            # 阶段检查清单
│   ├── protocols.md            # 原生澄清/有限盘问/任务拆分协议
│   └── reference.md            # 详细模板和规则
├── harness-run/
│   ├── SKILL.md                # TDD 编码循环
│   ├── checklist.md            # 编码步骤检查清单
│   ├── protocols.md            # 原生 TDD / 变更簇审查协议
│   └── reference.md            # 编译失败策略 + TDD 降级 + 编码约束
├── harness-test/
│   ├── SKILL.md                # 测试执行 + 避坑规则索引
│   ├── checklist.md            # Phase 0 环境准备 7 项检查
│   ├── reference.md            # API 测试细节 + 响应验证
│   └── pitfalls.md             # 30 条避坑规则（详细说明）
├── harness-review/
│   ├── SKILL.md                # 6 维度代码审查
│   ├── checklist.md            # 6 维度详细检查项
│   ├── protocols.md            # 原生 fixback 修复反馈协议
│   └── reference.md            # 审查标准 + 报告模板
├── harness-submit/
│   ├── SKILL.md                # 验证→commit→push；worktree 模式含 --no-ff 合并回主分支
│   ├── checklist.md            # 提交流程 + worktree 合并详细步骤
│   └── reference.md            # commit message 格式 + Windows worktree 清理兜底
└── harness-archive/
    ├── SKILL.md                # 变更归档（移入 archive/）
    ├── checklist.md            # 归档前后检查项
    ├── reference.md            # 归档操作 + 占位符真实性规则
    └── templates/
        ├── summary-data-template.json  # final-summary 数据结构
        └── render-summary.mjs          # final-summary UTF-8 固定渲染脚本
```

## Skill 列表

| Skill | 调用方式 | 职责 | 前置依赖 | 自动调用 | 产出路径 |
|-------|----------|------|:--------:|:--------:|----------|
| harness-sync | `/harness-sync` | 10 项元数据检查（7 核心 + 3 辅助） | 初始化检查 | ✅ | 控制台报告 + 自动更新 |
| harness-codebase-map | `/harness-codebase-map` | 生成代码库地图（7 类文档 + summary + manifest） | `sync`/独立 | ✅ | `.harness/codebase/map/` |
| harness-plan | `/harness-plan` | 需求→设计→任务拆分→**测试场景表** + 自动命名变更名 | `sync` | ✅ | `.harness/changes/<cn>/plans/` |
| harness-run | `/harness-run` | TDD 循环 变更簇编码 | `plan` | ✅ | `.harness/changes/<cn>/sqls/` |
| harness-test | `/harness-test` | 单元测试+接口测试+30条避坑 | `run` | ✅ | `.harness/changes/<cn>/reports/test/` |
| harness-review | `/harness-review` | 6维度参考性审查（不阻塞后续流程） | `test` | ✅ | `.harness/changes/<cn>/reports/review/` |
| harness-submit | `/harness-submit` 或 `/harness-merge`（别名） | commit+push（主目录）/ worktree：本地 commit→--no-ff 合并→push 主分支 | `review` | ✅ | ledger `mergeFinalHash` + 控制台报告 |
| harness-archive | `/harness-archive` | 归档产出到 archive/YYYY-MM-DD-<cn>，释放工作区 | `submit` | ✅ | `.harness/archive/YYYY-MM-DD-<cn>/` |
| harness-knowledge-query | `/harness-knowledge-query` | 查询 .harness/knowledge 历史上下文，生成需求 context pack | `sync`/独立 | ✅ | `.harness/knowledge/context-packs/` |
| harness-knowledge-ingest | `/harness-knowledge-ingest` | 从 archive 整理/同步/维护知识索引（promote/demote/audit） | `archive` | ✅ | `.harness/knowledge/index.json` |

> 所有 harness skill 均支持被其他 skill 调用。`harness-run`、`harness-submit`、`harness-archive` 涉及 git 写操作、文件移动或归档，被其他 skill 调用时必须确保前置条件已满足。
> `<cn>` = change-name，由 harness-plan 阶段7确定。其他 skill 自动扫描未归档变更定位。

## 关键合规约束（强制）

以下是各 skill 必须遵守的关键约束，违反任何一条都会导致流程被认定为不合规：

### Shell 与执行安全

- **PowerShell-first 自动重试**：Claude 必须默认使用 PowerShell 执行 git/构建/系统命令；如果误用普通 Bash 且被 hook 拒绝，不得中断流程或推断成功，必须立即自动改用等价 PowerShell 命令重试一次
- **禁止普通 Bash**：Windows / 中文路径下，所有 git/构建/文件移动命令必须通过 `powershell.exe -Command "..."` 执行
- **PowerShell 重试失败才停止**：只有 PowerShell 重试也失败、被拒绝、超时、无有效输出、或 exit code 非 0，才停止当前阶段并标记 ❌FAIL 或 🟡WARN
- **失败检测**：输出含 `Denied` / `PreToolUse:Bash hook error` / 非 0 exit code / 无有效 stdout 时，状态必须标记为失败或未知，**不得宣称"成功"**

### P0 执行可信度规则

见 [[shared/p0-trust.md|p0-trust]]（各 SKILL 通过 `<!-- @include shared/p0-trust.md -->` 引用）。

### 证据化报告

- **编译成功**必须有构建成功证据（Java 的 `BUILD SUCCESS` / 前端 build 成功 / exit 0）
- **测试通过**必须有测试通过证据（Java 的 `Tests run: N, Failures: 0, Errors: 0` / 前端 N passing 等）
- **拉取/推送成功**必须有 git 实际成功输出（`Already up to date.`、`Fast-forward`、`To <remote>` 等）
- **三类状态严格区分**：✅ 真实成功 / 🟡 静态验证或用户跳过 / ❌ 失败或被拒绝

### 各阶段强制检查

| 阶段 | 强制检查 |
|------|---------|
| **plan 阶段 0** | 检查工作区是否有未提交业务代码变更，已有则询问用户处理方式（继续/暂存/回滚/取消），不得假装"编码前规划" |
| **plan 阶段 3** | 默认主会话 CodeGraph/Read inline 探索；仅高复杂度且准备委派固定 agent 时单次预检，失败或无效返回立即 inline，不 retry |
| **plan 阶段 4/6** | 原生规划协议必须记录风险/复用/替代方案/推荐方案/关键决策，以及任务拆分摘要 |
| **plan 阶段 5** | 设计文档自审结果必须展示给用户；测试场景表未覆盖维度必须标记为 ⚠️ 缺口，不得全部 ✅ |
| **run 步骤 0** | 任何代码修改前必须先向 `events.ndjson` 追加 `phase.start`；执行日志由阶段结束事件自动渲染 |
| **run 轻量验证** | `/harness-run` 默认只做开发反馈：TDD RED/GREEN + REFACTOR + 构建命令增量编译（Java 的 `mvn compile -pl <module>` 等）+ 关门检查 + 写 verification-ledger；除非改了公共模块/数据访问层/sql/权限认证/接口层/数据契约 或用户要求 full-run-validation 或不打算继续 `/harness-test`，否则不默认跑全量测试命令（Java 的 `mvn test` 等）。若跑了全量测试必须写入 ledger 供 test/submit 复用 |
| **run TDD 降级** | 输出必须写"🟡 静态逻辑验证通过，未执行真实单元测试"，**禁止写"测试全部通过"**；降级标注写在执行日志和覆盖报告中，**不污染业务代码注释**；记录三项：降级原因、静态验证场景列表、待部署后验证场景列表 |
| **test ledger 复用** | Phase 1 单元测试前先读 `verification-ledger.json`：若 run 阶段已对同一 diffHash/module/profile 跑过单元测试命令（Java 的 `mvn test` 等）且测试通过（Java 的 `Tests run: N, Failures: 0, Errors: 0` / 前端 N passing），可跳过重跑并标记"✅ 复用 harness-run 单元测试结果"；diffHash 不一致 / profile 不一致 / 命令范围更窄 / run 后有行为性修改则不得复用 |
| **test 批量 runner** | 默认使用 **PowerShell 接口测试执行器**：生成 `.harness/changes/<cn>/runtime/api-test-runner.mjs`，通过一次 PowerShell + node 执行全部场景，输出 `api-test-results.json`，主会话只读 JSON 生成摘要。Playwright MCP `browser_evaluate` 仅作 fallback，报告必须区分执行器：PowerShell 接口测试执行器 ✅使用 / PowerShell batch 🟡fallback / Playwright MCP 🟡fallback / curl 🟡fallback |
| **test token 策略** | 先读 `.harness/changes/<cn>/runtime/credential-cache.json`（旧名 `token-cache.json` 兼容），本地轻量接口验证通过则复用，失败才访问远程 SSO；接口测试执行器必须用 request context / node fetch 直接请求本地 baseURL，**不得依赖浏览器当前页面 origin** |
| **post-test 变更分类** | test 之后发生代码变更时，submit/archive 必须按 7 类分类（NON_BEHAVIORAL_CLEANUP / COMMENT_ONLY / TEST_ONLY / BEHAVIORAL_SERVICE_CHANGE / API_CONTRACT_CHANGE / SQL_OR_MAPPER_CHANGE / SECURITY_OR_PERMISSION_CHANGE）写入 ledger 的 `postTestClassification`；非行为性清理可复用 API 测试结果但须记录依据，行为性变更必须重跑相关场景 |
| **submit 时序** | `/harness-submit` 完成后：主目录模式可直接 `/harness-archive`；worktree 模式在同一 skill 内自动完成合并后再 archive |
| **submit ledger 复用** | 验证前先读 `verification-ledger.json`：若当前 diffHash 已通过 test 完整验证且无行为性 post-test 修改，submit 不默认重跑构建命令/测试命令（Java 的 `mvn compile`/`mvn test` 等）；只在远端有新提交 / staged diff 与 ledger 不一致 / 行为性 post-test 修改 / test 报告缺失或失败 / 用户要求 submit-full-verify 时重跑，重跑结果写回 ledger |
| **submit commit message** | subject 只根据当前 `git diff --cached` 或本次变更名生成，**不得混入历史任务上下文** |
| **submit 步骤 3.5** | 强制检查 `.gitignore` 是否包含 `.harness/`；**禁止 `git add -A`** 一把梭，避免 `.harness`/日志/敏感信息被提交 |
| **submit 步骤 4** | 提交前必须展示四项：实际 staged 文件列表、diff stat、commit message、是否 push |
| **submit push 前** | `git fetch` 后检查远程是否有新提交；有则**不得直接 pull 后 push**，必须 pull/rebase + 重新 compile/test |
| **submit hash 记录** | pre-pull local hash + final pushed hash 双标注（主目录）；worktree 模式 submit 段只本地 commit，合并段产生 `mergeFinalHash`，archive 以 `mergeFinalHash` 为准（无则回退 final pushed hash） |
| **archive 阶段 1** | 归档前确认 commit 已 push、hash 与 submit/merge 记录一致、test/review 报告状态；阶段边界由 finalize 单进程维护，调用者不额外 append |
| **archive 文件移动** | 只用 PowerShell 或 Read+Write+验证，**禁止 Bash mv/cp/rm**；移动失败时不删除原目录 |
| **archive final-summary.html** | 默认运行 `harness_archive.py finalize`：由 events/ledger/log/manifest 生成 `summary-data.json`，再由 `templates/render-summary.mjs` 渲染 `final-summary.html`，内嵌 validate。无测试或无 review 时必须在 JSON 中标记 `NOT_RUN` / `ADVISORY_NOT_RUN`，禁止伪造 100% 通过率。必须真实展示状态演进（✅OK / 🟡WARN / 🔁REUSED / 🔁RETESTED / 📝ADVISORY / 🧹NON_BEHAVIORAL_CLEANUP） |

### 敏感信息脱敏

- token / Authorization / Cookie / Redis 密码 / 数据库密码 / API key / access&secret key 不得明文出现在 execution-log、报告、commit message、final-summary 中
- 引用敏感值时统一使用占位符：`<TOKEN_REDACTED>` / `<PASSWORD_REDACTED>` / `<SECRET_REDACTED>` / `<API_KEY_REDACTED>` / `<AUTH_HEADER_REDACTED>` / `<COOKIE_REDACTED>`
- 命令示例使用占位符，不复述真实值
- 测试中临时使用的 token 在持久化测试报告中必须替换为占位符

## 完整流程

```
                    ┌──────────────┐
                    │ 初始化检查 │ 由 `npx hunter-harness` 初始化阶段完成（非 skill）
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ harness-sync │  "10 项元数据检查" — git pull 后跑
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  harness-    │  "需求规划" — 需求→计划+场景表
                    │   plan       │       (自动命名 change-name)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  harness-    │  "TDD 编码" — RED→GREEN→REFACTOR
                    │   run        │       逐任务实现
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ harness-test │  "测试验证" — 单元+接口+数据兼容
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  harness-    │  "参考性审查" — 6 维度
                    │   review     │       📝不阻塞提交
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  harness-    │  "提交+合并" — 主目录:commit+push / worktree:commit→merge --no-ff→push
                    │   submit     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  harness-    │  "归档" — 释放工作区
                    │   archive    │       移入 archive/
                    └─────────────┘
                           │
     ┌─────────────────────▼──────────────────────────┐
     │       .harness/changes/<change-name>/                    │
     │  plans/ | reports/ | sqls/                  │
     │  所有产出集中管理，跨 skill 自动引用              │
     │  归档后移入 .harness/archive/YYYY-MM-DD-<change-name>/      │
     └─────────────────────────────────────────────────┘
```

> **harness-review 是参考性审查阶段**：默认只生成参考性审查报告和按需 fixback，不影响后续 submit、archive。如果用户选择处理 fixback，回到 `/harness-run --fixback`，再执行 `/harness-test` 和 `/harness-review`；如果团队希望 review RED 阻塞提交，可在 `.harness/config/harness-test-config.md` 中设置 `review.strict-review-gate: true`。

> **submit 与 archive 的时序**：主目录模式流程为 `run → test → review(advisory) → submit(含 push) → archive`；worktree 模式流程为 `run → test → review → submit(本地 commit + 自动 --no-ff 合并 + push 主分支) → archive`。`/harness-merge` 为 submit 的别名触发词。archive 优先读 ledger `mergeFinalHash`。

> **verification-ledger 驱动跨阶段复用**：每个变更目录维护 `.harness/changes/<change-name>/evidence/verification-ledger.json`，记录 compile/unitTest/apiTest 的结果+证据+diffHash+作用范围。run/test/submit 执行验证前先读 ledger，满足复用条件（diffHash 一致、module/profile 一致、范围更严格、有证据、无行为性 post-test 修改）则跳过重跑并标记 🔁REUSED；post-test 小改动按 7 类分类，非行为性清理可复用 API 测试。详见 `protocols/ledger-protocol.md`。

## 外部方法论吸收（已内化）

`harness-plan`、`harness-run`、`harness-review` 已将外部 skill 的有效方法内化为原生协议，不再运行时调用 Superpowers、grill-me 或 `receiving-code-review`，也不检查、降级或同步 `docs/superpowers/` 草稿。

| 方法论来源 | harness 落点 | 当前关系 |
|------------|--------------|----------|
| brainstorming | `harness-plan/protocols.md` 的 clarification-protocol | 已内化：风险、复用机会、替代方案、推荐方案 |
| grill-me | `harness-plan/protocols.md` 的 decision-grilling-protocol | 已内化：有限问题预算、一次一问、每问推荐答案 |
| writing-plans | `harness-plan/protocols.md` 的 implementation-planning-protocol | 已内化：任务简表、自适应执行参考、无占位符自检 |
| Superpowers TDD / subagent-driven-dev | `harness-run/protocols.md` 的 run-tdd-protocol / change-cluster-review-protocol | 已内化：RED 类型、GREEN 最小实现、风险触发审查 |
| receiving-code-review | `harness-review/protocols.md` 的 review-fixback-protocol | 已内化：RED/YELLOW 转结构化 fixback |

> **状态说明**：Superpowers / grill-me 可作为人工参考或后续方法论对标来源，但不是 harness 正式流程的运行时依赖；缺失时不触发降级记录。

## shared/ 片段与 overlay 合成（D12/D9）

Vault 内 SKILL.md 用 `<!-- @include shared/xxx.md -->` 引用公共段落（`p0-trust`、`read-protocol`、`logging`、`worktree-gate`）。**部署到目标项目前**须运行 `scripts/harness_deploy.py` 展开为自包含单文件。

| 路径 | 作用 |
|------|------|
| `shared/` | 源片段（Vault 维护，不直接复制到项目） |
| `overlays/java/` | Java 差异：`.overlay.md` 锚点合并 + `harness-apidoc`/`harness-package` + `pitfalls-java.md` |
| `overlays/java/PROJECT-PROFILE-EXAMPLE.md` | 项目专属 build-profile 示例（不进 skill 正文） |

Java 版独立目录已退役 → [[../../Java后端/harness-skills/README.md|Java harness-skills README]]。

## 安装（推荐：deploy 合成）

```powershell
$skillsRoot = "<Vault>/技术知识库/03-工作流/通用/harness-skills"
$out = "<build-output-dir>"

# 通用项目
python "$skillsRoot/scripts/harness_deploy.py" build --skills-root $skillsRoot --out $out --json

# Java 后端（core + java overlay → 12 skill 自包含树）
python "$skillsRoot/scripts/harness_deploy.py" build --skills-root $skillsRoot --overlay java --out $out --json

python "$skillsRoot/scripts/harness_deploy.py" install --from $out --project "<目标项目>" --json
python "$skillsRoot/scripts/harness_deploy.py" diff --from $out --project "<目标项目>" --json   # harness-sync 可调用
```

安装后首次 Java 项目运行：`python "$skillsRoot/scripts/harness_preflight.py" detect --project "<目标项目>" --json` 生成 `.harness/config/build-profile.json`。

### 手动复制（不推荐，无 include 展开）

将整个 `harness-skills/` 目录下的子目录复制到目标项目的 `.claude/skills/` 下：

```powershell
# 复制所有 skill 到目标项目
powershell.exe -Command "Copy-Item -Path 'harness-skills/harness-*' -Destination '<目标项目>/.claude/skills/' -Recurse -Force"
```

或者只复制需要的 skill：

```powershell
powershell.exe -Command "Copy-Item -Path 'harness-skills/harness-test' -Destination '<目标项目>/.claude/skills/' -Recurse -Force"
```

Claude Code/CodeBuddy 可选复制 3 个隔离角色：`harness-explorer` 仅高复杂度探索、`harness-evaluator` 仅 `--adversarial`/高风险规划、`harness-reviewer` 仅发布候选/高风险审查。Codex/Cursor 默认使用主会话或宿主临时隔离任务，不安装固定角色，也不执行固定 agent 预检：

```powershell
powershell.exe -Command "Copy-Item -Path 'harness-skills/agents/*.md' -Destination '<目标项目>/.claude/agents/' -Recurse -Force"
```

Claude Code 会自动识别 `.claude/skills/` 下的 skill 目录（每个目录必须含 `SKILL.md`）。

**安装后配置**：在目标项目的 `.gitignore` 中添加：
```gitignore
.harness/              # .harness 下所有文件都不提交到 git
```

## 快捷调用

```
npx hunter-harness   # 初始化阶段检查环境/CodeGraph/基础状态（非 skill）
/harness-sync         # 10 项元数据检查（7 核心 + 3 辅助）
/harness-codebase-map  # 生成代码库地图（7 类文档）
/harness-plan         # 需求规划（生成测试场景表 + 自动命名变更名）
/harness-run          # TDD 编码
/harness-test         # 运行测试（30条避坑规则）
/harness-review       # 代码审查
/harness-submit       # 提交代码（worktree 模式含合并；/harness-merge 为别名）
/harness-archive      # 归档产出（harness_archive.py finalize），释放工作区
```

## 避坑知识来源

`harness-test/pitfalls.md` 中的 30 条避坑规则来自真实对话日志（2026-06-12 ~ 06-24）。

---
← 返回 [[AI开发工作流|工作流主页]]
← 参考 [[项目初始化指引]]
← 参考 [[TDD测试流程]]


### Worktree 决策状态

`harness-plan` 阶段 2 用户选择后，必须写入 `.harness/changes/<change-name>/meta/worktree.json`。`harness-run` 负责读取该文件并创建/切换 worktree。

硬规则：如果 `worktree.json` 中 `requested=true`，而 worktree 不存在，`harness-run` 必须创建 worktree 或停止，不得静默回到主目录执行。


## Cross-skill Protocols

为减少重复规则和阶段间不一致，通用协议集中在 `protocols/`：

- `protocols/powershell-protocol.md`：Windows 中文路径命令执行协议（已取代原 `harness-plan/shell-safety.md`，各 skill 引用此版本）。
- `protocols/ledger-protocol.md`：verification-ledger、真实 diffHash、service-fingerprint（已取代原 `harness-plan/verification-ledger.md`，各 skill 引用此版本）。
- `protocols/sensitive-info-protocol.md`：敏感信息脱敏（token/密码/密钥占位符化，已取代原 `harness-plan/sensitive-info.md`，各 skill 引用此版本）。
- `protocols/evidence-based-reporting-protocol.md`：证据化报告（✅/🟡/❌ 三态，已取代原 `harness-plan/evidence-based-reporting.md`，各 skill 引用此版本）。
- `protocols/submit-protocol.md`：固定提交交互、中文 commit 文件、禁止 AI footer。
- `protocols/archive-report-protocol.md`：summary-data + template 渲染 final-summary、manifest/checksum。
- `protocols/report-pipeline-protocol.md`：events.ndjson + `harness_archive.py finalize/replay` + final-summary 一致性校验。
- `protocols/state-layout-protocol.md`：`.harness/changes/<cn>/` 子目录分层（meta/logs/evidence/reports/scripts/backups），读取先新后旧。

各 skill 的 `SKILL.md` 只保留阶段目标和硬门禁，细节优先引用这些协议，避免在多个 skill 中复制并产生冲突。


## State Layout Protocol（新增）

新版本 `.harness/changes/<change-name>/` 默认按子目录分层写入：

```text
meta/       worktree.json、change-context.json、manifest
logs/       execution-log.md
evidence/   verification-ledger.json、run-task-status.md
reports/    test/review/final 报告
scripts/    固定脚本和本次运行脚本
backups/    未提交但用于验证的测试文件等备份
```

读取时先读新路径，再兼容旧路径。详见 `protocols/state-layout-protocol.md`。

Archive 最终报告默认运行 `harness_archive.py finalize`，再使用 `harness-archive/templates/render-summary.mjs` 从 `summary-data.json` 渲染，避免 PowerShell 中文乱码、模型长 HTML 生成中断和日志汇总统计漂移。
