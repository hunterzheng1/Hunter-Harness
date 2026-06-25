# SAP Field Mapper 完整示例

> ⚠️ 对照表标题 `### 表名：XXX` 的 XXX 始终是 **S/4 原始表名**（如 ACDOCA、BKPF），不是实体类名。实体类名只出现在标题下方的 `- **实体类名**：` 行中。

## 输入文档示例

假设输入 Markdown 文档包含以下内容：

```markdown
## 技术实现方案

凭证抬头涉及以下字段：

| SAP表 | 字段 | 说明 |
|-------|------|------|
| BKPF | BLDAT | 凭证日期 |
| BKPF | BUDAT | 过账日期 |
| BKPF | BELNR | 凭证编号 |

公司代码信息：
- T001-BUKRS：公司代码
- T001-WAERS：货币

明细数据从 ACDOCA 表获取：
- ACDOCA-WSL：金额
- ACDOCA-VALUT：价值日期
```

## 处理过程

### 步骤 1：提取结果

```json
{
  "BKPF": ["BLDAT", "BUDAT", "BELNR"],
  "T001": ["BUKRS", "WAERS"],
  "ACDOCA": ["WSL", "VALUT"]
}
```

### 步骤 2：API 查询结果

| 表名 | 实体类名 | 查询状态 |
|------|---------|---------|
| BKPF | AccountingDocumentHeader | 成功 |
| T001 | CompanyCode | 成功 |
| ACDOCA | UniversalJournal | 成功 |

### 步骤 3：文件路径定位

| 实体类名 | 文件路径 |
|---------|---------|
| AccountingDocumentHeader | klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/AccountingDocumentHeader.java |
| CompanyCode | klerp-org-all/klerp-org-api/src/main/java/com/cnpc/erp/org/entity/CompanyCode.java |
| UniversalJournal | klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/UniversalJournal.java |

### 步骤 4：对照表字段映射

**BKPF → AccountingDocumentHeader：**

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| BELNR | documentNumber |
| BLDAT | documentDate |
| BUDAT | postingDate |

**T001 → CompanyCode：**

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| BUKRS | companyCode |
| WAERS | currency |

**ACDOCA → UniversalJournal：**

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| VALUT | valueDate |
| WSL | amount |

## 最终输出

```markdown
---

## S/4 表字段与实体类对照表

### 表名：ACDOCA
- **实体类名**：UniversalJournal
- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/UniversalJournal.java

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| WSL | amount |

---

### 表名：BKPF
- **实体类名**：AccountingDocumentHeader
- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/AccountingDocumentHeader.java

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| BELNR | documentNumber |
| BLDAT | documentDate |
| BUDAT | postingDate |

---

### 表名：T001
- **实体类名**：CompanyCode
- **实体类路径**：klerp-org-all/klerp-org-api/src/main/java/com/cnpc/erp/org/entity/CompanyCode.java

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| BUKRS | companyCode |
| WAERS | currency |
```

---

## T-table 示例：场景 A（基表同时出现）

### 输入文档

```markdown
## 定价条件配置

条件类型使用 T685 和 T685T 两张表：

| SAP表 | 字段 | 说明 |
|-------|------|------|
| T685 | KSCHL | 条件类型 |
| T685 | KAPPL | 应用 |
| T685T | VTEXT | 条件类型描述 |
| T685T | SPRAS | 语言 |
```

### 步骤 1：提取结果

```json
{
  "T685": ["KSCHL", "KAPPL"],
  "T685T": ["VTEXT", "SPRAS"]
}
```

### 步骤 2：T-table 检测

- `T685T` 匹配 T-table 模式 → 基表 = `T685`
- 基表 `T685` 已在提取列表中 → **场景 A**（合并）

### 步骤 3：API 查询

| 表名 | 查询用途 | 实体类名 | 字段映射 |
|------|---------|---------|---------|
| T685 | 实体类 + 字段 | **ConditionType** | KSCHL→conditionType, KAPPL→application |
| T685T | 仅字段映射 | ~~ConditionTypeText~~（不使用） | VTEXT→name, SPRAS→language |

### 步骤 4：合并输出

T685T 的字段并入 T685 块，实体类使用 `ConditionType`：

```markdown
---

## S/4 表字段与实体类对照表

### 表名：T685
- **实体类名**：ConditionType
- **实体类路径**：klerp-base-all/klerp-base-api/src/main/java/com/cnpc/erp/base/entity/ConditionType.java

| S/4 字段名 | 实体字段名 | 来源表 |
|-----------|-----------|--------|
| KAPPL | application | T685 |
| KSCHL | conditionType | T685 |
| SPRAS | language | T685T |
| VTEXT | name | T685T |
```

---

## T-table 示例：场景 B（T-table 单独出现）

### 输入文档

```markdown
## 描述文本获取

从 T685T 表读取 VTEXT 字段获取条件类型描述。
```

### 步骤 1：提取结果

```json
{
  "T685T": ["VTEXT"]
}
```

### 步骤 2：T-table 检测

- `T685T` 匹配 T-table 模式 → 基表 = `T685`
- 基表 `T685` **不在**提取列表中 → **场景 B**

### 步骤 3：API 查询

| 表名 | 查询用途 | 实体类名 | 字段映射 |
|------|---------|---------|---------|
| T685 | 仅实体类（追加查询） | **ConditionType** | — |
| T685T | 仅字段映射 | ~~ConditionTypeText~~（不使用） | VTEXT→name |

### 步骤 4：独立输出

T685T 独立为块，但实体类路径使用基表 T685 的 `ConditionType`：

```markdown
---

## S/4 表字段与实体类对照表

### 表名：T685T
- **实体类名**：ConditionType（来自基表 T685）
- **实体类路径**：klerp-base-all/klerp-base-api/src/main/java/com/cnpc/erp/base/entity/ConditionType.java

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| VTEXT | name |
```

---

## 表名-字段名 格式示例（`-` 分隔）

### 输入文档

需求文档中以 `表名-字段名` 格式出现，如 `ACDOCA-VALUT`、`BKPF-BLDAT`：

```markdown
## 数据提取规则

- ACDOCA-VALUT：价值日期
- ACDOCA-KSTAR：成本要素
- BKPF-BLDAT：凭证日期
- BKPF-BUDAT：过账日期
```

### 步骤 1：提取结果

**关键**：将 `-` 左侧识别为表名，右侧识别为字段名。

```json
{
  "ACDOCA": ["VALUT", "KSTAR"],
  "BKPF": ["BLDAT", "BUDAT"]
}
```

### 最终输出

```markdown
---

## S/4 表字段与实体类对照表

### 表名：ACDOCA
- **实体类名**：UniversalJournal
- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/UniversalJournal.java

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| KSTAR | costElement |
| VALUT | valueDate |

---

### 表名：BKPF
- **实体类名**：AccountingDocumentHeader
- **实体类路径**：klerp-finance-all/klerp-finance-api/src/main/java/com/cnpc/erp/finance/entity/AccountingDocumentHeader.java

| S/4 字段名 | 实体字段名 |
|-----------|-----------|
| BLDAT | documentDate |
| BUDAT | postingDate |
```