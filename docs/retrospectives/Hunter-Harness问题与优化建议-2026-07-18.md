# Hunter-Harness 问题与优化建议

## 1. 背景与结论

- 项目：CBM Forge
- Change：`phase1-single-well-integration`
- Harness run：`run-763cdd7a79ec47e7951432f712266fca`
- 记录日期：2026-07-18
- 本次产品验证结果：后端与地理模块 85 项测试通过、前端 51 项测试通过、真实栈 E2E 通过、数据库备份恢复通过、百万点性能验证通过。
- Harness 最终门禁：`OK`。

虽然本轮最终门禁成功关闭，但执行过程中出现了可能导致证据丢失、统计失真或“假通过”的 Harness 问题。以下问题按风险排序，事实、影响和建议分开描述。

## 2. P0：测试守卫允许空记录关闭，可能形成假通过

### 观察事实

当前 build profile 中 `testTracking.paths=[]`。向 test guard 记录真实测试文件时，所有路径均返回 `TEST_PATH_NOT_ALLOWED`。最终 test guard 仍可关闭为 `CLOSED`，结果为：

```text
files=[]
recordedCount=0
```

与此同时，外部测试命令实际已执行并通过，包括 85 项后端/地理测试、51 项前端测试和真实栈 E2E。

### 风险

- 最终报告可能把“无法记录测试”误写为“没有测试”或“测试为 0”。
- 门禁可在零测试证据下返回 `OK`，属于 fail-open。
- archive、final report 和知识库无法恢复真实的 run/passed/failed/skipped 数据。

### 建议

1. build profile 启用测试跟踪时，禁止 `paths=[]`；profile 加载阶段直接报配置错误。
2. 明确空数组语义：要么表示“允许全部项目内测试路径”，要么表示“禁用 test guard”，不能同时表现为“拒绝所有路径但允许关闭”。
3. 若计划或验证账本声明存在测试任务，而 `recordedCount=0`，test guard 和 phase gate 必须 fail-closed。
4. 测试证据改为结构化字段：`command`、`framework`、`run`、`passed`、`failed`、`skipped`、`durationMs`、`exitCode`、`artifactPath`。
5. 增加回归用例：空 paths、全拒绝、部分记录、零测试、外部测试已执行但守卫未记录。

## 3. P0：Harness 状态写入主工作区，而不是当前 worktree

### 观察事实

integration 实现在独立 worktree 中进行，但 Harness 脚本把 canonical 状态写入主工作区的：

```text
.harness/changes/phase1-single-well-integration/
```

为了让功能分支携带最终证据，本轮需要把主工作区中的 events、ledger、test-guard snapshot、execution log 和 worktree metadata 再同步到 integration worktree。同步后还需处理换行差异。

### 风险

- 主工作区被非预期写脏。
- 多个 Change 并行时共享写同一状态目录，存在覆盖、丢事件和证据串线风险。
- worktree 分支提交可能遗漏 canonical Harness 证据。
- submit/archive 若执行全仓 stash 或清理，会误处理其他 Change 的未提交证据。

### 建议

1. 每个 run 的动态状态只能有一个明确 owner，默认写入当前 worktree。
2. canonical 聚合应使用独立事务目录或数据库，不应直接复用主工作区的可变 Git 路径。
3. 合并状态时按 `runId + eventId` 做超集合并，不按文件覆盖。
4. submit 禁止对整个主工作区执行全仓 stash；只处理 Change ownership 清单内的路径。
5. 引入 transaction journal：记录源路径、目标路径、前后 hash、事件 ID、恢复动作和最终提交。

## 4. P1：长任务租约固定一小时且不会自动续期

### 观察事实

完整后端测试约 12 分钟，真实栈 E2E 约 2.5 分钟，另有故障注入、并发、性能、备份恢复和安全验证。整轮验证超过默认一小时后，phase gate 关闭时发现 lease 已过期，只能使用相同 run-id 重新 begin/续租后再关闭。

### 风险

- 正常运行中的长任务被判定为失去所有权。
- close 阶段才发现租约失效，造成最终状态悬空。
- 自动化环境可能错误重启同一任务，产生重复执行或并发写状态。

### 建议

1. Harness runner 在每个任务完成、证据写入和测试心跳时自动续租。
2. lease TTL 应基于 build profile 或执行计划估算，并设置合理上限。
3. 剩余租约低于阈值时主动告警，而不是等 close 失败。
4. 同 run-id 续租必须保留原始 attempt、事件链和耗时，不能重置统计。
5. 增加超过 TTL 的模拟长任务回归测试。

## 5. P1：最终报告与归档统计不能可靠地从证据恢复

### 既往实证

在 `phase1-single-well-product` 流程中曾出现：

