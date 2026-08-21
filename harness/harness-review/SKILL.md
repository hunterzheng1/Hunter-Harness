---
name: harness-review
description: "6维度代码审查（架构/安全/规范/兼容/测试/性能），对照项目规则（见 .harness/context-index.json）和测试场景表，在隔离上下文运行。仅当用户显式调用 /harness-review 时使用；不得在 test 结束后自动接续执行。"
disable-model-invocation: true
argument-hint: "变更名或留空自动检测"
effort: high
allowed-tools: [Read, Write, Edit, Glob, Grep, Agent, Bash(powershell.exe:*)]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(cp *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
  - Bash(codegraph *)
---

# harness-review — 代码审查

## Purpose

对 git diff 进行6维度审查，对照项目规则和测试场景表，输出分级报告。**审查结果仅供参考，默认不阻塞后续 submit/archive 流程。**

## When to Use

仅当用户显式调用 `/harness-review` 时执行。test 阶段结束后**不自动**进入本阶段；用户口头提到"审查/review"而未调用本 skill 时，先确认是否走 Harness 审查阶段。

**单阶段原则**：review 关门（报告 + fixback 产出）后必须停止并交还用户，仅提示下一步可执行 `/harness-execute --fixback`（有待修项）或 `/harness-submit`；禁止自动接续执行。

## Inputs

- `$ARGUMENTS`：变更名（可选，留空时自动扫描 `.harness/changes/*/plans/` 确定）
- 相关文件：`.harness/changes/*/plans/*-plan.md`、`项目规则（见 .harness/context-index.json）/`、测试场景表

## 前置条件

- `.harness/changes/<change-name>/plans/<change-name>-plan.md` 存在（任务真相源）
- 必须读取 `.harness/changes/<change-name>/meta/worktree.json`：`requested=true` 且 worktree 已创建 → 在 worktree 目录中执行审查；`requested=true` 但 worktree 不存在 → 停止，提示先修复 `harness-run`，不得静默回主目录
- **review 不阻塞后续流程**：test 报告缺失或未运行不阻止 review（review 是参考性阶段），但应在报告中标注 test 状态供参考

<!-- @include shared/read-protocol.md -->
> 片段：[[shared/read-protocol.md|read-protocol]]

## Workflow

先用 `harness_context.py prepare --phase review --executor <tool> [--change <id>] --json` 与 `harness_context.py begin --phase review --change <id> --executor <tool> --json` 解析唯一 active change 并校验实际前序 receipt；多个 active change 未显式选择时返回 `ACTIVE_CHANGE_AMBIGUOUS`，禁止再按 Glob/mtime 猜测。阶段门禁使用 `harness_gate.py begin --phase review --change <id> --task <n> --skills-root <skills-root> --executor-tool <tool> --json`；结束时只执行一次 `harness_gate.py close`，正常路径的 `--to-phase` 取 `plannedPhases` 中 review 的后继，Fixback 才返回 run。由 gate 完成阶段事件、租约、上下文交接与远端补传。不得手工追加阶段边界或再次调用 context close；任一 close 失败不得宣称评审完成。

0. **启动准备** — 确定变更名（Glob `.harness/changes/*/plans/*-plan.md`，排除 `.harness/archive/*/`，读 frontmatter 提取 change-name）；**append `phase.start` 事件**（不得等审查完成才补）
1. **读取 worktree 状态（门禁检查）** — 读 `.harness/changes/<change-name>/meta/worktree.json`：`requested=true` 但 worktree 不存在 → 停止并提示先修复 `harness-run`，不得静默回主目录（否则 git diff 为空）；`requested=true` 且 worktree 已创建 → spawned agent 用该 worktree 路径执行 `git diff`（确保审查 worktree 变更而非主目录）；`requested=false` → 审查主目录变更
<!-- @section-id review.delegate -->
### 2. 审查执行（独立评审优先）

review 默认优先在独立上下文执行，避免主会话已形成的实现结论影响审查。阶段开始后只做一次能力判定：固定 reviewer 可用时执行 `python <skills-root>/scripts/harness_preflight.py check-agents --skills-root <skills-root> --agent harness-reviewer --json`；宿主提供通用隔离任务能力时可直接委派一次只读审查。委派只读取 diff、规则和测试证据，主会话负责最终核验与落盘。

无隔离能力、定义损坏、spawn 失败、空返回或只有元数据时，不重试，立即由主会话按同一 6 维度检查清单完成审查。无论是否委派，都必须追加一条结构化 `decision` 事件：`--execution-mode delegated|inline` 标明执行方式；委派时写 `--executor-agent harness-reviewer --decision-reason-code REVIEW_DELEGATED`；回退时只写一个 `--fallback-reason-code REVIEW_INLINE_UNAVAILABLE|REVIEW_INLINE_SPAWN_FAILED|REVIEW_INLINE_INVALID_RESULT`。`decision` 和 `reason` 必须用中文完整说明，禁止把原因码拼进正文。正常主会话评审是可接受结果，不显示成流程故障；`fallbackPolicy=inline-no-retry`。

项目规模小、风险低或没有 CodeGraph 都不是跳过独立评审的理由。原因码是稳定机器字段，仅用于协议与技术详情；面向用户的事件摘要必须写成「已使用独立评审」或「当前环境没有可用的隔离评审能力，已由主会话完成评审」等中文说明。

3. **持久化报告与事实 sidecar（强制，主会话）** — Agent 返回后主会话 Write 到 `reports/review/review-report-*.md`，并把同一批发现写成临时 JSON 后调用 `python <skills-root>/scripts/harness_review.py write-findings --change-dir <change-dir> --input <findings.json>`。每条发现必须填写 `fixbackAction=code|manual|workflow`：只有确实需要修改产品代码的项使用 `code`；人工验收用 `manual`；流程、暂存或工具使用建议用 `workflow`。权威计数来自 `reports/review/review-findings.json`，不是 Markdown。任一写入缺失 → 评审未完整结束，不得关门。
4. **生成修复反馈（原生协议）** — 若报告存在 RED/YELLOW 问题，执行 `protocols.md` 的 `review-fixback-protocol`，将问题转化为结构化 fixback 清单并落盘到 `.harness/changes/<change-name>/reports/review/fixback-YYYYMMDD-HHmm.md`；随后把 disposition 临时 JSON 交给 `python <skills-root>/scripts/harness_review.py write-dispositions --change-dir <change-dir> --input <dispositions.json>`，权威状态写入 `reports/review/fixback-dispositions.json`。若无 RED/YELLOW，也必须写空 findings sidecar，并记录 `review-fixback-protocol: skipped(no findings)`。不调用 Superpowers `receiving-code-review`，也不记录外部 skill 降级。
5. **收尾** — 先写完 `review-findings.json` 与 `fixback-dispositions.json`，且两者 `runId` 必须等于本轮 Review；每个 finding 必须有 disposition。随后只调用一次 gate close，由门禁校验 sidecar、写 `phase.end` 与交接；缺失或不一致时保持 Review 未结束并按恢复提示补齐。控制台输出摘要。

## Review 定位（重要）

**harness-review 是参考性代码审查阶段，不是硬门禁。**

| 等级 | 含义 | 后续影响 |
|:----:|------|----------|
| RED | 高风险建议，强烈建议处理 | 不阻塞后续流程 |
| YELLOW | 中低风险建议 | 不阻塞后续流程 |
| OK | 无问题 | 不阻塞后续流程 |

- 审查结果默认只作为参考，不阻塞 `/harness-submit`、`/harness-archive`
- 除非用户显式要求"review 结果阻塞提交"，否则 review 不参与硬门禁
- Review 报告中**禁止写**：阻塞 submit / 必须修复后才能继续
- Review 报告中**应写**：建议优先处理 / 建议在 submit 前人工确认 / 建议补充测试 / 仅供参考，不阻塞后续 harness 流程

### 可选 strict-review-gate 配置

如果团队希望 review 结果阻塞提交，可在 `.harness/config/harness-test-config.md` 中设置：

```yaml
review:
  strict-review-gate: true   # 默认 false
```

当且仅当 `strict-review-gate: true` 时，review RED 才阻塞 submit。默认行为是 `strict-review-gate: false`。

## Output Format

审查报告保存到 `.harness/changes/<change-name>/reports/review/review-report-YYYYMMDD-HHmm.md`（时间戳区分多次运行），同时在控制台输出摘要。报告格式详见 `reference.md` 的「输出报告完整模板」。

## 渐进披露

- **Read `checklist.md`** 仅在执行完整6维度审查时 — 含6维度检查项详细列表 + 输出格式 + 执行日志记录模板
- **Read `reference.md`** 仅在需要理解审查标准或生成详细报告时 — 含"为什么需要审查"概述 + 严重级别判定标准 + 输出报告完整模板
- **Read `protocols.md`** 仅在 RED/YELLOW 问题需要转化为修复反馈时 — 含 `review-fixback-protocol` 的结构化 fixback 字段与落盘要求

## 原生修复反馈协议

`/harness-review` 不再运行时调用 Superpowers `receiving-code-review`。审查后的修复反馈能力内化为 `protocols.md` 的 `review-fixback-protocol`：

1. RED/YELLOW 问题转成 fixback 条目：严重级别、位置、风险、建议、验证方式、对 submit 的影响。
2. fixback 落盘到 `.harness/changes/<change-name>/reports/review/fixback-YYYYMMDD-HHmm.md`。
3. 无 RED/YELLOW 时记录跳过原因，不制造空修复任务。

没有 `.codegraph/` 只意味着“项目尚未建立 CodeGraph 索引，已直接读取源码”，不得将它写成独立评审不可用或委派失败原因。历史英文原因码不得进入摘要；稳定码只写结构化字段并留在技术详情。

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]

