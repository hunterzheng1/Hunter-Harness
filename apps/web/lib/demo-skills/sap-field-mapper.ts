import type { DemoAgent, DemoSourceSkill } from "./types";

const files = [
  {
    "path": "SKILL.md",
    "content": "---\r\nname: sap-field-mapper\r\ndescription: 从 Markdown 文档中自动提取 SAP/S4 表名和字段名，调用数据对象接口查询实体类映射，自动处理 T-table（文本表）的基表合并，生成 S/4 表字段与实体类对照表。当文档中出现 SAP 表名（BKPF/ACDOCA/T001/T685T 等）或 S/4 字段映射描述时自动触发。\r\nwhen_to_use: 文档中出现 SAP 标准表名（如 BKPF、ACDOCA、BSEG、T001、SKB1、T685T 等）、S/4 字段名、或\"字段映射\"\"实体类对照\"\"SAP表对应\"等描述时自动触发。\r\nallowed-tools: Read, Grep, Glob, Bash(curl *), Write, Edit\r\nmodel: inherit\r\npaths:\r\n  - \"**/*.md\"\r\n---\r\n\r\n# SAP/S4 字段映射工具\r\n\r\n## Purpose\r\n\r\n自动提取 Markdown 文档中的 SAP/S4 表名和字段名，通过 API 查询对应的实体类信息，在项目中定位实体类文件路径，生成完整的对照表追加到原文档末尾。\r\n\r\n## When to Use\r\n\r\n| 触发场景 | 操作 |\r\n|---------|------|\r\n| 文档出现 SAP 表名（BKPF、ACDOCA、BSEG、T001 等） | 自动提取并生成对照表 |\r\n| 文档出现 \"SAP表\" / \"S4表\" / \"标准表\" 标注 | 自动识别映射关系 |\r\n| 用户手动调用 `/sap-field-mapper` | 处理指定文档 |\r\n| 代码中出现 `bkpf.bldat` 等 SAP 字段引用 | 自动生成字段映射 |\r\n\r\n## Inputs\r\n\r\n- `$ARGUMENTS`：可选，指定的 Markdown 文档路径或文件名\r\n- 未指定时，从当前会话上下文中的文档自动提取\r\n\r\n## Workflow\r\n\r\n### 1. 提取 SAP/S4 表名和字段名\r\n仔细阅读目标文档，识别 SAP 标准表名和字段名：\r\n- 明确标注为 \"SAP表\"、\"S4表\"、\"标准表\" 的内容（优先）\r\n- 文本描述如 \"从 BKPF 表中读取 BLDAT 字段\"\r\n- 代码示例如 `bkpf.bldat`、`ACDOCA-WSL`\r\n- 注释说明如 \"对应 SAP 表 BKPF 的字段 BLDAT\"\r\n- **`表名-字段名` 格式**（如 `ACDOCA-VALUT`、`T001-BUKRS`）：以 `-` 连接的组合，`-` 左侧为 SAP 表名，右侧为字段名。例如 `ACDOCA-VALUT` → 表 `ACDOCA`、字段 `VALUT`；`AccountDocumentItem-valueDate` → 表 `AccountDocumentItem`、字段 `valueDate`。所有中间用 `-` 隔开的情况均按此逻辑拆分\r\n- 整理为 `{表名: [字段1, 字段2, ...]}` 结构，确保去重\r\n- 不确定的组合宁可遗漏也不要误提取\r\n\r\n### 2. T-table 检测与合并\r\n> T-table 是 SAP 中以 \"T\" 结尾的文本表（如 T685T），**项目中没有对应的实体类**，其字段实际存储在基表的实体类中。\r\n\r\n识别并处理 T-table：\r\n1. **识别**：扫描步骤1提取的所有表名，以 \"T\" 结尾即为 T-table（不要求以 T 开头）\r\n2. **推导基表**：去掉末尾 \"T\" 得到基表名（T685T → T685）\r\n3. **判断合并场景**：\r\n   - **场景A：基表也在提取列表中**（T685 + T685T 同时出现）→ T-table 的字段合并到基表块，T-table 本身不再独立查询实体类\r\n   - **场景B：仅 T-table 单独出现** → 额外查询基表的实体类信息，T-table 的字段使用基表的实体类\r\n4. **记录合并关系**：`{T685T: {baseTable: \"T685\", mergeType: \"A|B\"}}`\r\n\r\n详细的 T-table 模式和合并策略见 `reference.md`。\r\n\r\n### 3. 调用 API 查询实体信息\r\n对**合并后的表列表**（T-table 在场景A中替换为基表，场景B中追加基表）调用数据对象接口查询。详见 `reference.md`。\r\n\r\n**T-table 字段映射查询**：T-table 本身仍需查询 API 获取字段级映射（如 VTEXT → name），但实体类名使用基表的。\r\n\r\n### 4. 定位实体类文件路径\r\n对每个实体类名，用 Glob 搜索 `{实体类名}.java`，优先选择路径含 `api`/`entity`/`model`/`domain` 的文件。\r\n\r\n**T-table 路径**：直接使用基表的实体类路径，不单独搜索 T-table 的实体类。\r\n\r\n### 5. 生成并追加对照表\r\n按模板格式生成对照表，追加到原文档末尾。详细格式见 `templates/output-template.md`。\r\n\r\n**关键**：\r\n- `### 表名：XXX` 中的 XXX 必须是步骤1提取的 **S/4 原始表名**（如 `ACDOCA`、`BKPF`），严禁使用 API 返回的实体类名\r\n- **T-table 合并输出**：T-table 的字段合并到基表块中，表格增加\"来源表\"列区分字段归属\r\n\r\n## Rules\r\n\r\n- 始终使用 `tempAdminToken` 作为 API Token\r\n- S/4 字段名匹配时忽略大小写\r\n- **对照表标题 `### 表名：XXX` 必须使用 S/4 原始表名**（如 `ACDOCA`、`BKPF`），不能用实体类名（如 `UniversalJournal`）\r\n- **T-table 规则**：以 \"T\" 结尾的 SAP 表没有独立实体类，字段合并到基表（去 T）的实体类中；T-table 仍查询 API 获取字段映射，但实体类路径使用基表的\r\n- **T-table 输出**：合并场景下基表块增加\"来源表\"列，标注每个字段来自 T685 还是 T685T\r\n- API 调用失败或字段未匹配时标记为 \"未找到\"，继续处理下一项\r\n- 网络超时重试 1 次（间隔 2 秒）\r\n- 表按字母顺序排列，表内字段也按字母顺序排列\r\n- 每完成一个步骤向用户报告进度\r\n\r\n## Output Format\r\n\r\n对照表追加到原文档末尾，详见 `templates/output-template.md`。\r\n\r\n## Supporting Files\r\n\r\n| 文件 | 何时读取 |\r\n|------|---------|\r\n| `reference.md` | 调用 API、错误处理、**T-table 模式与合并策略**时 |\r\n| `examples.md` | 需要参考完整示例时 |\r\n| `templates/output-template.md` | 生成对照表输出时 |"
  },
  {
    "path": "examples.md",
    "content": "# SAP Field Mapper 完整示例\r\n\r\n> ⚠️ 对照表标题 `### 表名：XXX` 的 XXX 始终是 **S/4 原始表名**（如 ACDOCA、BKPF），不是实体类名。实体类名只出现在标题下方的 `- **实体类名**：` 行中。\r\n\r\n## 输入文档示例\r\n\r\n假设输入 Markdown 文档包含以下内容：\r\n\r\n```markdown\r\n## 技术实现方案\r\n\r\n凭证抬头涉及以下字段：\r\n\r\n| SAP表 | 字段 | 说明 |\r\n|-------|------|------|\r\n| BKPF | BLDAT | 凭证日期 |\r\n| BKPF | BUDAT | 过账日期 |\r\n| BKPF | BELNR | 凭证编号 |\r\n\r\n公司代码信息：\r\n- T001-BUKRS：公司代码\r\n- T001-WAERS：货币\r\n\r\n明细数据从 ACDOCA 表获取：\r\n- ACDOCA-WSL：金额\r\n- ACDOCA-VALUT：价值日期\r\n```\r\n\r\n## 处理过程\r\n\r\n### 步骤 1：提取结果\r\n\r\n```json\r\n{\r\n  \"BKPF\": [\"BLDAT\", \"BUDAT\", \"BELNR\"],\r\n  \"T001\": [\"BUKRS\", \"WAERS\"],\r\n  \"ACDOCA\": [\"WSL\", \"VALUT\"]\r\n}\r\n```\r\n\r\n### 步骤 2：API 查询结果\r\n\r\n| 表名 | 实体类名 | 查询状态 |\r\n|------|---------|---------|\r\n| BKPF | AccountingDocumentHeader | 成功 |\r\n| T001 | CompanyCode | 成功 |\r\n| ACDOCA | UniversalJournal | 成功 |\r\n\r\n### 步骤 3：文件路径定位\r\n\r\n| 实体类名 | 文件路径 |\r\n|---------|---------|\r\n| AccountingDocumentHeader | klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/AccountingDocumentHeader.java |\r\n| CompanyCode | klerp-org-all/klerp-org-api/src/main/java/com/cnpc/erp/org/entity/CompanyCode.java |\r\n| UniversalJournal | klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/UniversalJournal.java |\r\n\r\n### 步骤 4：对照表字段映射\r\n\r\n**BKPF → AccountingDocumentHeader：**\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| BELNR | documentNumber |\r\n| BLDAT | documentDate |\r\n| BUDAT | postingDate |\r\n\r\n**T001 → CompanyCode：**\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| BUKRS | companyCode |\r\n| WAERS | currency |\r\n\r\n**ACDOCA → UniversalJournal：**\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| VALUT | valueDate |\r\n| WSL | amount |\r\n\r\n## 最终输出\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：ACDOCA\r\n- **实体类名**：UniversalJournal\r\n- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/UniversalJournal.java\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| WSL | amount |\r\n\r\n---\r\n\r\n### 表名：BKPF\r\n- **实体类名**：AccountingDocumentHeader\r\n- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/AccountingDocumentHeader.java\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| BELNR | documentNumber |\r\n| BLDAT | documentDate |\r\n| BUDAT | postingDate |\r\n\r\n---\r\n\r\n### 表名：T001\r\n- **实体类名**：CompanyCode\r\n- **实体类路径**：klerp-org-all/klerp-org-api/src/main/java/com/cnpc/erp/org/entity/CompanyCode.java\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| BUKRS | companyCode |\r\n| WAERS | currency |\r\n```\r\n\r\n---\r\n\r\n## T-table 示例：场景 A（基表同时出现）\r\n\r\n### 输入文档\r\n\r\n```markdown\r\n## 定价条件配置\r\n\r\n条件类型使用 T685 和 T685T 两张表：\r\n\r\n| SAP表 | 字段 | 说明 |\r\n|-------|------|------|\r\n| T685 | KSCHL | 条件类型 |\r\n| T685 | KAPPL | 应用 |\r\n| T685T | VTEXT | 条件类型描述 |\r\n| T685T | SPRAS | 语言 |\r\n```\r\n\r\n### 步骤 1：提取结果\r\n\r\n```json\r\n{\r\n  \"T685\": [\"KSCHL\", \"KAPPL\"],\r\n  \"T685T\": [\"VTEXT\", \"SPRAS\"]\r\n}\r\n```\r\n\r\n### 步骤 2：T-table 检测\r\n\r\n- `T685T` 匹配 T-table 模式 → 基表 = `T685`\r\n- 基表 `T685` 已在提取列表中 → **场景 A**（合并）\r\n\r\n### 步骤 3：API 查询\r\n\r\n| 表名 | 查询用途 | 实体类名 | 字段映射 |\r\n|------|---------|---------|---------|\r\n| T685 | 实体类 + 字段 | **ConditionType** | KSCHL→conditionType, KAPPL→application |\r\n| T685T | 仅字段映射 | ~~ConditionTypeText~~（不使用） | VTEXT→name, SPRAS→language |\r\n\r\n### 步骤 4：合并输出\r\n\r\nT685T 的字段并入 T685 块，实体类使用 `ConditionType`：\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：T685\r\n- **实体类名**：ConditionType\r\n- **实体类路径**：klerp-base-all/klerp-base-api/src/main/java/com/cnpc/erp/base/entity/ConditionType.java\r\n\r\n| S/4 字段名 | 实体字段名 | 来源表 |\r\n|-----------|-----------|--------|\r\n| KAPPL | application | T685 |\r\n| KSCHL | conditionType | T685 |\r\n| SPRAS | language | T685T |\r\n| VTEXT | name | T685T |\r\n```\r\n\r\n---\r\n\r\n## T-table 示例：场景 B（T-table 单独出现）\r\n\r\n### 输入文档\r\n\r\n```markdown\r\n## 描述文本获取\r\n\r\n从 T685T 表读取 VTEXT 字段获取条件类型描述。\r\n```\r\n\r\n### 步骤 1：提取结果\r\n\r\n```json\r\n{\r\n  \"T685T\": [\"VTEXT\"]\r\n}\r\n```\r\n\r\n### 步骤 2：T-table 检测\r\n\r\n- `T685T` 匹配 T-table 模式 → 基表 = `T685`\r\n- 基表 `T685` **不在**提取列表中 → **场景 B**\r\n\r\n### 步骤 3：API 查询\r\n\r\n| 表名 | 查询用途 | 实体类名 | 字段映射 |\r\n|------|---------|---------|---------|\r\n| T685 | 仅实体类（追加查询） | **ConditionType** | — |\r\n| T685T | 仅字段映射 | ~~ConditionTypeText~~（不使用） | VTEXT→name |\r\n\r\n### 步骤 4：独立输出\r\n\r\nT685T 独立为块，但实体类路径使用基表 T685 的 `ConditionType`：\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：T685T\r\n- **实体类名**：ConditionType（来自基表 T685）\r\n- **实体类路径**：klerp-base-all/klerp-base-api/src/main/java/com/cnpc/erp/base/entity/ConditionType.java\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| VTEXT | name |\r\n```\r\n\r\n---\r\n\r\n## 表名-字段名 格式示例（`-` 分隔）\r\n\r\n### 输入文档\r\n\r\n需求文档中以 `表名-字段名` 格式出现，如 `ACDOCA-VALUT`、`BKPF-BLDAT`：\r\n\r\n```markdown\r\n## 数据提取规则\r\n\r\n- ACDOCA-VALUT：价值日期\r\n- ACDOCA-KSTAR：成本要素\r\n- BKPF-BLDAT：凭证日期\r\n- BKPF-BUDAT：过账日期\r\n```\r\n\r\n### 步骤 1：提取结果\r\n\r\n**关键**：将 `-` 左侧识别为表名，右侧识别为字段名。\r\n\r\n```json\r\n{\r\n  \"ACDOCA\": [\"VALUT\", \"KSTAR\"],\r\n  \"BKPF\": [\"BLDAT\", \"BUDAT\"]\r\n}\r\n```\r\n\r\n### 最终输出\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：ACDOCA\r\n- **实体类名**：UniversalJournal\r\n- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/UniversalJournal.java\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| KSTAR | costElement |\r\n| VALUT | valueDate |\r\n\r\n---\r\n\r\n### 表名：BKPF\r\n- **实体类名**：AccountingDocumentHeader\r\n- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/AccountingDocumentHeader.java\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| BLDAT | documentDate |\r\n| BUDAT | postingDate |\r\n```"
  },
  {
    "path": "reference.md",
    "content": "# SAP Field Mapper 参考手册\r\n\r\n## API 接口详情\r\n\r\n### 端点信息\r\n\r\n| 属性 | 值 |\r\n|------|-----|\r\n| URL | `http://10.29.208.109/erpaimodelapi/entity/viewEntityByTableName` |\r\n| 方法 | `POST` |\r\n| 请求头 | `Content-Type: application/x-www-form-urlencoded` |\r\n| Token | `tempAdminToken`（固定） |\r\n\r\n### 请求参数\r\n\r\n| 参数名 | 值 | 说明 |\r\n|--------|-----|------|\r\n| `projectInfo` | `{\"tenantId\":1,\"projectId\":1,\"versionId\":1}` | JSON 字符串 |\r\n| `tableName` | 表名（如 BKPF） | SAP/S4 表名，大写 |\r\n\r\n### curl 示例\r\n\r\n```bash\r\ncurl -s -X POST \"http://10.29.208.109/erpaimodelapi/entity/viewEntityByTableName\" \\\r\n  -H \"Content-Type: application/x-www-form-urlencoded\" \\\r\n  -H \"Token: tempAdminToken\" \\\r\n  -d 'projectInfo={\"tenantId\":1,\"projectId\":1,\"versionId\":1}&tableName=BKPF'\r\n```\r\n\r\n### 响应解析\r\n\r\n| 路径 | 说明 |\r\n|------|------|\r\n| `kldModelDefEntity.code` | 实体类名 |\r\n| `fieldList[].entityColumn.code` | 实体字段名 |\r\n| `fieldList[].entityColumn.s4FieldName` | S/4 字段名（用于匹配） |\r\n\r\n匹配逻辑：遍历 `fieldList`，当 `entityColumn.s4FieldName` 等于提取的 S/4 字段名时，取 `entityColumn.code` 作为实体字段名。\r\n\r\n## 实体类文件搜索策略\r\n\r\n1. 搜索模式：`**/{实体类名}.java`\r\n2. 在项目根目录下递归搜索\r\n3. 若多个匹配，优先级：`api` > `entity` > `model` > `domain` > 其他\r\n4. 最终提取从项目根目录开始的相对路径\r\n\r\n## 错误处理规则\r\n\r\n| 错误类型 | 处理方式 |\r\n|---------|---------|\r\n| API 调用失败 / 返回空 | 实体类名标记为 \"未找到\"，跳过字段级匹配 |\r\n| 字段未匹配 | 实体字段名标记为 \"未找到\" |\r\n| 实体类文件未找到 | 路径标记为 \"未找到\" |\r\n| 网络超时 | 重试 1 次（间隔 2 秒），仍失败则标记 \"未找到\" |\r\n\r\n## T-table 文本表处理\r\n\r\n### 什么是 T-table\r\n\r\nSAP 中以 \"T\" 结尾的表（如 T685T、T001T）是**文本表（Text Table）**，用于存储语言相关的描述文本。例如：\r\n- `T685`：条件类型主表，存储条件类型编码等核心数据\r\n- `T685T`：条件类型文本表，存储条件类型的多语言描述文本\r\n\r\n### 核心规则\r\n\r\n**T-table 在项目中不存在独立的实体类文件**。API 虽然会为 T-table 返回一个实体类名（如 T685T → `ConditionTypeText`），但该类在项目代码库中实际不存在。T-table 的字段实际存储在**基表**的实体类中。\r\n\r\n### 基表推导\r\n\r\n| T-table | 基表（去末尾 T） | 基表实体类 | T-table 字段归属 |\r\n|---------|-----------------|-----------|-----------------|\r\n| T685T | T685 | ConditionType | T685T.VTEXT → ConditionType.name |\r\n| T001T | T001 | CompanyCode | T001T.XXX → CompanyCode.xxx |\r\n\r\n### 合并场景\r\n\r\n#### 场景 A：基表同时出现（T685 + T685T）\r\n\r\n文档中同时提及基表和 T-table，T-table 字段合并到基表块。\r\n\r\n处理：\r\n1. T685T 识别为 T-table，基表 T685 在提取列表中 → 场景A\r\n2. T685 → API → 实体类 `ConditionType`，字段 `KSCHL → conditionType`\r\n3. T685T → API → **仅获取字段映射** `VTEXT → name`，不使用其返回的实体类 `ConditionTypeText`\r\n4. 输出时 T685T 字段并入 T685 块，实体类使用 `ConditionType`\r\n\r\n#### 场景 B：T-table 单独出现\r\n\r\n文档中仅提及 T685T，基表不在提取列表中。\r\n\r\n处理：\r\n1. T685T 识别为 T-table，基表 T685 不在提取列表中 → 场景B\r\n2. 额外查询 T685 → API → 仅获取实体类 `ConditionType`\r\n3. T685T → API → 获取字段映射 `VTEXT → name`\r\n4. 输出时 T685T 独立为块，但实体类路径使用基表的 `ConditionType`\r\n\r\n### API 查询策略总结\r\n\r\n| 表类型 | 是否查询 API | 用途 | 使用的实体类 |\r\n|--------|------------|------|------------|\r\n| 普通表（BKPF、T001） | 是 | 获取实体类名 + 字段映射 | API 返回的实体类 |\r\n| T-table（T685T）| 是 | **仅获取字段映射** | **基表的实体类** |\r\n| 场景B追加的基表（T685）| 是 | 仅获取实体类名 | API 返回的实体类 |\r\n\r\n### 文件搜索（T-table）\r\n\r\nT-table **不单独搜索**实体类文件，直接复用基表的文件路径。\r\n\r\n## 注意事项\r\n\r\n- S/4 字段名通常为大写，匹配时忽略大小写差异\r\n- API 同时匹配 `s4TableName` 和 `erpV2TableName`\r\n- 建议每批处理 5-10 个表，避免 API 限流\r\n- Token 固定使用 `tempAdminToken`，无需变更"
  },
  {
    "path": "templates/output-template.md",
    "content": "# 对照表输出模板\r\n\r\n## 追加位置\r\n\r\n在原文档末尾追加，以 `---` 分隔线与原文内容分开。\r\n\r\n## 整体结构\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：{S/4表名}\r\n- **实体类名**：{实体类名}\r\n- **实体类路径**：{相对路径}\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| {S4字段1} | {实体字段1} |\r\n| {S4字段2} | {实体字段2} |\r\n\r\n---\r\n\r\n### 表名：{S/4表名}\r\n- **实体类名**：{实体类名}\r\n- **实体类路径**：{相对路径}\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| {S4字段1} | {实体字段1} |\r\n```\r\n\r\n> ⚠️ `{S/4表名}` 是步骤1提取的原始 SAP 表名（如 ACDOCA、BKPF），不是 API 返回的实体类名（如 UniversalJournal）。\r\n\r\n## 格式规则\r\n\r\n| 规则 | 说明 |\r\n|------|------|\r\n| 标题 | 使用 `##` 二级标题 \"S/4 表字段与实体类对照表\" |\r\n| 表块标题 | `### 表名：{S/4表名}`，**必须是 S/4 原始表名（如 ACDOCA），严禁用实体类名（如 UniversalJournal）** |\r\n| 实体信息 | 用无序列表展示实体类名和实体类路径 |\r\n| 字段表格 | 两列表格：S/4 字段名 \\| 实体字段名 |\r\n| 表块分隔 | 不同表块之间用 `---` 分隔 |\r\n| 排序规则 | 表按字母顺序排列，表内字段也按字母顺序排列 |\r\n| 未找到标记 | 实体类名、路径、字段名未找到时统一标记为 \"未找到\" |\r\n| T-table 合并 | 场景A：字段合并到基表块，表格增加\"来源表\"列；场景B：独立为块，标注基表实体类 |\r\n\r\n## T-table 合并输出模板\r\n\r\n### 场景 A：基表同时出现（字段合并）\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：{基表S/4表名}\r\n- **实体类名**：{基表实体类名}\r\n- **实体类路径**：{基表实体类路径}\r\n\r\n| S/4 字段名 | 实体字段名 | 来源表 |\r\n|-----------|-----------|--------|\r\n| {S4字段1} | {实体字段1} | {基表名} |\r\n| {S4字段2} | {实体字段2} | {基表名} |\r\n| {S4字段3} | {实体字段3} | {T-table名} |\r\n```\r\n\r\n> 合并场景下表格增加\"来源表\"列，明确标注每个字段来自基表还是 T-table。\r\n\r\n### 场景 B：T-table 单独出现\r\n\r\n```markdown\r\n---\r\n\r\n## S/4 表字段与实体类对照表\r\n\r\n### 表名：{T-table名}\r\n- **实体类名**：{基表实体类名}（来自基表 {基表名}）\r\n- **实体类路径**：{基表实体类路径}\r\n\r\n| S/4 字段名 | 实体字段名 |\r\n|-----------|-----------|\r\n| {S4字段1} | {实体字段1} |\r\n```\r\n\r\n> 场景B中实体类名后标注\"（来自基表 XXX）\"，路径使用基表的实体类文件路径。\r\n\r\n## 生成时间戳\r\n\r\n在对照表标题下方添加生成时间：\r\n\r\n```markdown\r\n> 生成时间：YYYY-MM-DD HH:mm\r\n```"
  }
] as const;

