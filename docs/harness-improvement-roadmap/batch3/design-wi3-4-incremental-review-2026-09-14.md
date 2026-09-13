# WI-3.4 增量评审复用 — 设计文档

> 状态：**已实施（2026-09-14）**。裁决当日用户确认 §0 四项建议值全部采纳；
> 红测 17 例先行 → 实现 → `test_harness_review` 63/63、doc-contract 8/8、
> 全量回归 1618 绿。本文是
> `design-evidence-driven-delivery-2026-09-09.md` §2 WI-3
> 第 4 项（增量评审：review 输入从「整个 diff」收敛到「本次变更 + 受影响上下文」，
> 提案 §4.7）与任务书 `review-remediation-execution-2026-09-12.md` O2 §9.2 的
> 实施设计。按任务书批次 3 流程，先经用户裁决 §0 决策点，再进入红测与实现。

## 0. 待裁决决策点（每项附建议值）

| # | 决策点 | 选项 | 建议值 |
|---|--------|------|--------|
| 1 | 评审边界（被审内容身份）记录在哪 | A. `review-findings.json` 顶层加 `diffScope`（schemaVersion→3）　B. review phase.end 事件附字段　C. 独立边界文件 | **A**（findings 本来就是 per-run 重写的权威 sidecar，边界与结论同文件原子落盘；事件流保持闭集不拓宽） |
| 2 | 「须回退全量」的扩大信号来源 | A. 复用 risk-signals.json fullMarkers（shared-state/contract-schema 等，与 detect_blast_radius 同源）　B. 新增独立增量评审信号表 | **A**（WI-3.1 裁决 3 先例：同一信号源，无双轨漂移面） |
| 3 | 增量模式下既有未解决 findings 如何呈现 | A. 增量输入必附未解决清单（连同新 diff 一起交评审 agent）　B. 只给新 diff，旧结论完全靠 carryover 合并 | **A**（O2 §9.2 明示「未解决发现不因局部输入消失」是输入侧责任，不能只靠写回侧合并兜底；agent 看得到旧结论才能判断新改动是否影响它们） |
| 4 | gate 是否硬校验 diffScope 与当前内容一致 | A. advisory 只记录不拦截（与 review 阶段定位一致）　B. 关门硬校验（不一致拒 close） | **A**（review 是 advisory 阶段，strict-review-gate 默认 false；diffScope 作为审计事实落盘，不新增硬门禁——与 WI-3.1 同哲学） |

## 1. 目标与边界

**目标**：第二轮及以后的评审，输入从「整个 change diff」收敛到「上次评审
边界之后的增量 diff + 受影响上下文 + 既有未解决发现」，同时保持：

- 公共 API、依赖、权限、全局配置变化时**自动扩大回全量**（fail-closed）；
- 已修复发现不重复出现（WI-3.1 稳定 id 保证）；
- 未解决发现不因输入收窄而消失（输入侧附清单 + 写回侧 carryover 合并双保险）。

**不做**：

- 不改 finding id 算法、不改 carryover/处置继承机制（WI-3.1 已交付，本项消费之）；
- 不动轻任务链（harness_task 无 review 阶段）；
- 不向旧 `reviews/` 路径写新东西（仅归档兼容回退）；
- 不新增硬门禁（review 保持 advisory）。

## 2. 现状勘察结论（2026-09-14 实查）

- `harness_review.py`（912 行）是 findings/dispositions sidecar 的写入/校验/
  查询器，**无 diff 计算**；评审输入由 skill 流程约定（`harness-review/
  checklist.md` L15-20 两条裸 `git diff`，无 base 钉定、无增量概念）。
- 评审产物三份（state 根 `reports/review/` 下）：findings（v2）、
  dispositions（v1）、carryover 回执——**均无 base/head/diffHash**，「上次
  评审审的是哪段 diff」无任何记录。这是 WI-3.4 的核心缺口。
- 可复用底座：
  - `harness_ledger.compute_diff_hash(repo_root, base, change_dir)`（L928）：
    commit 无关的字节级内容哈希（工作树内容 + untracked），gate 已用于
    ledger 比对——fixback 中途 checkpoint commit 不会冲掉身份；
  - `harness_state.capture_current_state` 的 `git.base`（不可变 changeBase）
    与 `git.head`（随 capture 刷新）；
  - `harness_fixback.detect_blast_radius()`（L800-819）+ risk-signals.json
    fullMarkers：扩大语义的现成信号源；
  - WI-3.1 机制：稳定 finding id（去 runId）、锚点、carryover 自动合并、
    处置继承——增量评审的「结论侧」已完备。
