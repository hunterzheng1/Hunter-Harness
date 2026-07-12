// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardConsole,
  ArtifactHistory,
  ProjectRegistry,
  ProposalDetail,
  ReviewQueue
} from "../components/console";
import {
  ApiClientError,
  type HunterApi,
  type ArtifactSummary,
  type ProjectSummary,
  type ProposalDetailModel,
  type ProposalSummary
} from "../lib/api";

const projects: ProjectSummary[] = [{
  project_id: "prj_one",
  display_name: "Payments",
  role: "owner",
  latest_project_version: "pv_1",
  latest_artifact_id: "art_1",
  created_at: "2026-06-20T00:00:00Z"
}];
const proposals: ProposalSummary[] = [{
  proposal_id: "prp_one",
  project_id: "prj_one",
  status: "approved",
  created_at: "2026-06-20T01:00:00Z",
  changed_item_count: 2,
  risk_count: 0,
  base_project_version: "pv_1",
  created_by: "actor_owner"
}];
const artifacts: ArtifactSummary[] = [{
  artifact_id: "art_1",
  project_id: "prj_one",
  project_version: "pv_1",
  base_project_version: null,
  proposal_id: "prp_one",
  changed_item_count: 2,
  manifest_sha256: "sha256:" + "c".repeat(64),
  created_at: "2026-06-20T02:00:00Z"
}];
const detail: ProposalDetailModel = {
  schema_version: 1,
  proposal_id: "prp_one",
  project_id: "prj_one",
  status: "approved",
  created_by: "actor_owner",
  created_at: "2026-06-20T01:00:00Z",
  items: [
    {
      item_id: "item_one",
      operation: {
        operation: "add",
        path: ".claude/rules/one.md",
        file_kind: "user_editable",
        content_sha256: "sha256:" + "a".repeat(64),
        size_bytes: 10
      }
    },
    {
      item_id: "item_two",
      operation: {
        operation: "add",
        path: ".claude/rules/two.md",
        file_kind: "user_editable",
        content_sha256: "sha256:" + "b".repeat(64),
        size_bytes: 20
      }
    }
  ],
  scan_summary: { redacted: true },
  review_history: []
};

const overview = {
  generated_at: "2026-06-22T00:00:00.000Z",
  window: { days: 7, starts_at: "2026-06-16T00:00:00.000Z", ends_at: "2026-06-22T00:00:00.000Z" },
  metrics: {
    projects: 1, workflows: 1, skills: 1, published_skills: 1,
    pending_reviews: 1, approved_proposals: 0, rejected_proposals: 0,
    artifacts: 1, project_artifacts: 1, skill_artifacts: 0
  },
  trend: Array.from({ length: 7 }, (_, index) => ({ date: `2026-06-${String(16 + index).padStart(2, "0")}`, submitted: index === 6 ? 1 : 0, approved: 0, rejected: 0, pending: index === 6 ? 1 : 0 })),
  distributions: { skill_categories: [{ key: "workflow", count: 1 }], workflow_profiles: [{ key: "general", count: 1 }] },
  health: [{ key: "review_backlog", label: "Review backlog", status: "attention" as const, value: "1 pending", detail: "Human review is required." }],
  services: [{ key: "api", label: "Governance API", status: "operational" as const, detail: "Authenticated overview request completed.", checked_at: "2026-06-22T00:00:00.000Z" }],
  activity: [{ event_id: "evt_1", action: "project.resolved", target_id: "prj_one", project_id: "prj_one", actor_id: "actor_owner", created_at: "2026-06-22T00:00:00.000Z" }]
};

afterEach(cleanup);

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    getDashboardOverview: vi.fn(async () => overview),
    listProjects: vi.fn(async () => projects),
    listProjectProposals: vi.fn(async () => proposals),
    listAllProposals: vi.fn(async () => proposals),
    listSkills: vi.fn(async () => []),
    listWorkflowFamilies: vi.fn(async () => []),
    listProjectArtifacts: vi.fn(async () => artifacts),
    listAllArtifacts: vi.fn(async () => artifacts),
    getProject: vi.fn(async () => ({
      project_id: "prj_one",
      display_name: "Payments",
      role: "owner" as const,
      latest_project_version: "pv_1",
      latest_artifact_id: "art_1",
      created_at: "2026-06-20T00:00:00Z",
      request_id: "req_project"
    })),
    getArtifactManifest: vi.fn(async () => ({
      artifact_id: "art_1",
      project_id: "prj_one",
      schema_version: 1 as const,
      project_version: "pv_1",
      manifest_sha256: "sha256:" + "c".repeat(64),
      files: []
    })),
    getArtifactText: vi.fn(async () => ""),
    createProjectFileProposal: vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "pending_review" as const,
      received_files: 1
    })),
    getProposal: vi.fn(async () => detail),
    reviewProposal: vi.fn(async () => ({
      review_id: "rev_one",
      proposal_id: "prp_one",
      decision: "approve" as const,
      artifact_id: "art_two",
      child_proposal_ids: []
    })),
    ...overrides
  };
}

