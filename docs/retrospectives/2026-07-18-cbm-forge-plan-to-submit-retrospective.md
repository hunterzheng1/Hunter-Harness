# CBM Forge 从 Plan 到 Submit 的 Harness 流程复盘与改进建议

> 日期：2026-07-18  
> 范围：`harness-plan` → `harness-run` → `harness-test` → `harness-review` → 修复回归 → `harness-submit`  
> 样本项目：CBM Forge / `phase1-single-well-product`，并行 Change 包括 `phase1-data-backend-foundation`、`phase1-geo-golden-samples`  
> 结论：**REVISE（存在 P0 证据安全问题）**

## 1. 执行摘要

这次端到端实战证明，Harness 已具备较完整的规划、TDD、测试、审查、证据记录和 worktree 合并骨架，但当前 Submit 流程在“多个 Change 并行、实时证据写回主工作区”的场景下存在结构性缺陷：

1. `harness-submit` 使用仓库级 `git stash` 暂存主工作区改动；
2. 不同 worktree 的 `stateDir` 又统一写回主工作区的 `.harness/changes/<change-name>/`；
3. 其他 Change 在 Submit 期间仍可能继续追加事件、生成报告；
4. stash 恢复不是事务操作，无法自动合并快照之后新增的文件和事件；
5. 本次人工恢复又错误地使用了不可靠的 stash 引用方式，并在逐文件核验前删除了原 stash 引用。

最终结果是：其他两个 Change 的部分未提交 Harness 日志、报告一度被移出工作区；多数报告后来从残留 Git 对象中恢复，但 `phase1-data-backend-foundation` 的部分事件与派生日志仍未完整恢复。

这不是单纯的操作者失误，也不是单纯补一条提示即可解决的问题。根因是：**Harness 同时把主工作区当作共享运行时状态库和 Git 集成工作区，却没有为这两种角色提供事务隔离。**

建议将本问题定为 P0，在修复前明确限制多 Change 并行 Submit。首选改造是：**Submit 在临时 integration worktree 中完成拉取、合并、验证和推送，禁止为了集成而 stash 主工作区；同时明确实时状态的唯一所有者，功能分支不得携带同一份动态证据。**

## 2. 复盘目标与取证边界

本复盘关注三个问题：

- 从 Plan 到 Submit，哪些流程设计在真实项目中产生了摩擦或风险；
- 用户指出的“合并后其他两个分支的 Harness 日志、报告被清除”是否真实发生；
- 哪些问题应通过协议、脚本和自动化测试解决，而不是继续依赖 agent 临场操作。

取证使用了以下本地证据：

- CBM Forge 当前 `.harness/changes/` 内容；
- Submit 期间创建后被 drop、但对象尚未被 Git GC 清理的 stash commit；
- 各 stash 的 tracked/untracked tree 与当前文件逐项比较结果；
- `phase1-geo-golden-samples` 的 `EVIDENCE-LOSS-20260718.md` 现场说明；
- Hunter-Harness 当前的 submit checklist、worktree gate、事件流水线和验证账本协议；
- Submit 过程中发生的冲突、修复提交、测试追踪和 Windows worktree 清理记录。

本复盘不把事后推测写成事实。能够由对象和文件比较证明的内容标为“确认”，机制判断标为“根因分析”或“推断”。

## 3. P0 事故：并行 Change 的未提交证据被部分清除

### 3.1 结论

用户的观察成立。

- `phase1-data-backend-foundation` 和 `phase1-geo-golden-samples` 的未跟踪报告曾被仓库级 stash 移出工作区；
- 这些报告后来大部分从尚未回收的 Git 对象中恢复；
- 当前报告文件与相应的最新可用 stash 内容一致（按文本换行归一化后比较）；
- 但 backend Change 的事件流和由它渲染的执行日志仍存在真实缺口，因此不能宣称“证据已完整恢复”。

### 3.2 可恢复的 Git 对象

取证时以下已 drop 的 stash commit 仍可由对象 ID 读取：

| 对象 | 主要内容 | 作用 |
|---|---|---|
| `b1ca5d13f34c44634e04c440ba651725a433f4a3` | backend、geo、product 的事件/日志，以及 backend、geo 的多份未跟踪报告 | 第一个保护快照 |
| `9568f373a7489b99a6d9ab75d7b8d280dff540ac` | backend 的事件、日志及 04:28 review/fixback 报告 | 并发 review 后的快照 |
| `b75b1cc4d965202513496013a23eb8a9e97ec407` | backend、geo 的较新事件/日志及 04:33/03:20 报告 | 已经发生部分丢失后的后续快照 |

Git 对象尚存只是偶然的恢复窗口，不是恢复机制。对象一旦被 GC，缺少持久引用的内容将不可恢复。

### 3.3 文件比较结果

| Change / 证据 | 当前状态 | 取证结论 |
|---|---|---|
| backend API results（03:31、03:33、03:36） | 已恢复 | 与 `b1ca...` 中内容一致 |
| backend test report（03:36） | 已恢复 | 与 `b1ca...` 中内容一致 |
| backend review/fixback（04:28） | 已恢复 | 与 `9568...` 中内容一致 |
| backend review/fixback（04:33） | 已恢复 | 与 `b75...` 中内容一致 |
| geo test reports（02:40、03:05） | 已恢复 | 与 `b1ca...` 中内容一致 |
| geo review/fixback（03:20） | 已恢复 | 与较新的 `b75...` 内容一致 |
| geo `EVIDENCE-LOSS-20260718.md` | 已恢复 | 与 `b75...` 中内容一致 |
| geo `events.ndjson` / execution log | 未发现缺口 | 对可用较新快照为超集或一致 |
| backend `events.ndjson` | **仍不完整** | 相对 `b1ca...` 少 4 行；相对 `9568...` 少 2 行 |
| backend execution log | **仍不完整** | 相对 `9568...` 少 5 行，包括 04:29 review 小节 |

文本比较采用换行归一化，是因为从 worktree 到主工作区后发生过 LF/CRLF 转换；原始字节 hash 不同不等同于语义内容不同。

### 3.4 已确认的事故链

