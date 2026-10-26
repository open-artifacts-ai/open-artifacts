-- H-DV: delete revokes the install's Google directory grant first, and the
-- owner email of a deleted install is purged after 30 days.
--
-- installs gains the directory revoke state (provision's delete sets it
-- 'pending' or 'skipped'; the scheduler's */2 cron moves 'pending' to 'done',
-- 'unsupported' or 'failed') and owner_email becomes nullable for the purge.
--
-- SQLite can't drop NOT NULL in place, so installs is rebuilt. Foreign keys
-- are on (D1 always enforces them), and dropping a parent table that still
-- has children fails even with deferred constraints. So the two child
-- tables are rebuilt too, pointing at installs_new first: copy installs,
-- move hosts and install_versions onto installs_new, drop the old tables,
-- then rename. Renaming installs_new to installs rewrites the children's
-- REFERENCES to installs (SQLite 3.26+), so every foreign key is intact and
-- enforced at every step. The row_version trigger (0003) is dropped with the
-- old table and recreated. Run it once (it is not re-runnable).

CREATE TABLE installs_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  app_host TEXT NOT NULL UNIQUE,
  content_host TEXT NOT NULL UNIQUE,
  owner_email TEXT,
  d1_id TEXT,
  kv_id TEXT,
  version TEXT,
  previous_version TEXT,
  rl_ns INTEGER NOT NULL UNIQUE CHECK (rl_ns % 8 = 0),
  do_migration_tag TEXT,
  test_hooks INTEGER NOT NULL DEFAULT 0 CHECK (test_hooks IN (0, 1)),
  inputs_hash TEXT NOT NULL,
  broker_kid TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'upgrading', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease TEXT,
  lease_until INTEGER,
  vars TEXT,
  session_cut TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  session_cut_base TEXT,
  session_cut_armed INTEGER NOT NULL DEFAULT 0,
  directory_revoke TEXT CHECK (directory_revoke IN ('pending', 'done', 'unsupported', 'skipped', 'failed')),
  directory_revoked_at INTEGER,
  directory_revoke_attempts INTEGER NOT NULL DEFAULT 0,
  CHECK (app_host <> content_host)
);

INSERT INTO installs_new (id, slug, app_host, content_host, owner_email, d1_id, kv_id, version, previous_version, rl_ns, do_migration_tag, test_hooks, inputs_hash, broker_kid, state, created_at, updated_at, lease, lease_until, vars, session_cut, row_version, session_cut_base, session_cut_armed)
SELECT id, slug, app_host, content_host, owner_email, d1_id, kv_id, version, previous_version, rl_ns, do_migration_tag, test_hooks, inputs_hash, broker_kid, state, created_at, updated_at, lease, lease_until, vars, session_cut, row_version, session_cut_base, session_cut_armed
FROM installs;

CREATE TABLE hosts_new (
  host TEXT NOT NULL PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installs_new (id)
);
INSERT INTO hosts_new (host, install_id) SELECT host, install_id FROM hosts;
DROP TABLE hosts;

CREATE TABLE install_versions_new (
  install_id TEXT NOT NULL REFERENCES installs_new (id),
  version TEXT NOT NULL,
  vars TEXT NOT NULL,
  metadata TEXT NOT NULL,
  do_migration_tag TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (install_id, version)
);
INSERT INTO install_versions_new (install_id, version, vars, metadata, do_migration_tag, updated_at)
SELECT install_id, version, vars, metadata, do_migration_tag, updated_at FROM install_versions;
DROP TABLE install_versions;

DROP TABLE installs;
ALTER TABLE installs_new RENAME TO installs;
ALTER TABLE hosts_new RENAME TO hosts;
ALTER TABLE install_versions_new RENAME TO install_versions;

CREATE TRIGGER IF NOT EXISTS installs_row_version
AFTER UPDATE ON installs
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE installs SET row_version = OLD.row_version + 1 WHERE id = NEW.id;
END;

-- The scheduler's */2 tick reads only these rows.
CREATE INDEX installs_revoke_pending ON installs (id)
WHERE state = 'deleting' AND directory_revoke = 'pending';
