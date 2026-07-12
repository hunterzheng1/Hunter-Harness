// Harness 自有 canonical 内容的唯一来源：AGENTS.md / CLAUDE.md / CODEBUDDY.md 受管块正文，
// 以及生成的 rules 文件正文。initialize（首次安装）与 refresh（保守刷新）共享同一份字节。

export const AGENTS_CORE_BLOCK_ID = "hunter-harness-core";
export const CLAUDE_BLOCK_ID = "hunter-harness-claude-code";
export const CODEBUDDY_BLOCK_ID = "hunter-harness-codebuddy";

export const AGENTS_MANAGED_BLOCK_CONTENT = [
  "# Hunter Harness",
  "",
  "Use `.harness/context-index.json` to locate the instructions, skills, knowledge,",
  "and codebase map for the active agent.",
  "Treat installed `harness-*` skills as editable adapter working copies.",
  "Do not modify `.harness/state` or `.harness/cache` directly."
].join("\n");

export const CLAUDE_MANAGED_BLOCK_CONTENT = [
  "@AGENTS.md",
  "",
  "# Hunter Harness",
  "",
  "- Rules: .claude/rules/",
  "- Skills: .claude/skills/harness-*/",
  "- Knowledge: .harness/knowledge/",
  "- Codebase map: .harness/codebase/map/"
].join("\n");

export const CODEBUDDY_MANAGED_BLOCK_CONTENT = [
  "# Hunter Harness",
  "",
  "Use `.harness/context-index.json` to locate the instructions, skills, knowledge,",
  "and codebase map for the active agent.",
  "Treat installed `harness-*` skills as editable adapter working copies.",
  "Do not modify `.harness/state` or `.harness/cache` directly.",
  "",
  "- Skills: .codebuddy/skills/harness-*/",
  "- Agents: .codebuddy/agents/harness-*.md",
  "- Knowledge: .harness/knowledge/",
  "- Codebase map: .harness/codebase/map/"
].join("\n");

export const HARNESS_GENERAL_RULES_CONTENT =
  "# Hunter Harness Rules\n\n- Report evidence honestly.\n- Do not execute destructive actions without confirmation.\n";

export const HARNESS_JAVA_RULES_CONTENT =
  "# Java Profile\n\n- Verify builds and tests with the project build tool.\n";

export const CURSOR_GENERAL_RULES_CONTENT =
  "---\ndescription: Hunter Harness project-wide safety and evidence rules\nglobs:\nalwaysApply: true\n---\n\n" +
  "# Hunter Harness Rules\n\n- Report evidence honestly.\n- Do not execute destructive actions without confirmation.\n";

export const CURSOR_JAVA_RULES_CONTENT =
  "---\ndescription: Hunter Harness Java profile rules\nglobs:\nalwaysApply: true\n---\n\n" +
  "# Java Profile\n\n- Verify builds and tests with the project build tool.\n";
