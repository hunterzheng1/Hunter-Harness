// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactDetail } from "../components/artifact-detail";
import type { ArtifactManifestModel, HunterApi } from "../lib/api";

const sha = (character: string) => "sha256:" + character.repeat(64);

const firstManifest: ArtifactManifestModel = {
  schema_version: 1,
  project_id: "prj_one",
  project_version: "pv_one",
  artifact_id: "art_one",
  manifest_sha256: sha("a"),
  files: [{
    operation: "add",
    path: ".harness/knowledge/architecture.md",
    file_kind: "user_editable",
    content_sha256: sha("b"),
    size_bytes: 5
  }]
};
const secondManifest: ArtifactManifestModel = {
  schema_version: 1,
  project_id: "prj_one",
  project_version: "pv_two",
  artifact_id: "art_two",
  manifest_sha256: sha("c"),
  files: [{
    operation: "modify",
    path: ".harness/knowledge/architecture.md",
    file_kind: "user_editable",
    base_content_sha256: sha("b"),
    content_sha256: sha("d"),
    size_bytes: 5
  }]
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
      latest_project_version: "pv_two",
      latest_artifact_id: "art_two",
      created_at: "2026-06-20T00:00:00Z",
      request_id: "req_one"
    })),
    listProjectProposals: vi.fn(async () => []),
    listAllProposals: vi.fn(async () => []),
    listProjectArtifacts: vi.fn(async () => [
      { artifact_id: "art_two", project_id: "prj_one", project_version: "pv_two", base_project_version: "pv_one", proposal_id: "prp_two", changed_item_count: 1, manifest_sha256: sha("c"), created_at: "2026-06-21T00:00:00Z" },
      { artifact_id: "art_one", project_id: "prj_one", project_version: "pv_one", base_project_version: null, proposal_id: "prp_one", changed_item_count: 1, manifest_sha256: sha("a"), created_at: "2026-06-20T00:00:00Z" }
    ]),
    listAllArtifacts: vi.fn(async () => []),
    getArtifactManifest: vi.fn(async (id) => id === "art_two" ? secondManifest : firstManifest),
    getArtifactText: vi.fn(async (_id, hash) => hash === sha("b") ? "first" : "second"),
    createProjectFileProposal: vi.fn(async () => ({ proposal_id: "prp_rollback", status: "pending_review" as const, received_files: 1 })),
    getProposal: vi.fn(async () => { throw new Error("not used"); }),
    reviewProposal: vi.fn(async () => { throw new Error("not used"); }),
    ...overrides
  };
}

describe("ArtifactDetail", () => {
  it("shows a manifest, integrity metadata, file diff, and a review-gated rollback for the latest artifact", async () => {
    const createProjectFileProposal = vi.fn(async () => ({ proposal_id: "prp_rollback", status: "pending_review" as const, received_files: 1 }));
    render(<ArtifactDetail api={api({ createProjectFileProposal })} artifactId="art_two" />);

    expect(await screen.findByRole("heading", { name: "art_two" })).toBeInTheDocument();
    expect(screen.getByText("manifest sha-256")).toBeInTheDocument();
    expect([...document.querySelectorAll("pre")].some((node) =>
      node.textContent?.includes("- first\n+ second")
    )).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /propose rollback/i }));

    await waitFor(() => expect(createProjectFileProposal).toHaveBeenCalledWith(expect.objectContaining({
      action: "modify",
      path: ".harness/knowledge/architecture.md",
      baseContentHash: sha("d"),
      content: "first",
      baseProjectVersion: "pv_two",
      baseManifestHash: sha("c")
    })));
    expect(await screen.findByText(/rollback proposal prp_rollback is pending review/i)).toBeInTheDocument();
  });
});
