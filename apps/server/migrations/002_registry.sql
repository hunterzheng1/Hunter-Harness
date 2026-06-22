CREATE TABLE IF NOT EXISTS registry_state (
  state_id text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE registry_state IS
  'Canonical Skill Registry, versions, proposals, tags, and workflow metadata. Writes remain audited in audit_events.';
