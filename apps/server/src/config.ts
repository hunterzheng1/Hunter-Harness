import * as os from "node:os";
import * as path from "node:path";

export interface ServerConfig {
  maxFileBytes: number;
  maxUploadFiles: number;
  maxProposalBytes: number;
  maxChunkBytes: number;
  sessionTtlMs: number;
  aiSecretFile: string;
  /** External Skill 上游刷新间隔；0 表示禁用定时任务（测试默认禁用）。 */
  externalSkillRefreshIntervalMs: number;
  githubToken: string | null;
}

// AI provider secret file 默认路径：~/.hunter-harness/secrets/ai-providers.json
// 可用 env HUNTER_HARNESS_AI_SECRET_FILE 覆盖；key 只在此文件，不进项目/git/store
function defaultAiSecretFile(): string {
  const envFile = process.env.HUNTER_HARNESS_AI_SECRET_FILE;
  if (typeof envFile === "string" && envFile.length > 0) return envFile;
  return path.join(os.homedir(), ".hunter-harness", "secrets", "ai-providers.json");
}

function defaultGithubToken(): string | null {
  const value = process.env.HUNTER_HARNESS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function defaultExternalSkillRefreshIntervalMs(): number {
  const raw = process.env.HUNTER_HARNESS_EXTERNAL_SKILL_REFRESH_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 24 * 60 * 60 * 1000;
}

export const defaultServerConfig: ServerConfig = {
  maxFileBytes: 10 * 1024 * 1024,
  maxUploadFiles: 100,
  maxProposalBytes: 50 * 1024 * 1024,
  maxChunkBytes: 4 * 1024 * 1024,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  aiSecretFile: defaultAiSecretFile(),
  externalSkillRefreshIntervalMs: defaultExternalSkillRefreshIntervalMs(),
  githubToken: defaultGithubToken()
};
