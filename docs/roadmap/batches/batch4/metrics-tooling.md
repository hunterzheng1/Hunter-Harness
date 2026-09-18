# 批次 4 度量工具与方法学口径（WI-O5.2 交付物）

> 日期：2026-09-18
> 依据：[design-o5-benefit-evidence-2026-09-18.md](../../proposals/design-o5-benefit-evidence-2026-09-18.md) §4、§6；
> batch0 方法学 §4 口径。
> 状态：WI-O5.2 完成。token 可行性探测结论：**可采集**（见 §1）。

## 1. D5 探测结论：token 可采集

CodeBuddy 宿主将每次 LLM 调用的计量落盘于：

```
~/.codebuddy/traces/<workerPid>/trace_<id>.json
```

- 结构：`{trace: {workerPid, startedAt, endedAt, ...}, spans: [...]}`；
  `generation` 类型 span 的 `toolOutput` 是内嵌 chat.completion JSON 字符串，
  `usage` 字段含 `prompt_tokens` / `completion_tokens` / `total_tokens` /
  `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`。
- 模型版本号在同一对象的 `model` 字段（如 `custom:deepseek-v4.1-flash`），
  满足设计文档 D3「全程记录宿主/模型版本号」的采集要求。
- **限制**：
  - trace 头 `totalTokens` 字段不可靠（实测恒为 0），必须从 generation span 聚合；
  - trace 按 workerPid 分目录、按会话分段落盘，一次运行可能跨多个 trace 文件，
    须按时间窗聚合；同窗口并发会话会互相污染，须用 `--pids` 隔离被测会话；
  - `toolInput`/`toolOutput` 含完整提示词与响应——采集壳**只提取 usage 数字**，
    不复制内容，原始 trace 不出本机。
- 结论落点：设计文档 §0 D5「可采集则纳入指标」分支成立，token 纳入批 A/B 指标，
  不再标「未知」。

## 2. 采集壳：harness_run_metrics.py

只读聚合（不写任何文件），单次运行窗口的度量一次取齐：

```powershell
python harness/scripts/harness_run_metrics.py `
  --start "2026-09-20T10:00:00Z" --end "2026-09-20T10:30:00Z" `
  [--pids 54356] [--traces-root <path>] [--command-pattern <regex>]
```

输出（schemaVersion 1，逐项 `available=False + reason` 降级不阻断）：

| 字段 | 内容 | 对应口径（batch0 方法学 §4） |
|---|---|---|
| `window.wallClockSeconds` | 窗口墙钟 | 端到端墙钟（原生组口径；Harness 组另以 `summary-data.json` durations 为准交叉核对） |
| `tokens` | 按 model 聚合的 prompt/completion/cached/reasoning/total | token 指标（D5 探测后由「未知」转为可采集） |
| `generation.totalDurationMs` | 模型生成时间合计 | 参考拆分：模型等待 vs 本地执行 |
| `coordinationCommands` | Bash/PowerShell span 中匹配 harness 调用模式的命令条数与耗时 | 流程维护-协调命令（**命令埋点**，替代自报；默认模式 `hunter-harness\|harness_[a-z_]+\.py`） |
| `failures.spanErrors` / `totalDurationMs` | status≠ok 的 span 计数与耗时 | 失败恢复次数与耗时（跨进程重试仍须人工补记） |
| `ritualWriting` | 恒 `available=False` | 仪式写作：trace 不可观测，沿用模型自报并在采集记录标注 |
| `manualIntervention` | 恒 `available=False` | 人工介入：trace 不可观测，由采集记录人工登记 |

测试：`harness/scripts/tests/test_harness_run_metrics.py`（10 用例，
覆盖按模型聚合/窗口过滤/pid 隔离/命令埋点/失败计数/坏 trace 降级/CLI 冒烟）。

## 3. 采集规程（批 A/B 每次运行执行）

1. 运行开始前列出被测会话 workerPid（新会话启动后从 traces 目录最新 pid 目录取）。
2. 记录窗口起点（UTC，秒级）；运行结束后记录终点，立即跑采集壳，JSON 原文附入
   `batches/batch4/collected/<组>-<任务>-r<N>.md`。
3. 仪式写作与人工介入两项在采集记录中人工登记（采集壳输出不可用原因，禁止填估计值
   冒充实测）。
4. Harness 组（B/C）另附 `summary-data.json` durations 与门禁首过情况；原生组（A）
   仅以窗口墙钟为端到端口径。
5. 冷暖缓存：每格第 1 次为新会话+新工作区（冷），第 2/3 次为暖；采集记录标注缓存档位。

## 4. 与 §11 / 设计文档的对齐

- §11「记录 token」：D5 探测通过，token 可采集；若后续宿主版本移除该落盘，
  采集壳会因无 generation usage 自动降级为 `available=False`，回到「标未知」分支。
- §4「仪式写作靠模型自报，建议命令埋点」：协调命令已改命令埋点（`coordinationCommands`），
  仪式写作维持自报并显式标注口径。
- 「不扣产品缺陷成本」：采集壳如实聚合失败 span 耗时，不做任何扣除；
  产品缺陷归因在试点报告分析段人工标注。
- 禁止伪造：所有度量均可回溯至 trace 原始文件（文件名/pid/窗口在输出中落盘）。

## 5. 已知缺口（留给 WI-O5.3/4 执行时处理）

- **盲评产物**（隐藏验收清单评分）无工具链，按设计 §3.4 由独立会话人工执行并落盘；
  本工具不涉足。
- 原生组无 `summary-data.json`，端到端只能取窗口墙钟——任务卡需要求记录会话起止。
- `mcp_tools` span 未计入协调命令（语义混杂）；若批 A 发现其占比可观再评估扩模式。
