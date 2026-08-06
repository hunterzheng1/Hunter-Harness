# Orchestration Foundation（P5）

> Status: design only — **不实现**独立 orchestrator 进程。  
> Goal: 为未来 graph engineering / multi-agent 编排铺路，复用现有 Harness CLI + Platform Run 事件流。

## 1. 目标与非目标

**目标**

- 每个生命周期阶段（plan / run / test / review / submit / archive）提供稳定的 headless JSON 出口。
- Platform 的 Run 事件流（P4）成为编排协调总线。
- `scenario-manifest` / checkpoints 保持结构化，作为 DAG 雏形。

**非目标**

- 不实现 orchestrator daemon / worker pool / worktree 调度器。
- 不替换现有 agent skill；编排器未来经 CLI + API 驱动即可。

## 2. 参考结构（社区共识）

goal-flight / Legion 类原型的共同骨架：

```
Orchestrator (DAG owner)
  ├─ dispatch → Worker (codex / cursor / …) in isolated worktree
  ├─ collect  → structured result receipt
  └─ gate     → independent review before next node
```

Hunter 侧映射：

| 编排概念 | 现有载体 |
|---|---|
| DAG 节点 | change phase + scenario checkpoints |
| Worker 调用 | agent skill / CLI stage scripts（手动触发） |
| 结果收据 | `events.ndjson` + ledger |
| 协调总线 | Platform `runs/events:batch` + SSE |
| 隔离 | git worktree / change dir（未来） |

## 3. Headless 契约（稳定字段）

所有 stage 命令在 `--json`（及 CLI `--non-interactive`）下应输出：

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "gate.close|archive.finalize|events.sync|…",
  "change": "change-name",
  "phase": "plan|run|test|review|submit|archive|null",
  "exit_code": 0,
  "warnings": [],
  "errors": [],
  "result": {}
}
```

规则：

1. **stdout 仅 JSON**（一行或多行缩进均可；解析器取最后一个完整 JSON object）。
2. **stderr** 可含人读日志；编排器只依赖 stdout。
3. **exit_code**：`0` 成功；非 0 时 `ok=false` 且 `errors[]` 非空。
4. **幂等**：重复调用不得破坏权威账本（events append-only；gate close 可返回 `reused`）。
5. **无交互**：`--non-interactive` / `--yes` 禁止 prompt；缺参直接 fail-closed。

详细字段见 `docs/headless-json-contract.md`。

## 4. 编排驱动面（未来）

编排器（独立进程）建议只依赖：

```
CLI:
  hunter-harness connect / push / sync / doctor / events-sync
  python harness/scripts/harness_gate.py … --json
  python harness/scripts/harness_archive.py … --json
  python harness/scripts/harness_events_sync.py … 

Platform API:
  POST /api/v1/projects/:id/runs/events:batch
  POST /api/v1/projects/:id/runs/heartbeats
  GET  /api/v1/projects/:id/runs/:runId/stream   (SSE)
  POST /api/v1/projects/:id/knowledge/ingest
```

不直接解析 SKILL.md；skill 仍由人工或 agent 会话触发。

## 5. DAG 雏形

- `meta/scenario-manifest.json` / `meta/implementation-checkpoints.json`：节点与依赖。
- `harness_orchestration.py`：已有 verification DAG planner（side-effect free）。
- 未来 orchestrator 读取同一图，把节点映射到 stage 命令，而不是另起一套状态机。

## 6. 落地顺序（后续迭代）

1. 补齐各 stage script 的 `--json` 字段对齐（本阶段完成契约文档 + events-sync CLI）。
2. Orchestrator MVP：读 checkpoint 图 → 串行调用 stage CLI → 订阅 Platform SSE。
3. Worktree 隔离 + 并行节点（仅当依赖允许）。
4. 独立 review gate worker（与实现 worker 分离）。

## 7. 验收

- 契约文档可被外部编排器按字段消费。
- `hunter-harness events-sync --json` 返回稳定 envelope。
- 不引入新的长驻编排进程。