```text
多个 Change 并行执行
        │
        ├─ 每个 worktree 运行代码和测试
        └─ 所有动态 Harness 状态写回主工作区 .harness/changes/*
                          │
                          ▼
product Submit 需要操作主分支，但主工作区因其他 Change 的证据而 dirty
                          │
                          ▼
使用仓库级 git stash（包含 untracked）保护整个工作区
                          │
                          ├─ 其他 Change 在快照后继续写事件/报告
                          └─ stash restore 发生引用错误、冲突和部分恢复
                                             │
                                             ▼
                   未先做全量路径/hash/事件 ID 核验就 drop 原 stash
                                             │
                                             ▼
                      报告一度消失；多数找回，部分事件/日志永久缺口
```

### 3.5 根因分层

#### 系统根因

1. **共享状态面与 Git 集成面没有隔离。**  
   `worktree-gate.md` 要求代码在 `worktreeRoot`，而 logs/events/ledger/reports 写回主工作区 `stateDir`。这使主工作区在并行执行时持续变化。

2. **Submit 使用全仓 stash。**  
   当前 checklist 中的 `git stash → git pull --rebase → git stash pop` 没有路径范围、资产清单、并发写入冻结、恢复校验和失败保留机制。

3. **锁的保护范围不足。**  
   per-change 事件锁只保护单次 append，integration lock 只串行化集成者；两者都不能阻止 Git 对整个 `.harness/changes/` 状态树进行移动或替换，也不能协调其他 Change 的持续写入。

4. **证据同时存在于功能分支与主工作区。**  
   功能分支携带旧 Harness 证据，主工作区又有更新证据，合并时形成同路径、不同时间线的必然冲突。

#### 操作错误

本次执行中，我有两项应明确承担责任的错误：

1. stash 恢复时使用了不可靠的原始对象引用方式。Git 报出“not a stash reference”后，工作区出现了“部分内容已变化但操作整体失败”的模糊状态；此时不应继续按成功路径处理。
2. 在没有完成逐路径、逐 hash、逐事件 ID 对账前删除了原 stash 引用。正确策略应是失败关闭（fail closed）：任何不一致都保留原始快照并停止。

即使操作者完全谨慎，现有流程仍容易遇到并发快照漂移和 evidence merge 冲突；但上述错误扩大了影响，并使完整恢复失去稳定引用。

### 3.6 已排除或降级的假设

| 假设 | 判断 | 依据 |
|---|---|---|
| Windows `robocopy /MIR` 清理误删了其他 Change | 非主要原因 | 本次清理目标经过解析且限定在 product worktree；stash 对象中可直接看到被移走的其他 Change 文件 |
| `execution-log.md` 渲染器主动吞掉报告 | 非根因 | 报告是独立未跟踪文件；execution log 的缺口来自其事实源 `events.ndjson` 缺行 |
| 只是 Git 行尾变化造成“看起来不同” | 否 | 行尾解释了部分 blob hash 差异，但不能解释缺少的完整事件行和日志小节 |
| 其他 Change 的写入程序覆盖旧文件 | 次要并发因素 | Submit 期间确有新报告产生，但主要破坏机制是全局快照和非原子恢复，而不是正常 append |

## 4. 从 Plan 到 Submit 的流程问题

### 4.1 Plan：Change 生命周期不够明确

| 严重度 | 问题 | 影响 | 建议 |
|---|---|---|---|
| P1 | 目录存在即容易被视为活跃 Change，过期的 `fourth-review-design-remediation` 需要人工识别和删除 | 用户看到多于预期的 Change，依赖关系和范围判断被干扰 | 引入显式状态：draft/active/superseded/archived/cancelled；默认列表只显示 active |
| P1 | 计划拆分描述了代码依赖，但没有描述“状态所有权”和并发提交约束 | 代码可以并行，证据却在共享目录冲突 | Plan 必须生成 `stateOwnership`、`integrationOrder` 和允许并行的阶段矩阵 |
| P2 | 变更数量与最小可用切片的解释不够直接 | 用户需要追问“为什么是 5 个” | Plan 输出每个 Change 的独立价值、依赖、不可再拆理由和废弃条件 |

### 4.2 Run：worktree 隔离只覆盖代码，没有覆盖动态状态

| 严重度 | 问题 | 影响 | 建议 |
|---|---|---|---|
| P0 | `worktreeRoot` 与共享 `stateDir` 是两套根目录 | worktree 隔离被动态状态写回主目录部分抵消 | 明确唯一状态所有者；功能分支不得提交共享动态状态 |
| P1 | worktree 内旧证据和主目录新证据同时演进 | 合并时发生事件、ledger、tracking、log 冲突 | 动态证据从功能分支排除，或只通过确定性 checkpoint 快照进入 Git |
| P1 | Change 脚本允许 `changeDir` 在 `projectRoot` 外，部分工具又假设它在项目内 | 后续 diff-hash 和 test-tracking 报 `CHANGE_DIR_OUTSIDE_PROJECT` | 所有工具显式接收 `codeRoot`、`stateRoot`，禁止再从一个 root 推断另一个 root |

### 4.3 Test：验证身份和跨工作区稳定性不足

| 严重度 | 问题 | 影响 | 建议 |
|---|---|---|---|
| P1 | `test-tracking.json` 保存 worktree 的绝对 `projectRoot` | worktree 删除或合并回 main 后 manifest 失效 | 路径使用仓库 identity + 相对路径；提供受测的 root migration |
| P1 | manifest 文件 hash 受 LF/CRLF 影响 | 相同测试在 Windows worktree/main 之间出现 hash drift | 对文本应用 Git clean filter 或规范化换行后 hash；二进制继续按字节 hash |
| P1 | manifest 同时携带历史修复阶段的 `trackedBefore=true` 文件 | Submit staging gate 要求文件出现在本次 cached diff，导致 `CACHED_DIFF_MISMATCH` | manifest 增加 lifecycle/commit scope；提交时只校验当前变更触达集合 |
| P1 | ledger 存在验证项，但顶层 `currentHead/baseCommit/diffHash/module/profile` 不完整 | `can-reuse` 无法复用已完成验证，Submit 被迫重跑或人工解释 | ledger 写入改为原子事务，缺顶层身份字段时验证命令直接失败 |
| P1 | 文档引用的 profile resolve 能力与脚本真实 CLI 不一致 | agent 按文档执行时找不到命令 | 为所有文档命令增加 CLI contract test，发布前自动运行 |
| P2 | 构建与 Playwright 被并行执行，而它们共享构建产物/服务状态 | 出现瞬态失败和难以解释的 flaky 结果 | 测试计划声明资源锁和并行安全性；未知命令默认串行 |

