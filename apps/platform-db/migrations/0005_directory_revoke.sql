-- H-DV: delete revokes the install's Google directory grant first.
--
-- provision's delete sets directory_revoke to 'pending' (or 'skipped'), and
-- the scheduler's */2 cron moves 'pending' to 'done', 'unsupported' or
-- 'failed'. owner_email is unchanged (NOT NULL): the 30-day purge of a
-- deleted install writes '' (names.ts PURGED_EMAIL), never NULL.
-- Not re-runnable (ADD COLUMN): check PRAGMA table_info(installs) first.
ALTER TABLE installs ADD COLUMN directory_revoke TEXT CHECK (directory_revoke IN ('pending', 'done', 'unsupported', 'skipped', 'failed'));
ALTER TABLE installs ADD COLUMN directory_revoked_at INTEGER;
ALTER TABLE installs ADD COLUMN directory_revoke_attempts INTEGER NOT NULL DEFAULT 0;
-- When this delete attempt began: a done older than it is stale, so it
-- never unlocks teardown (provision sets it, and compares directory_revoked_at).
ALTER TABLE installs ADD COLUMN directory_revoke_requested_at INTEGER;

-- The scheduler's */2 tick reads only these rows.
CREATE INDEX installs_revoke_pending ON installs (id)
WHERE state = 'deleting' AND directory_revoke = 'pending';
