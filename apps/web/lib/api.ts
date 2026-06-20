import type { FileOperation } from "@hunter-harness/contracts";

export interface ProjectSummary {
  project_id: string;
  display_name: string;
  role: "owner" | "contributor" | "reviewer" | "admin";
  latest_project_version: string | null;
  latest_artifact_id: string | null;
  created_at: string;
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
  listProjectProposals(projectId: string): Promise<ProposalSummary[]>;
  listAllProposals(): Promise<ProposalSummary[]>;
  listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]>;
  listAllArtifacts(): Promise<ArtifactSummary[]>;
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

  async listProjects(): Promise<ProjectSummary[]> {
    const result = await this.request<{
      items: ProjectSummary[];
    }>("GET", "/api/v1/projects?limit=100");
    return result.items;
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