### 4.4 Review/Fixback：证据生产与 Submit 没有协调

| 严重度 | 问题 | 影响 | 建议 |
|---|---|---|---|
| P0 | 其他 Change 可在 Submit 快照后继续写共享目录 | stash 恢复无法判断应该采用快照、现值还是合并 | Git 集成不得触碰共享运行时状态；必要时使用很短的 repo mutation lock + 事件 ID 水位检查 |
| P1 | review/fixback 报告按时间戳生成，但缺少统一 artifact manifest | 文件恢复依赖人工枚举 | 每次 artifact 事件记录 path、size、sha256、producer run ID |
| P1 | 相同 Change 的旧报告可以在分支和主目录各自存在 | 合并冲突或历史覆盖 | 报告不可变；同 ID 禁止覆盖；归档时按 manifest 收集 |

### 4.5 Submit：当前风险最高的阶段

| 严重度 | 问题 | 影响 | 建议 |
|---|---|---|---|
| P0 | 主工作区 dirty 时使用全局 stash | 会移动用户改动和所有并行 Change 的证据 | 使用临时 integration worktree，Submit 不再 stash 主工作区 |
| P0 | stash 恢复没有事务 journal、资产清单和完成校验 | 部分恢复后仍可能继续，且无法证明完整性 | 脚本化 prepare/restore/verify；恢复失败保留快照并中止 |
| P0 | 原 stash 可在验证前 drop | 恢复窗口被人为关闭 | 只有路径/hash/事件 ID 全量通过后才允许删除；默认保留到整个 Submit 结束 |
| P0 | 事件文件按普通文本处理 | 快照与当前各含新增行时无法安全选择 | 按 event ID 做集合并集并校验 superset；log 从事件重新渲染 |
| P1 | product 分支旧证据与 main 新证据产生 6 个确定冲突 | 需要额外 reconciliation commit，增加误删风险 | 功能分支禁止携带实时 evidence；提交前自动检查“其他 Change 路径不得出现在 merge diff” |
| P1 | Submit 的 phase.start 会先写 tracked 日志，从而主动把 main 变 dirty | 为后续 pull/merge 制造 stash 需求 | Submit 运行日志写入运行时状态面；集成完成后再 checkpoint |
| P1 | diffHash 包含自身会更新的 ledger/events | 写入验证记录会改变被验证对象，难以形成稳定身份 | diffHash 排除 Harness 运行时文件，只覆盖产品代码和声明的静态规格 |
| P1 | phase.end、`mergeFinalHash`、worktree cleanup 信息发生在 commit/push 后 | “只 push 一次”与“最终证据进入 Git”互相矛盾 | 明确双提交模型或将 remote acknowledgement 留在非 Git runtime；协议只能选一种 |
| P1 | 本地主分支已包含其他 Harness commit，但远端无新 commit 时容易跳过组合态重验 | 单独验证过的两个状态不代表合并后状态 | 以 merge-base、树差异和风险路径决定重验，不只看远端是否前进 |
| P1 | Windows worktree 删除依赖多步人工兜底 | `node_modules` 残留、命令失败和路径误判风险高 | 提供带路径边界检查的正式 cleanup 子命令，禁止 agent 临时拼删除脚本 |

## 5. 本次合并暴露出的直接证据冲突

product 分支提交 `5b92896` 携带了较旧 Harness 证据，main 上提交 `8e50dfc` 已有更新证据。预合并阶段确认至少以下 6 个同路径冲突：

- `events.ndjson`
- `run-task-status.md`
- `test-guard-snapshot.json`
- `test-tracking.json`
- `verification-ledger.json`
- `logs/execution-log.md`

为保留 main 上较新的状态，最终增加了 reconciliation commit `48461a8`，先从功能分支撤回旧证据，再进行合并。

这次补救避免了直接用 “ours/theirs” 覆盖，但不应成为正常流程：如果每次 Submit 都要人工判断哪份 Harness 状态较新，说明状态所有权合同尚未建立。

## 6. 推荐目标架构

### 6.1 首选：独立 integration worktree

Submit 不再切换或清理当前主工作区，也不再 stash 用户或其他 Change 的文件。

```text
primary worktree
├─ 用户未提交代码（保持原状）
├─ .harness/changes/*（其他 Change 可继续写）
└─ 不参与 Submit 的 pull/merge/reset

feature worktree
└─ 待合并产品代码，不携带共享动态 evidence

temporary integration worktree
├─ 从本地主分支/目标远端创建
├─ 合并 feature commit
├─ 执行组合态验证
├─ 生成受控 evidence checkpoint
└─ 推送并安全移除
```

核心不变量：

1. Submit 不得因主工作区 dirty 而失败，也不得 stash 主工作区；
2. integration worktree 只包含 Git 已提交对象，输入可复现；
3. integration lock 只串行化目标分支更新，不阻塞其他 Change 长时间测试；
4. 合并 diff 不得修改 `.harness/changes/<other-change>/`；
5. 临时 worktree 删除失败不影响已生成证据，且只能清理解析后的精确路径。

### 6.2 动态状态的唯一所有者

建议把状态分为两类：

| 类型 | 示例 | 所有权与 Git 策略 |
|---|---|---|
| 静态 Change 合同 | design、plan、test-scenarios、meta | 可以随功能分支提交，修改需 review |
| 动态运行状态 | events、execution-log、ledger、tracking、reports、runtime | 由仓库级状态服务/主状态面唯一持有；功能分支不得保存副本 |

动态状态可以放在受脚本管理、默认忽略的 `.harness/state/changes/<change-id>/`；在明确 checkpoint、archive 或最终 evidence commit 时，由工具根据 manifest 生成不可变快照。即使暂时不迁目录，也必须做到“只有一个位置可写，其他位置只读或不存在”。

### 6.3 事件与报告的恢复合同

- `events.ndjson` 以 event ID 为身份；恢复操作必须做集合并集，而不是整文件 ours/theirs；
- 恢复后事件集合必须是操作前所有快照的超集，否则失败；
- `execution-log.md` 永远从合并后的事件流重新渲染，不参与人工冲突解决；
- 报告采用不可变路径，每个 artifact 事件记录 sha256；相同路径内容不同即报冲突；
- 任何保护快照都有持久命名引用和 transaction ID，直到 Submit 完整结束后才可回收。

