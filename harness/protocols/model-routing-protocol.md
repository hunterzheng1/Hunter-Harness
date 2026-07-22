# model-routing-protocol — 能力级模型路由（Wave-2 H-16）

> 本协议定义 **economy / balanced / frontier** 三档能力级。通用 Harness 规则与 skill **禁止**硬编码供应商模型名（如 `claude-*`、`gpt-*`、`gemini-*`）。宿主把能力级映射到具体模型；映射表属于项目/宿主配置，不属于本协议正文。

## 能力级

| 级别 | 适用任务 | 示例 |
|------|----------|------|
| `economy` | 机械提取、日志压缩、等待监控、格式化摘要 | 解析测试输出行、压缩长日志、轮询服务就绪 |
| `balanced` | 常规实现、常规修复、常规文档修订 | 按 plan 实现 CRUD、修 YELLOW、补 checklist |
| `frontier` | 架构取舍、安全/并发/迁移、最终审查、高风险判断 | 设计审批、RED 安全项、schema 迁移方案、merge 前终审 |

## 路由规则

1. Skill/任务描述用能力级（`--capability economy|balanced|frontier` 或文案「本任务=frontier」），不写供应商模型 id。  
2. 宿主或 `HUNTER_HARNESS_MODEL` 仅作**遥测**（`executor_model`），不得反过来驱动通用规则分支。  
3. **降级**（frontier→balanced→economy）必须由确定性命令结果或更高能力审查验收；不得用更低能力级的模型输出替代测试/门禁证据。  
4. 无法映射某能力级时：fail closed，列出可用级别，禁止静默落到未知模型。

## 与验证的关系

能力级不改变 ledger / can-reuse / verification graph 合同。模型便宜不能成为跳过 `unitTestFull` 或忽略 `requiredOnMerge` 的理由。