const entrypoint = files.find((file) => file.path === "SKILL.md");

if (entrypoint === undefined) throw new Error("sap-field-mapper entrypoint is missing");

const codexPatch = {
  "patchSummary": "Codex adaptation: replace hook-driven checks with explicit verification steps; perform delegated work in the current session when subagents are unavailable.",
  "appendedContent": "\n\n---\n\n## Codex adaptation\n\n- Replace hook-driven checks with explicit verification steps in the current task.\n- When subagents are unavailable, perform the delegated investigation in the current session and report its evidence.\n- Preserve the SAP table extraction, T-table merge, API query, and output-template workflow above.\n"
} as const;

const cursorPatch = {
  "patchSummary": "Cursor fallback preview: use the Claude Code source package but publish to Cursor rules path until a Cursor-specific package is uploaded.",
  "appendedContent": "\n\n---\n\n## Cursor fallback notes\n\nThis preview is resolved from the default Claude Code package. Downloading with `--agent cursor` installs the generated artifact under `.cursor/rules/sap-field-mapper.md` until a Cursor-specific version is uploaded and published.\n"
} as const;

const codexPreviewPatch = {
  "patchSummary": "Codex draft preview: remove Claude-only frontmatter and keep explicit execution instructions for Codex.",
  "appendedContent": "\n\n---\n\n## Codex draft notes\n\n- Treat this as a project-local instruction file.\n- Do not rely on Claude Code `allowed-tools` frontmatter.\n- Ask before writing generated mapping tables when the target document is ambiguous.\n"
} as const;