### 6.4 把高风险 Git 步骤从自然语言移入脚本

建议新增正式的 integration transaction 命令，例如：

```text
harness_integration.py preflight
harness_integration.py prepare
harness_integration.py merge
harness_integration.py verify
harness_integration.py push
harness_integration.py cleanup
harness_integration.py recover
```

事务 journal 至少记录：

- transaction ID、change ID、run ID；
- primary/feature/integration root 的解析后绝对路径；
- target branch、remote、base/head/merge commit；
- 操作前 Git 状态摘要；
- 所有保护引用；
- 其他 active Change 的事件 ID 水位与 artifact manifest；
- 每一步的开始、完成、失败和可重入状态；
- cleanup 的精确目标和路径边界验证结果。

命令应幂等：同一 transaction 重入时继续未完成步骤，不重复 merge、push 或删除。

## 7. 必须新增的回归测试

以下测试全部通过前，不应解除 P0 限制：

1. **并行证据保全**：Change A Submit 时，Change B/C 持续追加事件和生成未跟踪报告；完成后 B/C 内容逐项保持且新增内容仍在。
2. **主工作区 dirty 保全**：同时存在 staged、unstaged、untracked、ignored 文件时，Submit 不改变其状态、内容、mtime（允许明确排除 mtime 时需记录）。
3. **无全局 stash**：自动测试断言 Submit 正常路径不会创建或 pop 仓库级 stash。
4. **失败关闭**：模拟 restore/merge/verify 中途失败；保护引用必须保留，事务状态必须可恢复。
5. **事件超集**：快照后继续 append，恢复后所有旧、新 event ID 均存在且仅出现一次。
6. **派生日志一致**：删除 execution log 后从 events 重建，内容与标准 renderer 输出一致。
7. **不可变报告**：同路径不同 hash 必须阻断，不能静默 ours/theirs。
8. **其他 Change 零差异**：合并前后对 `.harness/changes/<other-change>/` 做 tree/hash 比较，必须一致或仅包含已证明的并发追加。
9. **根目录迁移**：test-tracking/ledger 从 feature worktree 到 integration/main 后仍能正确识别同一仓库与相对文件。
10. **LF/CRLF 稳定**：相同文本在不同 `core.autocrlf` 配置下产生相同逻辑 hash。
11. **提交生命周期**：最终 merge hash、验证身份、push 结果和 phase.end 的记录顺序符合唯一明确合同。
12. **Windows 清理边界**：worktree 含深层 `node_modules`、只读文件和长路径时可以清理；传入仓库根、父目录或未解析路径时必须拒绝。
13. **并发 integration lock**：两个 Submit 只能有一个更新目标分支，失败方不得改变任何工作区或状态文件。
14. **CLI 文档契约**：checklist/reference 中出现的每个脚本和子命令在测试环境中必须真实存在。

## 8. 改造优先级

### P0：证据安全

- 删除 submit checklist 中的全仓 `git stash` 正常路径；
- 实现临时 integration worktree；
- 建立动态证据唯一所有权，禁止功能分支携带旧运行时状态；
- 实现 transaction journal、保护引用和失败关闭；
- events 按 ID 合并，reports 按 hash 校验；
- 增加第 7 节中 1–8、13 的自动化测试；
- 修复前，在协议中明确警告：多个活跃 Change 写主 `stateDir` 时不得按现有流程 Submit。

### P1：身份与生命周期稳定

- 修正 test-tracking 的 root、EOL、历史 touched-files 语义；
- 让 ledger 身份字段成为必填且原子写入；
- diffHash 排除动态 Harness 状态；
- 定义最终证据 commit/push 模型；
- Plan 增加 Change 生命周期、状态所有权和 integration order；
- 提供正式 Windows worktree cleanup 命令；
- 增加组合态风险驱动的 merge revalidation。

### P2：可用性与维护成本

- 缩短 skill 主流程，把详细恢复步骤下沉到脚本和 reference；
- 自动生成 Change 拆分说明和并行矩阵；
- 统一 CLI 文档验证；
- 报告 UI/摘要显示“事实完整性”状态，例如 complete/degraded/recovered；
- 为 flaky 测试记录首次失败、重试条件和最终结论，避免只留下最终绿色结果。

## 9. 建议的验收标准

完成 P0 改造后，应能用一句可验证的不变量描述 Submit：

> 对一个 Change 执行 Submit，只会读取其声明输入、在隔离 integration worktree 中改变目标分支，并生成本 Change 的受控 checkpoint；任何其他工作区、用户未提交文件和其他 Change 的运行证据，在成功、失败、重试和进程中断情况下都不会被移动、覆盖或删除。

此外必须满足：

- 不依赖 reflog 或尚未 GC 的悬空对象进行恢复；
- 不依赖 agent 人工选择 ours/theirs 解决动态 evidence；
- 不以“文件最后存在”代替内容完整性验证；
- 事故恢复后若仍有缺口，报告必须保持 degraded 状态，不得宣称完整成功。

## 10. 本次流程中值得保留的部分

本复盘不建议推翻 Harness 全部设计。以下能力在实战中有明确价值：

- Plan 将第一阶段拆成可并行的纵向/基础 Change，代码层面的依赖关系总体合理；
- worktree 让功能代码并行开发时保持了较好的隔离；
- `events.ndjson` 作为事实源、execution log 确定性渲染的方向正确；
- per-change lease、事件 append 文件锁和 integration lock 分别解决了局部并发问题；
- test scenarios、review/fixback、verification ledger 让结论可以追溯；
- Submit 前的冲突预检成功提前暴露了 6 个证据冲突，没有直接盲目合并；
- 用户确认、测试、审查和提交分阶段执行，避免了未授权推送。

需要修正的是这些能力之间的边界：单文件追加安全不等于仓库级状态安全，代码 worktree 隔离也不等于运行证据隔离。

## 11. 最终结论

本次事故的直接教训不是“stash 要更小心”，而是：**实时证据不应成为集成工作区清洁度问题，Submit 也不应接触不属于当前 Change 的未提交状态。**

在临时 integration worktree、动态状态唯一所有权、事务 journal 和并发保全测试完成之前，当前 Harness Submit 对多 Change 并行场景仍应视为存在 P0 风险。

