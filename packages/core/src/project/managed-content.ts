// Harness 自有 canonical 内容的唯一来源：AGENTS.md / CLAUDE.md 受管块正文，以及生成的
// rules 文件正文。initialize（首次安装）与 refresh（保守刷新）共享同一份字节，避免双源漂移。
// 改动这里等于改动 canonical Harness 内容——需同步 design §4.1 与 Bundle Fidelity 约束。

export const AGENTS_MANAGED_BLOCK_CONTENT = [
  "# Hunter Harness",
  "",
  "Use .harness/context-index.json to route rules, Knowledge, and codebase maps.",
  "Treat .claude/skills/harness-* as editable adapter working copies.",
  "Do not modify .harness/state or .harness/cache directly."
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

export const HARNESS_GENERAL_RULES_CONTENT =
  "# Hunter Harness Rules\n\n- Report evidence honestly.\n- Do not execute destructive actions without confirmation.\n";

export const HARNESS_JAVA_RULES_CONTENT =
  "# Java Profile\n\n- Verify builds and tests with the project build tool.\n";
