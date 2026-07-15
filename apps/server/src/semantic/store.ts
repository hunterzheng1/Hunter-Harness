import type {
  SemanticDocument,
  SemanticDocumentKind,
  SemanticEdge,
  SemanticIndexBuild,
  SemanticOverview
} from "@hunter-harness/contracts";

export interface SemanticStore {
  rebuild(build: SemanticIndexBuild): Promise<void>;
  overview(projectId: string): Promise<SemanticOverview>;
  listByKinds(projectId: string, kinds: readonly SemanticDocumentKind[]): Promise<SemanticDocument[]>;
  listEdges(projectId: string): Promise<SemanticEdge[]>;
  graph(projectId: string, focusDocumentId?: string): Promise<{
    nodes: SemanticDocument[];
    edges: SemanticEdge[];
  }>;
  deleteProject(projectId: string): Promise<void>;
  search(query: string, projectId?: string): Promise<SemanticDocument[]>;
  latestArtifactId(projectId: string): Promise<string | null>;
}

export function overviewFromDocuments(
  projectId: string,
  artifactId: string | null,
  documents: readonly SemanticDocument[],
  edges: readonly SemanticEdge[]
): SemanticOverview {
  const kindCount = (kind: SemanticDocumentKind): number =>
    documents.filter((document) => document.kind === kind).length;
  return {
    project_id: projectId,
    artifact_id: artifactId,
    counts: {
      documents: documents.length,
      knowledge: kindCount("knowledge_entry") + kindCount("knowledge_markdown"),
      rules: kindCount("rule"),
      changes: kindCount("archive_record"),
      agent_instructions: kindCount("agent_instruction"),
      edges: edges.length
    }
  };
}