本次多数报告能够找回，不代表现行流程可靠；backend 事件与日志的剩余缺口已经证明，依赖人工 stash 恢复无法满足 Harness 自身强调的“可追溯、可复现、不可伪造”目标。

## 12. 归档最终报告数据审计（2026-07-18 补充）

### 12.1 审计结论

对 `CBM Forge/.harness/archive/2026-07-18-phase1-single-well-product/` 的 `summary-data.json`、最终 HTML、verification ledger、事件流、测试报告、审查报告、fixback 报告和归档 manifest 逐项对账后，结论为：**当前最终报告不能作为可信的机器可读事实摘要，应标记为 `DEGRADED/REVISE`。**

问题不只是展示口径不清。测试数、审查问题数、事件数、调用次数、文件范围和风险项均存在可复现的错误或缺失，而归档校验仍返回 `error_count=0`。这说明现有校验主要验证“HTML 是否呈现了 summary 中的值”，没有验证“summary 是否忠实于事实源”。

### 12.2 字段级对账结果

| 字段 | 事实源 | 最终报告 | 判定 |
|---|---:|---:|---|
| 单元测试 | ledger 明确记录 Vitest **52 项通过、0 失败** | `unitTests.total=0` | **错误** |
| API/浏览器测试 | API contract runtime 为 **7/7**；ledger 另记 Playwright **9 项通过、0 失败** | `apiTests.total=0` | **错误，且两类测试被混为一个字段** |
| Review 问题 | review report 为 **RED 2、YELLOW 4** | `red=0, yellow=0` | **错误** |
| Fixback 处置 | 无结构化逐项关闭状态 | `redFixed=0, yellowFixed=0` | **不可判定被伪装为零** |
| 事件总数 | 最终归档中 **63** 条 | `reportPipeline.eventCount=55` | **错误，采集发生在 finalize 尚未结束时** |
| archive 事件数 | 最终事件流中 **13** 条 | pipeline 仅看到 **5** 条 | **错误，属于中间快照** |
| archive 事务耗时 | `phase.start → phase.end` 为 **837 ms** | 页面显示“约 1 秒”；pipeline 另存 **85 ms** | 1 秒四舍五入本身正确，但同一报告内部口径冲突 |
| 阶段有效执行总时长 | 成对 start/end 合计 **192.25 分钟** | **193.69 分钟（约 194 分）** | 多计约 1.44 分钟，且“总耗时”标签含糊 |
| 首末事件墙钟跨度 | **316.49 分钟** | 未单独披露 | 与 194 分钟不是同一口径 |
| plan 耗时 | start/end 为 **479.207 秒** | **565.710 秒** | phase.end 后事件被错误计入 |
| `harness-run` 调用 | **2 次 attempt** | `skillCalls.run=1` | **错误** |
| 归档物理文件数 | **30** | `totalArchiveFiles=29` | manifest 自身被排除，但字段被错误命名为总文件数 |
| Change 代码范围 | 80 个前端文件；另有 10 个本 Change Harness 证据文件；并混入 18 个并行 backend/geo Harness 文件 | “108 个代码文件，+14102/-5” | **范围污染且标签错误** |
| 业务目标 | 设计目标是完整的单井产品纵向切片 | 仅显示计划任务 1“初始化 React/TS/Vite、路由、测试和设计 token” | **错误降级为首个任务标题** |
| 已知风险 | 测试报告明确有 **3 个 PARTIAL 场景**及真实后端联调后续事项 | 只显示一个已解决的 test-tracking 警告 | **严重不完整** |
| 最终状态原因 | 前端 Change 的 DB 验证应为不适用；测试和 review 均有 WARN/PARTIAL | `CONDITIONAL_OK`，唯一原因是 `dbCompatibility=NOT_RUN` | **适用性和原因聚合错误** |
| 最终校验 | 上述多项不一致均存在 | `error_count=0` | **校验器假阴性** |

因此，用户观察到的“测试都是 0”确认是错误；“归档时间 1 秒”需要分开判断：

- **若指 archive finalize 事务本身**，837 ms 显示为约 1 秒是正确的；
- **若理解为完整 `harness-archive` 工作耗时**，则标签具有误导性，因为 preflight、上下文读取、用户确认等待和外围 agent 工作均未计入；
- 同一份 summary 的 pipeline 又记录 85 ms，因此即使采用“事务耗时”口径，内部数据仍不一致；
- “约 194 分钟”是阶段 active duration 的求和，不是首末事件的 316.49 分钟墙钟跨度，而且当前还被 phase.end 后的迟到事件多计约 1.44 分钟。

建议报告同时显式给出 `activeExecutionMs`、`wallClockSpanMs`、`userWaitMs`、`preflightMs` 和 `transactionMs`，禁止继续使用没有口径说明的单一“总耗时”。

### 12.3 已确认根因

#### A. 测试统计依赖脆弱的自然语言正则

`harness/scripts/harness_archive.py` 的单测解析只识别 Maven 风格 `Tests run: N...`，API 解析只识别 `N/N passed`。实际 ledger 使用中文 Vitest/Playwright 描述，因此未匹配后静默回落为 0。

此外，真实 `api-test-results.json` 使用 `summary.scenariosTotal/passed/failed/blocked` 嵌套结构，采集器却只读取顶层 `total/passed/...`。现有测试夹具只覆盖英文规范文本或扁平 JSON，没有使用本次真实产物格式。

这里不应继续叠加更多自然语言正则。ledger 必须记录结构化 verification metrics，并将 `apiContract` 与 `browserE2E` 分开建模；自然语言只能作为说明，不能作为最终数字的唯一来源。

#### B. Review summary 没有解析 review/fixback 事实

当前 `_review_summary` 并未从 review report 读取 RED/YELLOW，也没有逐 finding 的修复状态；当没有旧 summary 可继承时直接给出全零。应生成结构化 `review-findings.json` 和 `fixback-dispositions.json`，每个 finding 使用稳定 ID，并区分 `OPEN/FIXED/ACCEPTED_RISK/DEFERRED/UNKNOWN`。在没有处置证据时必须显示 unknown，不能显示 0。

#### C. finalize 在事件流尚未闭合时采集 summary

`cmd_finalize` 在 archive 仅写入 5 条事件时就执行 `collect_summary_data`，随后还会写入 render、validate、manifest、closure、meta 和 phase.end 等事件。结束时 `_patch_archive_stage` 只回补少数字段，没有刷新 pipeline、风险、命令和 artifacts，造成 summary 天生是一个中间快照。

