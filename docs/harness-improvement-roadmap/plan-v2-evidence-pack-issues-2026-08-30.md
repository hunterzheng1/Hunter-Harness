# Plan v2 证据包流程问题报告与优化建议

> 来源：sales-insight-agent 项目首次完整走 `harness-plan`（change `demo-skeleton`，tier standard → assurance 推断）
> 日期：2026-08-30
> 报告人：pi（主会话实测）
> 版本：hunter-harness 0.4.7（npm 缓存实测）

## TL;DR

plan 阶段一次通过的目标是可达的，但本次实际跑了 **~15 次 evidence-pack + 3 次 finalize** 才发布成功。约 60% 时间耗在二分定位无定位信息的校验错误，25% 耗在 assurance 档对抗评审收据的链路断裂。下面按严重度排列，每条附实测证据。

---

## 🔴 P0-1：`adversarial_review` 收据链路断裂

**现象**

- 风险信号推断（auth/concurrency/migration 从 affected_paths 自动推断，合理）把 profile.mode 推到 `assurance`，phase_set 自动补 review 阶段
- finalize 硬性要求证据包顶层 `adversarial_review` 字段，缺失即 `PLAN_REVIEW_REQUIRED` fail closed
- **但 evidence-pack 不接受/不透传该字段**：放在自然输入的顶层、`approval`、`approval.content`、`intent`、`structured_input`、`machine`、`context` 全部被静默丢弃，pack 里永远不存在该字段
- 收据的 `input_hash` 绑定 layer2/layer3 内部输出（`hash2({artifacts, semantic: layer3SemanticBinding(layer2), capabilities, high_risk_findings_hash, lenses})`），外部无法预计算——语义投影、透镜派生、高风险发现全在 CLI 内部管线里

**实测的唯一活路**：先跑一次 finalize，读报错里 `review_execution.input_hash`（校验器会打印期望值），回填收据后重跑通过。这个设计本身很好（verifier 自曝期望值），但**完全没有文档**，是在 dist/bin.js 里翻到的。

**建议**

1. `plan evidence-pack` 支持顶层 `adversarial_review` 透传（最小改动）
2. 或新增 `hunter-harness plan review-record --receipt <file>` 子命令：内部算好 `input_hash`/`findings_hash` 并写回 pack（编排方只需要提供 reviewer_identity + findings）
3. 文档写明：绑定失败时报错会打印期望值（`review_execution.input_hash`），把"先跑一次拿期望值"变成公开契约
4. 报错时同时打印期望 `findings_hash`，并考虑 `--fix-receipt` 自动回填

## 🔴 P0-2：校验报错缺定位信息

**现象**

- `PLAN_DECISION_INPUT_INVALID`、`PLAN_ARTIFACT_INPUT_INVALID` 只返回 `message`，**没有 `field_path` 和 `problems[]`**（reference.md 承诺边界错误有这两个字段）
- 实际触发点：任务/场景/决策层的校验，只能靠逐字段二分定位（本次为此跑了 ~15 次对照实验）

**建议**：所有 `PLAN_*_INVALID` 统一带 `field_path` + `problems[]`（missing_keys / unexpected_keys / expect），与 `PLAN_EVIDENCE_INPUT_INVALID` 的行为对齐。

## 🟡 P1-1：`uncertainties` 实际只接受空数组

- 模板写 `"uncertainties": []`，放字符串项或对象项都报 PLAN_DECISION_INPUT_INVALID
- **建议**：要么实现非空项 schema，要么模板标注「当前仅支持空数组」

## 🟡 P1-2：模板与校验器不同步

- 模板占位 `plan_replace-with-your-plan-run-id` **自己过不了** `PLAN_RUN_ID_INVALID`（run_id 要求 `plan_<uuid>`）——"骨架一个字不改就能通过 evidence-pack"的回归不变量在此破例
- **建议**：模板生成合法占位（如 `plan_00000000-0000-4000-8000-000000000000`），并把该不变量纳入回归测试

## 🟡 P1-3：`affected_paths` 必须是文件形态路径

- 目录路径（如 `src/main/java/com/klerp/salesinsight/`）报 PLAN_ARTIFACT_INPUT_INVALID，无提示
- **建议**：报错文案说明「必须是文件路径，不接受目录」，或校验时给 field_path

## 🟡 P1-4：intent 与 approval.content 的 goal/scope 集合等价校验

- 有精确 diff 输出（好），但可以在 evidence-pack 阶段提供自动归一选项（approval 未显式覆盖时继承 intent），减少一次往返

## 🟡 P1-5：bootstrap-plan 对缺 `.harness/changes/` 报错误导

- 已 harness 管理但从未建过 change 的项目报 `PROJECT_ROOT_INVALID` 并提示"先运行 hunter-harness init"——init 是空白项目用的，对已 init 项目是误导
- **建议**：自动 `mkdir -p` 或改提示为具体修复命令

## 🟢 做得好的（请保留）

- 风险信号从 affected_paths + git status 自动推断，并与手填取并集（防漏报）
- scope mismatch 的 diff 输出精确到条目（missing/extra 分组）
- finalize 绑定失败时回显期望 input_hash（值得文档化，见 P0-1）
- phase_set 自动补 required 阶段（review），并告警 `phase_set_required_retained`

## 附：时间开销分解

| 环节 | 占比 | 归因 |
|---|---|---|
| 二分定位校验错误 | ~60% | P0-2 / P1-1 / P1-3 |
| 对抗评审收据链路 | ~25% | P0-1 |
| 正常运行 | ~15% | — |

P0-1 与 P0-2 修掉后，plan 阶段应能回到「一次通过」。

## 复现环境

- hunter-harness 0.4.7（npx），Node v24.14.0，Windows（Git Bash）
- 项目：sales-insight-agent，change `demo-skeleton`
- 关键操作序列：bootstrap-plan → configure-plan → evidence-pack（多次）→ finalize（3 次）
