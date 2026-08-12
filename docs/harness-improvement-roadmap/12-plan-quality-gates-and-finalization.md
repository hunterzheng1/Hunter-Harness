# 阶段 12：建立 Plan 分层质量检查与结束门

## 依赖与并行边界

必须先完成阶段 11，并稳定新的产物职责和兼容格式。该阶段不再重新定义 design、plan 或 scenarios 的字段。

本阶段拥有质量策略、finalizer 校验和 Plan 事件语义。它不能与阶段 10 或 11 并行修改 Plan 状态机和产物。阶段 13 可并行实现不依赖 Plan 终态的页面；监控、变更记录和事件文案必须等待本阶段事件 Schema 冻结后接入。

## 目标

建立三层质量检查：所有需求执行确定性检查，中等和高风险需求执行语义一致性检查，只有高风险或显式请求才执行对抗评审。finalizer 继续作为唯一结构发布入口。

## 当前问题

- 协议自检、checklist 和 finalizer 重复检查相同项目。
- 「协议自检通过」被写入事件，增加监控噪声但没有新的决策价值。
- 结构完整不代表 design、plan 和 scenarios 语义一致。
- 对抗评审适合高风险设计，但不应成为普通任务的默认成本。
- 固定质量清单容易让不适用维度变成形式化勾选。

## 分层检查模型

### 第一层：确定性结构检查

所有 `PlanProfile` 都执行：

- 标准文件存在且路径合法。
- frontmatter 和 JSON 可解析。
- 哈希、收据和生命周期一致。
- 任务 ID、场景 ID 唯一。
- 任务、checkpoint 和 scenario manifest 一致。
- ownership 覆盖计划修改范围。
- 不包含禁止占位符。
- staging 原子发布和 verify 成功。

这些检查由脚本执行。Agent 不再生成叙述式「全部通过」说明。

### 第二层：语义一致性检查

`standard` 和 `assurance` 执行只读检查：

- IntentContract 中的目标是否被 design 覆盖。
- design 的关键行为是否有对应任务和场景。
- plan 是否引入 design 未批准的范围。
- scenarios 是否验证关键不变量和失败行为。
- 文件与模块影响是否与 EvidenceMap 一致。
- 用户已拒绝的方案是否重新出现在任务中。

没有问题时只写机器结果，不生成单独报告。发现问题时，给出来源文件、冲突内容和建议修复位置。

### 第三层：高风险对抗评审

只有以下情况执行：

- `PlanProfile=assurance`。
- 用户显式指定 `--adversarial`。
- 语义检查发现需要独立复核的高风险冲突。

检查重点根据能力动态选择：

- 认证和授权。
- 支付和审计。
- 数据迁移与失败恢复。
- 并发、幂等和顺序。
- 不可逆删除。
- 对外 API 和客户端兼容。
- 性能和资源上限。

正常 inline 检查不记为降级。委派失败时最多回退一次 inline，不重复启动 evaluator。

对抗评审和语义检查统一记录执行收据：

```text
ReviewExecutionReceipt = {
  schema_version,
  review_mode,                 // inline | delegated
  delegation_attempted,
  delegation_outcome,          // not_requested | succeeded | unavailable | failed
  fallback_reason?,
  reviewer_identity,
  input_hash,
  findings_hash,
  completed_at
}
```

监控默认展示「使用独立评审」「使用主会话评审」或未委派的中文原因，不直接展示内部英文原因码。恢复和审计只读取机器字段。

## 自适应设计质量镜头

根据变更能力选择适用项，不要求所有设计机械填写：

- 用户可见行为和验收示例。
- 接口及调用者必须知道的约束。
- 数据所有权和一致性。
- 不变量和错误模式。
- 依赖方向和 Seam。
- 迁移、回滚和兼容。
- 并发、幂等和重试。
- 可观测性和故障诊断。
- 安全、权限和审计。

新建公共接口、跨模块 Seam 或难以撤销的架构决策时，可以要求至少比较两个设计。普通内部修改不执行该步骤。

## 事件规则

用户可见事件只记录：

- 阶段开始和结束。
- 用户确认的重要决策。
- 自动采用但会影响行为的重要默认值。
- 发现的冲突、风险和阻塞项。
- 产物发布及校验失败。

以下内容不再作为独立可见事件：

- 「协议自检通过」。
- 每个 checklist 项逐条通过。
- 重复的哈希和内部收据字段。
- 没有改变结论的正常 inline 路由。

技术字段保留在折叠详情或机器收据中。

事件 Schema 至少区分 `phase_started`、`decision_recorded`、`risk_found`、`artifact_published`、`validation_failed` 和 `phase_ended`。中文标题和摘要是展示字段；恢复逻辑只依赖机器类型、阶段、序号和幂等身份。

公共事件信封至少包含：

```text
PlanEvent = {
  schema_version,
  event_id,
  run_id,
  change_key,
  phase,
  attempt,
  type,
  producer_seq,
  occurred_at,
  idempotency_key,
  summary_zh?,
  detail_ref?,
  receipt_ref?
}
```

阶段重试递增 `attempt`，不能覆盖此前终态；`producer_seq` 只负责同一生产者的稳定顺序。页面可以倒序展示，但持久化和恢复仍按机器序号处理。

## 实施步骤

1. 盘点 finalizer 已覆盖的确定性检查，删除自然语言重复检查。
2. 定义跨产物语义一致性检查输入和输出。
3. 将语义检查绑定到 `standard` 和 `assurance`。
4. 将对抗评审绑定到 `assurance`、显式参数和高风险冲突。
5. 将固定清单改为按能力选择的质量镜头。
6. 统一 inline、delegated 和 fallback 的事件语义。
7. 清理监控中无决策价值的 verification 事件。
8. 保留完整机器收据，避免为界面精简删除审计证据。

## 验收条件

- `quick` 不执行昂贵的语义或对抗检查，除非风险升级。
- `standard` 能发现 design、plan 和 scenarios 的语义遗漏。
- `assurance` 必须完成高风险检查或明确阻塞。
- finalizer 仍是唯一原子发布入口。
- 结构检查和语义检查结果不会混在同一笼统状态中。
- 监控事件只显示有业务或恢复价值的内容。
- 委派失败不会形成重试循环。

## 聚焦测试

- design 有行为但 plan 无任务时，语义检查失败。
- plan 引入未批准模块时，语义检查失败。
- scenarios 缺少高风险不变量时，assurance 阻塞。
- quick 简单修复不调用 evaluator。
- evaluator 空返回或失败时只回退一次 inline。
- finalizer 结构失败时不写成功终态。
- 成功 Plan 不产生叙述式协议自检事件。
- 技术哈希仍存在机器收据中，但不占用默认事件正文。

## 非目标

- 不重新定义阶段 08～11 已冻结的分类、意图、决策或产物字段。
- 不把不稳定的模型建议变成所有模式的结构阻断。
- 不要求普通任务默认启动独立 evaluator。
- 不为了精简页面而删除恢复、委派和审计所需的机器证据。

## 停止条件和回退

如果语义检查依赖模型输出且结果不稳定，先将它设为 `standard` 的建议项、`assurance` 的阻塞项，并收集误报。不要让不稳定检查立即阻塞所有普通需求。

如果事件精简影响平台恢复或审计，保留机器事件类型，只调整默认展示。不要删除服务端恢复依赖的字段。