应建立单一不可变证据截点：先写完包括 `phase.end` 在内的事实事件，再从冻结快照纯函数式生成 summary/HTML；生成报告后不得继续向同一证据范围写事件。若必须保留报告生成事件，应使用外部 outbox，或在 summary 中记录明确的 `evidenceCutoffEventId` 并验证截点之后的事件不属于报告范围。选择性 patch 不能作为最终一致性机制。

#### D. 已关闭阶段仍被迟到事件延长

`harness_events.py` 的 duration 逻辑在存在 start/end 时仍取该阶段最后一条事件的时间作为 effective end。因此 plan 在 phase.end 后新增的一条 decision 被多计 86.503 秒。迟到事件可以记录并告警，但不能改写已经闭合阶段的耗时；应另记 `lateEventCount` 和迟到时长。

#### E. Git 范围不是 Change 所有权范围

归档用 `git diff --numstat base..head` 计算“代码范围”。no-ff 合并期间主分支已包含其他并行 Change 提交时，该区间会把 backend/geo 的 Harness 文件一起算入本 Change。本样本 108 个所谓代码文件中有 18 个明确属于其他 Change，另有 10 个是本 Change 的 Harness 证据而非产品代码。

报告应基于 feature commit 集合、merge second parent 或计划声明的 ownership 计算，并至少拆成 `productCode`、`productEvidence`、`foreignConcurrentChanges`。单 Change 报告中 `foreignConcurrentChanges` 非零时应降级并阻止发布“代码范围”结论。

#### F. manifest、调用次数和状态语义均有字段漂移

- manifest 合理地不哈希自身，但 `fileCount=29` 被渲染成“归档总文件数”；应分别报告 `physicalFileCount=30`、`manifestEntryCount=29`、`selfExcluded` 和 checksum coverage；
- skill call 按 stage 对象计数，忽略 attempts，因此两次 run 被计为一次；
- `NOT_RUN` 被普遍映射为 `CONDITIONAL_OK`，与协议中更窄的条件状态定义漂移；不适用应为 `NOT_APPLICABLE` 并带 scope reason；
- 状态计算只保留先命中的原因，掩盖 test/review WARN 和 PARTIAL；应按严重度聚合全部原因，而不是 first-match return。

#### G. 风险、业务目标和验证器都依赖非结构化推断

- business goal 解析不到 `## 1. 目标` 后的正文时回落到首个任务表格行，导致目标失真；
- risk/action 只从少量 issue/decision/stage 状态推断，不读取测试与 review 的结构化风险，因此 3 个 PARTIAL 场景消失；
- HTML validator 使用与 renderer 不同的对象字符串表示比较 risk，产生 `missing-risk` 假警告；
- 更关键的是，validator 只做“summary → HTML”呈现一致性，不做“事实源 → summary”语义一致性，所以测试 0、review 0、事件截断和范围污染全部漏报。

验证应分两层：第一层 source-consistency validator 对账 ledger/events/findings/manifest/Git ownership；第二层 renderer validator 验证 HTML/JSON 的呈现。第一层失败时不得产出绿色最终状态。

### 12.4 新增改造优先级

#### P0：报告事实可信度

- 引入 source-consistency validator；任何 summary 与 ledger/events/findings/manifest 的不一致均 fail closed；
- finalize 使用单一不可变 evidence cutoff，消除中途采集和选择性 patch；
- 测试、review/fixback、风险和 action 改为结构化 sidecar/event，不再从自由文本猜数字；
- Change 范围按 ownership/feature commit 计算，明确隔离并行 Change；
- 在上述修复完成前，最终报告应显示 `DEGRADED` 和“统计未完成事实对账”，不能显示等价于成功的结论。

#### P1：指标契约和时间语义

- 区分 unit、API contract、browser E2E、DB compatibility，并给出 applicability；
- 区分 active time、wall-clock span、user wait、preflight 和 finalize transaction；
- phase.end 后事件不得延长阶段时间；
- skillCalls 按 invocation/attempt ID 统计；
- 区分物理文件数、manifest entry 数和 checksum coverage；
- 最终状态聚合所有 WARN/PARTIAL/BLOCKED 原因，并支持 `NOT_APPLICABLE`；
- 业务目标、risks、manual actions 从结构化元数据读取。

#### P2：报告可读性

- 所有数字附 `source`、`asOfEventId`、口径说明和适用范围；
- 页面为“约 1 秒”等指标提供明确标签，例如“finalize 事务耗时”；
- 历史 TDD RED 必须标记 `expectedRed/resolvedBy`，避免被误读为当前失败；
- artifact path 在归档后转换为归档内稳定 URI，不能继续指向已移动的 `.harness/changes/...`。

### 12.5 必须补充的报告回归测试

在第 7 节 14 项流程测试之外，报告子系统至少新增以下用例：

15. **真实 Vitest 中文证据**：使用本次 ledger 文本夹具，必须解析或读取结构化值为 52/52，禁止静默回落为 0。
16. **嵌套 API runtime schema**：`summary.scenariosTotal=7` 必须得到 API contract 7/7；Playwright 9/9 必须进入独立 browser E2E 字段。
17. **Review/Fixback 结构化处置**：RED 2、YELLOW 4 必须保留；没有 disposition 时 fixed/deferred 为 unknown，不是 0。
18. **并行 no-ff merge 范围**：base..head 含其他 Change 提交时，产品范围只能统计当前 ownership，foreign 集合必须被披露或阻断。
19. **finalize 截点一致性**：归档结束后 summary event count 必须等于截点内真实事件数；不得出现 55/63 一类中间快照。
20. **archive 单一耗时值**：timeline、durations、pipeline 和页面均引用同一 canonical transaction duration。
21. **closed phase 迟到事件**：phase.end 后追加 decision 不改变 phase duration，只增加 late-event 指标。
22. **重入调用计数**：两个 run attempts 必须报告两次 invocation，并保留各自结果和耗时。
23. **manifest 自排除语义**：物理文件 30、entry 29 的场景分别显示，不得把 entry count 命名为总文件数。
24. **不适用验证**：前端 Change 的 DB 状态为 `NOT_APPLICABLE`，不能因其得到条件成功或失败。
25. **PARTIAL 风险传递**：测试报告中的 partial scenario 必须出现在 known risks/manual actions，并保留 scenario ID。
26. **源数据不一致必须失败**：把 ledger 单测设为 52、summary 设为 0，validator 必须返回错误并阻止绿色报告。
27. **业务目标章节解析**：`## 1. 目标` 后正文必须优先于首个 task row；最好直接使用结构化 frontmatter。
28. **risk 渲染归一化**：validator 与 renderer 使用同一个规范化 projection，既不假警告，也不漏报。

