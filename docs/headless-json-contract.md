# Headless JSON Contract（阶段命令）

本文件定义 Hunter-Harness 阶段脚本 / CLI 在 headless 模式下的稳定 JSON 出口。  
编排器、CI、Platform sync 只应依赖本契约，不依赖人读 Markdown 报告。

## 通用 Envelope

```ts
interface HeadlessEnvelope {
  schema_version: 1;
  ok: boolean;
  command: string;          // e.g. "gate.close", "archive.finalize", "events.sync"
  change?: string | null;
  phase?: string | null;
  exit_code: number;
  warnings: unknown[];
  errors: Array<{ code?: string; message: string } | string>;
  result?: Record<string, unknown>;
}
```

CLI 平台类命令（`push` / `connect` / `sync` …）继续使用 `CliResult`
（`packages/cli/src/output/json.ts`），`schema_version` 可为 1|2。

## 阶段脚本对照

| Stage | 入口 | 关键 JSON 标志 | 权威副作用 |
|---|---|---|---|
| plan/run/test/review/submit begin|close | `harness_gate.py begin\|close --json` | `--json` | events + ledger |
| events append/render | `harness_events.py … --json` | `--json` | events.ndjson / optional execution-log |
| archive status/finalize | `harness_archive.py … --json` | `--json`（默认 true） | archive tree + summary-data |
| knowledge ingest/query | `harness_knowledge.py …` | stdout JSON | entries / remote ingest |
| events → platform | `harness_events_sync.py` / `hunter-harness events-sync` | `--json` | runs batch + heartbeat |
| verification DAG plan | `harness_orchestration.py --json` | `--json` | none（pure planner） |

## 字段稳定性承诺

**不得破坏（semver 意义下的契约）**

- `ok` / `exit_code` / `errors` 语义
- `command` 字符串命名空间（`domain.action`）
- gate/archive 成功时 `result` 内既有的路径字段（若存在）

**允许扩展**

- 新增可选字段
- `warnings[]` 增加条目
- `result` 增加子键

## `--non-interactive` 规则

CLI：

- 禁止 stdin prompt。
- 缺必填参数 → 非 0 + JSON error。
- `--yes` 仅用于确认破坏性/上传类操作，不暗示跳过门禁。

Python stage scripts：

- 不读 TTY；所有输入来自 argv / 文件。

## 最小消费示例（编排器）

```bash
python harness/scripts/harness_gate.py close \
  --change-dir .harness/changes/demo --phase test --json
echo $?   # 0 才进入下一节点

hunter-harness events-sync --json
# 将 events.ndjson 增量上报到 Platform Run 总线
```

## 版本

- `schema_version: 1` — 2026-08 P5 冻结。
- 破坏性变更必须升到 `schema_version: 2` 并保留双读一个次要版本。
