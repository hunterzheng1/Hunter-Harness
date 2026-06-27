import * as os from "node:os";
import * as path from "node:path";

export interface ServerConfig {
  maxFileBytes: number;
  maxUploadFiles: number;
  maxProposalBytes: number;
  maxChunkBytes: number;
  sessionTtlMs: number;
  aiSecretFile: string;
}

// AI provider secret file 默认路径：~/.hunter-harness/secrets/ai-providers.json
// 可用 env HUNTER_HARNESS_AI_SECRET_FILE 覆盖；key 只在此文件，不进项目/git/store
function defaultAiSecretFile(): string {
  const envFile = process.env.HUNTER_HARNESS_AI_SECRET_FILE;
  if (typeof envFile === "string" && envFile.length > 0) return envFile;
  return path.join(os.homedir(), ".hunter-harness", "secrets", "ai-providers.json");
}

export const defaultServerConfig: ServerConfig = {
  maxFileBytes: 10 * 1024 * 1024,
  maxUploadFiles: 100,
  maxProposalBytes: 50 * 1024 * 1024,
  maxChunkBytes: 4 * 1024 * 1024,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  aiSecretFile: defaultAiSecretFile()
};
