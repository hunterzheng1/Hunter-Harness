import { z } from "zod";

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]+$/);
const tokenEnvSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const SERVER_URL_PROTOCOL_MESSAGE =
  "server URL must use HTTPS unless it targets a loopback host";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet)) &&
    Number(octets[0]) === 127 && octets.every((octet) => Number(octet) <= 255);
}

export function isAllowedServerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname));
  } catch {
    return false;
  }
}

export const serverUrlSchema = z.url().refine(
  isAllowedServerUrl,
  SERVER_URL_PROTOCOL_MESSAGE
);

export const HARNESS_AGENT_ORDER = [
  "claude-code",
  "codex",
  "cursor",
  "codebuddy",
  "pi"
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
  "pi",
  "generic",
  "mcp"
]);

export const initConfigSchema = z.object({
  agents: z.array(harnessAgentSchema).min(1),
  profile: z.enum(["general", "java"]),
  codebuddy_surface: codebuddySurfaceSchema.default("both"),
  server_url: serverUrlSchema.nullable().optional(),
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
    url: serverUrlSchema.nullable(),
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
