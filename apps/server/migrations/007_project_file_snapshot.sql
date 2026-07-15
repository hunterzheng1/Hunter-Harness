-- MANUAL REVIEW REQUIRED: apply through the normal migration process and verify on a backup first.
-- Materialized current files eliminate browser-side artifact replay and N+1 blob downloads.
BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_files_version text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_file_count integer NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE projects AS project
SET updated_at = COALESCE(
  (SELECT max(artifact.created_at) FROM artifacts AS artifact WHERE artifact.project_id = project.project_id),
  project.created_at
)
WHERE project.updated_at IS NULL;

ALTER TABLE projects ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE projects ALTER COLUMN updated_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS project_files_current (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  path text NOT NULL,
  file_kind text NOT NULL,
  content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  project_version text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE INDEX IF NOT EXISTS project_files_current_project_kind_path_idx
  ON project_files_current(project_id, file_kind, path);

COMMIT;
