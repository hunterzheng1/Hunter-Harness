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
- 迭代 14（收口，-84.5%→ 5.42）：全量 safe profile 64/64 模块绿（覆盖 6-13 轮
  共享代码改动）+ 最终测量。地板定性（callee 级 profile）：首扫 600 冷读 1.12s、
  durable 内核拷贝 + 协议读回、启动 ~0.25s。剩余候选均已评估并书面否决
  （见 ideas.md：源读统一跨模块耦合 ~0.2s / execution-log 渲染延迟契约风险 /
  collect×3 去重削弱验证独立性）。
- 迭代 15（-84.7%→ 5.37）：**apply_event_corrections 无修正快速路径**：
  原实现无论有无 correction 都 deepcopy 全部事件历史；它在每次 append 的
  render 循环（~11 次/execute）+ collect×3 + preflight 中被调用——大日志下
  O(n²) 深拷贝 churn。快速路径：单遍检测无 correction → 原样返回输入列表
  （无可修正时投影=输入）；有 correction 时完整独立拷贝投影照旧。
  调用方全部审计只读（与 e13 同契约）。1.3MB 日志 A/B：2.47→2.19s（-11%）。
- 迭代 16（-85.6%→ 5.04）：**源读统一（scanned_file_digest）**：staging 拷贝
  的源侧哈希复用敏感扫描已算过的 digest（hruntime._file_hash_cache，相对路径
  +size/mtime 校验的公共访问器；任何疑虑返回 None 回退真读）。预设门槛
  （>0.3s）先测后做：warm sha256×600 实测 0.406s 达标。三路径差分验证
  （有扫描/无扫描回退/扫描后改动不返回陈旧值）。候选 B（渲染 4ms×7）测得
  negligible 已关闭。
- 迭代 17（-85.5%→ 5.06）：**归档 append_event 渲染契约对齐**（修真 bug）：
  归档侧每次 append 都全量重渲染 execution-log，而 events §6.1 契约（CLI 路径）
  规定仅 phase.end/auto-seal 渲染（普通 append O(1)）且尊重 render-policy
  （on-demand 项目被强制重渲染）。对齐后仅终局 phase.end 渲染（collect/summary
  在其后消费日志，新鲜度依赖保留）。大日志（1.25MB）A/B：7 append 0.368s →
  机械 append 0.142s + phase.end 0.037s；基准中性如实记录。
- 已验证：sha256 缓存命中 3065/1242 miss（miss = 首次观察 + 拷贝验证，均为协议
  必要读）；迭代 6 后 238 归档+事件测试绿；全量 safe profile 64/64 模块绿
  （迭代 5 后重跑中）；typecheck 绿。导入仅 ~0.2s，不值得瘦身。
- 前一会话（测试提速，test_wall_seconds 176.8→128.2s）见 git log / log.jsonl
  早期条目，目标已切换。


## 会话结束状态（2026-09-02，17 轮实验后用户决定停止）

- **最终：archive_seconds 中位 5.22s（基线 34.99，-85.1%）**；置信度 19.6×。
- 真实世界收益：1.3MB 事件流 -11%/轮（e16）+ 17→9 解析（e13）+ git archive
  10×→1×（e10）+ 正则 14×（e12）——随仓库规模放大。
- 副产品：harness 自身 Python 全量套件 468.8s → 282.7s（-40%）。
- 正确性：safe profile 64/64 ×2、typecheck、93 events + 229 archive 测试、
  每轮 benchmark integrity 断言全绿。
- bundle content_sha256 已同步提交；下次发版会把优化带给消费项目。
- 残余：Defender 环境税（用户侧排除目录可消，见 ideas.md）；协议必要 I/O 地板
  （首扫/durable 读回/staging 拷贝）。剩余候选已评估并书面否决（ideas.md）。


## 会话最终关闭（2026-09-02，20 轮实验）

- **最终指标：archive_seconds 干净态中位 5.04s（基线 34.99，-85.6%）**。
  最后一次测量与全量套件并发执行（runs 5.04/5.23 自由，5.81/6.87/6.99 被套件
  I/O 负载拖慢，非回退）；干净态窗口 4.95-5.09s 与 e18/e19 一致。
- e18/e19（scanned_file_digest / append 渲染契约对齐）由最终全量 safe profile
  64/64（290.5s）覆盖验证。工作树干净、bundle sync OK、typecheck 绿。
- 会话期间另修复两个真实 bug：e19（归档 append 违反 events §6.1 渲染契约，
  不尊重 render-policy）、以及 append_event 双重全量读（e7）。
- 副产品：harness 自身全量套件 468.8s → ~285-290s（-38%）。
- 后续交还用户：发版流程（把优化带给消费项目）、可选 Defender 排除目录
  （ideas.md 有现成命令）。

- 迭代 18（收尾加固）：**回归防护测试**（test_harness_archive_perf_guards.py，
  13 用例）：e12 混合大小写检测/占位符跳过/内部键豁免、e13 缓存在 append 后
  必失效、e14 传递表可证伪（改后=新哈希）+ 无扫描回退、e18 stat 失配拒绝、
  e19 渲染契约 + render-policy。审计发现这 5 项优化此前只有一次性诊断验证、
  零持久化覆盖。已入 measure.sh 门禁。

- 迭代 19（规模加固）：**缓存容量悬崖修复**：per-file 缓存上限 8192→131072
  （hruntime._FILE_CACHE_MAX / archive._SHA256_CACHE_MAX）。验证 9000 文件树：
  修复前扫描缓存仅剩 808/9000（8192 处整体清空）、before-manifest 回退 8192 次
  真实读（5.41s）；修复后 9000/9000 全命中、0 真实读（1.41s）——大会话优化
  在大树上的静默失效被消除。防护模块加 CacheCapacityTests 冻结下限。

- 迭代 20（跨模块加固）：**harness_ledger.sha256_file stat 缓存**：
  compute_inputs_hash 是共享验证指纹原语（state snapshot 段、ledger 验证复用
  explicit/profile 双哈希 2494/2497/2640、service 会话指纹轮询、archive 认证
  stale-commit 重绑）。同进程重复指纹 600 文件 1.25s→0.06s（21×）；改动后
  指纹正确变化（可证伪）；117 ledger 测试绿。基准中性（不在 execute 热路径）。
  131k 上限沿用 e25 规模教训。发现途径：compute_inputs_hash 调用图审计，
  非 ideas 池（池关闭只覆盖归档热路径假设）。

- 迭代 21（审计闭环）：**哈希面审计穷尽**：harness_acceptance 一次性 CLI 非候选；
  ledger record/can-reuse 的 explicit+profile 双哈希是 S-4 故意语义（文件集冲突
  检测），e26 缓存已让第二次命中第一次（检查保留、成本归零）。全量 65/65 验证
  e26 ledger 缓存的所有消费方（ledger_v3/service/multiday/state-routing）。
  至此 harness 每个哈希面都有缓存或有书面理由不加。

- 迭代 22（规模验证）：**线性扩展确认**：600/1500/3000/6000 文件实测
  5.07/13.96/28.81/56.12s，每文件成本 7.1→9.2ms（1.30×，残差为 Defender
  大目录每文件税，环境项）。6000 文件分解：durable 26.9s（内核拷贝 16.4 +
  协议读回 11.0）+ 首扫 12.1s——全部线性协议 I/O，零平方级成分。
  会话最后一个未验证假设（"优化在真实规模下成立"）就此关闭。
