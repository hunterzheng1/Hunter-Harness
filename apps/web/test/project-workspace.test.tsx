// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectWorkspace } from "../components/project-workspace";
import type { ArtifactManifestModel, HunterApi } from "../lib/api";

const sha = (character: string) => "sha256:" + character.repeat(64);

const manifest: ArtifactManifestModel = {
  schema_version: 1,
  project_id: "prj_one",
  project_version: "pv_one",
  artifact_id: "art_one",
  manifest_sha256: sha("a"),
  files: [
    {
      operation: "add",
      path: ".harness/knowledge/architecture.md",
      file_kind: "user_editable",
      content_sha256: sha("b"),
      size_bytes: 12
    },
    {
      operation: "add",
      path: ".harness/state/local/status.json",
      file_kind: "internal_state",
      content_sha256: sha("c"),
      size_bytes: 2
    }
  ]
};

afterEach(cleanup);

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    getDashboardOverview: vi.fn(async () => { throw new Error("dashboard snapshot is not used by this test"); }),
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => ({
      project_id: "prj_one",
      display_name: "Payments",
      role: "owner" as const,
      latest_project_version: "pv_one",
      latest_artifact_id: "art_one",
      created_at: "2026-06-20T00:00:00Z",
      request_id: "req_one"
    })),
    listProjectProposals: vi.fn(async () => []),
    listAllProposals: vi.fn(async () => []),
    listProjectArtifacts: vi.fn(async () => [{
      artifact_id: "art_one",
      project_id: "prj_one",
      project_version: "pv_one",
      base_project_version: null,
      proposal_id: "prp_one",
      changed_item_count: 2,
      manifest_sha256: sha("a"),
      created_at: "2026-06-20T00:00:00Z"
    }]),
    listAllArtifacts: vi.fn(async () => []),
    getArtifactManifest: vi.fn(async () => manifest),
    getArtifactText: vi.fn(async (_artifactId, contentHash) =>
      contentHash === sha("b") ? "# Architecture" : "{}"
    ),
    createProjectFileProposal: vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "pending_review" as const,
      received_files: 1
    })),
    getProposal: vi.fn(async () => { throw new Error("not used"); }),
    reviewProposal: vi.fn(async () => { throw new Error("not used"); }),
    ...overrides
  };
}

describe("ProjectWorkspace", () => {
  it("reconstructs managed files and submits an editable change as a review proposal", async () => {
    const createProjectFileProposal = vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "pending_review" as const,
      received_files: 1
    }));
    render(<ProjectWorkspace api={api({ createProjectFileProposal })} projectId="prj_one" />);

    expect(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ".harness/knowledge/architecture.md" }));
    expect(screen.getByText("diff-proposal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /edit current file/i }));
    fireEvent.change(screen.getByLabelText(/draft content/i), { target: { value: "# Revised architecture" } });
    fireEvent.click(screen.getByRole("button", { name: /create review proposal/i }));

    await waitFor(() => expect(createProjectFileProposal).toHaveBeenCalledWith(expect.objectContaining({
      action: "modify",
      path: ".harness/knowledge/architecture.md",
      content: "# Revised architecture",
      baseProjectVersion: "pv_one",
      baseManifestHash: sha("a")
    })));
    expect(await screen.findByText(/proposal prp_new is pending review/i)).toBeInTheDocument();
  });

  it("shows the bound workflow family and profile", async () => {
    render(<ProjectWorkspace api={api({
      listWorkflowFamilies: vi.fn(async () => [{
        family_id: "wff_review",
        slug: "review",
        displayName: "Review",
        description: "Review workflow family",
        tags: ["review"],
        latest_version: "1.0.0",
        required_profiles: ["general"],
        revision: 1,
        npmReleases: [],
        created_at: "2026-06-20T00:00:00Z",
        updated_at: "2026-06-20T00:00:00Z"
      }]),
      getProjectWorkflowBinding: vi.fn(async () => ({
        project_id: "prj_one",
        family_slug: "review",
        profile: "general",
        version: "1.0.0",
        revision: 1,
        updated_at: "2026-06-20T00:00:00Z"
      }))
    })} projectId="prj_one" />);

    expect(await screen.findByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Bound workflow family" })).toHaveValue("review:general");
  });

  it("keeps protocol-only paths inspectable but never editable", async () => {
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);

    expect(await screen.findByRole("button", { name: ".harness/state/local/status.json" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ".harness/state/local/status.json" }));
    expect(screen.getByText(/only the protocol layer can write this path/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit current file/i })).not.toBeInTheDocument();
  });
});
