---
description: harness-plan 的阶段检查清单和覆盖检查列表。仅在执行完整需求规划时读取。
---

# harness-plan 检查清单

## 阶段 0：工作区变更检查 ⚠️ 强制检查

> 有未提交业务变更（排除 `.harness/`）→ **默认 baseline 隔离**，append `decision` 事件，**不 AskUserQuestion**，继续规划。PowerShell 失败 → ❌ 停止。

**固定命令**：`powershell.exe -Command "git -C '<项目路径>' status --porcelain"`

**判定**：stdout 为空 → ✅ 继续；stdout 非空 → baseline 隔离 + `decision`（note 含变更文件列表）；Bash 被拒 → PowerShell 重试。

## 阶段 0.5：事件初始化与知识查询

- [ ] 先确定 change-name，并立即用 `harness_events.py append` 追加 `phase.start`
- [ ] 再执行一次 knowledge `query`；由 query 内部 ensure-current，不另跑前置 sync
- [ ] 查询失败追加 `issue`，不得重跑“sync + query”循环或假装已读取历史

## 阶段 2：歧义优先检查与复杂度分级

- [ ] 否定、对比、动作对象、范围或保留/删除关系不存在未确认的多义解释
- [ ] 若存在歧义，仅完成最小取证后一次一问，并给出推荐理解
- [ ] 简单修复探索预算：最多 1 次合并 CodeGraph 查询 + 1 次定向补查、1 个澄清问题
- [ ] 无关发现只记非阻断 `issue`，未扩展当前方案或问题列表

## 设计审批包字段：Worktree

> worktree 不再单独询问。阶段 4 **设计审批包** 一次 AskUserQuestion 含 worktree 选项（推荐值读 `harness.json` `defaultWorktree`）。确认后写入 `meta/worktree.json`。

- [ ] 审批包确认后写入 worktree.json（`requested` true/false）
- [ ] 阶段 8 检查 worktree.json 存在

## 阶段 3：代码探索确认（含 Agent/CodeGraph 降级记录）

阶段 3 执行完成后，确认以下事项：

```
□ 是通过 Agent 工具委派 subagent 执行的（不是主会话直接调用 codegraph）
□ subagent 返回了结构化设计概要（涉及模块、接口变更、关键决策）
□ 委派前已运行 `python <skills-root>/scripts/harness_preflight.py check-agents --skills-root <skills-root> --agent harness-explorer --json`
□ `usable=false` 或未返回有效输出 → 主会话探索，**不 retry 委派**
□ 主会话未被代码探索的中间结果污染
□ 在执行日志中记录了 Agent 调用状态：
  - 是否成功调用
  - 使用的 agent 名称
  - 是否只读
  - 子代理实际 tool uses 计数
  - 返回的核心结论
```

> 如果 Agent 工具不可用，或子代理被委派但未返回有效输出（0 tool uses / 空返回 / 仅 "Done"），必须显式降级并记录：
> - 追加 `issue` 事件并在 note 写明降级原因：Agent 不可用 / 子代理未返回有效输出，改为主会话只读探索
> - 主会话直接使用 codegraph MCP 工具（`mcp__codegraph__codegraph_explore`）和 Read 探索代码（只读，不执行写操作）
> - 不得在主会话中执行任何写操作
> - CodeGraph 如通过 MCP 调用，必须优先用 MCP 工具，不允许通过普通 Bash 调 codegraph 命令
> - 禁止把子代理未经工具验证的文本结论当作"详尽报告"或代码证据采纳

## 影响面检查（远程客户端路径）

变更涉及 HTTP/RPC 客户端时，在设计/任务拆分前完成路径静态比对：

- [ ] 变更涉及 HTTP/RPC 客户端（Feign/RestTemplate/SDK 封装）时：取客户端注解路径（类级 + 方法级拼接），与服务提供方 controller 的 `@RequestMapping` + 方法级注解**完整拼接路径**逐一比对，在计划/执行记录中列出比对结果。只看方法级注解不算完成。

