## Worktree 门禁

读取 `meta/worktree.json`（兼容旧路径 `worktree.json`）：

| 条件 | 行为 |
|------|------|
| `requested=false` | 主目录执行 |
| `requested=true` + path 存在 | 切换 worktree 执行 |
| `requested=true` + path 不存在 | **必须创建**（run）或 **停止**（test/review/submit） |

**严禁** `requested=true` 时静默回主目录。创建失败 → 停止或 AskUserQuestion 降级（须 🟡WARN + 用户确认）。

**状态与代码分离**：代码/编译/测试在 `worktreeRoot`；`stateDir`（logs/events/ledger/reports）写回 `.harness/changes/<change-name>/`。

创建命令与 JSON 模板 → 各 skill `reference.md`（plan 写决策，run 创建/更新）。
