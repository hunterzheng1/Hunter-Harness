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