## 阶段 4：设计审批包 ⚠️ 强制阻断（一次 AskUserQuestion）

> 合并原「设计审核 + worktree + 场景表预览 + change-name」。推荐 worktree 读 `harness.json` `defaultWorktree`。

**展示内容**：

1. 设计摘要 + 关键证据 + 风险 + 变更清单
2. 测试场景表摘要 + 8 维度覆盖检查
3. worktree 选项（是/否，含推荐理由）
4. change-name（自动生成，可修改）
5. 确认进入任务拆分

确认后写入 `spec/<change>-design.md`（含 frontmatter）和 `meta/worktree.json`。

- [ ] 确认事件早于 approved 设计文档；未获确认时不得先落盘 `status: approved`

设计文档必须包含 frontmatter：
```yaml
---
change-name: <change-name>
created: YYYY-MM-DD HH:mm
status: approved
source: harness-plan
---
```

展示可审核包后，使用 `AskUserQuestion` 询问用户：
- **确认**：设计方向正确，继续任务拆分
- **修改**：某个部分需要调整，修改后再审核
- **取消**：方向不对，回到需求澄清阶段

### 设计文档自审清单

写完设计文档后，用以下清单自检，**并将自审结果展示给用户**：

```
□ 无"TBD"/"TODO"/未完成章节
□ 各节之间无矛盾
□ 范围聚焦，无不相关内容
□ 无歧义需求（可被两种方式解读的，已选一种并明确说明）
□ 自审结果已展示给用户
```

> 展示格式示例：
> ```
> ### 设计文档自审
> - ✅ 无 TBD/TODO/未完成章节
> - ✅ 各节之间无矛盾
> - ✅ 范围聚焦，无不相关内容
> - ⚠️ 第3.2节"枚举删除"与第4节变更清单中"标记@Deprecated"有矛盾，已修正为"删除"
> ```

## 测试场景覆盖检查表（8 维度覆盖检查表，强制输出）

> 注意：覆盖检查表是 8 维度，与 4 维度场景表（单元/接口/数据兼容/集成）是两个不同制品。

生成场景表后，逐项确认是否覆盖，**必须输出覆盖检查表展示给用户确认**。未覆盖的维度必须标记为缺口（⚠️ 缺口），不得全部标记为 ✅：

| 覆盖维度 | 状态 | 说明 |
|---|---|---|
| 正常路径 | ✅/🟡/❌ | 每个接口 ≥ 1 个正常场景 |
| 参数校验 | ✅/🟡/❌ | 必填缺失、格式非法、类型错误 |
| 业务规则 | ✅/🟡/❌ | 唯一性、范围约束、状态机 |
| 权限/组织边界 | ✅/🟡/❌ | 无权限、跨组织、角色限制 |
| 数据兼容 | ✅/🟡/❌ | 旧数据无新字段 |
| 错误码 | ✅/🟡/❌ | 每个异常对应明确错误码 |
| 集成影响 | ✅/🟡/❌ | 跨模块调用、端到端流程 |
| 并发/幂等 | ✅/🟡/❌ | 重复提交、并发修改 |

> 展示格式示例：
> ```
> ### 场景覆盖检查表
> | 覆盖维度 | 状态 | 说明 |
> |---|---|---|
> | 正常路径 | ✅ | 5 个接口各 ≥ 1 个正常场景 |
> | 参数校验 | ✅ | 必填缺失、格式非法已覆盖 |
> | 业务规则 | ✅ | 唯一性、状态机已覆盖 |
> | 权限/组织边界 | 🟡 | ⚠️ 缺口：未覆盖跨组织场景，需补充 |
> | 数据兼容 | ✅ | 旧数据 scene_code 迁移场景已覆盖 |
> | 错误码 | ✅ | 3 个错误码均有对应场景 |
> | 集成影响 | 🟡 | ⚠️ 缺口：未覆盖端到端流程，需部署后验证 |
> | 并发/幂等 | ❌ | ⚠️ 缺口：未覆盖重复提交场景，需补充 |
> ```

