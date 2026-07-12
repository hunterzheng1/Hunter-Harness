---
description: harness-apidoc 的7步工作流详细步骤、接口提取规则和执行日志记录格式。仅在执行文档生成流程时读取。
---

# harness-apidoc 检查清单

## 步骤 0：启动准备

确定变更名：用 Glob 搜索 `.harness/changes/*/plans/*-plan.md`（**排除 `.harness/archive/*/`**），读取 frontmatter 提取 `change-name`。默认最多一个未归档变更；如有多个，优先取最近修改的，或询问用户。

**检查 worktree**：读取 `.harness/changes/<change-name>/meta/worktree.json`（旧路径兼容根目录 `worktree.json`）：

- `requested=true` 且 `worktreeRoot` 存在 → cd 到 `worktreeRoot`，确保读取 worktree 中最新代码
- `requested=true` 但 worktree 不存在 → **停止并提示用户修复 worktree 状态，不得静默回到主目录**
- `requested=false` 或文件不存在 → 在主目录执行

不要用 `**` 通配符扫描 worktree（返回 100+ 无关文件）。

**append `phase.start`**（`harness_events.py`；禁止手工 Edit `execution-log.md`）：

```powershell
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase apidoc --type phase.start --note "<触发指令>"
```

## 步骤 1：识别变更范围

读取变更计划文件，结合 `git diff --stat` 确定涉及的 Controller、VO、ErrorCode 文件。

**⚠️ 必读：审查 logs/execution-log.md 中的后续修复记录**

plan 文件是初始设计，代码可能在 review/test 阶段被修改。必须读取 `logs/execution-log.md` 中 plan 之后的条目（旧路径兼容根目录 `execution-log.md`；特别是 harness-review 和审查修复补充），关注：

- 哪些方法被修改了实现逻辑（如硬编码改为枚举）
- 哪些字段被新增/删除/重命名
- 哪些行为发生了变更（如权限策略调整）

在生成文档时，以**实际代码**为准，不以 plan 文件的伪代码为准。

## 步骤 2：提取接口信息

逐个读取变更涉及的 Controller 文件，提取：

- **接口路径和方法**：从 `@RequestMapping`、`@GetMapping`、`@PostMapping` 等注解
- **请求参数**：从方法签名和 `@RequestBody`、`@RequestParam`、`@PathVariable` 注解
- **请求体结构**：从 SaveReqVO、PageReqVO 等请求 VO 的字段定义
- **响应体结构**：从 RespVO、SimpleRespVO 等响应 VO 的字段定义
- **校验规则**：从 VO 上的 `@NotNull`、`@NotBlank`、`@Size` 等校验注解
- **错误码**：从 ErrorCodeConstants 或相关常量类

用 CodeGraph 辅助探索调用链（Controller → Service → Mapper），理解接口的业务逻辑。

**⚠️ 行为变更接口必须读 Service 实际实现**

对于有行为变更的接口（如权限调整、返回值结构变更、查询逻辑修改），必须读取 Service 实现类的实际代码，不能仅依赖 plan 文件中的伪代码。

重点验证：

- `getMeta()` 等返回动态数据的接口 → 读实际返回值构造逻辑
- 枚举/常量值 → 读实际枚举类源码，不从 plan 推断
- 权限校验逻辑 → 读实际 Service 方法体

**枚举值交叉验证**：数据字典中的枚举值必须从实际枚举类源码提取，不从 plan 文件的伪代码推断。如果 plan 中写 `new SceneMetaVO("1", ...)` 但实际代码用 `ProjectTypeEnum.DELIVERY.getCode()`，以实际代码为准。

**codegraph 降级策略**：

- `codegraph_search` 返回 0 结果时（新文件索引未同步），立即用 Grep 搜索
- `codegraph_node` 遇到重名符号时（如多个 ErrorCodeConstants），用 `file` 参数指定文件名
- 不要对同一符号重复调用 codegraph_node 超过 2 次，第 2 次仍不对则用 Read 直接读文件

## 步骤 3：确定文档类型

