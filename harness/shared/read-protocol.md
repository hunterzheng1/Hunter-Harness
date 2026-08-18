## 统一读取协议

0. **脚本在 `<skills-root>/scripts/` 共享，不在每个 skill 子目录下** — 实际形态是 `.codebuddy/skills/scripts/harness_*.py`（`.claude`/`.cursor`/`.codex` 同理），**没有** `.../skills/harness-<phase>/scripts/`。plan、run/test、archive 三份执行日志里都先猜成后者、报 `No such file` 再靠 Search 找回来；照第一种写法直接用
1. **`.harness/changes/<change-name>/` 是唯一真相源** — 所有输入从该目录读取，产物写入对应子目录
2. **change-name 优先从 frontmatter 读取** — `plans/*-design.md`、`spec/*-design.md`、`plans/*-plan.md` 的 YAML `change-name`
3. **frontmatter 缺失时兼容旧格式** — 从路径推断，标记 `🟡 legacy-plan`，不失败
4. **design** — 设计真相源按序取第一个存在的：`plans/<change>-design.md`（v2 发布产物，哈希绑定）→ `spec/<change>-design.md`（legacy 手写）。两份**同时存在**时以 `plans/` 为准，并记 `🟡 WARN 设计文档双份`——v2 发布的那份才受完整性门禁保护，读手写的那份等于绕过校验
5. **plan** — 任务真相源：`plans/<change>-plan.md`
6. **implementation-detail** — 自适应执行参考；legacy 缺失 🟡WARN，不阻断
7. **test-scenarios** — 测试真相源：`plans/<change>-test-scenarios.md`
8. **禁止读取 `docs/superpowers/` 作为正式输入** — 旧草稿仅人工线索
9. **每个 skill 边界只刷新一次状态快照** — 先运行 `python <skills-root>/scripts/harness_state.py capture --project . --change-dir ".harness/changes/<change-name>" --json`。首次 Plan 捕获时，脚本把当时的 Git HEAD 写入不可变 `changeBase`；后续阶段只刷新 `git.head` 与各段指纹，不得用当前 HEAD 覆盖 `changeBase`。只有迁移旧 change 且已能证明真实计划起点时，才在首次补录时传 `--base <baseCommit>`。`changedSegments=[]` 时复用已有 profile/rules/map/change/code 指纹，不再重复跑全量 `harness-sync` 或代码库扫描。`knowledge` 段仅为兼容空段，知识始终按需远端查询；快照不能替代源码读取和验证门禁。

状态目录分层：新路径优先，旧路径兼容 → [[../protocols/state-layout-protocol.md|state-layout-protocol]]