## 阶段 7.5：计划对抗评审（可选）确认

> 仅在用户选择启用对抗评审时执行本节检查。默认不启用（高风险构建 auth/支付/迁移/并发 才启用）。

阶段 7.5 执行完成后，确认以下事项：

```
□ 已用 **设计审批包** 一次 AskUserQuestion（设计 + 场景表摘要 + worktree + change-name）
□ **未**单独询问 worktree 或对抗评审（对抗评审仅 `--adversarial`）
□ 用户同意后，已用 Agent 工具委派 harness-evaluator（haiku, context:fork, plan 模式只读, maxTurns:8）
□ 已用 context:fork 隔离上下文（evaluator 未参与规划，破除确认偏误）
□ 已校验子代理 tool uses > 0（0/空/Done 视为未返回有效输出，已降级为主会话自审并记录）
□ evaluator 返回了 VERDICT(APPROVED/REVISE) + 结构化问题清单（RED/YELLOW）
□ 评审报告已写入 .harness/changes/<change-name>/reports/plan-review/plan-review-YYYYMMDD-HHmm.md
□ VERDICT 和问题清单已展示给用户（不得仅记"已评审"）
□ REVISE 时已询问用户是否修订；修订后可选再审
□ 评审为参考性，未阻塞阶段8
□ 执行日志记录了 evaluator 调用状态（委派成功/降级原因）+ VERDICT 摘要
□ 如为主会话自审降级，已标注"⚠️ 同会话自审，回音壁风险"
```

## 原生规划协议检查

### 阶段 4：clarification + decision-grilling

阶段 4 执行完成后，确认以下事项：

```
□ 已读取 protocols.md，并按 clarification-protocol / decision-grilling-protocol 执行
□ 输入包含需求摘要 + 阶段1 context pack（如有）+ 阶段3代码探索结果 + 项目架构约束
□ 已用 decision / issue 事件 note 记录五类输出：风险识别 / 复用机会 / 替代方案 / 推荐方案 / 关键决策
□ 已叠加项目架构约束（分层规范、数据模型、接口规范）
□ 需求澄清结论已追加到 events.ndjson，阶段结束后执行日志由渲染器生成
□ 用户问题未超预算：简单修复 0-1 问，普通需求 1-3 问，高风险需求 5-7 问；无必须裁决事项时 0 问
□ 提问遵循"一次一问、等答再继续"；能由 context pack / 阶段3代码探索 / CodeGraph 自答的问题已自答，未打扰用户
□ 每个需要用户决策的问题，AI 先给出了推荐答案、理由和取舍，用户仅确认或修正
□ 高风险/业务语义决策（范围、权限、安全、支付、迁移、删除、API契约、用户可见行为）已显式等待用户确认
```

> 不再检查 Superpowers brainstorming 是否安装或调用；阶段 4 是 harness 原生协议，不存在外部 skill 降级分支。

### 阶段 6：implementation-planning

阶段 6 执行完成后，确认以下事项：

```
□ 已读取 protocols.md，并按 implementation-planning-protocol 执行
□ 输入为阶段4已审核设计文档
□ 已生成基础任务列表，并用 artifact 事件 note 记录任务拆分摘要
□ 已叠加项目层序依赖（数据/契约→业务层→接口层）
□ 已生成 4 维度场景表（单元/接口/数据兼容/集成）
□ 已确定变更名（kebab-case）
□ 产物已写入 .harness/changes/<change-name>/plans/：
  - <change-name>-plan.md（简洁任务表）
  - <change-name>-implementation-detail.md（自适应详细执行参考）
  - <change-name>-test-scenarios.md（测试场景表）
□ implementation-detail.md 按复杂度自适应：简单任务不过度展开，复杂任务写清接口/数据/顺序/风险/测试策略
□ plan / implementation-detail / test-scenarios 三件套互相引用一致，无 TBD/TODO/空泛占位
```