- 实际 Vitest 52/52、Playwright 9/9，最终 report 却显示测试为 0 或 `not_available`。
- archive 耗时字段出现约 1 秒或 85ms/837ms 等互相冲突的值，不能代表真实流程耗时。
- review 实际为 2 RED / 4 YELLOW，最终汇总曾显示为 0。
- `baseCommit..mergeFinalHash` 跨过并行证据提交，导致 changedFiles 混入其他 Change 文件。
- 物理文件数、manifest entry 数和生成文件数口径不一致。

### 根因方向

- 报告从人类可读 Markdown 反向猜测测试数量，而不是消费结构化 ledger。
- `wallClockDuration`、命令耗时、归档复制耗时和整个 Change 生命周期耗时混为同一字段。
- diff 范围只依赖 Git 提交区间，没有结合 Change ownership 和 feature commit 集合。

### 建议

1. 建立单一结构化事实源，最终报告只做渲染，不再解析 Markdown 恢复数字。
2. 明确区分 `changeDuration`、`runDuration`、`taskDuration`、`commandDuration`、`archiveDuration`。
3. 报告生成后执行 source-consistency validator；任何汇总数字必须能追溯到 ledger/event ID。
4. changedFiles 使用 ownership 清单、feature commits 和路径过滤联合计算。
5. validator 不得只返回 `error_count=0`；必须验证测试数、review finding、事件截点、文件清单和耗时守恒。

## 6. P1：submit 对并行 Change 的未提交证据不安全

### 既往实证

此前 submit 合并 `phase1-single-well-product` 时，全仓 stash/恢复流程清除了另外两个并行 Change 的部分未提交 Harness 日志和报告。多数文件可从残留 stash 中找回，但部分 events 与 execution log 仍不完整。

### 建议

1. submit 只暂存和提交当前 Change ownership 内的路径。
2. 不允许以“主工作区必须全仓干净”为前提自动 stash 所有文件。
3. 操作前生成不可变保护快照和逐路径 hash 清单，并创建持久 Git ref。
4. 恢复必须逐文件校验 hash 和 event ID 超集；验证失败时停止，不得继续 merge/archive。
5. 并行 Change 集成优先使用临时 integration worktree。

## 7. P2：门禁依赖隐式的 ledger 键名

### 观察事实

本轮已有多项构建和测试证据，但 gate 首次关闭时仍提示缺少验证项。补充名为 `compile` 和 `unitTest` 的 ledger 条目后才通过。

### 风险

- 证据是否有效取决于未显式声明的“魔法名称”。
- 不同 skill 或 agent 使用语义等价但名称不同的条目时，门禁产生误报。

### 建议

1. build profile 显式声明 required evidence 的 ID、类型和匹配规则。
2. ledger 项使用枚举化 `evidenceType`，显示名称不参与门禁判断。
3. 关闭失败时输出缺少的契约定义、已发现的候选证据及不匹配原因。

## 8. P2：test guard snapshot 与调用工作目录强耦合

### 观察事实

从错误的项目根目录关闭 test guard 会返回 `SNAPSHOT_INVALID`；切换到对应 worktree 项目后才能关闭。错误信息不足以直接识别 snapshot 所属 project/worktree。

### 建议

1. snapshot 内显式保存并返回 `projectRoot`、`worktreeId`、`runId` 和 owner。
2. 错误信息同时展示期望值与实际值。
3. CLI 优先根据 run-id 自动解析项目上下文，避免依赖当前目录。

## 9. P2：文本证据的换行与编码会造成无意义 hash 差异

### 观察事实

主工作区与 worktree 中的 Harness 文本内容经规范化比较一致，但原始 hash 会因 LF/CRLF 或编码差异不同。Git 同时给出 LF→CRLF 警告。

### 建议

1. 为 `.harness/**` 固定 UTF-8 与 LF，并提供 `.gitattributes` 契约。
2. 事件与 JSON 证据使用 canonical JSON 编码和稳定排序。
3. 同时保存 `contentHash`（规范化）与 `byteHash`（原始字节），并明确各自用途。

## 10. 推荐修复顺序

1. 先修 P0：test guard 空记录假通过、状态目录跨 worktree 共享写。
2. 再修长任务租约自动续期、submit 并行安全和结构化证据事实源。
3. 重写 report/archive 的 source-consistency validator，并用历史归档做回放测试。
4. 最后统一 ledger evidence type、snapshot 上下文和文本规范化。

## 11. 最小验收场景

修复后至少应自动覆盖：

1. 两个 Change 在两个 worktree 并行写事件并提交，彼此文件和事件零丢失。
2. 测试真实通过但 test guard 未记录时，门禁必须失败并给出可操作原因。
3. 测试为 52/52、9/9 时，run report、archive report 和 knowledge summary 三处数字完全一致。
4. 长任务超过默认 TTL 后仍通过心跳保持同一 lease、run-id 和 attempt。
5. submit 中途失败后可恢复，且其他 Change 的工作区、stash、事件和报告 hash 不变。
6. archive 的 changedFiles 只包含当前 Change ownership 范围。
7. LF/CRLF 不影响语义内容 hash，但原始字节差异仍可审计。