## 关键规则（硬门禁速查）

> 每条规则的详细判定、检查项见 `checklist.md` 对应章节；Shell 执行安全见 `../protocols/powershell-protocol.md`，敏感信息见 `../protocols/sensitive-info-protocol.md`，证据化报告见 `../protocols/evidence-based-reporting-protocol.md`，状态目录见 `../protocols/state-layout-protocol.md`，结构化报告事件见 `../protocols/report-pipeline-protocol.md`。

### 一、只审查 git diff 变更部分

只审查本次 `git diff` 中的变更，不审查已有代码；diff 为空 → 直接返回"无变更可审查"。每个问题给出具体修复建议（文件:行号 + 建议做法）。

### 二、严重级别三态

RED=高风险建议（强烈建议处理），YELLOW=中低风险建议，OK=无问题。6维度逐文件审查（架构/安全/规范/兼容/测试/性能）—— 检查项见 `checklist.md`。判定标准见 `reference.md`「严重级别判定标准」。

### 三、review 结果仅供参考（不阻塞后续流程）

review 结果默认只作参考，不阻塞 submit/archive；报告措辞遵循 `## Review 定位（重要）` 的“禁止写/应写”清单，不得出现“阻塞 submit / 必须修复后才能继续”。

### 四、Shell 安全 / 敏感信息 / 证据化报告 / CodeGraph 探索

