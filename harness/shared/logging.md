## 执行日志

`events.ndjson` 为唯一事实源（schema_version 2，`note` 承载人类可读摘要）；`logs/execution-log.md` 由 `harness_events.py` 渲染，**禁止手工 Edit**。结构 → [[../protocols/report-pipeline-protocol.md|report-pipeline-protocol]]

```powershell
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase <phase> --type phase.start --note "<触发指令>"
```

> **脚本接线**：`harness_events.py append`；`harness_archive.py finalize`；`harness_preflight.py check`；`harness_ledger.py can-reuse`；`harness_service.py ensure/stop`（须 `--files`/`serviceStart.inputFiles`）。JSON 输出按 D13 护栏解读。

> **Task 4 §6.1 写入契约**：普通 `append` = 加锁 -> 追加一行 -> fsync -> 解锁，**不 load 历史、不渲染**（O(1)，跨进程锁 `events.ndjson.lock`，UUID 用完整 `uuid4().hex` 无需去重扫描）。仅 `--type phase.end` append 在追加成功后渲染一次 `execution-log.md`；显式 `harness_events.py render` 随时从完整 events 重建；`harness_archive.py finalize` 在 collect 前强制 render 一次。高频 command append 期间 log 可能滞后，phase 边界保持最新。
