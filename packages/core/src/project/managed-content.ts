// Harness 自有 canonical 内容的唯一来源：缺失/空白项目指令的中文初始正文，
// 以及生成的 rules 文件正文。已有项目指令不会注入托管块；后续优化走远端提案。

export const AGENTS_CORE_BLOCK_ID = "hunter-harness-core";
export const CLAUDE_BLOCK_ID = "hunter-harness-claude-code";
export const CODEBUDDY_BLOCK_ID = "hunter-harness-codebuddy";

export const AGENTS_MANAGED_BLOCK_CONTENT = [
  "# 项目协作指南",
  "",
  "## 上下文入口",
  "",
  "- 使用 `.harness/context-index.json` 查找 Agent 入口、技能、远端知识和 codebase map。",
  "- 历史知识只通过 `npx hunter-harness knowledge query` 访问远端，不维护本地索引。",
  "- 不直接修改 `.harness/state` 或 `.harness/cache`。",
  "",
  "## 工作方式",
  "",
  "- 先理解现有模块边界，再做最小范围改动。",
  "- 修改后运行相关测试，并如实报告未执行或失败的验证。",
  "- 生命周期技能仅在用户明确要求时执行；一个阶段结束后将控制权交还用户。",
  "- 项目知识、规则、归档总结和 Agent 文档默认使用中文。"
].join("\n");

export const CLAUDE_MANAGED_BLOCK_CONTENT = [
  "@AGENTS.md",
  "@.harness/rules/project-guidance.md"
].join("\n");

export const CODEBUDDY_MANAGED_BLOCK_CONTENT = [
  "# 项目协作说明",
  "",
  "请遵循 `AGENTS.md` 与 `.harness/rules/project-guidance.md`。",
  "历史知识只从远端查询，不在本地生成知识索引。"
].join("\n");

const HARNESS_GENERAL_RULES_BODY =
  "# 项目规则\n\n" +
  "- 如实报告验证证据，不把未运行的检查描述为通过。\n" +
  "- 未经确认不执行破坏性或不可逆操作。\n" +
  "- 生命周期技能只在用户明确要求时运行；每个阶段完成后停止并交还控制权。\n" +
  "- 规则候选必须有归档证据并经过人工评审，不能自动追加到常驻规则。\n";

export const HARNESS_GENERAL_RULES_CONTENT = HARNESS_GENERAL_RULES_BODY;

export const HARNESS_JAVA_RULES_CONTENT =
  "# Java 项目规则\n\n- 使用项目实际采用的构建工具验证编译与测试。\n";

export const CURSOR_GENERAL_RULES_CONTENT =
  "---\ndescription: 项目级安全、证据与工作流规则\nglobs:\nalwaysApply: true\n---\n\n" +
  HARNESS_GENERAL_RULES_BODY;

export const CURSOR_JAVA_RULES_CONTENT =
  "---\ndescription: Java 项目构建与验证规则\nglobs:\nalwaysApply: true\n---\n\n" +
  "# Java 项目规则\n\n- 使用项目实际采用的构建工具验证编译与测试。\n";
