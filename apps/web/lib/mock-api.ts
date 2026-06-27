import type {
  DashboardOverview,
  DraftState,
  RegistryAgent,
  RegistrySkillDetail,
  RegistrySkillProposal,
  RegistrySkillVersion,
  RegistryTag,
  RegistryWorkflow,
  RegistryWorkflowMutation,
  SkillCheckItem,
  SkillCheckResult,
  SkillDiffFile,
  SkillIr
} from "@hunter-harness/contracts";

import { bootstrapSkills, workflowOrder } from "./catalog";
import { findDemoSourceSkill, sapFieldMapper } from "./demo-skills/sap-field-mapper";
import { ApiClientError } from "./api";
import type {
  HunterApi,
  ProjectSummary,
  ProjectDetailModel,
  ProjectFileProposalInput,
  ProjectFileProposalResult,
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

function toIr(skill: (typeof bootstrapSkills)[number]): SkillIr {
  return {
    name: skill.name,
    kind: skill.kind,
    description: skill.description,
    triggers: skill.triggers,
    inputs: skill.inputs,
    outputs: skill.outputs,
    forbidden_actions: skill.forbiddenActions,
    required_context: skill.requiredContext,
    profiles: Object.fromEntries(skill.profiles.map((profile) => [profile, { enabled: true }])),
    adapters: Object.fromEntries(skill.adapters.map((adapter) => [adapter, { enabled: true }])),
    version: skill.version,
    instructions: skill.instructions,
    source_provenance: "Explicit demo data"
  };
}

const MOCK_SKILLS: RegistrySkillDetail[] = bootstrapSkills.map((skill, index) => ({
  skill_id: "skl_demo_" + index,
  slug: skill.name,
  name: skill.name,
  description: skill.description,
  tags: skill.kind === "governance" ? ["review"] : ["bootstrap"],
  status: "published",
  latest_version: skill.version,
  defaultAgent: skill.adapters.some((a) => a === "claude-code") ? "claude-code" : null,
  agents: skill.adapters.map((agent) => ({
    agent: agent as RegistryAgent,
    enabled: true,
    isDefault: agent === "claude-code",
    installTarget: ".claude/skills/" + skill.name,
    latestVersion: agent === "claude-code" ? skill.version : null,
    draftVersion: null,
    sourcePackagePath: null
  })),
  revision: 1,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
  ir: toIr(skill),
  sourceFiles: [],
  examples: []
}));

const SAP_FIELD_MAPPER_IR: SkillIr = {
  name: "harness-sap-field-mapper",
  kind: "tooling",
  description: "Extract SAP/S4 table and field references from Markdown and build entity-class mapping tables.",
  triggers: ["map SAP fields", "map S/4 fields", "SAP entity mapping"],
  inputs: ["markdown_document", "project_source"],
  outputs: ["sap_entity_mapping_table", "entity_class_paths"],
  forbidden_actions: ["modify_source_without_request", "discard_unmatched_fields"],
  required_context: ["target_markdown_document", "project_root"],
  profiles: { general: { enabled: true } },
  adapters: { "claude-code": { enabled: true }, codex: { enabled: true } },
  version: "1.0.0",
  instructions: [
    "Extract SAP/S4 table and field references from the target Markdown document.",
    "Merge T-table fields into the derived base-table entity mapping.",
    "Append the verified mapping table to the requested document."
  ],
  allowed_capabilities: ["read", "search", "network-api", "write"],
  source_provenance: "Demo source package imported from the original sap-field-mapper directory."
};

MOCK_SKILLS.push({
  skill_id: "skl_demo_sap_field_mapper",
  slug: sapFieldMapper.slug,
  name: sapFieldMapper.slug,
  description: SAP_FIELD_MAPPER_IR.description,
  tags: ["sap", "source-package"],
  status: "published",
  latest_version: SAP_FIELD_MAPPER_IR.version,
  defaultAgent: "claude-code",
  agents: [
    { agent: "claude-code", enabled: true, isDefault: true, installTarget: ".claude/skills/" + sapFieldMapper.slug, latestVersion: SAP_FIELD_MAPPER_IR.version, draftVersion: null, sourcePackagePath: null },
    { agent: "codex", enabled: true, isDefault: false, installTarget: ".harness/generated/codex/" + sapFieldMapper.slug, latestVersion: null, draftVersion: null, sourcePackagePath: null }
  ],
  revision: 1,
  created_at: "2026-06-25T00:00:00Z",
  updated_at: "2026-06-25T00:00:00Z",
  ir: SAP_FIELD_MAPPER_IR,
  sourceFiles: [],
  examples: []
});

const MOCK_TAGS: RegistryTag[] = [
  { tag_id: "tag_demo_bootstrap", slug: "bootstrap", label: "Bootstrap", active: true, revision: 1, usageCount: 0, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" },
  { tag_id: "tag_demo_review", slug: "review", label: "Review", active: true, revision: 1, usageCount: 0, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" }
];

const MOCK_WORKFLOWS: RegistryWorkflow[] = [{
  workflow_id: "wf_demo_general",
  key: "general",
  name: "General",
  description: "Explicit read-only demo workflow",
  profile: "general",
  default_agent: "claude-code",
  enabled: true,
  skill_slugs: [...workflowOrder],
  revision: 1,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z"
}];

const MOCK_DASHBOARD: DashboardOverview = {
  generated_at: "2026-06-22T12:00:00.000Z",
  window: { days: 7, starts_at: "2026-06-16T00:00:00.000Z", ends_at: "2026-06-22T12:00:00.000Z" },
  metrics: {
    projects: 5, workflows: 1, skills: MOCK_SKILLS.length, published_skills: MOCK_SKILLS.length,
    pending_reviews: 3, approved_proposals: 2, rejected_proposals: 1,
    artifacts: 15, project_artifacts: 3, skill_artifacts: 12
  },
  trend: [
    { date: "2026-06-16", submitted: 1, approved: 1, rejected: 0, pending: 0 },
    { date: "2026-06-17", submitted: 3, approved: 1, rejected: 0, pending: 1 },
    { date: "2026-06-18", submitted: 2, approved: 0, rejected: 1, pending: 1 },
    { date: "2026-06-19", submitted: 4, approved: 2, rejected: 0, pending: 2 },
    { date: "2026-06-20", submitted: 2, approved: 1, rejected: 0, pending: 1 },
    { date: "2026-06-21", submitted: 1, approved: 1, rejected: 0, pending: 0 },
    { date: "2026-06-22", submitted: 3, approved: 1, rejected: 0, pending: 2 }
  ],
  distributions: {
    skill_categories: [
      { key: "workflow", count: 5 }, { key: "governance", count: 3 },
      { key: "tooling", count: 2 }, { key: "migration", count: 2 }
    ],
    workflow_profiles: [{ key: "general", count: 1 }]
  },
  health: [
    { key: "review_backlog", label: "Review backlog", status: "attention", value: "3 pending", detail: "Human review is required before pending proposals can publish." },
    { key: "review_outcome", label: "Review outcome", status: "healthy", value: "2/3 approved", detail: "Calculated from recorded review decisions." },
    { key: "artifact_traceability", label: "Artifact traceability", status: "healthy", value: "15/15 linked", detail: "Every demo artifact has a governed source." },
    { key: "audit_evidence", label: "Audit evidence", status: "healthy", value: "12 recent events", detail: "Recent immutable audit entries are available." }
  ],
  services: [
    { key: "api", label: "Governance API", status: "operational", detail: "Authenticated overview request completed.", checked_at: "2026-06-22T12:00:00.000Z" },
    { key: "repository", label: "Project repository", status: "operational", detail: "Projects, proposals, and artifacts were read successfully.", checked_at: "2026-06-22T12:00:00.000Z" },
    { key: "registry", label: "Skill registry", status: "operational", detail: "Skill and Workflow metadata were read successfully.", checked_at: "2026-06-22T12:00:00.000Z" },
    { key: "audit", label: "Audit log", status: "operational", detail: "Recent audit events were read without exposing details.", checked_at: "2026-06-22T12:00:00.000Z" }
  ],
  activity: [
    { event_id: "evt_demo_1", action: "skill.proposal.created", target_id: "skp_demo_1", project_id: null, actor_id: "actor_owner", created_at: "2026-06-22T11:40:00.000Z" },
    { event_id: "evt_demo_2", action: "workflow.updated", target_id: "wf_demo_general", project_id: null, actor_id: "actor_owner", created_at: "2026-06-22T10:20:00.000Z" }
  ]
};

function demoReadOnly(): never {
  throw new ApiClientError(403, "DEMO_READ_ONLY", "Demo mode is read-only and did not write server state.");
}

function demoChecksToResult(checks: readonly SkillCheckItem[]): SkillCheckResult {
  const items: SkillCheckItem[] = checks.map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status,
    message: c.message,
    filePath: c.filePath,
    fixable: c.fixable
  }));
  return {
    items,
    summary: {
      green: items.filter((i) => i.status === "green").length,
      yellow: items.filter((i) => i.status === "yellow").length,
      red: items.filter((i) => i.status === "red").length
    },
    checkedAt: "2026-06-25T15:20:00Z"
  };
}