### 12.6 报告子系统验收门槛

报告子系统完成整改后，应满足以下可执行不变量：

> 对同一个 evidence cutoff，summary 中每个可量化字段都能指向唯一结构化事实源；重新采集得到字节级或规范化语义一致的结果；任一事实源与 summary 不一致时，归档失败关闭并保留诊断证据，不得生成成功态最终报告。

同时要求：

- `summary.eventCount == cutoff 内事件数`；
- 单测、API、浏览器和 review 统计与各自结构化源完全一致；
- `foreignConcurrentChanges == 0`，否则报告明确降级；
- duration 口径互斥且可解释，closed phase 不被迟到事件改写；
- manifest 覆盖率、物理文件数和自排除项可独立验证；
- validator 至少包含 source consistency 与 renderer consistency 两层，任何一层失败都不得返回 `error_count=0`。

## 13. Sync、Skill 版本与运行时清理复审（2026-07-18 补充）

### 13.1 本轮处置边界

本轮最初拟执行“修复归档摘要、刷新 adapter、重建知识、清理 sync 临时目录”，但经用户调整，**暂不修改实现、不刷新安装、不重建/发布知识、不删除运行时目录**，统一把证据、根因和验收标准补入本复盘，后续在 Hunter-Harness 中作为完整 Change 实施。

为避免遗留半成品，本轮曾产生的 archive/events 试验性代码和测试已撤回；未触碰 Hunter-Harness 工作区原有的其他未提交修改。

### 13.2 “Skill 版本过期”是检查口径误报，不是 npx 漏装

用户通过同一次 `npx` 流程安装多个 Agent 的 Harness，这是正确安装方式。本次所谓“10 个 skill 过期”经复核属于**比较了错误的两个构建阶段**：

```text
canonical Harness source
        │
        ▼
harness_deploy.py build --agent <agent>
        │  生成带 agent overlay 的原始 bundle
        ▼
adaptBundleDir(stage, agent)
        │  按 Codex / Claude / Cursor / CodeBuddy 运行时约束规范化
        ▼
published workflow bundle / npx installed bundle
```

上次检查直接把第一阶段的原始 build 与第三阶段的 Codex 安装结果交给 `harness_deploy.py diff`。Codex 适配会合法地移除或改写部分 frontmatter 字段，因此文件 hash 必然不同；`diff` 只知道字节不同，不知道两边处于不同 projection stage，最终把合法适配误报为 `outdated`。

本次可核验证据包括：

- 原始 build 和已安装 Codex bundle 的 `coreHash` 同为 `53361b95f7f11cc6`；
- npm/workflow-data 中发布的 Codex bundle 与项目已安装形态一致；
- 原始 build 中出现而 Codex 安装形态中省略的 frontmatter，符合 adapter projection，而不是下载缺失；
- Hunter-Harness 当前源码在 workflow `0.2.9` 发布后没有新的 Harness 核心提交需要重新部署。

因此不能用“所有 Agent 是一次 npx 下载”推导“每个 Agent 的 SKILL.md 必须字节相同”。同一发布版本会共享 canonical core，但不同 adapter 的最终 projection 本来就可以不同。

真正可能导致 skill 过期的情况仍然存在，但应限定为：

1. installed bundle 的 `coreHash` 或 bundle version 落后于当前正式发布包；
2. adapter/profile 与项目配置不一致；
3. managed file 被本地修改、删除，或安装中断；
4. 安装目录出现不属于 manifest 的受管文件漂移；
5. CLI 与 workflow-data 使用了不兼容的发布版本。

**本样本不属于以上情况，不应触发刷新。**

### 13.3 Skill 新鲜度检查的目标合同

`harness-sync` 的 skill 检查必须比较同一阶段、同一 adapter、同一 profile 的产物，禁止再把 pre-adaptation build 与 post-adaptation install 直接比较。

建议正式实现以下身份模型：

| 字段 | 含义 |
|---|---|
| `cliVersion` | 执行 init/refresh 的 CLI 版本 |
| `workflowVersion` | workflow-data 发布版本 |
| `bundleVersion` | bundle manifest 版本 |
| `agent` / `profile` | projection 目标 |
| `coreHash` | canonical core + overlay 的稳定身份 |
| `adapterHash` | agent projection 规则身份 |
| `manifestHash` | post-adaptation 文件 manifest 身份 |
| `installedManifestHash` | 实际安装结果身份 |

状态不再只输出含糊的 `stale=true/false`，而应区分：

- `CURRENT`：正式 post-adaptation manifest 与安装结果一致；
- `LOCALLY_MODIFIED`：受管文件相对正式 manifest 漂移；
- `MISSING`：正式文件或 build marker 缺失；
- `VERSION_BEHIND`：正式发布身份确实落后；
- `PROFILE_MISMATCH`：agent/profile 与项目配置不一致；
- `UNVERIFIABLE`：缺少足够身份数据，不能推断过期。

只有 `VERSION_BEHIND`、`MISSING` 或用户确认覆盖的 `LOCALLY_MODIFIED` 才建议执行官方 `hunter-harness refresh`。`UNVERIFIABLE` 必须报告诊断，不能擅自归类为 outdated。

官方刷新路径必须只有一个：读取 npx 安装包携带的正式 per-agent bundle/manifest，执行保守 refresh，并验证 managed files；不得在项目同步阶段临时拼装另一套未经 `adaptBundleDir` 的候选包。

### 13.4 `.harness` 与 `.gitignore`：取消检查

用户明确决定：**Harness 不需要检查 `.harness` 是否被 Git 跟踪，也不需要检查 `.harness` 是否写入 `.gitignore`。**

当前 `harness-sync/reference.md` 第 6 步把“整条忽略 `.harness/`”判为 WARN，并建议按 file-policy 拆分跟踪策略。这一规则超出了 sync 的职责，也会把项目自主的版本控制策略误判为 Harness 完整性问题，应删除。

