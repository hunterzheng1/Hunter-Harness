import type { ExternalSkillSnapshot, ExternalSkillSource } from "@hunter-harness/contracts";

export type FetchFn = typeof globalThis.fetch;

export interface ExternalFetcherDeps {
  fetch?: FetchFn;
  githubToken?: string | null;
  now?: () => string;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const GITHUB_API = "https://api.github.com";

export class ExternalFetchError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ExternalFetchError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 规范化 npm 包名（去空白；保留 scope）。 */
export function normalizeNpmRef(ref: string): string {
  const trimmed = ref.trim().replace(/^npm:/i, "");
  if (trimmed.length === 0) {
    throw new ExternalFetchError(422, "VALIDATION_FAILED", "npm package name is required");
  }
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(trimmed)) {
    throw new ExternalFetchError(422, "VALIDATION_FAILED", "invalid npm package name");
  }
  return trimmed;
}

/** 从 GitHub URL 或 `owner/repo` 解析为规范化 ref。 */
export function normalizeGithubRef(ref: string): { owner: string; repo: string; ref: string } {
  const trimmed = ref.trim().replace(/\.git$/i, "");
  let owner: string | undefined;
  let repo: string | undefined;

  const https = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (https !== null) {
    owner = https[1];
    repo = https[2];
  } else {
    const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+)/i);
    if (ssh !== null) {
      owner = ssh[1];
      repo = ssh[2];
    } else {
      const short = trimmed.match(/^([^/\s]+)\/([^/\s#?]+)$/);
      if (short !== null) {
        owner = short[1];
        repo = short[2];
      }
    }
  }

  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new ExternalFetchError(422, "VALIDATION_FAILED", "invalid GitHub repository reference");
  }
  return { owner, repo, ref: `${owner}/${repo}` };
}

export function normalizeExternalSource(source: ExternalSkillSource): ExternalSkillSource {
  if (source.type === "npm") {
    return { type: "npm", ref: normalizeNpmRef(source.ref) };
  }
  return { type: "github", ref: normalizeGithubRef(source.ref).ref };
}

function encodeNpmPath(packageName: string): string {
  // npm registry 要求 scope 包路径把 `/` 编码为 `%2F`（`@scope%2Fname`）
  return encodeURIComponent(packageName);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchNpmSnapshot(
  packageName: string,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSkillSnapshot> {
  const name = normalizeNpmRef(packageName);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const url = `${NPM_REGISTRY}/${encodeNpmPath(name)}`;
  const response = await fetchFn(url, {
    headers: { accept: "application/json" }
  });
  if (response.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm package not found: ${name}`);
  }
  if (!response.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm registry returned ${response.status}`);
  }
  const body = (await readJson(response)) as Record<string, unknown> | null;
  if (body === null || typeof body !== "object") {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "npm registry returned invalid JSON");
  }
  const distTags = (body["dist-tags"] ?? {}) as Record<string, unknown>;
  const version = typeof distTags.latest === "string" ? distTags.latest : null;
  const description = typeof body.description === "string" ? body.description : "";
  const license = typeof body.license === "string"
    ? body.license
    : (typeof (body.license as { type?: string } | undefined)?.type === "string"
      ? (body.license as { type: string }).type
      : null);
  const homepage = typeof body.homepage === "string" ? body.homepage : null;
  const readme = typeof body.readme === "string" ? body.readme : null;
  const displayName = typeof body.name === "string" ? body.name : name;

  return {
    name: displayName,
    description,
    version,
    readme,
    installCommand: `npm install ${name}`,
    license,
    homepage,
    releaseUrl: homepage ?? `https://www.npmjs.com/package/${name}`,
    fetchedAt: now()
  };
}

async function fetchGithubReadme(
  owner: string,
  repo: string,
  fetchFn: FetchFn,
  headers: Record<string, string>
): Promise<string | null> {
  const response = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}/readme`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = (await readJson(response)) as { content?: string; encoding?: string } | null;
  if (body === null || typeof body.content !== "string") return null;
  if (body.encoding === "base64") {
    try {
      return Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return body.content;
}

export async function fetchGithubSnapshot(
  owner: string,
  repo: string,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSkillSnapshot> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "hunter-harness-external-skill"
  };
  const token = deps.githubToken?.trim();
  if (token !== undefined && token !== "") {
    headers.authorization = `Bearer ${token}`;
  }

  const repoResponse = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}`, { headers });
  if (repoResponse.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `GitHub repository not found: ${owner}/${repo}`);
  }
  if (!repoResponse.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `GitHub API returned ${repoResponse.status}`);
  }
  const repoBody = (await readJson(repoResponse)) as Record<string, unknown> | null;
  if (repoBody === null) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "GitHub API returned invalid JSON");
  }

  let version: string | null = null;
  let releaseUrl: string | null = typeof repoBody.html_url === "string" ? repoBody.html_url : `https://github.com/${owner}/${repo}`;
  const releaseResponse = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}/releases/latest`, { headers });
  if (releaseResponse.ok) {
    const releaseBody = (await readJson(releaseResponse)) as Record<string, unknown> | null;
    if (releaseBody !== null) {
      if (typeof releaseBody.tag_name === "string") version = releaseBody.tag_name;
      if (typeof releaseBody.html_url === "string") releaseUrl = releaseBody.html_url;
    }
  } else if (typeof repoBody.default_branch === "string") {
    version = repoBody.default_branch;
  }

  const licenseObj = repoBody.license as { spdx_id?: string; name?: string } | null | undefined;
  const license = typeof licenseObj?.spdx_id === "string" && licenseObj.spdx_id !== "NOASSERTION"
    ? licenseObj.spdx_id
    : (typeof licenseObj?.name === "string" ? licenseObj.name : null);

  const readme = await fetchGithubReadme(owner, repo, fetchFn, headers);
  const name = typeof repoBody.full_name === "string" ? repoBody.full_name : `${owner}/${repo}`;
  const description = typeof repoBody.description === "string" ? repoBody.description : "";
  const homepage = typeof repoBody.homepage === "string" && repoBody.homepage.length > 0
    ? repoBody.homepage
    : (typeof repoBody.html_url === "string" ? repoBody.html_url : `https://github.com/${owner}/${repo}`);

  return {
    name,
    description,
    version,
    readme,
    installCommand: `https://github.com/${owner}/${repo}`,
    license,
    homepage,
    releaseUrl,
    fetchedAt: now()
  };
}

export async function fetchExternalSnapshot(
  source: ExternalSkillSource,
  deps: ExternalFetcherDeps = {}
): Promise<{ source: ExternalSkillSource; snapshot: ExternalSkillSnapshot }> {
  const normalized = normalizeExternalSource(source);
  if (normalized.type === "npm") {
    return { source: normalized, snapshot: await fetchNpmSnapshot(normalized.ref, deps) };
  }
  const { owner, repo } = normalizeGithubRef(normalized.ref);
  return { source: normalized, snapshot: await fetchGithubSnapshot(owner, repo, deps) };
}
