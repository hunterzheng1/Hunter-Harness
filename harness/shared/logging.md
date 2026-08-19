## 执行日志

`events.ndjson` 为唯一事实源（schema_version 3，兼容读取 v1/v2；`note` 承载人类可读摘要）；`logs/execution-log.md` 由 `harness_events.py` 渲染，**禁止用 Write/Edit 直接维护**。直接修改的内容会在 `phase.end` 或 finalize 时被完整重建覆盖，属于数据丢失；需要保留的详情必须进入事件 `note`。结构 → [[../protocols/report-pipeline-protocol.md|report-pipeline-protocol]]

**`phase.start` 由 `harness_gate.py begin` 写，不要再手工追加一次。** 两条同 `run-id` 的
`phase.start` 会让 `plan finalize` 以 `PHASE_START_DUPLICATE` 卡死，而且手工那次会先触发
auto-seal、把正在开始的 attempt 封成 `RECOVERED`。要补触发指令说明就带 `--note` 跑 `gate begin`。
（重复追加现已按 `(phase, run-id)` 判为幂等 no-op，但依赖它不如不写。）

```powershell
# 阶段开始：gate begin 负责，note 在这里给
python <skills-root>/scripts/harness_gate.py begin --change-dir ".harness/changes/<change-name>" --phase <phase> --note "<触发指令>"
# 阶段中的其他事件才用 append
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase <phase> --type <command|issue|verification> --run-id <phase-run-id> --note "<摘要>"
```

> **脚本接线**：`harness_events.py append`；`harness_archive.py finalize`；`harness_preflight.py check`；`harness_ledger.py can-reuse`；`harness_service.py ensure/stop`（须 `--files`/`serviceStart.inputFiles`）。JSON 输出按 D13 护栏解读。

> **Task 4 §6.1 写入契约**：普通 `append` = 加锁 -> 追加一行 -> fsync -> 解锁，**不 load 历史、不渲染**（O(1)，跨进程锁 `events.ndjson.lock`，UUID 用完整 `uuid4().hex` 无需去重扫描）。仅 `--type phase.end` append 在追加成功后渲染一次 `execution-log.md`；显式 `harness_events.py render` 随时从完整 events 重建；`harness_archive.py finalize` 在 collect 前强制 render 一次。高频 command append 期间 log 可能滞后，phase 边界保持最新。

每个阶段的 `phase.start` 与对应 `phase.end` 必须复用同一 `--run-id` / `--attempt`；阶段结束必须写 `--status OK|WARN|FAIL|BLOCKED`。重试同一阶段时生成新的 run-id 并增加 `--attempt <n>`，不得覆盖或伪装成一次执行。**`attempt` 按 phase 全局递增，不是按 run-id**：一个 run-id 只绑定一个 attempt，重试必须「新 run-id ＋ 下一个 attempt」两者同时换，只换其一会撞 `EVENT_ATTEMPT_CONFLICT` 或 `PHASE_ALREADY_CLOSED`。已发布的 plan 用 `harness_plan_finalize.py republish` 自动分配两者。

阶段跑得久（plan/run 常见）时用 `harness_context.py renew --project . --change <cn> --executor <tool>` 续租；租约到期本身不再阻断 `close`（同一 owner 的过期租约不构成冲突，收据里记 `leaseLapsed`），但续租能让 `view` 的状态如实反映在跑。跨工具继续执行时写 `--executor-tool <codex|claude-code|codebuddy|cursor>`，并在接棒事件写 `--handoff-from-tool` / `--handoff-reason`；也可由 `HUNTER_HARNESS_TOOL/AGENT/MODEL/RUN_ID` 环境变量统一注入。
