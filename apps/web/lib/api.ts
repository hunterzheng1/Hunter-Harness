import { canonicalJson, type FileOperation } from "@hunter-harness/contracts";

import type { WebFileKind } from "./file-policy";

export interface ProjectSummary {
  project_id: string;
  display_name: string;
  role: "owner" | "contributor" | "reviewer" | "admin";
  latest_project_version: string | null;
  latest_artifact_id: string | null;
  created_at: string;
}

export interface ProjectDetailModel extends ProjectSummary {
  request_id: string;
}

export interface ArtifactManifestModel {
  schema_version: 1;
  project_id: string;
  project_version: string | null;
  artifact_id: string;
  manifest_sha256: string;
  files: FileOperation[];
}

export interface ProjectFileProposalInput {
  projectId: string;
  baseProjectVersion: string | null;
  baseManifestHash: string;
  action: "add" | "modify" | "rename" | "delete";
  path: string;
  targetPath?: string;
  baseContentHash?: string;
  content?: string;
  fileKind: WebFileKind;
  confirmProjectLocal: boolean;
}

export interface ProjectFileProposalResult {
  proposal_id: string;
  status: "pending_review";
  received_files: number;
}

export interface ProposalSummary {
  proposal_id: string;
  project_id: string;
  status: string;
  created_at: string;
  changed_item_count: number;
  risk_count: number;
  base_project_version: string | null;
  created_by: string;
}

export interface ArtifactSummary {
  artifact_id: string;
  project_id: string;
  project_version: string;
  base_project_version: string | null;
  proposal_id: string;
  changed_item_count: number;
  manifest_sha256: string;
  created_at: string;
}

export interface ProposalDetailModel {
  schema_version: 1;
  proposal_id: string;
  project_id: string;
  status: string;
  created_by: string;
  created_at: string;
  items: Array<{ item_id: string; operation: FileOperation }>;
  scan_summary: { redacted: true };
  review_history: Array<{
    review_id: string;
    decision: string;
    created_at: string;
  }>;
}

export interface ReviewInput {
  decision: "approve" | "reject" | "need_more_evidence" | "split";
  comment: string | null;
  target_scope: string;
  split_groups: Array<{
    name: string;
    item_ids: string[];
    target_scope: string;
  }>;
}

export interface ReviewResult {
  review_id: string;
  proposal_id: string;
  decision: ReviewInput["decision"];
  artifact_id: string | null;
  child_proposal_ids: string[];
}

export interface HunterApi {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectDetailModel>;
  listProjectProposals(projectId: string): Promise<ProposalSummary[]>;
  listAllProposals(): Promise<ProposalSummary[]>;
  listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]>;
  listAllArtifacts(): Promise<ArtifactSummary[]>;
  getArtifactManifest(artifactId: string): Promise<ArtifactManifestModel>;
  getArtifactText(artifactId: string, contentHash: string): Promise<string>;
  createProjectFileProposal(input: ProjectFileProposalInput): Promise<ProjectFileProposalResult>;
  getProposal(proposalId: string): Promise<ProposalDetailModel>;
  reviewProposal(proposalId: string, input: ReviewInput): Promise<ReviewResult>;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(redact(message));
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

