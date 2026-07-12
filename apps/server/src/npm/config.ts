import { readFileSync } from "node:fs";

export interface NpmPublishConfig {
  scope: string | null;
  token: string | null;
}

export function loadNpmPublishConfig(env: NodeJS.ProcessEnv = process.env): NpmPublishConfig {
  const scope = env.HUNTER_HARNESS_NPM_SCOPE?.trim() ?? null;
  let token = env.HUNTER_HARNESS_NPM_TOKEN?.trim() ?? null;
  if (token === null || token === "") {
    const tokenFile = env.HUNTER_HARNESS_NPM_TOKEN_FILE?.trim();
    if (tokenFile !== undefined && tokenFile.length > 0) {
      try {
        token = readFileSync(tokenFile, "utf8").trim();
      } catch {
        token = null;
      }
    }
  }
  if (token === "") token = null;
  return { scope, token };
}

export function isNpmPublishConfigured(config: NpmPublishConfig): boolean {
  return config.scope !== null && config.scope.length > 0
    && config.token !== null && config.token.length > 0;
}

export function packageNameForSkill(config: NpmPublishConfig, slug: string): string {
  const scope = config.scope;
  if (scope === null || scope === "") {
    throw new Error("npm scope is required to build a package name");
  }
  return `${scope.replace(/\/$/, "")}/${slug}`;
}

export function packageNameForWorkflowFamily(config: NpmPublishConfig, familySlug: string): string {
  const scope = config.scope;
  if (scope === null || scope === "") {
    throw new Error("npm scope is required to build a package name");
  }
  const normalized = scope.replace(/\/$/, "");
  if (familySlug === "harness") return `${normalized}/workflow-harness`;
  return `${normalized}/workflow-${familySlug}`;
}
