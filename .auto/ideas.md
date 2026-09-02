# 归档优化：待试想法

- **git 子进程去重**：finalize 流程内 ~50 次 subprocess（git rev-parse/ls-files 重复、
  CLI 解析、events sync）。git_run 按参数 memoize 有状态突变风险（push/fetch 改 refs），
  只对只读命令（rev-parse HEAD、cat-file、diff --name-only）做进程内 memo 可省 ~1s。
- **scan+manifest 融合**：第一次敏感扫描（change_dir）与 staging 拷贝后的 manifest
  （work_dir）是不同文件集，无法直接融合；但 staging 拷贝读源文件时可以顺带填充
  sha256 缓存（读的是源字节，不写 manifest，不削弱拷贝后校验）→ manifest-before
  只需 stat。注意：**不能**用"写入流哈希"代替"读回哈希"（会让 manifest/coverage
  变成自证）。
- **harness_archive 导入瘦身**：11k 行模块 import ~1s；按子命令懒加载 hruntime/heff
  等依赖。
- **events append 批处理**：finalize 内 6+ 次 append_event 每次全量读写 events.ndjson；
  已有 batch-append 机制但 finalize 未用（注意 phase.end 仍需单次 append 的语义）。
- **Defender 排除目录**（非代码）：把 .harness/archive-operations、durable root、
  %TEMP%\harness-* 加入 Defender 排除可消除慢态；属用户侧配置，不在本仓库范围。

## 已否决

- hash-while-copy 写入流哈希替代读回校验：削弱 manifest/coverage/durable 校验语义
  （自证），明确不做。
- durable readback 缓存：readback 的目的就是读回磁盘字节检测腐化；inode 缓存已让
  verified_hash 命中 staged_hash（rename 同 inode），staged_hash 保持真实读。
- maxWorkers 提高到 >8：I/O 延迟已充分重叠，收益递减且放大 Defender 抖动。
