-- Provisioning API: the signup queue, for admin and self-serve creates
-- (#859's 0007, amended before pinning).
-- signups: one row per signup; signup_id equals the first create job's id.
-- Status walks pending | waiting_cap -> queued -> creating -> ready | failed.
-- admitted_at is set when it is admitted (the self-serve daily cap counts a
-- UTC day's self-serve admitted_at only). install_id is set once the install
-- exists. vars is canonical JSON (AUTH_PROVIDERS, AUTH_DOMAINS, TIER and
-- optionally TEST_DOMAIN), never an email. welcome_claimed_at and
-- welcome_sent_at make the welcome email send once.
-- signup_secret: the owner's email, kept apart from the queue row and
-- removed when the create is done.
-- Additive only. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS signups (
  signup_id TEXT NOT NULL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('admin', 'self-serve')),
  owner_sub TEXT,
  slug TEXT NOT NULL,
  install_id TEXT UNIQUE,
  job_id TEXT NOT NULL,
  vars TEXT NOT NULL,
  version TEXT,
  test_hooks INTEGER NOT NULL DEFAULT 0 CHECK (test_hooks IN (0, 1)),
  send_welcome INTEGER NOT NULL DEFAULT 0 CHECK (send_welcome IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'waiting_cap', 'creating', 'ready', 'failed')),
  admitted_at INTEGER,
  welcome_claimed_at INTEGER,
  welcome_sent_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (source = 'admin' OR owner_sub IS NOT NULL)
);
-- Abort on #859's older signups shape (IF NOT EXISTS would keep it): no such column.
SELECT source, job_id, vars, version, test_hooks, send_welcome FROM signups LIMIT 0;
CREATE TABLE IF NOT EXISTS signup_secret (
  signup_id TEXT NOT NULL PRIMARY KEY,
  owner_email TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signups_admitted_at ON signups (source, admitted_at);
-- A slug is held by one live signup; a failed one frees it.
CREATE UNIQUE INDEX IF NOT EXISTS signups_live_slug ON signups (slug) WHERE status <> 'failed';
CREATE INDEX IF NOT EXISTS signups_owner ON signups (owner_sub) WHERE owner_sub IS NOT NULL;
