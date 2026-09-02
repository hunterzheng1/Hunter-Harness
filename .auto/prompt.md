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
- 迭代 5（-79.9%→ 7.04）：**git_run memo**（40 位全哈希钉住的只读命令
  rev-parse --verify/archive/diff/merge-base/cat-file/ls-tree/show；refs 可变
  不缓存；仅 code=0 缓存）。execute 内 58 次 git 调用：22 次重复 rev-parse
  --verify 同一 hash、10 次重复 `git archive` 同一 commit（真实大仓上是
  10 次全树 tar 提取，现在 1 次）。
- 迭代 6（-80.1%→ 6.96）：**append_event 去二次全量读**：append 后不再
  重读整个 events.ndjson，用 existing+autoSealed+event 内存拼装渲染
  execution-log（写入仍是每次 append 后渲染，契约不变）。基准收益中性
  （fixture 事件小），真实大事件流收益显著。
- 迭代 8（-80.4%→ 6.86）：**service-stop 预检**：无服务会话时进程内内联
  判定（load_session 纯加载器），有会话仍走隔离子进程（杀进程路径崩溃隔离
  保留），异常回退子进程。
- 迭代 9（-81.8%→ 6.37）：**compute_product_tree_hash_for_commit 结果 memo**
  （键=project+解析后全哈希+limit；它直接 subprocess 调 `git archive` 绕过了
  文本版 git_run memo，同一 product commit 每次归档被全树 tar 提取 10 次 → 1 次；
  真实仓库收益随体积放大）。
- 迭代 10（-77.2%→ 7.97 快态 ~6.9）：**walk hygiene**：
  `_publishable_tree_digest` 的收据排除从 per-file resolve() 改为相对路径比较
  （扫描侧早已如此并带注释；~2440 realpath/次归档）；`validate_source_consistency`
  把 change_dir.resolve() 提出循环（~600 冗余 realpath；per-entry containment
  resolve 保留不动）。A/B：10.40→7.05。测量期遭 Defender 持续风暴（单 run 最高
  56s，两腿均出现），以 A/B 与快态为准。
- 迭代 11（-83.3%→ 5.86）：**敏感扫描正则快速路径**：根因不是 I/O 而是
  `(?i)`——Python re 在 IGNORECASE 下无法用字面前缀快速路径，回退逐位置交替
  匹配（二进制数据上慢 14×；同数据 sha256 只要 0.008s）。改为 `bytes.lower()`
  预降主体（ASCII-only、保长度、C 速度）+ 去掉模式 `(?i)`（全小写字面量，与
  bytes 模式 (?i) 逐字节等价）+ 纯字面量关键字探针两段式。差分 fuzz 10000 例
  0 失配；warm 树扫描 1.15s→0.24s；A/B +0.13s（扫描已 8 线程并行所以墙钟
  收益小于原语收益）。注意 Defender 冷读税（最高 8.5ms/文件）是环境项非代码项。
- 迭代 12（-85.1%→ 5.22 快态）：**opt-in 事件缓存（load_events_cached）**：
  execute 期间同一 events.ndjson 被完整解析 17 次（gate/preflight×4/collect×3/
  freeze/一致性/append×7）。按 (path,size,mtime_ns) 缓存 + 双 stat 防撕裂；
  NDJSON append 必然增大文件→指纹永不命中陈旧字节；返回共享列表（8 个调用点
  已逐一审计只读；apply_event_corrections 先 deepcopy）。17→9 次解析（9 次
  均为语义必要）。基准中性（fixture 事件小），真实 1.3MB 流 A/B：2.37→2.15s，
  重解析 22.1MB→11.7MB，线性放大。保持规则：同等性能+删冗余=keep。
- 迭代 13（→ 5.55，窗口快态 5.26-5.55）：**staging 拷贝哈希传递**：
  before-manifest 原来要把 600 个新拷贝文件从盘读回（Defender 首读税）。
  `_parallel_copytree(record_hashes=True)`（仅 finalize staging 启用）在拷贝时
  记录 (dst路径, size, mtime, 源侧sha256)——copy2 保留 size+mtime 所以 dest
  指纹=src 指纹，源哈希在拷贝中顺带算（warm）。sha256_file 先查传递表。
  腐化检测等价性已证明：拷贝期间损坏今日本就不被发现（before 读到坏字节
  →缓存→after 命中→相等）；manifest 之后的损坏 stat 变化→传递失效→真读。
  durable staged 读回与 restore 校验保持 record_hashes=False 真实读。
  注意：v1 用 Python 流式拷贝边写边哈希反而吃掉收益（copy2 走内核
  CopyFile2 快路径），v2 改回 copy2+源侧哈希。
- 已验证：sha256 缓存命中 3065/1242 miss（miss = 首次观察 + 拷贝验证，均为协议
  必要读）；迭代 6 后 238 归档+事件测试绿；全量 safe profile 64/64 模块绿
  （迭代 5 后重跑中）；typecheck 绿。导入仅 ~0.2s，不值得瘦身。
- 前一会话（测试提速，test_wall_seconds 176.8→128.2s）见 git log / log.jsonl
  早期条目，目标已切换。
