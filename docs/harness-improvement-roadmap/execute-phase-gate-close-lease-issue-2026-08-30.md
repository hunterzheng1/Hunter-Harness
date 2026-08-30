# Execute 阶段 gate close 租约释放顺序问题

> 来源：sales-insight-agent 项目 `demo-skeleton` execute 阶段实测
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.7

## TL;DR

`harness_gate.py close --phase execute` 在部分步骤成功、整体未完成的中间状态下**提前释放了阶段租约**，导致后续 close 全部报 `LEASE_ABSENT`，必须人工 `harness_change.py claim` 重取租约才能关门。租约释放应是 close 的最后一个原子步骤，或 close 应支持幂等续跑。

## 现象与复现

执行序列（`demo-skeleton`，run_id `run_1a0a0b06…`）：

1. `gate close --phase execute --change demo-skeleton`（漏传 `--status`）→ 参数解析错误，无副作用（正常）
2. `gate close --phase execute --change demo-skeleton --status OK --note "..."` → 输出显示 `gateRecovery.ok=true`、`scratchSwept.ok=true`、`platformMonitor` 有 run 上传，但**没有返回 `PHASE_CLOSED`**，流程在中途结束
3. 再次执行同样的 close → `{"ok": false, "code": "LEASE_ABSENT"}`
4. 再试一次 → 同样 `LEASE_ABSENT`
5. `harness_context.py view` 显示 `currentPhase=execute`、`phase.end` 已写入 1 条——**phase.end 写了、租约没了、阶段没关上**
6. `harness_change.py claim --change demo-skeleton --phase execute --run-id <原run-id>` 重取租约后，`gate close` 返回 `PHASE_CLOSED` OK

## 分析

第 2 次 close 的行为表明：close 内部把「写 phase.end / 释放租约」执行在了「返回成功 / 写 handoff」之前，一旦中途出错（或输出管线中断），就留下「phase.end 已写 + 租约已释放 + 阶段未关闭」的不一致状态。

按 skill 文档，`LEASE_ABSENT` 的正确处理是 `harness_change.py claim` 人工重取——但这应该只发生在真正的异常恢复场景，而不是一次正常 close 的必然结局。

## 建议

1. **租约释放原子化**：把释放租约移到 close 的最后一步（写 handoff 成功之后），或给 close 加事务/journal，中途失败可从首个未完成步骤幂等续跑（与 integration transaction 的 journal 模式对齐）
2. **close 幂等**：`phase.end` 已写但阶段未关时，重跑 close 应识别并续跑剩余步骤，而不是先死在 LEASE_ABSENT
3. **LEASE_ABSENT 报错带上恢复提示**：直接输出 `harness_change.py claim --change <cn> --phase <p> --run-id <rid>` 的完整可执行命令（现在的报错没有这个指引，是我翻文档找到的）

## 次要观察

- `harness_context.py close`（--from-phase/--to-phase）与 `harness_gate.py close`（--status）语义重叠易混，建议合并或在 gate close 的帮助里注明「关门只调本命令」
- gate close 成功时的输出是大段 JSON，建议顶部给一个一行摘要（`PHASE_CLOSED · OK · next: review`）

## 复现环境

- hunter-harness 0.4.7（npx），Node v24.14.0，Windows（Git Bash）
- 项目：sales-insight-agent，change `demo-skeleton`
- 阶段：execute（13/13 单测全绿、ledger 三条 OK 后的正常关门）
