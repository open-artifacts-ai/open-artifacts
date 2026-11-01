-- prod oa-p-platform as read by the user on 2026-11-01, before its first
-- platform-db run: DDL only (no rows), exactly as sqlite_master holds it.
-- sqlite_sequence comes from d1_migrations' AUTOINCREMENT.
CREATE TABLE _cf_KV ( key TEXT PRIMARY KEY, value BLOB ) WITHOUT ROWID;
CREATE TABLE "d1_migrations"( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL );
CREATE TABLE hosted_audit ( id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, install_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT , actor TEXT);
CREATE TABLE hosts ( host TEXT NOT NULL PRIMARY KEY, install_id TEXT NOT NULL REFERENCES installs (id) );
CREATE TABLE install_versions ( install_id TEXT NOT NULL REFERENCES installs (id), version TEXT NOT NULL, vars TEXT NOT NULL, metadata TEXT NOT NULL, do_migration_tag TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (install_id, version) );
CREATE TABLE installs ( id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, app_host TEXT NOT NULL UNIQUE, content_host TEXT NOT NULL UNIQUE, owner_email TEXT NOT NULL, d1_id TEXT, kv_id TEXT, version TEXT, previous_version TEXT, rl_ns INTEGER NOT NULL UNIQUE CHECK (rl_ns % 8 = 0), do_migration_tag TEXT, test_hooks INTEGER NOT NULL DEFAULT 0 CHECK (test_hooks IN (0, 1)), inputs_hash TEXT NOT NULL, broker_kid TEXT, state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'upgrading', 'deleting', 'deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER, vars TEXT, session_cut TEXT, row_version INTEGER NOT NULL DEFAULT 0, session_cut_base TEXT, session_cut_armed INTEGER NOT NULL DEFAULT 0, directory_revoke TEXT CHECK (directory_revoke IN ('pending', 'done', 'unsupported', 'skipped', 'failed')), directory_revoked_at INTEGER, directory_revoke_attempts INTEGER NOT NULL DEFAULT 0, directory_revoke_requested_at INTEGER, CHECK (app_host <> content_host) );
CREATE TABLE release_floor ( id INTEGER PRIMARY KEY CHECK (id = 1), floor_seq INTEGER NOT NULL CHECK (floor_seq >= 0) );
CREATE INDEX installs_revoke_pending ON installs (id) WHERE state = 'deleting' AND directory_revoke = 'pending';
CREATE TRIGGER hosted_audit_no_delete BEFORE DELETE ON hosted_audit BEGIN SELECT RAISE(ABORT, 'hosted_audit is append-only'); END;
CREATE TRIGGER hosted_audit_no_update BEFORE UPDATE ON hosted_audit BEGIN SELECT RAISE(ABORT, 'hosted_audit is append-only'); END;
CREATE TRIGGER installs_row_version AFTER UPDATE ON installs WHEN NEW.row_version = OLD.row_version BEGIN UPDATE installs SET row_version = OLD.row_version + 1 WHERE id = NEW.id; END;
INSERT INTO d1_migrations (id, name, applied_at) VALUES (1, '0001_installs.sql', '2026-10-28 16:08:52');
INSERT INTO d1_migrations (id, name, applied_at) VALUES (2, '0002_release_floor.sql', '2026-10-28 16:08:52');
INSERT INTO d1_migrations (id, name, applied_at) VALUES (3, '0003_lifecycle.sql', '2026-10-28 16:08:52');
INSERT INTO d1_migrations (id, name, applied_at) VALUES (4, '0004_audit_actor.sql', '2026-10-28 16:08:52');
INSERT INTO d1_migrations (id, name, applied_at) VALUES (5, '0005_directory_revoke.sql', '2026-10-28 16:08:52');
