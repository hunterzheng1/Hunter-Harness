import type {
  SemanticDocument,
  SemanticDocumentKind,
  SemanticEdge,
  SemanticIndexBuild,
  SemanticOverview
} from "@hunter-harness/contracts";
import type { Pool } from "pg";

import { overviewFromDocuments, type SemanticStore } from "./store.js";

function documentFromRow(row: Record<string, unknown>): SemanticDocument {
  return {
    document_id: String(row.document_id),
    project_id: String(row.project_id),
    artifact_id: String(row.artifact_id),
    kind: String(row.kind) as SemanticDocumentKind,
    source_path: String(row.source_path),
    title: String(row.title),
    body: String(row.body),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    content_sha256: String(row.content_sha256)
  };
}

function edgeFromRow(row: Record<string, unknown>): SemanticEdge {
  return {
    edge_id: String(row.edge_id),
    project_id: String(row.project_id),
    artifact_id: String(row.artifact_id),
    from_document_id: String(row.from_document_id),
    to_document_id: String(row.to_document_id),
    kind: String(row.kind) as SemanticEdge["kind"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>
  };
}

export class PgSemanticStore implements SemanticStore {
  constructor(private readonly pool: Pool) {}

  async rebuild(build: SemanticIndexBuild): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM semantic_edges WHERE project_id = $1", [build.project_id]);
      await client.query("DELETE FROM semantic_documents WHERE project_id = $1", [build.project_id]);
      for (const document of build.documents) {
        await client.query(
          `INSERT INTO semantic_documents(
             document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [
            document.document_id,
            document.project_id,
            document.artifact_id,
            document.kind,
            document.source_path,
            document.title,
            document.body,
            JSON.stringify(document.metadata),
            document.content_sha256
          ]
        );
      }
      for (const edge of build.edges) {
        await client.query(
          `INSERT INTO semantic_edges(
             edge_id, project_id, artifact_id, from_document_id, to_document_id, kind, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            edge.edge_id,
            edge.project_id,
            edge.artifact_id,
            edge.from_document_id,
            edge.to_document_id,
            edge.kind,
            JSON.stringify(edge.metadata)
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async overview(projectId: string): Promise<SemanticOverview> {
    const documents = await this.listByKinds(projectId, [
      "knowledge_entry",
      "knowledge_markdown",
      "rule",
      "archive_change",
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
    if (kinds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
       FROM semantic_documents
       WHERE project_id = $1 AND kind = ANY($2::text[])
       ORDER BY source_path ASC`,
      [projectId, [...kinds]]
    );
    return result.rows.map((row) => documentFromRow(row as Record<string, unknown>));
  }

  async listEdges(projectId: string): Promise<SemanticEdge[]> {
    const result = await this.pool.query(
      `SELECT edge_id, project_id, artifact_id, from_document_id, to_document_id, kind, metadata
       FROM semantic_edges
       WHERE project_id = $1
       ORDER BY edge_id ASC`,
      [projectId]
    );
    return result.rows.map((row) => edgeFromRow(row as Record<string, unknown>));
  }

  async latestArtifactId(projectId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT artifact_id FROM semantic_documents WHERE project_id = $1 LIMIT 1`,
      [projectId]
    );
    const row = result.rows[0] as { artifact_id?: string } | undefined;
    return row?.artifact_id ?? null;
  }

  async search(query: string, projectId?: string): Promise<SemanticDocument[]> {
    const needle = query.trim();
    if (needle === "") return [];
    const result = projectId === undefined
      ? await this.pool.query(
        `SELECT document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
         FROM semantic_documents
         WHERE search_vector @@ plainto_tsquery('simple', $1)
         ORDER BY title ASC
         LIMIT 100`,
        [needle]
      )
      : await this.pool.query(
        `SELECT document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
         FROM semantic_documents
         WHERE project_id = $2 AND search_vector @@ plainto_tsquery('simple', $1)
         ORDER BY title ASC
         LIMIT 100`,
        [needle, projectId]
      );
    return result.rows.map((row) => documentFromRow(row as Record<string, unknown>));
  }
}
