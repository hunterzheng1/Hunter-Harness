-- MANUAL REVIEW REQUIRED: apply through the normal migration process and verify on a backup first.
-- Project recycle-bin lifecycle; nullable timestamps preserve existing rows.
BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS purged_at timestamptz;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_lifecycle_state_check;
ALTER TABLE projects ADD CONSTRAINT projects_lifecycle_state_check
  CHECK (lifecycle_state IN ('active', 'archived', 'purged'));

CREATE INDEX IF NOT EXISTS projects_owner_lifecycle_created_idx
  ON projects(owner_actor_id, lifecycle_state, created_at DESC, project_id DESC);

CREATE INDEX IF NOT EXISTS projects_archived_purge_after_idx
  ON projects(purge_after, project_id)
  WHERE lifecycle_state = 'archived';

COMMIT;
