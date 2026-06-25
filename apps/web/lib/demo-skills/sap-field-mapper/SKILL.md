---
name: sap-field-mapper
description: 从 Markdown 文档中自动提取 SAP/S4 表名和字段名，调用数据对象接口查询实体类映射，自动处理 T-table（文本表）的基表合并，生成 S/4 表字段与实体类对照表。当文档中出现 SAP 表名（BKPF/ACDOCA/T001/T685T 等）或 S/4 字段映射描述时自动触发。
when_to_use: 文档中出现 SAP 标准表名（如 BKPF、ACDOCA、BSEG、T001、SKB1、T685T 等）、S/4 字段名、或"字段映射""实体类对照""SAP表对应"等描述时自动触发。
allowed-tools: Read, Grep, Glob, Bash(curl *), Write, Edit
model: inherit
paths:
  - "**/*.md"
---

# SAP/S4 字段映射工具

## Purpose

自动提取 Markdown 文档中的 SAP/S4 表名和字段名，通过 API 查询对应的实体类信息，在项目中定位实体类文件路径，生成完整的对照表追加到原文档末尾。

## When to Use

| 触发场景 | 操作 |
|---------|------|
| 文档出现 SAP 表名（BKPF、ACDOCA、BSEG、T001 等） | 自动提取并生成对照表 |
| 文档出现 "SAP表" / "S4表" / "标准表" 标注 | 自动识别映射关系 |
| 用户手动调用 `/sap-field-mapper` | 处理指定文档 |
| 代码中出现 `bkpf.bldat` 等 SAP 字段引用 | 自动生成字段映射 |

## Inputs

- `$ARGUMENTS`：可选，指定的 Markdown 文档路径或文件名
- 未指定时，从当前会话上下文中的文档自动提取

## Workflow

### 1. 提取 SAP/S4 表名和字段名
仔细阅读目标文档，识别 SAP 标准表名和字段名：
- 明确标注为 "SAP表"、"S4表"、"标准表" 的内容（优先）
- 文本描述如 "从 BKPF 表中读取 BLDAT 字段"
- 代码示例如 `bkpf.bldat`、`ACDOCA-WSL`
- 注释说明如 "对应 SAP 表 BKPF 的字段 BLDAT"
- **`表名-字段名` 格式**（如 `ACDOCA-VALUT`、`T001-BUKRS`）：以 `-` 连接的组合，`-` 左侧为 SAP 表名，右侧为字段名。例如 `ACDOCA-VALUT` → 表 `ACDOCA`、字段 `VALUT`；`AccountDocumentItem-valueDate` → 表 `AccountDocumentItem`、字段 `valueDate`。所有中间用 `-` 隔开的情况均按此逻辑拆分
- 整理为 `{表名: [字段1, 字段2, ...]}` 结构，确保去重
- 不确定的组合宁可遗漏也不要误提取

### 2. T-table 检测与合并
> T-table 是 SAP 中以 "T" 结尾的文本表（如 T685T），**项目中没有对应的实体类**，其字段实际存储在基表的实体类中。

识别并处理 T-table：
1. **识别**：扫描步骤1提取的所有表名，以 "T" 结尾即为 T-table（不要求以 T 开头）
2. **推导基表**：去掉末尾 "T" 得到基表名（T685T → T685）
3. **判断合并场景**：
   - **场景A：基表也在提取列表中**（T685 + T685T 同时出现）→ T-table 的字段合并到基表块，T-table 本身不再独立查询实体类
   - **场景B：仅 T-table 单独出现** → 额外查询基表的实体类信息，T-table 的字段使用基表的实体类
4. **记录合并关系**：`{T685T: {baseTable: "T685", mergeType: "A|B"}}`

详细的 T-table 模式和合并策略见 `reference.md`。

### 3. 调用 API 查询实体信息
对**合并后的表列表**（T-table 在场景A中替换为基表，场景B中追加基表）调用数据对象接口查询。详见 `reference.md`。

**T-table 字段映射查询**：T-table 本身仍需查询 API 获取字段级映射（如 VTEXT → name），但实体类名使用基表的。

### 4. 定位实体类文件路径
对每个实体类名，用 Glob 搜索 `{实体类名}.java`，优先选择路径含 `api`/`entity`/`model`/`domain` 的文件。

**T-table 路径**：直接使用基表的实体类路径，不单独搜索 T-table 的实体类。

### 5. 生成并追加对照表
按模板格式生成对照表，追加到原文档末尾。详细格式见 `templates/output-template.md`。

**关键**：
- `### 表名：XXX` 中的 XXX 必须是步骤1提取的 **S/4 原始表名**（如 `ACDOCA`、`BKPF`），严禁使用 API 返回的实体类名
- **T-table 合并输出**：T-table 的字段合并到基表块中，表格增加"来源表"列区分字段归属

## Rules

- 始终使用 `tempAdminToken` 作为 API Token
- S/4 字段名匹配时忽略大小写
- **对照表标题 `### 表名：XXX` 必须使用 S/4 原始表名**（如 `ACDOCA`、`BKPF`），不能用实体类名（如 `UniversalJournal`）
- **T-table 规则**：以 "T" 结尾的 SAP 表没有独立实体类，字段合并到基表（去 T）的实体类中；T-table 仍查询 API 获取字段映射，但实体类路径使用基表的
- **T-table 输出**：合并场景下基表块增加"来源表"列，标注每个字段来自 T685 还是 T685T
- API 调用失败或字段未匹配时标记为 "未找到"，继续处理下一项
- 网络超时重试 1 次（间隔 2 秒）
- 表按字母顺序排列，表内字段也按字母顺序排列
- 每完成一个步骤向用户报告进度

## Output Format

对照表追加到原文档末尾，详见 `templates/output-template.md`。

## Supporting Files

| 文件 | 何时读取 |
|------|---------|
| `reference.md` | 调用 API、错误处理、**T-table 模式与合并策略**时 |
| `examples.md` | 需要参考完整示例时 |
| `templates/output-template.md` | 生成对照表输出时 |