function demoDiffToFiles(diffFiles: readonly SkillDiffFile[] | undefined): SkillDiffFile[] {
  return (diffFiles ?? []).map((d) => ({
    path: d.path,
    status: d.status,
    publishedContent: d.publishedContent,
    draftContent: d.draftContent
  }));
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), DELAY_MS));
}

export class MockApiClient implements HunterApi {
  async getDashboardOverview(): Promise<DashboardOverview> { return delay(clone(MOCK_DASHBOARD)); }

  async listSkills(): Promise<RegistrySkillDetail[]> {
    return delay(clone(MOCK_SKILLS));
  }

  async getSkill(slug: string): Promise<RegistrySkillDetail> {
    const skill = MOCK_SKILLS.find((item) => item.slug === slug);
    if (skill === undefined) throw new ApiClientError(404, "SKILL_NOT_FOUND", "Demo Skill not found.");
    return delay(clone(skill));
  }

  async listSkillVersions(slug: string): Promise<RegistrySkillVersion[]> {
    const skill = await this.getSkill(slug);
    return delay([{ skill_slug: slug, version: skill.latest_version ?? "1.0.0", ir: skill.ir, artifacts: [], source_proposal_id: null, sourceFiles: [], examples: [], changeNote: null, created_at: skill.updated_at }]);
  }

