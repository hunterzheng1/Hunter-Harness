# Autoresearch: Hunter-Harness 架构优化 + 测试提速

## Objective

对 Hunter-Harness monorepo（TS 五包 + Python harness）做一轮架构清理与效率优化：

1. **删除冗余**：core 包内 5 份语义微差的 `stableJson/stableHash/deepFreeze` 拷贝、
   重复的 compareCodepoint/canonicalize、死代码、重复 helper。
2. **解耦**：把重复工具收敛到单一权威模块，各子系统只依赖权威实现；
   消除 barrel 级联导致的测试 import 成本（当前 core barrel 冷 import ≈1.4s、
   bin.ts ≈1.75s，90% 是磁盘 I/O 读模块）。
3. **修真实使用问题**：hash 语义不一致 = 持久化哈希漂移隐患；CLI 启动/部署路径的
   冗余 I/O；测试里反复拷贝 14MB bundle 的浪费。
4. **测试提速**（用户明确痛点）：当前 `npm test` 墙钟 ~176s（vitest Duration
   import 48.6s + tests 281s/2 workers）。顶部慢文件：
   push.test.ts 24s（其中 1 个用例独占 14.4s）、update.test.ts 23s、
   migration.test.ts 20s、rules-review.test.ts 15s、initialize.test.ts 13s、
   guarded-default-cli.test.ts 12s、recovery-v3.test.ts 12s、
   map-publication-filesystem.test.ts 9s。

## Metrics

- **Primary**: `test_wall_seconds`（vitest Duration 秒，lower is better）
  —— `npm test` 中 vitest 主体墙钟，代表开发者等待时间。
- **Secondary**:
  - `test_count` — 通过的用例数（≥2244，必须不降 = 不删用例、不减断言）
  - `import_seconds` — vitest 报告的 import 阶段耗时
  - `tests_sum_seconds` — 各 worker 测试耗时合计（2 台 worker 的理论下限）
  - `real_total_seconds` — `npm test` 整条命令 real 时间（含 pretest）

## How to Run

`./.auto/measure.sh` — 输出 `METRIC name=value` 行。

## Files in Scope

- `packages/core/src/**` — 冗余工具收敛、死代码删除、import 图瘦身
- `packages/cli/src/**` — 命令层（如 `--agents all` 安装路径）
- `packages/cli/test/**`、`packages/core/test/**`、`tests/**` — 测试基建
  （seeded-init 拷贝策略、fixture 复用、临时目录布局）
- `vitest.config.ts` — worker/超时/项目划分（不得用删测试换速度）
- `scripts/sync-harness.mjs`、`scripts/bundle-cli.mjs` — pretest 环节
- `.auto/` 之外一律不许动

## Off Limits

- **禁止作弊**：不得删除/跳过/`it.skip`/`describe.skip` 任何用例；不得削弱断言
  （删 expect、改阈值、把真断言换成 `expect(true)`）；不得让测试依赖缓存结果。
  `test_count` 下降即视为失败。
- 不得改 `packages/contracts` 的公开 schema（行为契约）。
- 不得改 Python harness 的生产行为（只允许测试层优化）。
- 不得动 `.github/workflows` 与发布链路。

## Constraints

- `npm run typecheck` 必须通过（每次迭代都要跑，checks.sh 已接）。
- vitest 全量必须全绿；慢用例若靠"调大超时"掩盖，视为作弊。
- 收敛 stable/hash 工具时：**对同一输入的字节输出必须与现状完全一致**
  （持久化哈希一旦漂移 = 数据损坏）。语义差异点（如 undefined 键是否过滤、
  NaN 是否抛错）先逐调用点确认语义，再统一；有差异的调用点保留差异并用测试冻结。
- 简化优先：同等性能下删除代码 = keep；为小收益引入复杂度 = discard。

## What's Been Tried

（随迭代更新）

- 2026-09-01 本轮已落地（分支 autoresearch/optimize-arch-tests-2026-09-01）：
  1. **事务双检查点按批落盘**（最大头）：durable 镜像（syncDurableRecovery）与
     权威 journal（writeTransactionJournal）都从逐操作整份重写（O(n^2)）改为每
     16 操作 + 收尾/中断/失败/提交路径写精确状态。恢复语义不变（resume 幂等重放 / rollback 快照还原）。
     `--agents all` 五 Agent 安装 14.5s → ~5.2s；init.test.ts 32 用例 76.9s；
     refresh-cli 25.9s。
  2. **Agent Bundle 并行加载**：refresh/initialize/context-index 的 per-agent
     加载与盘上校验 Promise.all 化（模块级 bundle 缓存复用，顺序保持）。
  3. **fs/path-safety 微优化**：正则等价替换 Array.from 逐字符 + win32.isAbsolute。
  4. **5 份 stable/hash 重复实现收敛**到 packages/core/src/fs/stable.ts
     （canonical / raw / strict 三模式 + 兼容转发层，差分测试验证逐字节一致）。
  5. **per-file 盘上哈希校验并行化**（refresh/initialize）；update.test.ts
     seedBaseline 并行写入（测试侧）。
  实测：vitest Duration 176.8s → ~129-130s（tests_sum 281 → ~189s），2244 用例全绿。
- 2026-08 历史：recovery store 堆积导致 init/refresh 测试极慢（已修，readIndex
  有界化 + 测试隔离）；CI_ONLY 两文件本地跳过；CLI 种子初始化（一次部署+目录拷贝）；
  mini bundle 改造。全量 TS 从 36 分钟 → 当前 ~2.2 分钟。
- 已确认并保留：maxWorkers=4 无收益（I/O 绑定，140s 与 2 workers 相当），维持 2。
- 已知安全边界：事务协议（逐操作权威检查点 / completed_target_states / staged 幂等
  重放）不可再压缩；installStaged 的 copy 必须保留（staged 是 pending 操作的恢复源）。