- gate 挂点：`harness_gate.py:2750 validate_review_outputs_for_close()` 是
  review 关门唯一校验口（本项只读不写）。

## 3. 设计

### 3.1 评审边界记录（findings sidecar schemaVersion 3）

`write_findings` 落盘时顶层新增：

```json
"diffScope": {
  "base": "<解析后的 base（changeBase 或 root commit）>",
  "head": "<写入时刻 git rev-parse HEAD，可为空（无提交）>",
  "diffHash": "sha256:...（compute_diff_hash 输出，commit 无关，整体校验）",
  "files": {"rel/path.py": "sha256:... 或 null(已删除)"},
  "mode": "full | incremental",
  "capturedAt": "<ISO>"
}
```

- schemaVersion 升 3；读侧兼容 v2（无 diffScope 即「未知边界」→ 下轮回退
  full，见 3.3）；
- `files` 是增量判定的主键：diffHash 不可逆出文件清单，per-file 内容哈希
  才能算出「上轮之后又动了哪些文件」（新增/内容变化/删除；还原的文件
  自然退出变更集不算增量）；diffHash 保留做整体一致性校验（UNEXPLAINED_DRIFT）；
- `mode` 记录本轮是增量还是全量：显式输入（write-findings `--mode` /
  stdin `diffMode` 字段）优先，缺省自动推断（上轮有 diffScope →
  incremental，否则 full）；
- 变更集定义与 ledger 同源：复用 `harness_ledger._changed_paths`
  （commit 无关：相对 base 的 tracked diff ∪ untracked）。

### 3.2 新增 CLI：`harness_review.py diff-scope --change <cn> --json`

评审流程「获取变更范围」步（SKILL.md ①）改为先调本命令。输出：

```json
{
  "ok": true, "code": "REVIEW_DIFF_SCOPE",
  "mode": "incremental | full",
  "reason": "<full 回退原因，mode=incremental 时为 null>",
  "changeBase": "<不可变 base>",
  "previousReview": { "runId": "...", "diffHash": "sha256:...",
                      "capturedAt": "..." } | null,
  "incrementalFiles": ["src/a.py", ...],
  "contextFiles": ["<受影响上下文，见 3.4>"],
  "openFindings": [ {id/dimension/severity/path/line/title}, ... ],
  "fullFiles": ["<mode=full 时的全量文件集>"]
}
```

- `incrementalFiles`：上一轮 diffHash 对应内容 → 当前工作区的文件级增量。
  实现：以「上轮 findings 落盘后工作区内容」为旧侧、「当前工作区」为新侧。
  由于 diffHash 是内容哈希而非 commit，文件级增量用
  `git diff --name-only <上轮 head>..<当前>` ∪ 未提交/未跟踪改动（相对上轮
  head 之后新出现的脏路径）计算；上轮 head 缺失或 diff 不可算 → full。
- `openFindings`：status() 的 currentRisks（OPEN/ACCEPTED_RISK/DEFERRED/
  UNKNOWN）逐条给出——增量评审输入必含（裁决 3）。

### 3.3 回退全量条件（fail-closed，任一命中即 full）

1. 无上一轮 findings sidecar，或 sidecar 无 diffScope（v2 及以前）；
2. 上轮 head 在 git 中不可解析（仓库重置/rebase 历史改写）；
3. 增量文件集命中 risk-signals.json fullMarkers 路径模式（shared-state、
   contract-schema、auth/migration 等）——与 `detect_blast_radius` 同一
   信号源（裁决 2）；
4. 增量文件集为空但工作区与上轮 diffHash 不一致（无法解释的漂移）→
   full 而非「空增量通过」；
5. `incrementalFiles` 计算过程任何 git 错误 → full（不半路降级）。

回退时 `reason` 给出机器可读码（`NO_PREVIOUS_SCOPE`/`HEAD_UNRESOLVABLE`/
`EXPANDED_SIGNALS:<signal>`/`UNEXPLAINED_DRIFT`/`DIFF_ERROR`），供审计与
测试断言。

### 3.4 受影响上下文（contextFiles）的保守圈定

