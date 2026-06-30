import type { SkillIr } from "@hunter-harness/contracts";

/**
 * 渲染 mcp adapter 产出：.harness/generated/mcp/<name>.json
 * MCP server tool 契约 JSON（tool_name/description/input_schema 从 skill IR 派生）+ harness 元数据。
 * installable=false（contract-only 边界：产出契约 JSON，非可安装 skill）。
 */
export function renderMcpContract(
  skill: SkillIr,
  sourceIrHash: string,
  compilerVersion: string
): string {
  const properties: Record<string, { type: string }> = {};
  for (const input of skill.inputs) {
    properties[input] = { type: "string" };
  }
  const contract = {
    tool_name: skill.name,
    description: skill.description,
    input_schema: {
      type: "object",
      properties,
      required: [...skill.inputs]
    },
    source_ir_hash: sourceIrHash,
    compiler_version: compilerVersion,
    adapter: "mcp"
  };
  return JSON.stringify(contract, null, 2) + "\n";
}
