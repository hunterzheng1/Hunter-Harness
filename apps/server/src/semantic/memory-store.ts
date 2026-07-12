import type {
  SemanticDocument,
  SemanticDocumentKind,
  SemanticEdge,
  SemanticIndexBuild,
  SemanticOverview
} from "@hunter-harness/contracts";

import { overviewFromDocuments, type SemanticStore } from "./store.js";

export class SemanticMemoryStore implements SemanticStore {
  private readonly documents = new Map<string, SemanticDocument>();
  private readonly edges = new Map<string, SemanticEdge>();
  private readonly latestArtifactByProject = new Map<string, string>();

  async rebuild(build: SemanticIndexBuild): Promise<void> {
    for (const [documentId, document] of [...this.documents.entries()]) {
      if (document.project_id === build.project_id) {
        this.documents.delete(documentId);
      }
    }
    for (const [edgeId, edge] of [...this.edges.entries()]) {
      if (edge.project_id === build.project_id) {
        this.edges.delete(edgeId);
      }
    }
    for (const document of build.documents) {
      this.documents.set(document.document_id, document);
    }
    for (const edge of build.edges) {
      this.edges.set(edge.edge_id, edge);
    }
    this.latestArtifactByProject.set(build.project_id, build.artifact_id);
  }

  async overview(projectId: string): Promise<SemanticOverview> {
    const documents = await this.listByKinds(projectId, [
      "knowledge_entry",
      "knowledge_markdown",
      "rule",
      "archive_record",
      "agent_instruction"
    ]);
    return overviewFromDocuments(
      projectId,
      await this.latestArtifactId(projectId),
      documents,
      await this.listEdges(projectId)
    );
  }

  async listByKinds(
    projectId: string,
    kinds: readonly SemanticDocumentKind[]
  ): Promise<SemanticDocument[]> {
    const allowed = new Set(kinds);
    return [...this.documents.values()]
      .filter((document) => document.project_id === projectId && allowed.has(document.kind))
      .sort((left, right) => left.source_path.localeCompare(right.source_path));
  }

  async listEdges(projectId: string): Promise<SemanticEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.project_id === projectId)
      .sort((left, right) => left.edge_id.localeCompare(right.edge_id));
  }

  async latestArtifactId(projectId: string): Promise<string | null> {
    return this.latestArtifactByProject.get(projectId) ?? null;
  }

  async search(query: string, projectId?: string): Promise<SemanticDocument[]> {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return [...this.documents.values()]
      .filter((document) => projectId === undefined || document.project_id === projectId)
      .filter((document) =>
        document.title.toLowerCase().includes(needle) ||
        document.body.toLowerCase().includes(needle) ||
        document.source_path.toLowerCase().includes(needle)
      )
      .sort((left, right) => left.title.localeCompare(right.title));
  }
}
