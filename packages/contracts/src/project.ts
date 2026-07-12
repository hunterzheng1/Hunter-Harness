import { z } from "zod";

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]+$/);
const tokenEnvSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const httpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === "https:",
  "server URL must use HTTPS"
);

export const HARNESS_AGENT_ORDER = [
  "claude-code",
  "codex",
  "cursor",
  "codebuddy"
] as const;

export const harnessAgentSchema = z.enum(HARNESS_AGENT_ORDER);
export type HarnessAgent = z.infer<typeof harnessAgentSchema>;

export const codebuddySurfaceSchema = z.enum(["both", "ide", "cli"]);
export type CodeBuddySurface = z.infer<typeof codebuddySurfaceSchema>;

export function sortHarnessAgents(agents: readonly HarnessAgent[]): HarnessAgent[] {
  return HARNESS_AGENT_ORDER.filter((agent) => agents.includes(agent));
}

export const adapterNameSchema = z.enum([
  "claude-code",
  "codex",
  "cursor",
  "codebuddy",
  "generic",
  "mcp"
]);

export const initConfigSchema = z.object({
  agents: z.array(harnessAgentSchema).min(1),
  profile: z.enum(["general", "java"]),
  codebuddy_surface: codebuddySurfaceSchema.default("both"),
  server_url: httpsUrlSchema.nullable().optional(),
  token_env: tokenEnvSchema.nullable().optional(),
  project_id: projectIdSchema.nullable().optional(),
  features: z.object({
    codegraph_check: z.boolean().default(true),
    superpowers_check: z.boolean().default(true)
  }).strict().optional()
}).strict();

export const projectConfigSchema = z.object({
  harness: z.object({
    name: z.literal("hunter-harness"),
    schema_version: z.literal(1)
  }).strict(),
  project: z.object({
    name: z.string().min(1),
    root: z.literal("."),
    local_project_key: z.uuid(),
    project_id: projectIdSchema.nullable(),
    profiles: z.array(z.string().min(1)).min(1)
  }).strict(),
  server: z.object({
    url: httpsUrlSchema.nullable(),
    token_env: tokenEnvSchema
  }).strict(),
  adapters: z.object({
    enabled: z.array(adapterNameSchema).min(1)
  }).strict(),
  adapter_options: z.object({
    codebuddy: z.object({
      surface: codebuddySurfaceSchema
    }).strict()
  }).strict().optional()
}).strict();

export type InitConfig = z.infer<typeof initConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
