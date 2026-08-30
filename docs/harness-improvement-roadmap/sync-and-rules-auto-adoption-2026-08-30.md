# Sync 体验与规则自动采纳分层建议

> 来源：sales-insight-agent 项目 harness-sync 实测 + 用户对「规则是否可自动采纳」的提问
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.7
> 关联：前三份阶段问题报告（plan / execute / review+fixback / submit+archive）

## TL;DR

sync 本身一条命令跑通、摘要清晰，但 remediation 的 `applyCommand` 大面积为空，WARN 到可执行修复之间断链。规则自动采纳可以做，但必须按信任等级分层——先把"候选生成器把事件摘要当规则"的上游质量问题修掉，再谈自动化。

## 🔴 Sync 问题

### S1：remediation 空 applyCommand

`codebase-map` / `codegraph` / `instruction-graph` 三个 WARN 的修复项 `applyCommand` 均为空字符串，用户拿到 WARN 后不知道下一步命令。对比 rules 的 ADVISORY 就带了完整 preview/apply 命令。

**建议**：每个 reasonCode 映射到可执行的 applyCommand（如 `CODEBASE_MAP_MISSING` → 调用 harness-codebase-map skill 的说明，或 `npx hunter-harness sync --fix resolve-codebase-map`）。

### S2：CodeGraph「服务不可达」分级过重

daemon 未运行 ≠ 索引不可用。实测 `codegraph status/index` 正常（CLI 可用、索引在、可增量）。`CODEGRAPH_SERVICE_UNREACHABLE` 应降级为「服务未运行，查询仍可用，仅增量同步暂停」的提示级，而非 WARN。

## 🟡 规则自动采纳：分层模型建议

用户的诉求是"以后规则自动判断是否采纳"。判断：可做，但**不能全自动**——规则是 agent 行为控制面。建议三层：

| 层级 | 规则特征 | 处置 |
|---|---|---|
| 自动采纳 | 可被工具强制验证（lint/类型/格式化）、≥N 次归档证据、纯增量不改行为 | 直接应用 + 审计记录 |
| 摘要批量审 | 行为引导类、证据充分 | 攒一批一次性让用户勾选，而非逐条打断 |
| 永不自动 | 改变权限边界、覆盖既有约定、来源存疑 | 永远人工确认 |

## 🔴 上游问题：候选质量过滤缺失

本次审计的规则候选是"委派只读评审完成，OK 带 notes…"——**这是 review 阶段的事件摘要，不是规则**。候选生成器把 `decision` 事件 note 直接当规则候选了。

在加自动采纳之前，应该先加候选质量过滤：
- 候选必须是「条件 → 约束/动作」结构，事件记录/结果摘要直接过滤
- 候选必须引用归档证据且可定位到具体行为

否则自动分层越完善，垃圾候选进入得越快。

## 复现环境

- hunter-harness 0.4.7（npx），sync 于 sales-insight-agent（阶段 1 归档后）
- 触发组件：rules（ADVISORY）/ codebase-map / codegraph / instruction-graph（WARN）
