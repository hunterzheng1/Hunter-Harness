import {
  canonicalJson,
  type AiProviderConfig,
  type AiQuotaUsage,
  type DashboardOverview,
  type DraftState,
  type FileOperation,
  type FixPlan,
  type PublishSkillRequest,
  type RegistryAgent,
  type RegistryArtifact,
  type RegistryProjectWorkflowBinding,
  type RegistrySkillDetail,
  type RegistrySkillProposal,
  type RegistrySkillVersion,
  type RegistryTag,
  type RegistryWorkflow,
  type RegistryWorkflowMutation,
  type SetDefaultAgentRequest,
  type SkillCheckResult,
  type SkillDiffFile,
  type SkillIr,
  type PublishWorkflowPackageRequest,
  type WorkflowPackage,
  type WorkflowPackageDraftState,
  type WorkflowPackageVersion
} from "@hunter-harness/contracts";

import type { WebFileKind } from "./file-policy";

// 异步 AI 检查 job 状态（GET /api/v1/ai-jobs/:id 响应；与 server AiJobStore 对齐）
export interface AiJobState {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed";
  result: SkillCheckResult | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

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
  getDashboardOverview(days?: number): Promise<DashboardOverview>;
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
  listSkills?(filters?: Record<string, string>): Promise<RegistrySkillDetail[]>;
  listSkillArtifacts?(): Promise<RegistryArtifact[]>;
  getSkill?(slug: string): Promise<RegistrySkillDetail>;
  listSkillVersions?(slug: string, agent?: RegistryAgent): Promise<RegistrySkillVersion[]>;
  getSkillAdapterPreview?(slug: string, agent: RegistryAgent): Promise<{ path: string; content: string; sourceIrHash: string; compilerVersion: string; adapter: string }>;
  listSkillProposals?(status?: string): Promise<RegistrySkillProposal[]>;
  createSkillProposal?(ir: SkillIr, agent: RegistryAgent): Promise<RegistrySkillProposal>;
  reviewSkillProposal?(proposalId: string, decision: "approve" | "reject", comment: string | null): Promise<Record<string, unknown>>;
  downloadSkillArtifact?(slug: string, agent: RegistryAgent): Promise<{ blob: Blob; hash: string; filename: string }>;
  listTags?(): Promise<RegistryTag[]>;
  createTag?(slug: string, label: string): Promise<RegistryTag>;
  updateTag?(tagId: string, input: { revision: number; label?: string; active?: boolean }): Promise<RegistryTag>;
  mergeTag?(tagId: string, targetTagId: string, revision: number): Promise<RegistryTag>;
  bindSkillTag?(skillSlug: string, tagId: string, remove?: boolean): Promise<RegistrySkillDetail>;
  listWorkflows?(): Promise<RegistryWorkflow[]>;
  createWorkflow?(input: RegistryWorkflowMutation): Promise<RegistryWorkflow>;
  updateWorkflow?(workflowId: string, input: Partial<RegistryWorkflowMutation> & { revision: number }): Promise<RegistryWorkflow>;
  deleteWorkflow?(workflowId: string, revision: number): Promise<void>;
  getProjectWorkflowBinding?(projectId: string): Promise<RegistryProjectWorkflowBinding | null>;
  bindProjectWorkflow?(projectId: string, workflowId: string, revision: number | null): Promise<RegistryProjectWorkflowBinding>;
  uploadSkillDraft?(form: FormData, agent: RegistryAgent): Promise<DraftState>;
  getSkillDraft?(slug: string, agent: RegistryAgent): Promise<DraftState>;
  discardSkillDraft?(slug: string, agent: RegistryAgent, revision: number): Promise<{ slug: string; discarded: boolean }>;
  runSkillDraftChecks?(slug: string, agent: RegistryAgent): Promise<SkillCheckResult>;
  publishSkillDraft?(slug: string, agent: RegistryAgent, req: PublishSkillRequest): Promise<RegistrySkillVersion>;
  diffSkillDraft?(slug: string, agent: RegistryAgent): Promise<SkillDiffFile[]>;
  setDefaultAgent?(slug: string, agent: RegistryAgent, revision: number): Promise<RegistrySkillDetail>;
  deleteSkill?(slug: string): Promise<{ slug: string; deleted: boolean }>;
  uploadWorkflowPackage?(form: FormData): Promise<WorkflowPackageDraftState>;
  getWorkflowPackageDraft?(key: string): Promise<WorkflowPackageDraftState>;
  discardWorkflowPackageDraft?(key: string, revision: number): Promise<{ key: string; discarded: boolean }>;
  runWorkflowPackageChecks?(key: string): Promise<SkillCheckResult>;
  publishWorkflowPackage?(key: string, req: PublishWorkflowPackageRequest): Promise<WorkflowPackageVersion>;
  diffWorkflowPackageDraft?(key: string): Promise<SkillDiffFile[]>;
  listWorkflowPackages?(): Promise<WorkflowPackage[]>;
  getWorkflowPackage?(key: string): Promise<WorkflowPackage>;
  listWorkflowPackageVersions?(key: string): Promise<WorkflowPackageVersion[]>;
  listAiProviders?(): Promise<{ items: AiProviderConfig[]; default_provider: string | null }>;
  createAiProvider?(input: {
    provider_id: string; label: string; base_url: string; model: string;
    enabled: boolean; api_key_env: string; is_default?: boolean;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
  }): Promise<AiProviderConfig>;
  updateAiProvider?(providerId: string, revision: number, patch: {
    label?: string; base_url?: string; model?: string; enabled?: boolean; api_key_env?: string;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
  }): Promise<AiProviderConfig>;
  deleteAiProvider?(providerId: string): Promise<{ provider_id: string; deleted: boolean }>;
  testAiProvider?(providerId: string): Promise<{ provider_id: string; ok: boolean; model?: string; error?: string }>;
  setAiProviderKey?(providerId: string, key: { api_key: string; base_url?: string; model?: string }): Promise<{ provider_id: string; key_set: boolean }>;
  getAiUsage?(): Promise<AiQuotaUsage[]>;
  runSkillAiChecks?(slug: string, agent: RegistryAgent): Promise<{ jobId: string; status: string }>;
  getAiJob?(jobId: string): Promise<AiJobState>;
  previewSkillFix?(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan>;
  applySkillFix?(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<DraftState>;
  generateReleaseNote?(slug: string, agent: RegistryAgent): Promise<{ releaseNote: string | null; generatedAt: string; degraded?: boolean; reason?: string }>;
  fetchFixSuggestions?(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan>;
  applyFixSuggestion?(slug: string, agent: RegistryAgent, input: { checkId: string; suggestedContent: string; appliesTo: string | null }): Promise<DraftState>;
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

export function buildUploadFormData(files: File[]): FormData {
  const fd = new FormData();
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const filename = rel && rel.length > 0 ? rel : f.name;
    fd.append("file", f, filename);
  }
  return fd;
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
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
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
      Authorization: "Bearer " + token
    });
    if (body !== undefined) {
      headers.set("X-Request-Id", uuid());
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
      throw new ApiClientError(0, "NETWORK_ERROR", "Unable to reach the governance server while requesting " + path + ".");
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

  async getDashboardOverview(days = 7): Promise<DashboardOverview> {
    return this.request("GET", "/api/v1/dashboard/overview?days=" + encodeURIComponent(String(days)));
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

  async listSkills(filters: Record<string, string> = {}): Promise<RegistrySkillDetail[]> {
    const query = new URLSearchParams(filters);
    const result = await this.request<{ items: RegistrySkillDetail[] }>(
      "GET", "/api/v1/skills" + (query.size === 0 ? "" : "?" + query.toString())
    );
    return result.items;
  }

  async listSkillArtifacts(): Promise<RegistryArtifact[]> {
    return (await this.request<{ items: RegistryArtifact[] }>("GET", "/api/v1/skill-artifacts")).items;
  }

  async getSkill(slug: string): Promise<RegistrySkillDetail> {
    return this.request("GET", "/api/v1/skills/" + encodeURIComponent(slug));
  }

  async listSkillVersions(slug: string, agent?: RegistryAgent): Promise<RegistrySkillVersion[]> {
    const base = "/api/v1/skills/" + encodeURIComponent(slug) + "/versions";
    const path = agent === undefined ? base : base + "?agent=" + encodeURIComponent(agent);
    const result = await this.request<{ items: RegistrySkillVersion[] }>("GET", path);
    return result.items;
  }

  async getSkillAdapterPreview(slug: string, agent: RegistryAgent): Promise<{
    path: string;
    content: string;
    sourceIrHash: string;
    compilerVersion: string;
    adapter: string;
  }> {
    return this.request(
      "GET",
      "/api/v1/skills/" + encodeURIComponent(slug) + "/adapter-preview/" + encodeURIComponent(agent)
    );
  }
  async listSkillProposals(status?: string): Promise<RegistrySkillProposal[]> {
    const suffix = status === undefined ? "" : "?status=" + encodeURIComponent(status);
    const result = await this.request<{ items: RegistrySkillProposal[] }>("GET", "/api/v1/skill-proposals" + suffix);
    return result.items;
  }

  async createSkillProposal(ir: SkillIr, agent: RegistryAgent): Promise<RegistrySkillProposal> {
    return this.request("POST", "/api/v1/skill-proposals", {
      schema_version: 1, skill_ir: ir, agent
    });
  }

  async reviewSkillProposal(
    proposalId: string,
    decision: "approve" | "reject",
    comment: string | null
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/v1/skill-proposals/" + encodeURIComponent(proposalId) + "/review", {
      schema_version: 1, decision, comment
    });
  }

  async downloadSkillArtifact(
    slug: string,
    agent: RegistryAgent
  ): Promise<{ blob: Blob; hash: string; filename: string }> {
    const token = this.tokenProvider();
    if (token === null || token === "") throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    const response = await this.fetch(
      this.baseUrl + "/api/v1/skills/" + encodeURIComponent(slug) + "/artifacts/" + encodeURIComponent(agent) + "/download",
      { headers: { Authorization: "Bearer " + token, "X-Request-Id": uuid() } }
    );
    if (!response.ok) throw new ApiClientError(response.status, "DOWNLOAD_FAILED", "Skill artifact download failed.");
    return {
      blob: await response.blob(),
      hash: response.headers.get("X-Content-SHA256") ?? "",
      filename: /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? slug + ".zip"
    };
  }

  async listTags(): Promise<RegistryTag[]> {
    return (await this.request<{ items: RegistryTag[] }>("GET", "/api/v1/tags")).items;
  }

  async createTag(slug: string, label: string): Promise<RegistryTag> {
    return this.request("POST", "/api/v1/tags", { schema_version: 1, slug, label });
  }

  async updateTag(tagId: string, input: { revision: number; label?: string; active?: boolean }): Promise<RegistryTag> {
    return this.request("PATCH", "/api/v1/tags/" + encodeURIComponent(tagId), input);
  }

  async mergeTag(tagId: string, targetTagId: string, revision: number): Promise<RegistryTag> {
    return this.request("POST", "/api/v1/tags/" + encodeURIComponent(tagId) + "/merge", {
      revision, target_tag_id: targetTagId
    });
  }

  async bindSkillTag(skillSlug: string, tagId: string, remove = false): Promise<RegistrySkillDetail> {
    return this.request(remove ? "DELETE" : "PUT", "/api/v1/skills/" + encodeURIComponent(skillSlug) + "/tags/" + encodeURIComponent(tagId), {});
  }

  async listWorkflows(): Promise<RegistryWorkflow[]> {
    return (await this.request<{ items: RegistryWorkflow[] }>("GET", "/api/v1/workflows")).items;
  }

  async createWorkflow(input: RegistryWorkflowMutation): Promise<RegistryWorkflow> {
    return this.request("POST", "/api/v1/workflows", { schema_version: 1, ...input });
  }

  async updateWorkflow(
    workflowId: string,
    input: Partial<RegistryWorkflowMutation> & { revision: number }
  ): Promise<RegistryWorkflow> {
    return this.request("PATCH", "/api/v1/workflows/" + encodeURIComponent(workflowId), input);
  }

  async deleteWorkflow(workflowId: string, revision: number): Promise<void> {
    await this.request("DELETE", "/api/v1/workflows/" + encodeURIComponent(workflowId) + "?revision=" + revision, {});
  }

  async getProjectWorkflowBinding(projectId: string): Promise<RegistryProjectWorkflowBinding | null> {
    const result = await this.request<{ binding: RegistryProjectWorkflowBinding | null }>(
      "GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/workflow-binding"
    );
    return result.binding;
  }

  async bindProjectWorkflow(
    projectId: string,
    workflowId: string,
    revision: number | null
  ): Promise<RegistryProjectWorkflowBinding> {
    return this.request("PUT", "/api/v1/projects/" + encodeURIComponent(projectId) + "/workflow-binding", {
      schema_version: 1, workflow_id: workflowId, revision
    });
  }

  private async multipartRequest<T>(path: string, formData: FormData): Promise<T> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    let response: Response;
    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: "Bearer " + token
      });
      headers.set("X-Request-Id", uuid());
      headers.set("Idempotency-Key", uuid());
      response = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers,
        body: formData
      });
    } catch {
      throw new ApiClientError(0, "NETWORK_ERROR", "Unable to reach the governance server while uploading " + path + ".");
    }
    const payload = await response.json() as { error?: { code?: string; message?: string } } & T;
    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        payload.error?.code ?? "HTTP_ERROR",
        payload.error?.message ?? "Skill upload failed."
      );
    }
    return payload;
  }

  private draftPath(slug: string, agent: RegistryAgent, suffix = ""): string {
    return "/api/v1/skills/" + encodeURIComponent(slug) + "/draft/" + encodeURIComponent(agent) + suffix;
  }

  async uploadSkillDraft(form: FormData, agent: RegistryAgent): Promise<DraftState> {
    return this.multipartRequest<DraftState>("/api/v1/skills/draft?agent=" + encodeURIComponent(agent), form);
  }

  async getSkillDraft(slug: string, agent: RegistryAgent): Promise<DraftState> {
    return this.request("GET", this.draftPath(slug, agent));
  }

  async discardSkillDraft(slug: string, agent: RegistryAgent, revision: number): Promise<{ slug: string; discarded: boolean }> {
    return this.request("DELETE", this.draftPath(slug, agent), { revision });
  }

  async runSkillDraftChecks(slug: string, agent: RegistryAgent): Promise<SkillCheckResult> {
    return this.request("POST", this.draftPath(slug, agent, "/checks"), {});
  }

  async publishSkillDraft(slug: string, agent: RegistryAgent, req: PublishSkillRequest): Promise<RegistrySkillVersion> {
    return this.request("POST", this.draftPath(slug, agent, "/publish"), req);
  }

  async diffSkillDraft(slug: string, agent: RegistryAgent): Promise<SkillDiffFile[]> {
    const result = await this.request<{ items: SkillDiffFile[] }>("GET", this.draftPath(slug, agent, "/diff"));
    return result.items;
  }

  async setDefaultAgent(slug: string, agent: RegistryAgent, revision: number): Promise<RegistrySkillDetail> {
    const body: SetDefaultAgentRequest = { defaultAgent: agent, revision };
    return this.request("PATCH", "/api/v1/skills/" + encodeURIComponent(slug) + "/default-agent", body);
  }

  async deleteSkill(slug: string): Promise<{ slug: string; deleted: boolean }> {
    return this.request("DELETE", "/api/v1/skills/" + encodeURIComponent(slug), {});
  }

  async uploadWorkflowPackage(form: FormData): Promise<WorkflowPackageDraftState> {
    return this.multipartRequest<WorkflowPackageDraftState>("/api/v1/workflow-packages", form);
  }
  async getWorkflowPackageDraft(key: string): Promise<WorkflowPackageDraftState> {
    return this.request("GET", "/api/v1/workflow-packages/" + encodeURIComponent(key) + "/draft");
  }
  async discardWorkflowPackageDraft(key: string, revision: number): Promise<{ key: string; discarded: boolean }> {
    return this.request("DELETE", "/api/v1/workflow-packages/" + encodeURIComponent(key) + "/draft", { revision });
  }
  async runWorkflowPackageChecks(key: string): Promise<SkillCheckResult> {
    return this.request("POST", "/api/v1/workflow-packages/" + encodeURIComponent(key) + "/draft/checks", {});
  }
  async publishWorkflowPackage(key: string, req: PublishWorkflowPackageRequest): Promise<WorkflowPackageVersion> {
    return this.request("POST", "/api/v1/workflow-packages/" + encodeURIComponent(key) + "/publish", req);
  }
  async diffWorkflowPackageDraft(key: string): Promise<SkillDiffFile[]> {
    const result = await this.request<{ items: SkillDiffFile[] }>("GET", "/api/v1/workflow-packages/" + encodeURIComponent(key) + "/draft/diff");
    return result.items;
  }
  async listWorkflowPackages(): Promise<WorkflowPackage[]> {
    const result = await this.request<{ items: WorkflowPackage[] }>("GET", "/api/v1/workflow-packages");
    return result.items;
  }
  async getWorkflowPackage(key: string): Promise<WorkflowPackage> {
    return this.request("GET", "/api/v1/workflow-packages/" + encodeURIComponent(key));
  }
  async listWorkflowPackageVersions(key: string): Promise<WorkflowPackageVersion[]> {
    const result = await this.request<{ items: WorkflowPackageVersion[] }>("GET", "/api/v1/workflow-packages/" + encodeURIComponent(key) + "/versions");
    return result.items;
  }

  async listAiProviders(): Promise<{ items: AiProviderConfig[]; default_provider: string | null }> {
    return this.request("GET", "/api/v1/ai-config/providers");
  }
  async createAiProvider(input: {
    provider_id: string; label: string; base_url: string; model: string;
    enabled: boolean; api_key_env: string; is_default?: boolean;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
  }): Promise<AiProviderConfig> {
    return this.request("POST", "/api/v1/ai-config/providers", { schema_version: 1, ...input });
  }
  async updateAiProvider(providerId: string, revision: number, patch: {
    label?: string; base_url?: string; model?: string; enabled?: boolean; api_key_env?: string;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
  }): Promise<AiProviderConfig> {
    return this.request("PATCH", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId), { schema_version: 1, revision, ...patch });
  }
  async deleteAiProvider(providerId: string): Promise<{ provider_id: string; deleted: boolean }> {
    return this.request("DELETE", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId), {});
  }
  async testAiProvider(providerId: string): Promise<{ provider_id: string; ok: boolean; model?: string; error?: string }> {
    return this.request("POST", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId) + "/test", {});
  }
  async setAiProviderKey(providerId: string, key: { api_key: string; base_url?: string; model?: string }): Promise<{ provider_id: string; key_set: boolean }> {
    return this.request("POST", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId) + "/key", key);
  }
  async getAiUsage(): Promise<AiQuotaUsage[]> {
    const res = await this.request<{ usage: AiQuotaUsage[] }>("GET", "/api/v1/ai-config/usage");
    return res.usage;
  }
  async runSkillAiChecks(slug: string, agent: RegistryAgent): Promise<{ jobId: string; status: string }> {
    return this.request("POST", this.draftPath(slug, agent, "/ai-checks"), {});
  }
  async getAiJob(jobId: string): Promise<AiJobState> {
    return this.request("GET", "/api/v1/ai-jobs/" + encodeURIComponent(jobId));
  }
  async previewSkillFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    return this.request("POST", this.draftPath(slug, agent, "/fix-preview"), { checkIds });
  }
  async applySkillFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<DraftState> {
    return this.request("POST", this.draftPath(slug, agent, "/apply-fix"), { checkIds });
  }
  async generateReleaseNote(slug: string, agent: RegistryAgent): Promise<{ releaseNote: string | null; generatedAt: string; degraded?: boolean; reason?: string }> {
    return this.request("POST", this.draftPath(slug, agent, "/release-note:generate"), {});
  }
  async fetchFixSuggestions(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    return this.request("POST", this.draftPath(slug, agent, "/fix-suggestions"), { checkIds });
  }
  async applyFixSuggestion(slug: string, agent: RegistryAgent, input: { checkId: string; suggestedContent: string; appliesTo: string | null }): Promise<DraftState> {
    return this.request("POST", this.draftPath(slug, agent, "/apply-fix-suggestion"), input);
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