const claudeSkillPublished = [
  "---",
  "name: sap-field-mapper",
  "allowed-tools: Read, Grep, Glob, Bash(curl *), Write, Edit",
  "---",
  "",
  "## Rules",
  "- Always use tempAdminToken as the API token.",
  "- Append the generated mapping table to the requested Markdown document.",
  "- Report progress after each workflow step."
].join("\n");

const claudeSkillDraft = [
  "---",
  "name: sap-field-mapper",
  "allowed-tools: Read, Grep, Glob, Bash(curl *), Write, Edit",
  "---",
  "",
  "## Rules",
  "- Always use tempAdminToken as the API token; confirm it is a test token before publishing.",
  "- Ask before appending the generated mapping table to a user document.",
  "- Report progress after each workflow step with the target file path."
].join("\n");

const codexSkillPublished = [
  "# sap-field-mapper",
  "",
  "Use the SAP/S4 extraction workflow from the source package.",
  "Generated mapping tables may be appended when the target document is clear.",
  "No hard dependency on subagents is required."
].join("\n");

const codexSkillDraft = [
  "# sap-field-mapper",
  "",
  "Use the SAP/S4 extraction workflow from the source package.",
  "Ask before appending generated mapping tables to user documents.",
  "Run verification steps in the current Codex session when subagents are unavailable."
].join("\n");

