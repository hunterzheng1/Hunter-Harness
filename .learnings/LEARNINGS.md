# Project Learnings

## [LRN-20260714-001] correction

**Logged**: 2026-07-14T22:45:00+08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
未选择某个 Agent 不等于授权 Harness 删除或清理该 Agent 的目录。

### Details
在 CLI 多 Agent 配置设计中，曾错误地把“没有选择 Claude Code”解释为应清理空的 `.claude/agents`。正确边界是：未选择的 Agent 完全不介入其命名空间；只有目标此前由 Harness 明确管理且用户在变更预览中显式选择清理时，才允许删除对应的受管文件。任何用户文件都不得删除。

### Suggested Action
Agent 选择模型采用非侵入式增量语义：选择表示安装或刷新；未选择表示不处理。若要提供卸载，必须作为独立显式操作，并展示将删除的受管文件清单后确认。

### Metadata
- Source: user_feedback
- Related Files: packages/cli/src/commands/configure.ts, packages/core/src/project/refresh.ts
- Tags: agent-selection, non-invasive, deletion-boundary
- Pattern-Key: config.unselected_agent_noop
- Recurrence-Count: 1
- First-Seen: 2026-07-14
- Last-Seen: 2026-07-14

---

## [LRN-20260811-001] correction

**Logged**: 2026-08-11T17:04:17+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
本地 Harness 安装与恢复不应扫描用户 Agent 文档中的账号、密码或路径并阻断文件下载。

### Details
曾把 `RECOVERY_MIRROR_SENSITIVE_CONTENT` 解释为应保留的安全门禁，仅建议跳过无变化文件。用户明确了产品边界：`npx hunter-harness` 的职责是下载并安装所选 Agent/Profile 的官方文件，不负责审查 `AGENTS.md`、`CODEBUDDY.md` 等本地内容。账号与密码扫描属于远端上传/发布边界，不属于本地安装、刷新或本地恢复；以此阻断安装是产品行为错误，而不只是错误提示不清晰。

### Suggested Action
从 init/refresh/local recovery 路径移除内容敏感扫描；继续校验官方 Bundle 的来源、manifest 与 SHA-256，并仅在 push/archive/外部上传等离开本机的边界执行敏感扫描。保留事务路径安全与原子恢复，不把内容审查混入文件安装。

### Resolution
CLI 0.2.69 已移除本地耐久恢复镜像的内容扫描及允许哈希例外；初始化、刷新和恢复只校验受管路径、事务完整性与原子写入。新增回归测试覆盖已有 CodeBuddy 指令文件、敏感样例字节的中断续传与回滚，外发扫描保持不变。

### Metadata
- Source: user_feedback
- Related Files: packages/core/src/transaction/recovery-store.ts, packages/core/src/project/initialize.ts, packages/core/src/project/refresh.ts
- Tags: recovery-mirror, local-install, sensitive-scan, product-boundary
- Pattern-Key: security.scan_only_on_external_egress
- Recurrence-Count: 1
- First-Seen: 2026-08-11
- Last-Seen: 2026-08-11

---

## [LRN-20260825-001] correction

**Logged**: 2026-08-25T15:00:00+08:00
**Priority**: high
**Status**: pending
**Area**: testing

### Summary
字节冻结的测试夹具必须用 `.gitattributes -text` 固定行尾，否则 `core.autocrlf=true` 的
Windows 检出会把它们转成 CRLF，字节哈希/字节数断言必挂。

### Details
冻结夹具（哈希、字节数、golden JSON 字符串）在多平台一致性依赖“磁盘字节 == 提交字节”。
本仓此前只对部分路径（`resources/harness/**`、`harness/**`、v0.1.1 迁移夹具、content-sync
夹具）做了行尾固定，`packages/contracts/test/fixtures/**` 与 `packages/core/test/fixtures/**`
遗漏，导致平台信息导出、远端上传/归档契约、archive-outbox 序列化等 4 个测试文件在
Windows 上长期红灯，且容易被误判为“环境问题”。新增字节冻结夹具时，必须同步在
`.gitattributes` 补 `-text`，并验证 `wc -c` 与 `git cat-file -s <blob>` 一致。

### Suggested Action
任何新增的字节级断言夹具（哈希/字节数/原文比对）提交前检查：是否已在 `.gitattributes`
标记 `-text`；用 `git ls-files -s` + `git cat-file -s` 对比磁盘字节数验证未被行尾规范化。

### Metadata
- Source: debugging
- Related Files: .gitattributes, packages/contracts/test/fixtures/, packages/core/test/fixtures/
- Tags: gitattributes, autocrlf, byte-frozen-fixture, cross-platform
- Pattern-Key: testing.byte_frozen_fixture_eol
- Recurrence-Count: 1
- First-Seen: 2026-08-25
- Last-Seen: 2026-08-25

---

## [LRN-20260825-002] correction

**Logged**: 2026-08-25T15:05:00+08:00
**Priority**: high
**Status**: pending
**Area**: core

### Summary
给 runCli 注入精简 env 的测试必须透传 `HUNTER_HARNESS_RECOVERY_ROOT`，否则
`resolveRecoveryRoot` 读 `dependencies.env` 缺键，回退到开发者机器的真实恢复存储。

### Details
`tests/setup/global-temp.ts` 的重定向只写入主进程 `process.env`；而 CLI 命令走
`resolveRecoveryRoot(dependencies.env)`，注入 `env: {}` 的用例丢掉重定向键，把测试事务的
durable 副本写进 `%LOCALAPPDATA%/HunterHarness/recovery`，实测 18 天堆出 1.87M 文件/37GB，
并让每次 runCli 多花十几秒遍历索引。修复：共享 `packages/cli/test/recovery-env.ts` 透传，
teardown 泄漏守卫计数报警兜底。

### Suggested Action
新增给 runCli 传自定义 env 的用例时，一律 `env: { ...recoveryEnv, <额外键> }`；
review 时把“自定义 env 是否含恢复根”作为检查项。注意隐蔽场景：测试文件里裸的
`runCli(["--profile", ...])`（无命令名）就是 init，同样写恢复记录（knowledge-query 用例曾因此泄漏）。

### Metadata
- Source: debugging
- Related Files: packages/cli/test/recovery-env.ts, tests/setup/global-temp.ts, packages/core/src/transaction/recovery-store.ts
- Tags: recovery-store, env-isolation, test-hygiene, leak-guard
- Pattern-Key: testing.custom_env_recovery_root
- Recurrence-Count: 1
- First-Seen: 2026-08-25
- Last-Seen: 2026-08-25

---
