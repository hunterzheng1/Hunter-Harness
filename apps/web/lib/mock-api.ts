import type {
  HunterApi,
  ProjectSummary,
  ProjectDetailModel,
  ProposalSummary,
  ArtifactSummary,
  ArtifactManifestModel,
  ProposalDetailModel,
  ReviewInput,
  ReviewResult,
} from "./api";

// ── Rich mock data for local dev / demo ─────────────────────

const MOCK_PROJECTS: ProjectSummary[] = [
  {
    project_id: "agent-harness",
    display_name: "Agent Harness",
    role: "owner",
    latest_project_version: "v2.4.1",
    latest_artifact_id: "art_a7f3c91b",
    created_at: "2025-11-15T08:30:00Z",
  },
  {
    project_id: "skill-registry",
    display_name: "Skill Registry",
    role: "contributor",
    latest_project_version: "v1.8.0",
    latest_artifact_id: "art_2e6d401f",
    created_at: "2025-12-01T14:00:00Z",
  },
  {
    project_id: "governance-api",
    display_name: "Governance API",
    role: "admin",
    latest_project_version: "v3.0.2",
    latest_artifact_id: "art_9b4c7e12",
    created_at: "2026-01-10T09:15:00Z",
  },
  {
    project_id: "review-dashboard",
    display_name: "Review Dashboard",
    role: "reviewer",
    latest_project_version: "v0.9.3",
    latest_artifact_id: "art_d51e8a06",
    created_at: "2026-03-22T16:45:00Z",
  },
  {
    project_id: "hunter-cli",
    display_name: "Hunter CLI",
    role: "owner",
    latest_project_version: "v1.2.0",
    latest_artifact_id: null,
    created_at: "2026-05-05T11:00:00Z",
  },
];

const MOCK_PROPOSALS: ProposalSummary[] = [
  {
    proposal_id: "prop_a1b2c3",
    project_id: "agent-harness",
    status: "pending_review",
    created_at: "2026-06-20T10:00:00Z",
    changed_item_count: 3,
    risk_count: 0,
    base_project_version: "v2.4.0",
    created_by: "alice",
  },
  {
    proposal_id: "prop_d4e5f6",
    project_id: "skill-registry",
    status: "pending_review",
    created_at: "2026-06-19T15:30:00Z",
    changed_item_count: 7,
    risk_count: 1,
    base_project_version: "v1.7.2",
    created_by: "bob",
  },
  {
    proposal_id: "prop_g7h8i9",
    project_id: "governance-api",
    status: "pending_review",
    created_at: "2026-06-18T09:45:00Z",
    changed_item_count: 2,
    risk_count: 0,
    base_project_version: "v3.0.1",
    created_by: "carol",
  },
  {
    proposal_id: "prop_j0k1l2",
    project_id: "agent-harness",
    status: "approved",
    created_at: "2026-06-15T08:00:00Z",
    changed_item_count: 5,
    risk_count: 0,
    base_project_version: "v2.3.1",
    created_by: "alice",
  },
  {
    proposal_id: "prop_m3n4o5",
    project_id: "review-dashboard",
    status: "rejected",
    created_at: "2026-06-14T13:00:00Z",
    changed_item_count: 1,
    risk_count: 0,
    base_project_version: "v0.9.2",
    created_by: "dave",
  },
  {
    proposal_id: "prop_p6q7r8",
    project_id: "skill-registry",
    status: "approved",
    created_at: "2026-06-12T11:00:00Z",
    changed_item_count: 4,
    risk_count: 0,
    base_project_version: "v1.7.0",
    created_by: "bob",
  },
];

const MOCK_ARTIFACTS: ArtifactSummary[] = [
  {
    artifact_id: "art_a7f3c91b",
    project_id: "agent-harness",
    project_version: "v2.4.1",
    base_project_version: "v2.3.1",
    proposal_id: "prop_j0k1l2",
    changed_item_count: 5,
    manifest_sha256: "sha256:a1b2c3d4e5f60001",
    created_at: "2026-06-15T08:05:00Z",
  },
  {
    artifact_id: "art_2e6d401f",
    project_id: "skill-registry",
    project_version: "v1.8.0",
    base_project_version: "v1.7.0",
    proposal_id: "prop_p6q7r8",
    changed_item_count: 4,
    manifest_sha256: "sha256:b2c3d4e5f60002",
    created_at: "2026-06-12T11:30:00Z",
  },
  {
    artifact_id: "art_9b4c7e12",
    project_id: "governance-api",
    project_version: "v3.0.2",
    base_project_version: "v3.0.0",
    proposal_id: "prop_x9y0z1",
    changed_item_count: 8,
    manifest_sha256: "sha256:c3d4e5f60003",
    created_at: "2026-06-08T17:00:00Z",
  },
];

