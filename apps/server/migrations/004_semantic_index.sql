-- Semantic index: rebuildable derivative of project artifact managed files.
CREATE TABLE IF NOT EXISTS semantic_documents (
  document_id text PRIMARY KEY,
  project_id text NOT NULL,
  artifact_id text NOT NULL,
  kind text NOT NULL,
  source_path text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_sha256 text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_documents_project_idx
  ON semantic_documents (project_id, artifact_id);

CREATE INDEX IF NOT EXISTS semantic_documents_search_idx
  ON semantic_documents USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS semantic_edges (
  edge_id text PRIMARY KEY,
  project_id text NOT NULL,
  artifact_id text NOT NULL,
  from_document_id text NOT NULL REFERENCES semantic_documents(document_id) ON DELETE CASCADE,
  to_document_id text NOT NULL REFERENCES semantic_documents(document_id) ON DELETE CASCADE,
  kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_edges_project_idx
  ON semantic_edges (project_id, artifact_id);

COMMENT ON TABLE semantic_documents IS
  'Rebuildable semantic documents derived from the latest project artifact managed files.';

COMMENT ON TABLE semantic_edges IS
  'Relationships between semantic documents for graph and navigation surfaces.';
