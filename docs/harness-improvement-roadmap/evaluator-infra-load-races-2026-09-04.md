# 评估基础设施负载竞态（AutoLoop 全量测试误报根因）

> 状态：RESOLVED（2026-09-04 当天修复并压测验证；2026-09-05 登记归档）
> 来源：2026-09-03/04 精简执行轮（docs/simplification-analysis-2026-09.md §8.3）。
> AutoLoop 会话以全量 Python 安全档测试为护栏，环境噪声此前被误判为"代码回归"，
> 是全量测试偶发红的根因。本文档把四个竞态的修复登记为正式 issue 记录。

## 症状

全量安全档套件（58 模块串行，BELOW_NORMAL 优先级）在无代码变更时偶发整批红；
失败集合逐轮漂移；子进程退出码批量出现 `0xC0000409`
（STATUS_STACK_BUFFER_OVERRUN，3221225794）。

## 四个竞态与修复

| # | 缺陷 | 症状 | 修复 | 提交 |
|---|---|---|---|---|
| 1 | STARTING 会话用稳态宽限期判心跳丢失 | detached worker 冷启动 >2s 被误判 HEARTBEAT_LOST（~1/7 概率） | STARTING 改用 startup_grace（10s） | caee9e7 |
| 2 | launcher 失败测试中 workerPid/workerIdentity 从未持久化 | 10s STARTING 窗口后轮询校验空身份 → WORKER_IDENTITY_MISMATCH | worker-handoff.json sidecar | caee9e7 |
| 3 | AssignProcessToJobObject 负载下瞬时失败直接杀子进程并抛异常 | 整个测试 runner 中止（IDENTITY_UNVERIFIABLE） | 5 次重试 + 20ms 退避 | caee9e7 |
| 4 | 短命子进程在 job 分配前退出仍走失败路径 | `python -c` 型子进程偶发崩溃 | 识别良性竞态，直接放行无 proof 返回 | 73aa530 |

## 验证

- runtime 模块 20 轮压测全绿（修复前 1/7 概率红）；
- 全量套件连续两轮 58/58（修复前连续 3 轮失败）。

## 判别模式（沉淀给后续排查）

1. 模块单独跑 N/N 通过、仅在全量 runner 上下文失败 → 环境问题，不是代码回归；
2. 失败集合漂移、仅超时无断言错误 → 负载 flake；
3. 子进程批量 `0xC0000409` = 负载 flake 签名；stale vitest/node worker 是放大器，
   全量评估前先清理残留 worker；
4. 同类问题的平台侧案例（guardian powershell 冷启动 vs vitest testTimeout）见
   hunter-platform `a58fc16`（2026-09-05，globalSetup 预热 + 受影响文件 120s 预算）。
