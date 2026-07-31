---
description: 长时命令、验证调度、环境复用与 fixback 的可恢复执行协议。
---

# Execution Session Protocol

## 受管运行会话

可能超过交互窗口的命令必须通过 `harness_runtime.py run-start` 创建受管会话，而不是依赖调用方进程持续在线。会话状态位于：

```text
runtime/run-sessions/<session-id>/
├── session.json
├── stdout.log
├── stderr.log
└── worker.log
```

`session.json` 只持久化脱敏身份：命令哈希、环境哈希、产品身份、验证目标、阶段、资源锁、进程身份、心跳、进度、超时和原因码。原始环境变量和敏感 argv 不得写入回执。

- `run-status` 可由新进程重连；心跳丢失超过 grace period 才标记 `INCOMPLETE`。
- `run-log --cursor` 按字节游标增量读取 UTF-8 日志，返回下一游标。
- `run-cancel` 只终止身份完全匹配的进程树；身份不确定时 fail closed。
- launcher 尚未启动子进程时失败，状态为 `INCOMPLETE/LAUNCHER_FAILED`；子进程非零退出为 `FAIL/CHILD_EXIT_NONZERO`；超时为 `CANCELLED/TIMEOUT`。
- `resourceLocks` 通过 `runtime/resource-locks/<lock-hash>.json` 原子独占；冲突会在启动测试进程前返回 `INCOMPLETE/RESOURCE_LOCK_BUSY`，终态写入前必须释放持有的锁。
- Windows 使用 shell-free argv 和 kill-on-close Job Object；Job Object 绑定失败时必须终止已验证的子进程并返回 `PROCESS_TREE_ISOLATION_UNAVAILABLE`，不得降级为无隔离运行。

## 验证调度

`harness_verification.py plan` 对验证 DAG 做拓扑调度。每个目标声明 `dependsOn`、`resourceLocks`、identity 与复用策略。

- 只有资源锁不相交的 ready 目标可进入同一 wave。
- 未声明资源锁且预计大于等于 60 秒的目标自动使用 `harness:unclassified-heavy`，因此默认串行。
- 冻结后的产品 identity 发生变化时返回 `FROZEN_IDENTITY_DRIFT`，禁止继续执行或复用。
- 复用和跳过必须记录 `decision`、`reasonCode` 与人类可读 `explanation`；无证据不得返回 `REUSE`。

## 环境会话

环境租约支持两种模式：

- `change-session`：同一 change、stack、内容指纹和通过的 canary 可复用。
- `ephemeral`：每次 acquire 都创建新 session；替换既有 session 前必须提供匹配 stack/environment identity 的 provider reset 回执。

租约获取通过注册锁原子串行化，跨 change 的 writable volume 永不共享。`change-session` 只有在内容指纹非空、environment hash、owner identity、expiry、mode、volume 和 canary 全部匹配时才可复用。内容指纹漂移标记 `STALE_CONTENT`；过期租约不可写。prepare/reuse 写入事实回执；reset/cleanup 只有在 provider operation evidence 为 `OK` 时才可如此命名。单纯释放租约只能记录 `release`，不得声称已清理外部环境。回执写入 change 的 `runtime/environment-receipts/`，文件名使用 stack hash，且不包含凭据明文。

## Fixback 批次

Review/Test 回灌通过 `harness_fixback.py` 形成批次。一个批次可包含多条相关问题，但每条问题必须保留可读取的 JSON RED/GREEN 证据。证据必须位于项目或 change state 内，包含 evidence id、状态和产品 identity，并在批次中固定 SHA-256；RED 必须为 `FAIL`，GREEN 必须为 `PASS/OK`。affected verification 与 review 回执必须绑定最终产品 identity，其 `passedGates` 合集覆盖风险扩展后的全部门禁。`freeze-readiness` 会重新校验证据摘要；开放问题、证据漂移或缺门禁均阻止 code freeze。

## 效率摘要

`harness_efficiency.py summary` 从运行会话、环境回执和失效回执生成事实型指标：墙钟区间并集、累计活动/资源等待、execution/launcher/verification 尝试、失败分类、环境 prepare/reuse/reset/cleanup、重复且没有新 result digest 的命令和人工 wrapper 数。reset/cleanup 只统计带有效 provider evidence 的回执。归档摘要自动包含该结构；指标不得归责个人，也不得在历史样本不足时虚构 ETA。