describe("Web Console", () => {
  it("renders the real governance workbench from one overview snapshot", async () => {
    const dashboardApi = {
      ...api(),
      getDashboardOverview: vi.fn(async () => ({
        generated_at: "2026-06-22T00:00:00.000Z",
        window: { days: 7, starts_at: "2026-06-16T00:00:00.000Z", ends_at: "2026-06-22T00:00:00.000Z" },
        metrics: {
          projects: 4, workflows: 3, skills: 12, published_skills: 10,
          pending_reviews: 2, approved_proposals: 8, rejected_proposals: 1,
          artifacts: 14, project_artifacts: 4, skill_artifacts: 10
        },
        trend: [
          { date: "2026-06-16", submitted: 1, approved: 0, rejected: 0, pending: 1 },
          { date: "2026-06-17", submitted: 2, approved: 1, rejected: 0, pending: 0 },
          { date: "2026-06-18", submitted: 1, approved: 1, rejected: 0, pending: 0 },
          { date: "2026-06-19", submitted: 1, approved: 0, rejected: 1, pending: 0 },
          { date: "2026-06-20", submitted: 2, approved: 1, rejected: 0, pending: 1 },
          { date: "2026-06-21", submitted: 0, approved: 0, rejected: 0, pending: 0 },
          { date: "2026-06-22", submitted: 1, approved: 1, rejected: 0, pending: 0 }
        ],
        distributions: {
          skill_categories: [{ key: "workflow", count: 7 }, { key: "governance", count: 3 }],
          workflow_profiles: [{ key: "general", count: 2 }, { key: "java", count: 1 }]
        },
        health: [{ key: "review_backlog", label: "Review backlog", status: "attention", value: "2 pending", detail: "Human review is required." }],
        services: [{ key: "api", label: "Governance API", status: "operational", detail: "Authenticated overview request completed.", checked_at: "2026-06-22T00:00:00.000Z" }],
        activity: [{ event_id: "evt_1", action: "skill.proposal.created", target_id: "skp_1", project_id: null, actor_id: "actor_owner", created_at: "2026-06-22T00:00:00.000Z" }]
      }))
    };
    render(<DashboardConsole api={dashboardApi as HunterApi} />);

    expect(await screen.findByRole("img", { name: "Proposal activity line chart" })).toBeInTheDocument();
    expect(screen.getByText("Review backlog")).toBeInTheDocument();
    expect(screen.getByText("Governance API")).toBeInTheDocument();
    expect(screen.getByText("skill.proposal.created")).toBeInTheDocument();
    expect(dashboardApi.getDashboardOverview).toHaveBeenCalledOnce();
  });

  it("renders dashboard and project registry from /api/v1", async () => {
    const dashboard = render(<DashboardConsole api={api()} />);
    expect(screen.getByText(/loading governance overview|正在加载治理总览/i)).toBeInTheDocument();
    expect(await screen.findByText("1 pending")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Proposal activity line chart" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent projects" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Skill usage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Artifact changes" })).toBeInTheDocument();

    dashboard.unmount();
    render(<ProjectRegistry api={api()} />);
    expect(await screen.findByText("pv_1")).toBeInTheDocument();
    expect(screen.getByText("art_1")).toBeInTheDocument();
  });

  it("shows a redacted authentication failure without leaking server details", async () => {
    const failing = api({
      getDashboardOverview: vi.fn(async () => {
        throw new ApiClientError(401, "TOKEN_INVALID", "Bearer super-secret-token");
      })
    });
    render(<DashboardConsole api={failing} />);
    expect(await screen.findByText(/authentication required|需要认证/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("super-secret-token");
  });

  it("renders change history with loading and empty states", async () => {
    const client = api();
    const view = render(<ReviewQueue api={client} />);
    expect(screen.getByText(/loading change history|正在加载变更历史/i)).toBeInTheDocument();
    expect(await screen.findByText("prp_one")).toBeInTheDocument();
    view.unmount();

    render(<ReviewQueue api={api({ listAllProposals: vi.fn(async () => []) })} />);
    expect(await screen.findByText(/no change history|暂无变更历史/i)).toBeInTheDocument();
  });

  it("renders approved artifact history without artifact content", async () => {
    render(<ArtifactHistory api={api()} />);
    expect(await screen.findByText("art_1")).toBeInTheDocument();
    expect(screen.getByText("pv_1")).toBeInTheDocument();
    expect(screen.getByText("prp_one")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("approved rule");
  });

  it("renders proposal detail as read-only change history", async () => {
    render(<ProposalDetail api={api()} proposalId="prp_one" />);
    expect(await screen.findByText(".claude/rules/one.md")).toBeInTheDocument();
    expect(screen.getByText(/content is redacted|内容.*隐去/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|批准/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject|拒绝/i })).toBeNull();
  });
});
