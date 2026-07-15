// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SemanticDocument } from "@hunter-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectSemanticPanels } from "../components/project-semantic-panels";
import type { HunterApi } from "../lib/api";

afterEach(cleanup);

describe("ProjectSemanticPanels", () => {
  it("opens on the searchable knowledge library and loads only a focused graph on demand", async () => {
    const knowledge: SemanticDocument = {
      document_id: "sem_one",
      project_id: "prj_one",
      artifact_id: "art_one",
      kind: "knowledge_entry",
      source_path: ".harness/knowledge/entries/active/one.json",
      title: "Architecture boundary",
      body: "Keep the boundary explicit.",
      metadata: { status: "active" },
      content_sha256: "sha256:" + "a".repeat(64)
    };
    const getProjectSemanticGraph = vi.fn(async () => ({
      nodes: [knowledge],
      edges: [],
      focus_document_id: knowledge.document_id,
      relation_status: "no_relations" as const,
      indexed_documents: 1
    }));
    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 1, knowledge: 1, rules: 0, changes: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => [knowledge]),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => []),
      getProjectSemanticGraph,
      searchSemanticDocuments: vi.fn(async () => [{ document: knowledge, project_id: "prj_one" }])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    expect(await screen.findByRole("heading", { name: "Architecture boundary" })).toBeInTheDocument();
    expect(getProjectSemanticGraph).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "关系探索" }));
    await waitFor(() => expect(getProjectSemanticGraph).toHaveBeenCalledWith("prj_one", "sem_one"));
    expect(await screen.findByText("暂未发现可展示的知识关系")).toBeInTheDocument();
  });
});
