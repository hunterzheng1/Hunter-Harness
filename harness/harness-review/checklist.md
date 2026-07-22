---
description: harness-review 的6维度审查检查项详细列表。仅在执行完整代码审查时读取。
---

# harness-review 检查清单

## 启动准备：确定变更名

用 Glob 搜索 `.harness/changes/*/plans/*-plan.md`（**排除 `.harness/archive/*/`**），读取 frontmatter 提取 `change-name`。默认最多一个未归档变更；如有多个，优先取最近修改的，或询问用户。后续所有路径基于此变更名。

**读取 worktree 状态**：读 `.harness/changes/<change-name>/meta/worktree.json`。`requested=true` 且 worktree 已创建 → 后续 `git diff` 的 `<项目路径>` 用 worktree 路径（`.worktrees/<change-name>`）；`requested=true` 但 worktree 不存在 → 停止，提示先修复 `harness-run`，不得静默回主目录。

## 审查流程

### 1. 获取变更范围

```powershell
powershell.exe -Command "git -C '<项目路径>' diff --stat"
powershell.exe -Command "git -C '<项目路径>' diff"
```

### 2. 六维度逐文件审查

#### 维度 1：架构

| 检查项 | 为什么重要 |
|--------|------------|
| 接口层中有业务逻辑 | 破坏分层，后续修改影响面不可控 |
| 业务层间循环依赖 | 启动失败或运行时 StackOverflow |
| 接口层跨模块调用业务层 | 破坏模块边界，耦合扩散 |
| 业务层抛异常、接口层 try-catch | 异常处理应在全局异常处理器统一 |
| 写操作无事务边界 | 数据不一致（部分写入成功、部分失败） |

#### 维度 2：安全

| 检查项 | 为什么重要 |
|--------|------------|
| 硬编码密码/Token/密钥 | 代码泄露 = 凭据泄露 |
| 字符串拼接 SQL | SQL 注入风险 |
| 用户输入直接返回前端 | XSS 风险 |
| 对生产库执行写操作 | 数据丢失/破坏 |
| 日志打印敏感信息 | 日志泄露 Token/身份证号 |
| 新增接口无权限校验 | 未授权访问 |

#### 维度 3：编码规范

| 检查项 | 严重度 |
|--------|:------:|
| 数据类暴露不必要可变 setter（应改只读访问器） | YELLOW |
| 控制台输出替代日志框架 | YELLOW |
| 集合方法返回 null 而非空集合 | YELLOW |
| 魔法值未定义常量 | YELLOW |
| 公共 API 无文档注释 | YELLOW |

#### 维度 4：兼容性

| 检查项 | 为什么重要 |
|--------|------------|
| 删除/修改已发布接口的字段 | 旧前端/调用方立即报错 |
| 删除/重命名数据库已有字段 | 数据丢失 |
| 删除/修改已有枚举值 | 存量数据无法解析 |
| 新增字段不为 nullable | 旧数据无法查询/写入 |

#### 维度 5：测试

对照场景表检查覆盖。重点看新增业务方法是否有对应单元测试，异常场景是否有覆盖。

#### 维度 6：性能

| 检查项 | 信号 |
|--------|------|
| N+1 查询 | 循环体内调用数据访问层查询 |
| 缺少索引 | 新增 WHERE 条件无对应索引 |
| 大事务 | 事务内含远程调用或文件 IO |
| 逐条 insert | 循环内单条 insert 而非批量 |

### 3. 对照 项目规则（见 .harness/context-index.json）/ 检查

逐个规则文件检查变更是否违规。违规项标注对应规则文件名和行号。

### 4. 对照场景表检查

如果场景表存在，逐条确认代码是否覆盖。未覆盖的标记为「测试缺口」。

## 输出格式

审查报告保存到 `.harness/changes/<change-name>/reports/review/review-report-YYYYMMDD-HHmm.md`（时间戳格式：日期+时分），同时在控制台输出摘要。完整报告模板见 `reference.md`「输出报告完整模板」，本文不再重复。

## 原生修复反馈检查

### fixback 生成确认（按需）

如果用户需要修复任务清单，确认以下事项：

```
□ 已读取 harness-review/protocols.md
□ 已执行 review-fixback-protocol（不调用外部 receiving-code-review）
□ RED/YELLOW 问题已转化为结构化修复任务清单
□ 修复任务清单含严重级别、位置、风险、修复建议、验证方式、submit 影响
□ fixback 已落盘到 .harness/changes/<change-name>/reports/review/fixback-YYYYMMDD-HHmm.md
```

> 如果没有 RED/YELLOW 问题，记录 `review-fixback-protocol: skipped(no findings)`，不要生成空 fixback。`harness-review` 不检查 Superpowers 是否安装，也不记录外部 skill 降级。

### 代码探索效率检查

```
□ 审查代码时优先使用 codegraph_explore（一次获取多个符号源码）
□ 未逐个 Read 文件（违反 项目 codegraph 规则 规则）
```

## 关键原则

- 只审查 `git diff` 中的变更部分，不审查已有代码
- 对照 `项目规则（见 .harness/context-index.json）/` 是审查的基准线
- 区分严重级别：RED=高风险建议（强烈建议处理），YELLOW=中低风险建议
- 每个问题给出具体修复建议（文件:行号 + 建议做法）
- 如果 diff 为空，直接返回"无变更可审查"
- **review 结果仅供参考，不阻塞后续 submit/archive**

## 事件记录

- [ ] append `phase.start` 事件（步骤 0 启动准备之前；`note` 含触发指令）
- [ ] append `phase.end` 事件（`note` 含耗时、结果、落盘 path、RED/YELLOW 统计摘要）
