import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CREDENTIALS_LOCAL_RELATIVE = ".harness/credentials.local.yaml";

export const CREDENTIALS_GITIGNORE_LINES = [
  ".harness/credentials.local.yaml",
  ".harness/credentials.local.*"
] as const;

export interface LocalCredentials {
  token?: string;
  server_url?: string;
}

export class InvalidCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCredentialsError";
  }
}

export function assertHttpsServerUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") {
      throw new InvalidCredentialsError("server_url must use HTTPS");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      throw error;
    }
    throw new InvalidCredentialsError("server_url is invalid");
  }
}

function validateLocalCredentials(credentials: LocalCredentials): LocalCredentials {
  const token = typeof credentials.token === "string" && credentials.token.trim().length > 0
    ? credentials.token.trim()
    : undefined;
  const serverUrl = typeof credentials.server_url === "string" &&
    credentials.server_url.trim().length > 0
    ? assertHttpsServerUrl(credentials.server_url)
    : undefined;
  if (token === undefined && serverUrl === undefined) {
    throw new InvalidCredentialsError("credentials.local must include token and/or server_url");
  }
  return {
    ...(token === undefined ? {} : { token }),
    ...(serverUrl === undefined ? {} : { server_url: serverUrl })
  };
}

function parseLocalCredentials(raw: unknown): LocalCredentials | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const token = typeof record.token === "string" && record.token.trim().length > 0
    ? record.token.trim()
    : undefined;
  const serverUrlRaw = typeof record.server_url === "string" &&
    record.server_url.trim().length > 0
    ? record.server_url.trim()
    : undefined;
  let serverUrl: string | undefined;
  if (serverUrlRaw !== undefined) {
    try {
      serverUrl = assertHttpsServerUrl(serverUrlRaw);
    } catch {
      return null;
    }
  }
  if (token === undefined && serverUrl === undefined) {
    return null;
  }
  return {
    ...(token === undefined ? {} : { token }),
    ...(serverUrl === undefined ? {} : { server_url: serverUrl })
  };
}

export function mergeLocalCredentials(
  existing: LocalCredentials | null,
  patch: LocalCredentials
): LocalCredentials {
  return validateLocalCredentials({
    ...(existing?.token === undefined ? {} : { token: existing.token }),
    ...(existing?.server_url === undefined ? {} : { server_url: existing.server_url }),
    ...patch
  });
}

export async function readLocalCredentials(
  projectRoot: string
): Promise<LocalCredentials | null> {
  try {
    const raw = await readFile(
      join(projectRoot, CREDENTIALS_LOCAL_RELATIVE),
      "utf8"
    );
    return parseLocalCredentials(parseYaml(raw));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeLocalCredentials(
  projectRoot: string,
  credentials: LocalCredentials
): Promise<void> {
  const normalized = validateLocalCredentials(credentials);
  await writeFile(
    join(projectRoot, CREDENTIALS_LOCAL_RELATIVE),
    stringifyYaml(normalized, { sortMapEntries: true }) + "\n",
    "utf8"
  );
}

export async function ensureCredentialsGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = join(projectRoot, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const existing = new Set(content.split("\n").map((line) => line.trim()));
  const harnessDirectoryIgnored = [
    ".harness",
    ".harness/",
    "/.harness",
    "/.harness/",
    ".harness/**",
    "/.harness/**"
  ].some((line) => existing.has(line));
  if (harnessDirectoryIgnored) {
    return;
  }
  const missing = CREDENTIALS_GITIGNORE_LINES.filter((line) => !existing.has(line));
  if (missing.length === 0) {
    return;
  }
  const suffix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, content + suffix + missing.join("\n") + "\n", "utf8");
}

export interface ResolvedPushAuth {
  serverUrl: string;
  token: string;
}

export interface MissingPushAuth {
  code: "SERVER_URL_REQUIRED" | "TOKEN_INVALID";
  missing: Array<"url" | "token">;
}

export function resolvePushAuth(input: {
  serverUrlFlag?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  local: LocalCredentials | null;
  projectUrl: string | null;
  projectTokenEnv: string;
}): ResolvedPushAuth | MissingPushAuth {
  const tokenEnv = input.tokenEnv ?? input.projectTokenEnv;
  const envToken = input.env[tokenEnv]?.trim();
  const localToken = input.local?.token?.trim();
  const token = envToken && envToken.length > 0
    ? envToken
    : localToken && localToken.length > 0
      ? localToken
      : undefined;

  const serverUrl = input.serverUrlFlag ??
    input.local?.server_url ??
    input.projectUrl ??
    undefined;

  const missing: Array<"url" | "token"> = [];
  if (serverUrl === undefined || serverUrl === null || serverUrl.trim() === "") {
    missing.push("url");
  }
  if (token === undefined) {
    missing.push("token");
  }
  if (missing.length > 0) {
    return {
      code: missing.includes("url") ? "SERVER_URL_REQUIRED" : "TOKEN_INVALID",
      missing
    };
  }
  if (serverUrl === undefined || token === undefined) {
    throw new Error("push auth resolution invariant failed");
  }
  return { serverUrl, token };
}
