// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectWorkspace } from "../components/project-workspace";
import type { HunterApi, ProjectFileContent, ProjectFileMetadata } from "../lib/api";

const sha = (character: string) => "sha256:" + character.repeat(64);
const files: ProjectFileMetadata[] = [
  {
    path: ".harness/knowledge/architecture.md",
    file_kind: "user_editable",
    content_sha256: sha("b"),
    size_bytes: 12,
    project_version: "pv_one",
    updated_at: "2026-06-20T00:00:00Z"
  },
  {
    path: ".harness/state/local/status.json",
    file_kind: "internal_state",
    content_sha256: sha("c"),
    size_bytes: 2,
    project_version: "pv_one",
    updated_at: "2026-06-20T00:00:00Z"
  }
];

afterEach(cleanup);

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    getDashboardOverview: vi.fn(async () => { throw new Error("not used"); }),
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => ({
      project_id: "prj_one",
      display_name: "Payments",
      role: "owner" as const,
      latest_project_version: "pv_one",
      latest_artifact_id: "art_one",
      current_file_count: 2,
      updated_at: "2026-06-20T00:00:00Z",
      created_at: "2026-06-20T00:00:00Z",
      request_id: "req_one"
    })),
    listProjectFiles: vi.fn(async () => ({
      project_id: "prj_one",
      project_version: "pv_one",
      total: 2,
      items: files
    })),
    getProjectFileContent: vi.fn(async (_projectId, path) => ({
      ...(files.find((file) => file.path === path) ?? files[0] as ProjectFileMetadata),
      project_id: "prj_one",
      content: path.endsWith(".md") ? "# Architecture" : "{}"
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
    getArtifactManifest: vi.fn(async () => { throw new Error("browser artifact replay must not run"); }),
    getArtifactText: vi.fn(async () => { throw new Error("browser artifact replay must not run"); }),
    createProjectFileProposal: vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "approved" as const,
      artifact_id: "art_two",
      received_files: 1
    })),
    getProposal: vi.fn(async () => { throw new Error("not used"); }),
    ...overrides
  };
}

describe("ProjectWorkspace", () => {
  it("loads only file metadata, then saves an edit directly", async () => {
    const getProjectFileContent = vi.fn(async (_projectId: string, path: string) => ({
      ...(files.find((file) => file.path === path) ?? files[0] as ProjectFileMetadata),
      project_id: "prj_one",
      content: "# Architecture"
    }));
    const createProjectFileProposal = vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "approved" as const,
      artifact_id: "art_two",
      received_files: 1
    }));
    render(<ProjectWorkspace api={api({ getProjectFileContent, createProjectFileProposal })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "文件" }));
    expect(getProjectFileContent).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" }));
    expect(await screen.findByText("# Architecture")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "# Revised architecture" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(createProjectFileProposal).toHaveBeenCalledWith(expect.objectContaining({
      action: "modify",
      path: ".harness/knowledge/architecture.md",
      content: "# Revised architecture",
      baseProjectVersion: "pv_one",
      baseArtifactId: "art_one",
      baseManifestHash: sha("a")
    })));
    expect(await screen.findByText(/文件已保存并生成新版本/)).toBeInTheDocument();
  });

  it("keeps system paths visible but read-only", async () => {
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: ".harness/state/local/status.json" }));
    expect((await screen.findAllByText("系统只读")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("keeps edit and rename disabled until lazy content is available", async () => {
    let release: (() => void) | undefined;
    const getProjectFileContent = vi.fn((_projectId: string, path: string) =>
      new Promise<ProjectFileContent>((resolve) => {
        release = () => resolve({
          ...(files.find((file) => file.path === path) ?? files[0] as ProjectFileMetadata),
          project_id: "prj_one",
          content: "# Architecture"
        });
      })
    );
    render(<ProjectWorkspace api={api({ getProjectFileContent })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" }));
    expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();

    release?.();
    expect(await screen.findByText("# Architecture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重命名" })).toBeEnabled();
  });

  it("keeps directories collapsed by default until expanded", async () => {
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);
    fireEvent.click(await screen.findByRole("tab", { name: "文件" }));

    const harness = await screen.findByText(".harness");
    const details = harness.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("2 项")).toBeInTheDocument();

    fireEvent.click(harness);
    await waitFor(() => expect(details).toHaveAttribute("open"));
    expect(screen.getByText("knowledge")).toBeInTheDocument();
  });

  it("shows human version bases and paginates dense change sets", async () => {
    const manyFiles = Array.from({ length: 45 }, (_, index) => ({
      operation: (index % 2 === 0 ? "add" : "modify") as "add" | "modify",
      path: `.harness/knowledge/entries/active/item-${String(index).padStart(2, "0")}.json`,
      file_kind: "user_editable" as const,
      ...(index % 2 === 0
        ? { content_sha256: sha("d"), size_bytes: 40 }
        : {
          base_content_sha256: sha("b"),
          content_sha256: sha("c"),
          size_bytes: 12
        })
    }));
    const getArtifactManifest = vi.fn(async () => ({
      schema_version: 1 as const,
      project_id: "prj_one",
      project_version: "pv_two",
      artifact_id: "art_two",
      manifest_sha256: sha("a"),
      files: manyFiles
    }));
    render(<ProjectWorkspace api={api({
      listProjectArtifacts: vi.fn(async () => [
        {
          artifact_id: "art_two",
          project_id: "prj_one",
          project_version: "pv_two",
          base_project_version: "pv_one",
          proposal_id: "prp_two",
          changed_item_count: 45,
          manifest_sha256: sha("a"),
          created_at: "2026-06-21T00:00:00Z"
        },
        {
          artifact_id: "art_one",
          project_id: "prj_one",
          project_version: "pv_one",
          base_project_version: null,
          proposal_id: "prp_one",
          changed_item_count: 2,
          manifest_sha256: sha("a"),
          created_at: "2026-06-20T00:00:00Z"
        }
      ]),
      getArtifactManifest
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "版本记录" }));
    expect(await screen.findByText(/基于版本 1/)).toBeInTheDocument();
    expect(screen.queryByText(/pv_/)).not.toBeInTheDocument();

    const viewButton = screen.getAllByRole("button", { name: "查看变更" })[0];
    if (viewButton === undefined) throw new Error("expected view-changes button");
    fireEvent.click(viewButton);
    expect(await screen.findByText("第 1/3 页 · 45 条")).toBeInTheDocument();
    expect(screen.getByText(".harness/knowledge/entries/active/item-00.json")).toBeInTheDocument();
    expect(screen.queryByText(".harness/knowledge/entries/active/item-20.json")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第 2/3 页 · 45 条")).toBeInTheDocument();
    expect(screen.getByText(".harness/knowledge/entries/active/item-20.json")).toBeInTheDocument();
    expect(getArtifactManifest).toHaveBeenCalledWith("art_two");
  });
});