  async getSkillAdapterPreview(slug: string, agent: RegistryAgent) {
    const sourceSkill = findDemoSourceSkill(slug);
    if (sourceSkill !== undefined) {
      const content = sourceSkill.preview(agent);
      if (content === null) throw new ApiClientError(422, "ADAPTER_NOT_INSTALLABLE", "Demo adapter is contract-only.");
      const path = agent === "claude-code"
        ? `.claude/skills/${slug}/SKILL.md`
        : `.harness/generated/codex/${slug}/SKILL.md`;
      return delay({ path, content, sourceIrHash: "sha256:" + "d".repeat(64), compilerVersion: "demo-source-package", adapter: agent });
    }
    const skill = await this.getSkill(slug);
    if (agent !== "claude-code") throw new ApiClientError(422, "ADAPTER_NOT_INSTALLABLE", "Demo adapter is contract-only.");
    return delay({ path: `.claude/skills/${slug}/SKILL.md`, content: `# ${slug}\n\n${skill.description}\n`, sourceIrHash: "sha256:" + "d".repeat(64), compilerVersion: "1.0.0", adapter: agent });
  }

  async listSkillProposals(): Promise<RegistrySkillProposal[]> { return delay([]); }
  async listTags(): Promise<RegistryTag[]> { return delay(clone(MOCK_TAGS)); }
  async listWorkflows(): Promise<RegistryWorkflow[]> { return delay(clone(MOCK_WORKFLOWS)); }
  async listSkillArtifacts() { return delay([]); }
  async createSkillProposal(): Promise<RegistrySkillProposal> { return demoReadOnly(); }
  async reviewSkillProposal(): Promise<Record<string, unknown>> { return demoReadOnly(); }
  async downloadSkillArtifact(): Promise<{ blob: Blob; hash: string; filename: string }> { return demoReadOnly(); }
  async createTag(): Promise<RegistryTag> { return demoReadOnly(); }
  async updateTag(): Promise<RegistryTag> { return demoReadOnly(); }
  async mergeTag(): Promise<RegistryTag> { return demoReadOnly(); }
  async bindSkillTag(): Promise<RegistrySkillDetail> { return demoReadOnly(); }
  async createWorkflow(input: RegistryWorkflowMutation): Promise<RegistryWorkflow> { void input; return demoReadOnly(); }
  async updateWorkflow(): Promise<RegistryWorkflow> { return demoReadOnly(); }
  async deleteWorkflow(): Promise<void> { return demoReadOnly(); }
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

