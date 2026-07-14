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