// ── MockApiClient — returns mock data without any network call ──

const DELAY_MS = 400; // simulate a slight async feel

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), DELAY_MS));
}

export class MockApiClient implements HunterApi {
  async listProjects(): Promise<ProjectSummary[]> {
    return delay([...MOCK_PROJECTS]);
  }

  async getProject(projectId: string): Promise<ProjectDetailModel> {
    const project = MOCK_PROJECTS.find((p) => p.project_id === projectId);
    if (!project) throw new Error("Project not found");
    return delay({
      ...project,
      request_id: "mock-" + crypto.randomUUID(),
    });
  }

  async listProjectProposals(projectId: string): Promise<ProposalSummary[]> {
    return delay(
      MOCK_PROPOSALS.filter((p) => p.project_id === projectId)
    );
  }

  async listAllProposals(): Promise<ProposalSummary[]> {
    return delay(
      [...MOCK_PROPOSALS].sort(
        (a, b) => b.created_at.localeCompare(a.created_at)
      )
    );
  }

  async listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]> {
    return delay(
      MOCK_ARTIFACTS.filter((a) => a.project_id === projectId)
    );
  }

  async listAllArtifacts(): Promise<ArtifactSummary[]> {
    return delay(
      [...MOCK_ARTIFACTS].sort(
        (a, b) => b.created_at.localeCompare(a.created_at)
      )
    );
  }

  async getArtifactManifest(_artifactId: string): Promise<ArtifactManifestModel> {
    return delay({
      schema_version: 1,
      project_id: "agent-harness",
      project_version: "v2.4.1",
      artifact_id: "art_a7f3c91b",
      manifest_sha256: "sha256:a1b2c3d4e5f60001",
      files: [
        {
          operation: "add",
          path: "src/index.ts",
          file_kind: "source" as any,
          content_sha256: "sha256:abc123",
          size_bytes: 2048,
        },
        {
          operation: "modify",
          path: "package.json",
          file_kind: "manifest" as any,
          base_content_sha256: "sha256:old456",
          content_sha256: "sha256:new789",
          size_bytes: 1024,
        },
      ],
    });
  }

  async getArtifactText(
    _artifactId: string,
    _contentHash: string
  ): Promise<string> {
    return delay("// Mock artifact content\nconsole.log('hello hunter-harness');");
  }

  async createProjectFileProposal(_input: any): Promise<any> {
    return delay({
      proposal_id: "prop_mock" + Date.now(),
      status: "pending_review",
      received_files: 1,
    });
  }

  async getProposal(_proposalId: string): Promise<ProposalDetailModel> {
    return delay({
      schema_version: 1,
      proposal_id: "prop_a1b2c3",
      project_id: "agent-harness",
      status: "pending_review",
      created_by: "alice",
      created_at: "2026-06-20T10:00:00Z",
      items: [
        {
          item_id: "item_001",
          operation: {
            operation: "modify",
            path: "src/agent.ts",
            file_kind: "source" as any,
            base_content_sha256: "sha256:old123",
            content_sha256: "sha256:new456",
            size_bytes: 4096,
          },
        },
        {
          item_id: "item_002",
          operation: {
            operation: "add",
            path: "src/tools/skill-loader.ts",
            file_kind: "source" as any,
            content_sha256: "sha256:abc789",
            size_bytes: 1536,
          },
        },
        {
          item_id: "item_003",
          operation: {
            operation: "rename",
            from_path: "src/old-utils.ts",
            to_path: "src/utils/helpers.ts",
            file_kind: "source" as any,
            base_content_sha256: "sha256:old999",
            content_sha256: "sha256:old999",
            size_bytes: 2048,
          },
        },
      ],
      scan_summary: { redacted: true },
      review_history: [
        {
          review_id: "rev_001",
          decision: "need_more_evidence",
          created_at: "2026-06-20T12:00:00Z",
        },
      ],
    });
  }

  async reviewProposal(
    proposalId: string,
    input: ReviewInput
  ): Promise<ReviewResult> {
    return delay({
      review_id: "rev_" + Date.now(),
      proposal_id: proposalId,
      decision: input.decision,
      artifact_id:
        input.decision === "approve" ? "art_mock" + Date.now() : null,
      child_proposal_ids:
        input.decision === "split"
          ? ["prop_child_1", "prop_child_2"]
          : [],
    });
  }
}

export const mockApi = new MockApiClient();