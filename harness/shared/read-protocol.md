## 统一读取协议

1. **`.harness/changes/<change-name>/` 是唯一真相源** — 所有输入从该目录读取，产物写入对应子目录
2. **change-name 优先从 frontmatter 读取** — `spec/*-design.md`、`plans/*-plan.md` 的 YAML `change-name`
3. **frontmatter 缺失时兼容旧格式** — 从路径推断，标记 `🟡 legacy-plan`，不失败
4. **spec** — 设计真相源：`spec/<change>-design.md`
5. **plan** — 任务真相源：`plans/<change>-plan.md`
6. **implementation-detail** — 自适应执行参考；legacy 缺失 🟡WARN，不阻断
7. **test-scenarios** — 测试真相源：`plans/<change>-test-scenarios.md`
8. **禁止读取 `docs/superpowers/` 作为正式输入** — 旧草稿仅人工线索
9. **每个 skill 边界只刷新一次状态快照** — 先运行 `python <skills-root>/scripts/harness_state.py capture --project . --change-dir ".harness/changes/<change-name>" --base <baseCommit> --json`；`changedSegments=[]` 时复用已有 profile/rules/map/knowledge/change/code 指纹，不再重复跑全量 `harness-sync`、知识重建或代码库扫描。只有对应 segment 变化或缺失时才定向刷新；快照不能替代源码读取和验证门禁。

状态目录分层：新路径优先，旧路径兼容 → [[../protocols/state-layout-protocol.md|state-layout-protocol]]
