import type { SemanticDocument, SemanticEdge, SemanticIndexBuild } from "@hunter-harness/contracts";

export class SemanticMemoryStore {
  private readonly documents = new Map<string, SemanticDocument>();
  private readonly edges = new Map<string, SemanticEdge>();
  private readonly latestArtifactByProject = new Map<string, string>();

  rebuild(build: SemanticIndexBuild): void {
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

  listDocuments(projectId: string): SemanticDocument[] {
    return [...this.documents.values()]
      .filter((document) => document.project_id === projectId)
      .sort((left, right) => left.source_path.localeCompare(right.source_path));
  }

  listEdges(projectId: string): SemanticEdge[] {
    return [...this.edges.values()]
      .filter((edge) => edge.project_id === projectId)
      .sort((left, right) => left.edge_id.localeCompare(right.edge_id));
  }

  latestArtifactId(projectId: string): string | null {
    return this.latestArtifactByProject.get(projectId) ?? null;
  }

  search(query: string, projectId?: string): SemanticDocument[] {
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
