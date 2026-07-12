BEGIN;

CREATE TABLE IF NOT EXISTS actors (
  actor_id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS projects (
  project_id text PRIMARY KEY,
  owner_actor_id text NOT NULL REFERENCES actors(actor_id),
  display_name text NOT NULL,
  latest_project_version text,
  latest_artifact_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_bindings (
  actor_id text NOT NULL REFERENCES actors(actor_id),
  local_project_key uuid NOT NULL,
  project_id text NOT NULL REFERENCES projects(project_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, local_project_key)
);

CREATE TABLE IF NOT EXISTS proposal_sessions (
  session_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  base_project_version text,
  base_manifest_hash text NOT NULL,
  operations jsonb NOT NULL,
  scan_overrides jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('open', 'finalized')),
  expires_at timestamptz NOT NULL,
  max_chunk_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id),
  created_by text NOT NULL REFERENCES actors(actor_id),
  base_project_version text,
  base_manifest_hash text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending_review', 'approved', 'rejected', 'needs_evidence', 'split')
  ),
  parent_proposal_id text REFERENCES proposals(proposal_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposal_items (
  item_id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  item_index integer NOT NULL,
  operation jsonb NOT NULL,
  UNIQUE (proposal_id, item_index)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id),
  project_version text NOT NULL UNIQUE,
  base_project_version text,
  proposal_id text NOT NULL REFERENCES proposals(proposal_id),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS base_project_version text;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_latest_artifact_id_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_latest_artifact_id_fkey
  FOREIGN KEY (latest_artifact_id) REFERENCES artifacts(artifact_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS reviews (
  review_id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(proposal_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  decision text NOT NULL CHECK (
    decision IN ('approve', 'reject', 'need_more_evidence', 'split', 'auto-approved')
  ),
  comment text,
  target_scope text NOT NULL,
  artifact_id text REFERENCES artifacts(artifact_id),
  child_proposal_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  project_id text REFERENCES projects(project_id),
  action text NOT NULL,
  target_id text NOT NULL,
  request_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_id text NOT NULL REFERENCES actors(actor_id),
  method text NOT NULL,
  canonical_path text NOT NULL,
  idempotency_key uuid NOT NULL,
  body_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, method, canonical_path, idempotency_key)
);

CREATE INDEX IF NOT EXISTS proposals_project_created_idx
  ON proposals(project_id, created_at DESC, proposal_id DESC);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON proposal_sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_project_created_idx
  ON audit_events(project_id, created_at DESC);

COMMIT;