| 变更规模 | 文档类型 | 说明 |
|----------|----------|------|
| 新功能/新模块（5+ 新接口） | **完整接口文档** | 包含所有章节 |
| 扩展已有接口（新增字段、修改逻辑） | **增量接口文档** | 只描述变更部分，注明与旧版本的差异 |
| 小改动（1-2 个字段变更） | **增量接口文档** | 简要描述变更 |

## 步骤 4：生成文档

按照 `reference.md` 的7章节模板生成文档。关键要求：
- 每个接口必须有：路径参数表、Query/请求体字段表、响应字段表
- 响应示例必须包含完整 JSON
- 字段表必须包含：字段名、类型、必填（请求）、说明
- 校验规则写入字段表的「校验」列（如 `≤50字符`、`枚举`）
- 枚举值必须列入「数据字典」章节，标注前端展示方式
- 前端用法要写具体（不是"展示数据"，而是控件+联动）
- 扩展接口必须描述行为变更（不只是字段变更）
- 前端交互建议用表格：操作 → 接口 → 触发时机 → 交互效果
- 兼容性说明用表格：场景 → 旧行为 → 新行为 → 前端处理
- 错误码必须包含触发场景列
- 从代码提取信息，不从需求文档猜测

**⚠️ 前端影响分级标注（强制）**

每个变更接口必须标注前端影响级别，让前端开发者一眼看出哪些需要改代码、哪些无需处理：

| 标记 | 含义 | 前端动作 |
|:----:|------|----------|
| 🔴 **BREAKING** | 破坏性变更，前端不修改会报错或功能异常 | **必须修改**，优先处理 |
| 🟡 **NEEDS-UPDATE** | 非破坏性变更，但前端需要适配才能使用新功能 | **建议修改**，否则无法使用新能力 |
| 🟢 **TRANSPARENT** | 后端内部变更，前端无感，无需修改 | 无需处理，仅供了解 |

**判定规则**：

- 🔴 **BREAKING**：删除字段、字段类型变更、枚举值删除/变更、请求必填字段新增、响应结构变更、接口路径变更
- 🟡 **NEEDS-UPDATE**：新增可选字段、新增可选参数、新增响应字段（前端可选渲染）、行为变更（如权限放开，前端可删除旧的 403 处理）
- 🟢 **TRANSPARENT**：后端内部重构（如死代码删除、Mapper 优化）、性能优化、日志变更、注释变更

**标注位置**：

1. **接口变更概览表**：在「变更」列后增加「前端影响」列
2. **扩展接口详情**：每个接口标题下方用 callout 标注
3. **文档开头**：增加「前端改动清单」摘要章节

**前端改动清单模板**（放在文档开头，接口变更概览之前）：

```markdown
## ⚡ 前端改动清单

> 前端开发者请优先处理以下 🔴 BREAKING 项，其次处理 🟡 NEEDS-UPDATE 项。

| 优先级 | 接口 | 改动点 | 前端动作 |
|:------:|------|--------|----------|
| 🔴 | `GET /indicator/meta` | `applicableScenes[].code` 值从数字改为枚举编码 | Select 组件 value 改用 `projectType` 字段 |
| 🔴 | `POST /indicator/applicable` | 请求体 `sceneCode` 删除 | 改为传 `projectType` |
| 🟡 | `GET /indicator/enabled` | 新增 `projectType` 过滤参数 | 可选适配，传入可筛选适用指标 |
| 🟢 | `POST /indicator/list` | 后端自动 orgCode 过滤 | 无需处理，前端可删除传 orgCode 逻辑 |
```

## 步骤 5：保存文档

用 Write 工具保存到 `.harness/changes/<change-name>/apidoc/<模块名>-前端接口文档-YYYY-MM-DD.md`。

## 步骤 6：展示并确认

展示文档摘要，询问用户是否满意。不满意 → 修改后重新保存。

**append `phase.complete`**（`note` 含结果/摘要/文档路径）：

```powershell
python <skills-root>/scripts/harness_events.py append --change-dir ".harness/changes/<change-name>" --phase apidoc --type phase.complete --note "OK|WARN|FAIL — <摘要>"
```