不建依赖图（超出本项范围，O2 允许「依赖图缺失时保守回退」）。圈定规则：

- 增量文件被 `git grep -l` 引用的**同仓库产品树文件**（按文件名主干与
  导出符号粗匹配，限同语言同目录树）；
- 圈定失败/超阈值（>20 个文件）→ 只附增量文件本身，不伪造上下文完整性
  （`contextFiles` 为空数组 + `contextNote` 说明原因），**不回退 full**
  ——上下文是加分项不是门禁；
- 测试文件（`tests/test_<同名>`）自动纳入。

### 3.5 行号偏移与 finding 对账（已知摩擦点的明确策略）

- stable_finding_id 含 `line`，移动文件/行号偏移会生成新 id——**不改
  算法**（WI-3.1 机制不动）；
- 旧 finding 的存续由 WI-3.1 carryover 回执判定（锚点漂移 → invalidate
  → 下轮重新上报，此时按新行号得新 id，firstSeenRunId 重新起算——可接受，
  因为锚点漂移语义上就是「需要重新审」）；
- 评审报告模板（reference.md）增量轮加一段「对账」：`新增 / 持续
  （id 同上轮 openFindings）/ 消失` 三组计数，供人读核对漏审。

### 3.6 门禁与审计（advisory）

- `diffScope.mode`/`diffHash` 随 findings 落盘即审计事实；gate 不新增
  硬校验（裁决 4）；
- `harness-review/SKILL.md` 与 `checklist.md` 的「获取变更范围」步改为
  先调 `diff-scope`，按其输出构造评审输入；`reference.md` 报告模板加
  对账段。文档变更在 doc-contract 扫描范围内，同步更新。

## 4. 红测矩阵（任务书 O2 §9.2 必测全覆盖）

| 场景 | 断言 |
|------|------|
| 首轮评审（无 sidecar） | diff-scope → full，reason=NO_PREVIOUS_SCOPE |
| 二轮纯增量（改 1 个无关模块文件） | mode=incremental；incrementalFiles 只含该文件（**无关模块不重审**） |
| 增量命中 fullMarkers（如改 workflow-policy.json） | mode=full，reason=EXPANDED_SIGNALS:shared-state（**全局配置触发扩大**） |
| 接口/跨模块变化（改契约邻接文件） | mode=full，reason=EXPANDED_SIGNALS:contract-schema（**接口变化正确扩展**） |
| 上轮 head 不可解析（reset 历史） | mode=full，reason=HEAD_UNRESOLVABLE |
| 空增量但内容漂移 | mode=full，reason=UNEXPLAINED_DRIFT |
| 无变化（diffHash 相同） | mode=incremental，incrementalFiles=[]，openFindings 仍附 |
| **未解决发现不消失** | 上轮 OPEN finding 的文件本轮未动 → diff-scope 的 openFindings 仍列出；write_findings 未重上报 → carryover 合并回 sidecar |
| **已修复发现不重复** | 上轮 finding 修复后重审 → 新 sidecar 无该 id |
| **移动文件/行号偏移** | 同文件行号偏移后重报 → 新 id；旧 id 经锚点漂移 invalidate；对账计数正确（新增/持续/消失） |
| findings v3 写入 | diffScope 五字段齐、mode 正确；v2 sidecar 读取兼容（视为无边界） |
| commit 无关性 | 评审后 checkpoint commit 再改文件 → 增量判定不被 commit 冲掉（diffHash 语义） |

## 5. 实施步骤

1. 红测：上述矩阵落 `tests/test_harness_review.py` 新类
   （`DiffScopeTests`/`IncrementalRoundTripTests`），先全红；
2. `harness_review.py`：`diff-scope` 子命令 + write_findings 写 diffScope
   （schemaVersion 3 + 读侧兼容分流）；
3. 文档：`harness-review/SKILL.md`、`checklist.md`、`reference.md`
   （报告模板对账段）；doc-contract 回归；
4. 全量回归 + 提交（单 commit）。

## 6. 影响面

| 文件 | 变更 |
|------|------|
| `harness/scripts/harness_review.py` | diff-scope 子命令、findings v3（diffScope） |
| `harness/scripts/tests/test_harness_review.py` | 红测 2 个新类 |
| `harness/harness-review/SKILL.md`、`checklist.md`、`reference.md` | 流程接线与报告模板 |
| 设计文档 | 本文（裁决后状态推进） |
