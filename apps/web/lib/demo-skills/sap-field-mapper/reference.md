# SAP Field Mapper 参考手册

## API 接口详情

### 端点信息

| 属性 | 值 |
|------|-----|
| URL | `http://10.29.208.109/erpaimodelapi/entity/viewEntityByTableName` |
| 方法 | `POST` |
| 请求头 | `Content-Type: application/x-www-form-urlencoded` |
| Token | `tempAdminToken`（固定） |

### 请求参数

| 参数名 | 值 | 说明 |
|--------|-----|------|
| `projectInfo` | `{"tenantId":1,"projectId":1,"versionId":1}` | JSON 字符串 |
| `tableName` | 表名（如 BKPF） | SAP/S4 表名，大写 |

### curl 示例

```bash
curl -s -X POST "http://10.29.208.109/erpaimodelapi/entity/viewEntityByTableName" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Token: tempAdminToken" \
  -d 'projectInfo={"tenantId":1,"projectId":1,"versionId":1}&tableName=BKPF'
```

### 响应解析

| 路径 | 说明 |
|------|------|
| `kldModelDefEntity.code` | 实体类名 |
| `fieldList[].entityColumn.code` | 实体字段名 |
| `fieldList[].entityColumn.s4FieldName` | S/4 字段名（用于匹配） |

匹配逻辑：遍历 `fieldList`，当 `entityColumn.s4FieldName` 等于提取的 S/4 字段名时，取 `entityColumn.code` 作为实体字段名。

## 实体类文件搜索策略

1. 搜索模式：`**/{实体类名}.java`
2. 在项目根目录下递归搜索
3. 若多个匹配，优先级：`api` > `entity` > `model` > `domain` > 其他
4. 最终提取从项目根目录开始的相对路径

## 错误处理规则

| 错误类型 | 处理方式 |
|---------|---------|
| API 调用失败 / 返回空 | 实体类名标记为 "未找到"，跳过字段级匹配 |
| 字段未匹配 | 实体字段名标记为 "未找到" |
| 实体类文件未找到 | 路径标记为 "未找到" |
| 网络超时 | 重试 1 次（间隔 2 秒），仍失败则标记 "未找到" |

## T-table 文本表处理

### 什么是 T-table

SAP 中以 "T" 结尾的表（如 T685T、T001T）是**文本表（Text Table）**，用于存储语言相关的描述文本。例如：
- `T685`：条件类型主表，存储条件类型编码等核心数据
- `T685T`：条件类型文本表，存储条件类型的多语言描述文本

### 核心规则

**T-table 在项目中不存在独立的实体类文件**。API 虽然会为 T-table 返回一个实体类名（如 T685T → `ConditionTypeText`），但该类在项目代码库中实际不存在。T-table 的字段实际存储在**基表**的实体类中。

### 基表推导

| T-table | 基表（去末尾 T） | 基表实体类 | T-table 字段归属 |
|---------|-----------------|-----------|-----------------|
| T685T | T685 | ConditionType | T685T.VTEXT → ConditionType.name |
| T001T | T001 | CompanyCode | T001T.XXX → CompanyCode.xxx |

### 合并场景

#### 场景 A：基表同时出现（T685 + T685T）

文档中同时提及基表和 T-table，T-table 字段合并到基表块。

处理：
1. T685T 识别为 T-table，基表 T685 在提取列表中 → 场景A
2. T685 → API → 实体类 `ConditionType`，字段 `KSCHL → conditionType`
3. T685T → API → **仅获取字段映射** `VTEXT → name`，不使用其返回的实体类 `ConditionTypeText`
4. 输出时 T685T 字段并入 T685 块，实体类使用 `ConditionType`

#### 场景 B：T-table 单独出现

文档中仅提及 T685T，基表不在提取列表中。

处理：
1. T685T 识别为 T-table，基表 T685 不在提取列表中 → 场景B
2. 额外查询 T685 → API → 仅获取实体类 `ConditionType`
3. T685T → API → 获取字段映射 `VTEXT → name`
4. 输出时 T685T 独立为块，但实体类路径使用基表的 `ConditionType`

### API 查询策略总结

| 表类型 | 是否查询 API | 用途 | 使用的实体类 |
|--------|------------|------|------------|
| 普通表（BKPF、T001） | 是 | 获取实体类名 + 字段映射 | API 返回的实体类 |
| T-table（T685T）| 是 | **仅获取字段映射** | **基表的实体类** |
| 场景B追加的基表（T685）| 是 | 仅获取实体类名 | API 返回的实体类 |

### 文件搜索（T-table）

T-table **不单独搜索**实体类文件，直接复用基表的文件路径。

## 注意事项

- S/4 字段名通常为大写，匹配时忽略大小写差异
- API 同时匹配 `s4TableName` 和 `erpV2TableName`
- 建议每批处理 5-10 个表，避免 API 限流
- Token 固定使用 `tempAdminToken`，无需变更