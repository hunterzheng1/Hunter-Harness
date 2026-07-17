// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardConsole,
  ProjectRegistry
} from "../components/console";
import {
  ApiClientError,
  type HunterApi,
  type ProjectSummary
} from "../lib/api";

const projects: ProjectSummary[] = [{
  project_id: "prj_one",
  display_name: "Payments",
  role: "owner",
  latest_project_version: "pv_1",
  latest_artifact_id: "art_1",
  created_at: "2026-06-20T00:00:00Z"
}];

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
  health: [{ key: "review_backlog", label: "Review backlog", status: "attention" as const, value: "1 pending", detail: "Human review is required before pending proposals can publish." }],
  services: [{ key: "api", label: "Governance API", status: "operational" as const, detail: "Authenticated overview request completed.", checked_at: "2026-06-22T00:00:00.000Z" }],
  activity: [{ event_id: "evt_1", action: "project.resolved", target_id: "prj_one", project_id: "prj_one", actor_id: "actor_owner", created_at: "2026-06-22T00:00:00.000Z" }]
};

afterEach(cleanup);

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    getDashboardOverview: vi.fn(async () => overview),
    listProjects: vi.fn(async () => projects),
    listSkills: vi.fn(async () => []),
    listAllProposals: vi.fn(async () => []),
    listAllArtifacts: vi.fn(async () => []),
    getProject: vi.fn(async () => {
      const project = projects[0];
      if (project === undefined) throw new Error("fixture project missing");
      return { ...project, request_id: "req" };
    }),
    listProjectProposals: vi.fn(async () => []),
    listProjectArtifacts: vi.fn(async () => []),
    getArtifactManifest: vi.fn(async () => ({ schema_version: 1, project_id: "prj_one", project_version: "pv_1", artifact_id: "art_1", manifest_sha256: "sha", files: [] })),
    getArtifactText: vi.fn(async () => ""),
    createProjectFileProposal: vi.fn(async () => ({ proposal_id: "prp", status: "pending" })),
    getProposal: vi.fn(async () => ({ schema_version: 1, proposal_id: "prp", project_id: "prj_one", status: "approved", created_by: "a", created_at: "2026-06-20T00:00:00Z", items: [], scan_summary: { redacted: true }, review_history: [] })),
    ...overrides
  } as unknown as HunterApi;
}

describe("Web Console", () => {
  it("renders dashboard overview in Chinese-friendly copy", async () => {
    render(<DashboardConsole api={api()} />);
    expect(screen.getByText(/正在加载总览|Loading overview/i)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /总览|Overview/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /最近项目|Recent projects/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /技能使用|Skill usage/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Artifact changes" })).not.toBeInTheDocument();
  });

  it("renders dashboard and project registry from /api/v1", async () => {
    const dashboard = render(<DashboardConsole api={api()} />);
    expect(await screen.findByRole("heading", { name: /总览|Overview/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /变更提交|Change activity/i })).toBeInTheDocument();
    dashboard.unmount();
    render(<ProjectRegistry api={api()} />);
    expect(await screen.findByRole("heading", { name: "Payments" })).toBeInTheDocument();
    expect(screen.queryByText("art_1")).not.toBeInTheDocument();
  });

  it("loads projects without workflow N+1 calls and moves a project to the recycle bin", async () => {
    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? projects : []);
    const listWorkflowFamilies = vi.fn(async () => []);
    const getProjectWorkflowBinding = vi.fn(async () => null);
    const archiveProject = vi.fn(async () => ({
      project_id: "prj_one",
      display_name: "Payments",
      lifecycle_state: "archived" as const,
      archived_at: "2026-06-21T00:00:00Z",
      purge_after: "2026-07-21T00:00:00Z",
      purged_at: null
    }));
    render(<ProjectRegistry api={api({ listProjects, listWorkflowFamilies, getProjectWorkflowBinding, archiveProject })} />);

    expect(await screen.findByRole("heading", { name: "Payments" })).toBeInTheDocument();
    expect(listWorkflowFamilies).not.toHaveBeenCalled();
    expect(getProjectWorkflowBinding).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移到回收站" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(archiveProject).toHaveBeenCalledWith("prj_one"));
  });

  it("shows a redacted authentication failure without leaking server details", async () => {
    const failing = api({
      getDashboardOverview: vi.fn(async () => {
        throw new ApiClientError(401, "TOKEN_INVALID", "Bearer super-secret-token");
      })
    });
    render(<DashboardConsole api={failing} />);
    expect(await screen.findByText(/需要认证|authentication required|演示数据失败|Bearer \[REDACTED\]/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("super-secret-token");
  });
});