export const sapFieldMapper: DemoSourceSkill = {
  slug: "sap-field-mapper",
  defaultAgent: "claude-code",
  source: { entrypoint, files },
  examples: [
    {
      title: "自动识别 Markdown 中的 SAP 字段",
      description: "当需求文档中出现 BKPF、ACDOCA、T001 等 SAP/S4 表字段时，直接生成实体类映射表。",
      request: "请检查 docs/payment-posting.md 里的 SAP 表字段，并补充实体类对照表。",
      result: "在目标 Markdown 末尾追加按表分组的 S/4 字段与实体字段映射。",
      files: ["docs/payment-posting.md"]
    },
    {
      title: "手动指定输入文件",
      description: "用户明确给出一个 Markdown 文件路径时，只处理该文件并保留原文内容。",
      request: "/sap-field-mapper requirements/fi-clearing.md",
      result: "读取指定文件、提取字段、查询实体信息，并把结果追加到同一文件。",
      files: ["requirements/fi-clearing.md", "templates/output-template.md"]
    },
    {
      title: "从字段引用片段生成映射",
      description: "当对话或代码片段中出现 bkpf.bldat、ACDOCA-WSL 这类引用时，按字段引用生成映射。",
      request: "这些字段需要实体映射：bkpf.bldat、BKPF-BUDAT、ACDOCA-WSL、T001-BUKRS。",
      result: "输出 BKPF、ACDOCA、T001 三组字段的实体类名称、文件路径和字段映射。",
      files: ["reference.md"]
    }
  ],
  agents: [
    {
      agent: "claude-code",
      label: "Claude Code",
      configured: true,
      default: true,
      targetPath: ".claude/skills/sap-field-mapper/SKILL.md",
      latestVersion: {
        version: "1.2.0",
        sourceLabel: "Published Claude Code source package",
        releasedAt: "2026-06-25T09:30:00Z",
        sourceHash: "sha256:22f5c9c3d8f4c7a1",
        artifactHash: "sha256:7cc2f0f6a7e89144",
        targetPath: ".claude/skills/sap-field-mapper/SKILL.md",
        fileCount: files.length,
        status: "published"
      },
      draftVersion: {
        version: "1.3.0-draft",
        sourceLabel: "Uploaded folder draft",
        releasedAt: "2026-06-25T15:20:00Z",
        sourceHash: "sha256:draftb8d5c3f1a992",
        artifactHash: "sha256:draft9e12087f44",
        targetPath: ".claude/skills/sap-field-mapper/SKILL.md",
        fileCount: files.length + 1,
        status: "draft"
      },
      checks: [
        { id: "entrypoint", label: "SKILL.md entrypoint", status: "green", message: "Found root SKILL.md and supporting files.", filePath: null, fixable: false },
        { id: "path-safe", label: "Path safety", status: "green", message: "No absolute paths, parent traversal, or unsafe names detected.", filePath: null, fixable: false },
        { id: "secret-scan", label: "Sensitive content", status: "yellow", message: "Token-like value `tempAdminToken` appears in reference instructions; confirm it is a test token.", filePath: "reference.md", fixable: true },
        { id: "publish", label: "Publish readiness", status: "green", message: "Claude Code artifact can be generated for the draft.", filePath: null, fixable: false }
      ],
      diffFiles: [
        {
          path: ".claude/skills/sap-field-mapper/SKILL.md",
          status: "modified",
          publishedContent: claudeSkillPublished,
          draftContent: claudeSkillDraft
        },
        {
          path: ".claude/skills/sap-field-mapper/templates/checklist.md",
          status: "added",
          publishedContent: "",
          draftContent: "# Publish checklist\n\n- Confirm tempAdminToken is safe for demo use.\n- Confirm document write permission before appending output.\n- Run adapter generation for Claude Code."
        }
      ],
      metrics: { files: files.length + 1, green: 3, yellow: 1, red: 0, suggestions: 2 },
      uploadHint: "Upload a Claude Code Skill folder or zip containing SKILL.md."
    },
    {
      agent: "cursor",
      label: "Cursor",
      configured: false,
      default: false,
      fallbackFrom: "claude-code",
      targetPath: ".cursor/rules/sap-field-mapper.md",
      checks: [
        { id: "fallback", label: "Fallback source", status: "yellow", message: "Cursor has no dedicated package; preview resolves from Claude Code default.", filePath: null, fixable: false },
        { id: "target-path", label: "Install target", status: "green", message: "Download would install to .cursor/rules/sap-field-mapper.md.", filePath: null, fixable: false },
        { id: "cursor-native", label: "Cursor native rules", status: "yellow", message: "No Cursor-specific rule formatting has been uploaded yet.", filePath: null, fixable: true }
      ],
      metrics: { files: files.length, green: 1, yellow: 2, red: 0, suggestions: 3 },
      uploadHint: "Upload a Cursor rules folder or zip to create a dedicated Cursor version."
    },
    {
      agent: "codex",
      label: "Codex",
      configured: true,
      default: false,
      targetPath: ".codex/skills/sap-field-mapper/SKILL.md",
      latestVersion: {
        version: "0.8.0",
        sourceLabel: "Codex adaptation package",
        releasedAt: "2026-06-24T18:00:00Z",
        sourceHash: "sha256:4df0d7cfa190ab22",
        artifactHash: "sha256:b18c669830ba11d0",
        targetPath: ".codex/skills/sap-field-mapper/SKILL.md",
        fileCount: files.length,
        status: "published"
      },
      checks: [
        { id: "claude-frontmatter", label: "Claude-only metadata", status: "yellow", message: "`allowed-tools` frontmatter should be rewritten for Codex guidance.", filePath: "SKILL.md", fixable: true },
        { id: "subagent", label: "Unsupported automation", status: "green", message: "No hard dependency on subagents detected.", filePath: null, fixable: false },
        { id: "write-boundary", label: "Write boundary", status: "red", message: "Generated table append behavior should explicitly ask before modifying user documents.", filePath: "SKILL.md", fixable: true }
      ],
      diffFiles: [
        {
          path: ".codex/skills/sap-field-mapper/SKILL.md",
          status: "modified",
          publishedContent: codexSkillPublished,
          draftContent: codexSkillDraft
        }
      ],
      metrics: { files: files.length, green: 1, yellow: 1, red: 1, suggestions: 4 },
      uploadHint: "Upload a Codex-specific skill package or apply AI fixes to the current draft."
    },
    {
      agent: "generic",
      label: "Generic Markdown",
      configured: false,
      default: false,
      fallbackFrom: "claude-code",
      targetPath: ".harness/generated/generic/sap-field-mapper.md",
      checks: [
        { id: "fallback", label: "Fallback source", status: "yellow", message: "Generic output currently falls back to the Claude Code source package.", filePath: null, fixable: false },
        { id: "portable", label: "Portable instructions", status: "red", message: "The source references tool-specific frontmatter and Bash permissions.", filePath: "SKILL.md", fixable: true }
      ],
      diffFiles: [
        {
          path: ".harness/generated/generic/sap-field-mapper.md",
          status: "modified",
          publishedContent: "This generic preview is derived from the Claude Code package.",
          draftContent: "This generic preview removes tool-specific frontmatter and keeps portable instructions only."
        }
      ],
      metrics: { files: files.length, green: 0, yellow: 1, red: 1, suggestions: 2 },
      uploadHint: "Upload a portable Markdown package to create a generic version."
    }
  ],
  adapters: { codex: codexPatch, cursor: cursorPatch },
  preview(agent: DemoAgent): string | null {
    if (agent === "claude-code") return entrypoint.content;
    if (agent === "codex") return entrypoint.content + codexPreviewPatch.appendedContent;
    if (agent === "cursor") return entrypoint.content + cursorPatch.appendedContent;
    if (agent === "generic") return entrypoint.content + "\n\n---\n\n## Generic fallback\n\nThis generic preview is derived from the default Claude Code package and should be simplified before publishing as a portable instruction file.\n";
    return null;
  }
};

export function findDemoSourceSkill(slug: string): DemoSourceSkill | undefined {
  return slug === sapFieldMapper.slug ? sapFieldMapper : undefined;
}
