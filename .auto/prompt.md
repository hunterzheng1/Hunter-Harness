# Autoresearch: Hunter-Harness 归档阶段优化（中间产物简化 / 解耦 / 提速）

## Objective

归档（`harness_archive.py execute`：预检 → gate → finalize → durable → 收尾）目前
对 600 文件 / 14MB 的真实规模树耗时 ~50s，且中间产物在流程内被反复重算导致
漂移面大：候选收据（敏感扫描 receipt / candidate CI / knowledge candidates）、
身份解析（baseCommit/finalCommit/diffStat）、归档成功但 JSON 输出丢失。
目标：

1. **消除同一进程内的重复全树扫描/哈希**：敏感扫描跑 5 遍（18.8s）、
   publishable digest 4 遍、archive tree digest 3 遍（6.9s）、manifest 2 遍。
2. **中间产物收据化复用**：同一内容状态的计算结果在流水线内传递/缓存，
   不重复重算；stat 指纹一致即复用（写入必然更新 mtime/ctime）。
3. **不得改变对外行为契约**：磁盘产物 schema（summary-data.json 2.3、
   manifest、receipt、durable store）与 CLI JSON 输出保持不变。

## Metrics

- **Primary**: `archive_seconds`（基准全流程墙钟，lower is better）
  —— `.auto/bench_archive.py`：真实 git 项目 + 600 文件/14MB 树 +
  state snapshot capture + `execute --intent record-only --skip-ingest
  --durable-root`。
- **Secondary**:
  - `integrity_failures` — 必须 0（stdout JSON 完整、summary/manifests/
    execute-result/durable 收据齐全、身份字段与 git 事实一致）
  - `tree_files` / `tree_mb` — 基准规模锚点（600 / 14.1）

## How to Run

`./.auto/measure.sh` — 输出 `METRIC name=value` 行；基准通过后再跑归档
Python 测试模块（正确性背压内嵌在 measure.sh 里，因为
run_experiment 在本机用 WSL bash 调 .auto/checks.sh 会因 Windows 路径不可
打开而必然失败；故 checks.sh 已移除，门禁语义等价内嵌）。
`BENCH_PROFILE=1 python .auto/bench_archive.py` — 额外产出
`.auto/last_archive.prof`（cProfile）。

## Files in Scope

- `harness/scripts/harness_archive.py`、`harness/scripts/harness_runtime.py`
  等归档链路 Python 源
- `harness/scripts/tests/test_harness_archive*.py`、`test_harness_runtime.py`
  等测试（只许加不许删）
- `.auto/**`

## Off Limits

- **禁止作弊**：不得为基准专门造快路径；缓存必须语义等价（指纹含
  size+mtime_ns+ctime_ns，任何写入都会失效）；不得删测试/削弱断言。
- 不得改 `packages/`（TS 侧）与发布链路；typecheck 必须保持绿。
- durable 写入后的 readback 校验语义不得削弱（磁盘腐化检测是有意为之）。
- 归档磁盘产物的 schema 与字节稳定性：同一输入下 summary-data.json、
  manifests、receipt 的内容（除时间戳类字段）必须逐字段一致。

## Constraints

- 正确性背压（内嵌 measure.sh）：归档 Python 测试模块（archive /
  archive_c / preflight / remote / runtime）全绿，否则该次迭代按失败处理。
- 基准 integrity_failures > 0 视为失败（checks_failed 同类处理）。
- 简化优先：同等收益下删代码/减扫描次数 > 加缓存层。

## What's Been Tried

（随迭代更新）

- 2026-09-02 基线：archive_seconds ≈ 34.75（中位数协议；单次协议曾测 34.99-
  55，噪声双峰：快态 ~24-26 / 慢态 ~32-37，Defender 对新文件的周期扫描）。
  cProfile（34s in-process）热点：`_sensitive_candidates` ×5 = 18.8s、
  `validate_sensitive_evidence_publication_gate` ×3 = 11.0s、
  `write_durable_archive` 内 `_archive_tree_digest` ×3 = 6.9s、
  `check_status` = 7.1s、`_publishable_tree_digest` ×4 = 1.6s、manifest ×2 ≈ 1.1s、
  subprocess ×50 ≈ 1.4s。io.open 每次开销 ~1.3-4ms（Defender）。
- 迭代 1（-24%→ 26.5）：harness_runtime 加**按文件 stat 缓存**
  （`_sensitive_candidates` + `_publishable_tree_digest`）：同进程内同一内容
  只读一次；跨根命中 staging 副本（copy2 保留 mtime）；events.ndjson 增量只重读
  该文件；扫描同时填充哈希缓存。
- 迭代 2（-27%→ 25.5）：harness_archive 加**inode 键 sha256 缓存**
  （sha256_file / generate_manifest / coverage / _archive_tree_digest 共享）：
  键 (st_dev, st_ino)+size+mtime，同卷 rename 后仍命中；staged/durable 新 inode
  真实重读（保住腐化检测）；树摘要字节格式不变（bytes.fromhex）。
- 迭代 3（-70.6%→ 10.3）：**全树 pass 逐文件并行**（扫描/摘要/manifest/树摘要，
  线程池 min(8,cpu)，结果按原顺序组装，磁盘产物逐字节一致）。双峰噪声消失。
- 迭代 4（-75.5%→ 8.57）：**并行 copytree**（staging/durable/restore 三处拷贝，
  遇符号链接整体回退 shutil.copytree；copy2 保留 mtime 供缓存命中）。
  A/B：串行中位 9.28（有 28.6s 慢态离群），并行中位 8.57 全快态。
- 已验证：sha256 缓存命中 3065/1242 miss（miss = 首次观察 + 拷贝验证，均为协议
  必要读）；215 归档测试全绿。
- 前一会话（测试提速，test_wall_seconds 176.8→128.2s）见 git log / log.jsonl
  早期条目，目标已切换。
