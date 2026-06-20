// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  status: "pending_review",
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
  status: "pending_review",
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

afterEach(cleanup);

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    listProjects: vi.fn(async () => projects),
    listProjectProposals: vi.fn(async () => proposals),
    listAllProposals: vi.fn(async () => proposals),
    listProjectArtifacts: vi.fn(async () => artifacts),
    listAllArtifacts: vi.fn(async () => artifacts),
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
  it("renders dashboard and project registry from /api/v1", async () => {
    render(<DashboardConsole api={api()} />);
    expect(screen.getByText(/loading governance overview/i)).toBeInTheDocument();
    expect(await screen.findByText("Payments")).toBeInTheDocument();
    expect(screen.getByText("pending review")).toBeInTheDocument();

    render(<ProjectRegistry api={api()} />);
    expect(await screen.findByText("pv_1")).toBeInTheDocument();
    expect(screen.getByText("art_1")).toBeInTheDocument();
  });

  it("shows a redacted authentication failure without leaking server details", async () => {
    const failing = api({
      listProjects: vi.fn(async () => {
        throw new ApiClientError(401, "TOKEN_INVALID", "Bearer super-secret-token");
      })
    });
    render(<DashboardConsole api={failing} />);
    expect(await screen.findByText(/authentication required/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("super-secret-token");
  });

  it("renders the review queue with loading and empty states", async () => {
    const client = api();
    const view = render(<ReviewQueue api={client} />);
    expect(screen.getByText(/loading review queue/i)).toBeInTheDocument();
    expect(await screen.findByText("prp_one")).toBeInTheDocument();
    view.unmount();

    render(<ReviewQueue api={api({ listAllProposals: vi.fn(async () => []) })} />);
    expect(await screen.findByText(/review queue is clear/i)).toBeInTheDocument();
  });

  it("renders approved artifact history without artifact content", async () => {
    render(<ArtifactHistory api={api()} />);
    expect(await screen.findByText("art_1")).toBeInTheDocument();
    expect(screen.getByText("pv_1")).toBeInTheDocument();
    expect(screen.getByText("prp_one")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("approved rule");
  });

  it("approves, rejects, and splits proposal items through review decisions", async () => {
    const reviewProposal = vi.fn(async (_id, input) => ({
      review_id: "rev_action",
      proposal_id: "prp_one",
      decision: input.decision,
      artifact_id: input.decision === "approve" ? "art_two" : null,
      child_proposal_ids: input.decision === "split" ? ["prp_a", "prp_b"] : []
    }));
    render(<ProposalDetail api={api({ reviewProposal })} proposalId="prp_one" />);
    expect(await screen.findByText(".claude/rules/one.md")).toBeInTheDocument();
    expect(screen.getByText(/content is redacted/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(reviewProposal).toHaveBeenCalledWith(
      "prp_one", expect.objectContaining({ decision: "approve" })
    ));
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => expect(reviewProposal).toHaveBeenCalledWith(
      "prp_one", expect.objectContaining({ decision: "reject" })
    ));
    fireEvent.click(screen.getByRole("button", { name: /split/i }));
    await waitFor(() => expect(reviewProposal).toHaveBeenCalledWith(
      "prp_one",
      expect.objectContaining({
        decision: "split",
        split_groups: expect.arrayContaining([
          expect.objectContaining({ item_ids: ["item_one"] }),
          expect.objectContaining({ item_ids: ["item_two"] })
        ])
      })
    ));
  });
});