git diff/log 命令通过 `powershell.exe -Command "..."` 执行；review-report 中如发现明文 token/密码/密钥，必须列入 RED 问题并在报告中以 `<TOKEN_REDACTED>` 等占位符引用；RED/YELLOW/OK 结论必须基于实际 diff 内容，不得凭印象判断。代码探索必须优先使用 CodeGraph MCP 工具（`mcp__codegraph__codegraph_explore`），不允许通过普通 Bash 调 codegraph 命令（已列入 `disallowed-tools`）；采纳任何返回源码前，按 `reference.md` 的 C12 合同校验 executionRoot/rootPath、worktreeId、repositoryId、HEAD 与 index snapshot，`IDENTITY_MISMATCH` 必须读取实际 worktree，不得当作 stale 忽略；MCP 不可用时降级为 Grep/Glob + Read，并在执行日志记录降级原因。遵循 `../protocols/powershell-protocol.md` / `sensitive-info-protocol.md` / `evidence-based-reporting-protocol.md`。

### 五、state snapshot 与源码重验

review 读取 `state-snapshot.json`（`harness_state.py` / state-layout-protocol §state-snapshot.json）的 code/diff 段确定审查范围；snapshot 失效或代码段变化时**必须重新读取实际变更源码**，不得仅凭缓存快照跳过源码审查（design §3.6）。

## 交互白名单

**无** blocking user confirmation（审查全自动）。委派失败 → 主会话审查 + `decision` 事件。

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`review` · 事件：phase/decision/verification/issue/artifact
