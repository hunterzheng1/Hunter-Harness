# 归档优化：待试想法

## 已完成（e1-e14，见 prompt.md / log.jsonl）

- ~~per-file stat 缓存（敏感扫描 + publishable digest）~~ e1
- ~~inode 键 sha256 缓存（manifest/coverage/durable payload hash 共享）~~ e2
- ~~全树 pass 并行 I/O（扫描/digest/manifest/树摘要）~~ e3
- ~~并行 copytree（符号链接回退）~~ e4
- ~~git_run 只读命令 memo + compute_product_tree_hash_for_commit 结果 memo~~ e6/e10
- ~~append_event 去二次全量读 + load_events_cached opt-in 事件缓存~~ e7/e13
- ~~service-stop 无会话预检~~ e8
- ~~walk hygiene（resolve() per-file 消除）~~ e11
- ~~敏感扫描正则快速路径（lower + 去 (?i) + 字面量探针）~~ e12
- ~~staging 拷贝哈希传递（before-manifest 零读新文件）~~ e14

## 待试（均为小收益，基准地板已达，谨慎评估）

- ~~源侧三次读统一~~ e18：scanned_file_digest 公共访问器（扫描 digest 复用，
  门槛 0.3s 先测后做，实测 0.406s 达标落地）。
- **execution-log 渲染延迟**：finalize 内 7 次 append 每次全量重渲染
  execution-log.md（O(n²) 写）。800 事件下每次渲染 10-30ms → 共 ~0.2s。
  风险：append 语义变化（日志新鲜度契约）；需确认无读者在 finalize 中途读它。
- **events batch-append 用于 finalize 内的机械事件**：CONTEXT.md 已有机制但
  finalize 未用；phase.end 必须单次 append 的语义限制哪些能合并不明确。

## 环境项（非代码，用户侧）

- **Defender 排除目录**：`.harness/archive-operations`、durable root、
  `%TEMP%\harness-*`。可消除慢态（单 run 最高 56s）与首读/首写税；预期把快态
  再压 ~0.5-1s。PowerShell（管理员）：
  `Add-MpPreference -ExclusionPath <path>`。

## 已否决（勿重试）

- hash-while-copy 写入流哈希替代读回校验（自证）/ durable staged readback 缓存：
  削弱腐化检测语义，prompt.md 明令禁止。
- Python 流式拷贝边写边哈希：copy2 走内核 CopyFile2，Python 读写循环反而更慢
  （e14 v1 实测吃掉全部收益）。
- collect_summary_data ×3 去重：三次调用分别是 pre-freeze 预检 / canonical
  写入 / 验证层独立重建（后者刻意验证 projection 纪律，输入含已写 summary），
  线程化结果会削弱验证语义。
- maxWorkers >8：收益递减且放大 Defender 抖动。
- 工作树产品哈希（compute_product_tree_hash_detail）memo：仅 legacy 迁移路径
  使用，非每次 execute 成本；且工作树可变，memo 不安全。
