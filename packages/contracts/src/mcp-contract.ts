import { z } from "zod";

/**
 * MCP server tool 契约：tool_name / description / input_schema。
 * mcp adapter render 从 skill IR 派生此契约（installable=false，contract-only 边界）。
 */
export const mcpToolContractSchema = z.object({
  tool_name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown())
}).strict();

export type McpToolContract = z.infer<typeof mcpToolContractSchema>;