> 不再检查 Superpowers writing-plans 是否安装或调用；阶段 6 是 harness 原生协议，不存在 `docs/superpowers/` 同步分支。

## 阶段 8：结束前产物完整性检查 ⚠️ 强制

> **缺任一文件 → ❌FAIL，不得宣称 plan 完成。**

- [ ] 所有待发布产物先写入 staging，不直接覆盖正式 change 目录
- [ ] 执行 `harness_plan_finalize.py finalize --change-dir ... --staging-dir ... --change ... --run-id ... --attempt ... --json`
- [ ] finalizer 返回 `ok=true` 与 `artifactsHash`；重复执行返回 `idempotent=true`
- [ ] finalizer 失败时正式目录无半发布产物、无成功 `phase.end`、无伪造 execution log
- [ ] 禁止在 finalizer 之前手工追加成功 `phase.end`

| 文件 | 必须存在 | 检查结果 |
|------|:---:|:---:|
| `.harness/changes/<change>/spec/<change>-design.md` | ✅ | □ |
| `.harness/changes/<change>/plans/<change>-plan.md` | ✅ | □ |
| `.harness/changes/<change>/plans/<change>-implementation-detail.md` | ✅ | □ |
| `.harness/changes/<change>/plans/<change>-test-scenarios.md` | ✅ | □ |
| `.harness/changes/<change>/meta/worktree.json` | ✅ | □ |
| `.harness/changes/<change>/logs/execution-log.md` | ✅ | □ |
| `.harness/changes/<change>/events.ndjson` | ✅ | □ |

### Plan 结束行为检查

```
□ 未询问 Subagent-Driven / Inline Execution 等执行模式
□ 最终输出只提示了产出物路径和下一步 /harness-run
□ 未将 docs/superpowers/ 列为最终产物路径
```

### Legacy Frontmatter 兼容

```
□ 已确认 plan 文件 frontmatter 存在
□ 如不存在 → 已从路径推断 change-name 和 plan-name
□ 如不存在 → 执行日志中已标记 🟡 legacy-plan
□ 旧 plan 不因 frontmatter 缺失而 FAIL
```

## 关键原则

- **产物路径唯一性**：`.harness/changes/<change-name>/` 是唯一真相源，plan 产物必须直接写入此目录
- **原生规划协议**：阶段 4/6 使用 clarification、decision-grilling、implementation-planning 三段内置协议，不运行时依赖 Superpowers/grill-me/writing-plans
- **阶段 4 是强制阻断检查点**——展示设计审批包后必须停下来问用户，收到回复后才能写 approved 设计文档。不要跳过
- 代码探索只读不写——这个阶段的目标是理解，不是修改
- 场景表是后续所有步骤的真相源——宁可多花时间打磨，不要草草了事
- 如果需求不明确，优先提问而不是猜测后继续设计
- 任务拆分粒度按复杂度调整——plan 简表保持可追踪，implementation-detail 按风险和复杂度自适应展开
- **Plan 结束禁止询问执行模式**：Subagent-Driven / Inline Execution 属于 /harness-run 阶段

## 事件记录（前置规则）

- [ ] 确定 change-name 后立即 append `phase.start` 事件；各阶段用 `harness_events.py append` 写入 `decision` / `issue` / `artifact`
- [ ] 阶段 0 在 change-name 确定前可不写事件；阶段 0.5 确定 change-name 后必须开始记录

## 需求范围缩减后的 change-name 检查 ⚠️

- [ ] 阶段 4 澄清后，检查最终需求范围是否和 change-name 一致
- [ ] 如果用户取消某个需求，但 change-name 仍包含该需求关键词，必须建议重命名
- [ ] 重命名后同步目录名、spec/plan/scenarios 文件名、frontmatter、logs/execution-log、events.ndjson、meta/worktree.json
- [ ] 如果用户选择不重命名，记录 🟡WARN 到 events.ndjson（`issue` 或 `decision` 事件）