function redact(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z]:\\[^\s]+/g, "[REDACTED_PATH]")
    .slice(0, 500);
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return "sha256:" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class HttpHunterApi implements HunterApi {
  readonly baseUrl: string;
  readonly tokenProvider: () => string | null;
  readonly fetch: typeof globalThis.fetch;

  constructor(options: {
    baseUrl: string;
    tokenProvider: () => string | null;
    fetch?: typeof globalThis.fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    const headers = new Headers({
      Accept: "application/json",
      Authorization: "Bearer " + token,
      "X-Request-Id": uuid()
    });
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", uuid());
    }
    let response: Response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw new ApiClientError(0, "NETWORK_ERROR", "Unable to reach the governance server.");
    }
    const payload = await response.json() as {
      error?: { code?: string; message?: string };
    } & T;
    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        payload.error?.code ?? "HTTP_ERROR",
        payload.error?.message ?? "Governance request failed."
      );
    }
    return payload;
  }

  private async binaryRequest(
    method: string,
    path: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>
  ): Promise<void> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    const uploadBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const response = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "X-Request-Id": uuid(),
        "Idempotency-Key": uuid(),
        ...headers
      },
      body: uploadBody
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new ApiClientError(response.status, payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? "Upload failed.");
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const result = await this.request<{
      items: ProjectSummary[];
    }>("GET", "/api/v1/projects?limit=100");
    return result.items;
  }

  async getProject(projectId: string): Promise<ProjectDetailModel> {
    return this.request("GET", "/api/v1/projects/" + encodeURIComponent(projectId));
  }

  async listProjectProposals(projectId: string): Promise<ProposalSummary[]> {
    const result = await this.request<{ items: ProposalSummary[] }>(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/proposals?limit=100"
    );
    return result.items.map((item) => ({ ...item, project_id: projectId }));
  }

  async listAllProposals(): Promise<ProposalSummary[]> {
    const projects = await this.listProjects();
    return (await Promise.all(projects.map(async (project) =>
      this.listProjectProposals(project.project_id)
    ))).flat().sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]> {
    const result = await this.request<{ items: ArtifactSummary[] }>(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/artifacts?limit=100"
    );
    return result.items;
  }

  async listAllArtifacts(): Promise<ArtifactSummary[]> {
    const projects = await this.listProjects();
    return (await Promise.all(projects.map(async (project) =>
      this.listProjectArtifacts(project.project_id)
    ))).flat().sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async getArtifactManifest(artifactId: string): Promise<ArtifactManifestModel> {
    return this.request("GET", "/api/v1/artifacts/" + encodeURIComponent(artifactId) + "/manifest");
  }

  async getArtifactText(artifactId: string, contentHash: string): Promise<string> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    const response = await this.fetch(
      this.baseUrl + "/api/v1/artifacts/" + encodeURIComponent(artifactId) + "/blobs/" + encodeURIComponent(contentHash),
      { method: "GET", headers: { Accept: "text/plain", Authorization: "Bearer " + token, "X-Request-Id": uuid() } }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new ApiClientError(response.status, payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? "Artifact content is unavailable.");
    }
    const content = await response.text();
    if (await sha256Text(content) !== contentHash || response.headers.get("X-Content-SHA256") !== contentHash) {
      throw new ApiClientError(422, "ARTIFACT_HASH_MISMATCH", "Artifact content failed integrity verification.");
    }
    return content;
  }

  async createProjectFileProposal(input: ProjectFileProposalInput): Promise<ProjectFileProposalResult> {
    const encoded = input.content === undefined ? undefined : new TextEncoder().encode(input.content);
    const contentHash = encoded === undefined ? undefined : await sha256Text(input.content ?? "");
    let operation: FileOperation;
    if (input.action === "delete") {
      if (input.baseContentHash === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "A delete proposal requires the current file hash.");
      operation = {
        operation: "delete",
        path: input.path,
        file_kind: input.fileKind,
        base_content_sha256: input.baseContentHash,
        tombstone: { deleted_at: new Date().toISOString(), reason: "Web Console proposal", previous_sha256: input.baseContentHash }
      };
    } else if (input.action === "add") {
      if (contentHash === undefined || encoded === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "An add proposal requires content.");
      operation = { operation: "add", path: input.path, file_kind: input.fileKind, content_sha256: contentHash, size_bytes: encoded.byteLength };
    } else if (input.action === "modify") {
      if (contentHash === undefined || encoded === undefined || input.baseContentHash === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "A modification proposal requires content and the current file hash.");
      operation = { operation: "modify", path: input.path, file_kind: input.fileKind, base_content_sha256: input.baseContentHash, content_sha256: contentHash, size_bytes: encoded.byteLength };
    } else {
      if (contentHash === undefined || encoded === undefined || input.baseContentHash === undefined || input.targetPath === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "A rename proposal requires content, source hash, and target path.");
      operation = { operation: "rename", from_path: input.path, to_path: input.targetPath, file_kind: input.fileKind, base_content_sha256: input.baseContentHash, content_sha256: contentHash, size_bytes: encoded.byteLength };
    }
    const session = await this.request<{
      session_id: string;
      missing_blobs: string[];
    }>("POST", "/api/v1/projects/" + encodeURIComponent(input.projectId) + "/proposal-sessions", {
      schema_version: 1,
      request_id: uuid(),
      client_id: "cli_web_console",
      base_project_version: input.baseProjectVersion,
      base_manifest_hash: input.baseManifestHash,
      proposal_manifest: { files: [operation] },
      artifact_manifest: { schema_version: 1, files: [operation] },
      confirmations: {
        project_local_paths: input.confirmProjectLocal
          ? [...new Set([input.path, input.targetPath].filter((path): path is string => path !== undefined))]
          : []
      }
    });
    if (contentHash !== undefined && encoded !== undefined && session.missing_blobs.includes(contentHash)) {
      await this.binaryRequest("PUT", "/api/v1/proposal-sessions/" + encodeURIComponent(session.session_id) + "/blobs/" + encodeURIComponent(contentHash), encoded, {
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes 0-" + Math.max(0, encoded.byteLength - 1) + "/" + encoded.byteLength,
        "X-Chunk-SHA256": contentHash
      });
    }
    return this.request("POST", "/api/v1/proposal-sessions/" + encodeURIComponent(session.session_id) + ":finalize", {
      schema_version: 1,
      manifest_sha256: await sha256Text(canonicalJson([operation]))
    });
  }

  async getProposal(proposalId: string): Promise<ProposalDetailModel> {
    return this.request(
      "GET",
      "/api/v1/proposals/" + encodeURIComponent(proposalId)
    );
  }

  async reviewProposal(proposalId: string, input: ReviewInput): Promise<ReviewResult> {
    return this.request(
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposalId) + "/review-decisions",
      { schema_version: 1, ...input }
    );
  }
}

export function browserApi(): HunterApi {
  return new HttpHunterApi({
    baseUrl: process.env.NEXT_PUBLIC_HUNTER_HARNESS_API_URL ?? "",
    tokenProvider: () => typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem("hunter-harness-token")
  });
}