  async getArtifactManifest(artifactId: string): Promise<ArtifactManifestModel> {
    void artifactId;
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
          file_kind: "user_editable",
          content_sha256: "sha256:abc123",
          size_bytes: 2048,
        },
        {
          operation: "modify",
          path: "package.json",
          file_kind: "user_editable",
          base_content_sha256: "sha256:old456",
          content_sha256: "sha256:new789",
          size_bytes: 1024,
        },
      ],
    });
  }

  async getArtifactText(
    artifactId: string,
    contentHash: string
  ): Promise<string> {
    void artifactId;
    void contentHash;
    return delay("// Mock artifact content\nconsole.log('hello hunter-harness');");
  }

  async createProjectFileProposal(input: ProjectFileProposalInput): Promise<ProjectFileProposalResult> {
    void input;
    return delay({
      proposal_id: "prop_mock" + Date.now(),
      status: "pending_review",
      received_files: 1,
    });
  }

  async getProposal(proposalId: string): Promise<ProposalDetailModel> {
    void proposalId;
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
            file_kind: "user_editable",
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
            file_kind: "user_editable",
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
            file_kind: "user_editable",
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

  async uploadSkillDraft(): Promise<DraftState> { return demoReadOnly(); }

  async getSkillDraft(slug: string): Promise<DraftState> {
    const src = findDemoSourceSkill(slug);
    if (src === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo draft not found.");
    const agent = src.agents.find((a) => a.agent === src.defaultAgent) ?? src.agents[0];
    if (agent === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo agent not found.");
    return delay({
      slug: src.slug,
      sourceFiles: src.source.files.map((f) => ({ path: f.path, content: f.content })),
      ir: SAP_FIELD_MAPPER_IR,
      examples: src.examples.map((e) => ({ title: e.title, description: e.description, request: e.request, result: e.result, files: e.files ? [...e.files] : [] })),
      draftVersion: agent.draftVersion?.version ?? null,
      checks: demoChecksToResult(agent.checks),
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T15:20:00Z"
    });
  }

  async discardSkillDraft(): Promise<{ slug: string; discarded: boolean }> { return demoReadOnly(); }

  async runSkillDraftChecks(slug: string): Promise<SkillCheckResult> {
    const src = findDemoSourceSkill(slug);
    if (src === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo draft not found.");
    const agent = src.agents.find((a) => a.agent === src.defaultAgent) ?? src.agents[0];
    if (agent === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo agent not found.");
    return delay(demoChecksToResult(agent.checks));
  }

  async publishSkillDraft(): Promise<RegistrySkillVersion> { return demoReadOnly(); }

  async diffSkillDraft(slug: string): Promise<SkillDiffFile[]> {
    const src = findDemoSourceSkill(slug);
    if (src === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo draft not found.");
    const agent = src.agents.find((a) => a.agent === src.defaultAgent) ?? src.agents[0];
    return delay(demoDiffToFiles(agent?.diffFiles));
  }

  async deleteSkill(): Promise<{ slug: string; deleted: boolean }> { return demoReadOnly(); }
}

export const mockApi = new MockApiClient();
