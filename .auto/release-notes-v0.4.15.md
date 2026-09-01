## [0.4.15] — hunter-harness + workflow-harness

> 知识链路与隔离位置修复轮：知识候选补 Goal 抽取（变更意图可被自然语言检索）、
> 私有证据隔离根不再落到驱动器根、RemoteSync 缺 scope 错误带 required_scope、
> 新增 plan→execute→review→submit 生命周期端到端测试。
> CLI 0.4.14 → 0.4.15，workflow-harness 0.4.14 → 0.4.15，bundle 0.2.74 → 0.2.75
> （harness 源码变更），minimumCliVersion 保持 0.4.13。

### Fixed

- **知识候选生成补 Goal 抽取**：`build_plan_candidates` 此前只从 design 的
  Requirements/Invariants/Risks 与 plan 的 Tasks、test-scenarios 提取候选，
  「这个变更做了什么」只写在 design.md 的 Goal 与 User-visible outcome 段，
  用户按变更意图检索（如「问候语模块」）查不到。新增 `_goal_from_design` 把
  Goal + User-visible outcome 提取为 requirement 候选（body 带目标/用户可见结果）。
  2026-09 真实环境自测：greeting-module 归档后 `knowledge query '问候语'`
  0 命中 → 补 Goal 后 1 命中。
- **私有证据隔离根不再落到驱动器根**：默认根 `~/.harness/private-evidence`（C 盘）
  与项目跨盘时 `os.replace` 报 WinError 17，代码此前退到「源所在驱动器根」的
  `.harness-private-evidence`——Windows 上污染盘根、权限受限且不私密。改为
  `_transfer_evidence` 同卷 `os.replace`、跨卷 `shutil.copy2 + unlink`（digest
  校验与 fail-closed 保留），隔离根恒为 `~/.harness/private-evidence` 或
  `HARNESS_PRIVATE_EVIDENCE_ROOT`，不再回退盘根。
- **RemoteSync 缺 scope 错误带 required_scope**：project-key 缺 `files:read/write`
  时 pull/push 此前只报裸 `PROJECT_KEY_SCOPE`，不知道要补哪个权限；现在
  `errorFromResponse` 把服务端 details 拼进 serverCode（如
  `PROJECT_KEY_SCOPE (required_scope=files:read)`）。

### Tests

- **新增 plan→execute→review→submit 生命周期端到端测试**：用 subprocess 真实调用
  harness_gate/context/ledger/review 走完整链（无 mock），断言阶段事件序列严格
  plan→execute→review→submit、review findings 绑定 run_id、execute phase.end
  run_id 与 begin 一致（attempt 连续性）、无前一阶段时 handoff fail-closed。
  3 轮稳定，gate/context/review/runtime 回归全绿。