新的边界应为：

- sync 只验证运行必需的 `.harness/project.yaml`、`.harness/context-index.json` 等是否存在、可读、schema 有效且相互引用一致；
- 不解析 `.gitignore` 来判断 `.harness`；
- 不执行 `git check-ignore` 来判断 `.harness`；
- 不因 `.harness` 被整体忽略、部分忽略或完全跟踪而产生 OK/WARN/FAIL；
- 不自动修改 `.gitignore`，也不建议用户修改；
- archive/submit 可以基于自身显式输入和 manifest 工作，不能把“是否被 Git 跟踪”当作证据完整性的替代指标。

这不等于取消 Harness 自己的文件分类。`user_editable/internal_state/generated_cache` 仍可用于决定工具能否覆盖、清理和发布文件，但它不再决定项目必须如何配置 Git。

### 13.5 `sync-deploy-*` 临时目录生命周期缺陷

CBM Forge 的 `.harness/runtime/` 中发现多个 `sync-deploy-<agent>` 目录。它们是同步过程构建/比较 adapter 时产生的工作目录，不应长期驻留，更不应依赖用户手工清理。

建议改为每次运行独立目录：

```text
.harness/runtime/sync/<run-id>/deploy/<agent>/
```

并满足：

1. 创建时写入 `owner.json`，记录 run ID、PID、startedAt、agent、用途；
2. 正常成功、普通失败和异常退出均通过 `finally` 清理本次目录；
3. 进程启动时只回收 owner 已死亡且超过 TTL 的目录；
4. 删除前解析绝对路径，必须位于 `<project>/.harness/runtime/sync/` 内，禁止 glob 后跨 shell 删除；
5. 删除失败降级为 cleanup warning，并列出精确路径和占用原因；
6. 不复用固定的 `sync-deploy-codex` 等目录，避免并发覆盖和把上次残留误当本次输入；
7. `--keep-temp` 仅用于显式诊断，输出保留路径和到期时间；默认永不保留。

缓存策略还应区分：

- **临时 deploy workspace**：任务结束自动清理；
- **可复用内容寻址缓存**：按 hash 命名，可跨运行复用，有容量上限和 LRU/TTL；
- **安装结果**：不是缓存，不得被通用 cleanup 删除；
- **诊断证据**：只有显式请求保留时才进入 reports/artifacts。

本轮按用户最新要求没有删除现存目录；待正式 Change 完成安全清理器后，由该清理器处理，避免再次使用临时命令绕过路径边界。

### 13.6 归档事实修复与知识发布必须解耦

当前 archive summary 已确认存在测试数为 0、review 数为 0、事件截断、范围污染等问题。在修复这些派生事实前执行 knowledge ingest/judge，会把错误摘要升级为长期知识，因此原先“先修归档摘要，再 judge/publish”的顺序是正确的，但实现时不应静默覆盖不可变 archive。

建议采用版本化派生修复：

1. 保留原始 archive 和原始 manifest；
2. 从结构化证据重新生成 `derived/summary-v<N>.json` 与对应 HTML；
3. 生成 `repair-record.json`，记录旧值、新值、事实源、修复器版本和校验结果；
4. archive meta 指向当前 authoritative derived version，但原版本仍可审计；
5. knowledge ingest 只读取通过 source-consistency validator 的 authoritative version；
6. `DEGRADED/UNVERIFIED` archive 最多生成 candidate，不得自动 judge/promote；
7. 修复后重新 ingest 时，旧错误知识必须 supersede 或撤回，不能与修复值并存为 active。

因此后续完整整改的依赖顺序应为：

```text
结构化事实契约
  → source consistency validator
  → versioned archive repair/replay
  → final report revalidation
  → knowledge re-ingest
  → Agent judgement
  → promotion/publish
```

### 13.7 必须新增的 Sync/版本/清理回归测试

在第 7 节和第 12.5 节测试基础上，新增：

29. **pre/post adaptation 不误报**：raw Codex build 与 adapted bundle 字节不同、`coreHash` 一致时，正式检查以 adapted manifest 为准并返回 `CURRENT`。
30. **四 Agent 同版本不同 projection**：同一次 npx 安装的 Codex/Claude/Cursor/CodeBuddy 允许 SKILL.md 不同，但各自 manifest 必须通过。
31. **真实本地修改可识别**：只修改一个 managed skill 后返回 `LOCALLY_MODIFIED`，列出精确文件，不错误标记其他 skill 过期。
32. **版本落后与形态差异分离**：旧 `coreHash` 返回 `VERSION_BEHIND`；仅 frontmatter projection 不同不得返回该状态。
33. **refresh 幂等**：连续执行两次官方 refresh，第二次零 managed diff、零额外备份、零残留临时目录。
34. **不检查 `.gitignore`**：整体忽略、部分忽略、完全跟踪 `.harness` 三种 fixture 得到相同的 Harness 完整性结论，且 sync 不调用 `git check-ignore`。
35. **不修改 `.gitignore`**：sync/refresh 前后文件字节和 mtime 保持不变。
36. **临时目录成功清理**：四 Agent build/compare 成功后，本 run 的 deploy workspace 为零。
37. **临时目录失败清理**：模拟第二个 Agent 构建失败，前两个和失败 Agent 的本 run 临时目录均被清理，安装结果不变。
38. **并发 sync 隔离**：两个 run 使用不同 run ID，互不覆盖；一个失败不删除另一个仍存活的目录。
39. **陈旧目录回收边界**：只回收 owner 死亡且超过 TTL 的目录；活跃、未过期、路径越界目录均拒绝删除。
40. **知识发布前置门**：archive source consistency 失败时，judge/apply/promote 必须阻断并指出 archive ID；修复版本通过后才可继续。

### 13.8 本补充的最终判断

- 用户的 npx 安装方式没有问题；skill “过期”结论应撤销；
- 误报根因是 sync 使用了错误的 comparison boundary；
- `.harness` 的 Git 跟踪/忽略策略不再属于 Harness sync 检查范围；
- `sync-deploy-*` 是未闭合的临时资源生命周期问题，应由正式清理器自动解决；
- archive 事实未修复前不得推进知识发布；
- 本轮仅完成复盘和验收设计，未实施上述修复、刷新、知识变更或清理。
