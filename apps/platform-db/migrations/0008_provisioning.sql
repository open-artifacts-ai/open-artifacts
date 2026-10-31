-- Provisioning API (design v7 section 8.3): jobs, install lifecycle, audit,
-- sessions, agent tokens, MCP client bookkeeping, D1 rate counters,
-- self-serve account claims, prod-clean reports, the migration tracker and
-- the install_status view. Times are epoch milliseconds. No customer data;
-- emails only in sessions and agent_tokens (the signed-in admin).
-- Additive only. Re-runnable (IF NOT EXISTS, INSERT OR IGNORE).

-- One row per accepted API write. body_hash is the sha256 of the canonical
-- {route, installId, body}; args is JSON {version, from, to, reason}, never an
-- email. sealed holds redline_creds ciphertext and is cleared on first read.
-- error_message is redacted and at most 300 characters.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'retry', 'upgrade', 'rollback', 'suspend', 'resume', 'delete', 'restore', 'purge', 'discard', 'release_lease', 'cleanup', 'redline_creds', 'update')),
  workflow TEXT NOT NULL CHECK (workflow IN ('provision_install', 'manage_install', 'none')),
  install_id TEXT NOT NULL,
  signup_id TEXT,
  -- cleanup: the job it compensates.
  parent_job_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'token', 'user', 'oidc', 'system')),
  -- admin:<email> | token:<id> | user:<sub> | oidc:<repo id> | system:<name>
  actor_key TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  token_id TEXT,
  request_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  step TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  retry_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  sealed TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (actor_key, request_id)
);
-- At most one queued or running job per install.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs (install_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_install ON jobs (install_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_open ON jobs (status, updated_at) WHERE status IN ('queued', 'running');

-- API-side lifecycle of every install. No foreign key: written before the
-- installs row exists. serving_mode is what the provisioner last wrote to
-- HOSTS.
CREATE TABLE IF NOT EXISTS install_lifecycle (
  install_id TEXT NOT NULL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('admin', 'self-serve')),
  owner_sub TEXT,
  tier TEXT CHECK (tier IN ('trial', 'team', 'business')),
  suspended_at INTEGER,
  suspend_reason TEXT,
  deleted_at INTEGER,
  purge_at INTEGER,
  discarded_at INTEGER,
  serving_mode TEXT CHECK (serving_mode IN ('serving', 'paused', 'closed', 'unmapped')),
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('ok', 'failing', 'unknown')),
  health_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((deleted_at IS NULL) = (purge_at IS NULL))
);
CREATE INDEX IF NOT EXISTS lifecycle_purge ON install_lifecycle (purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS lifecycle_owner ON install_lifecycle (owner_sub) WHERE owner_sub IS NOT NULL;

-- Append-only: one row per authenticated principal action (design 4.9).
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_label TEXT,
  token_id TEXT,
  action TEXT NOT NULL,
  install_id TEXT,
  job_id TEXT,
  request_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused', 'error')),
  code TEXT,
  ip_hmac TEXT,
  email_hmac TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at);
CREATE INDEX IF NOT EXISTS admin_audit_install ON admin_audit (install_id, at);
CREATE INDEX IF NOT EXISTS admin_audit_action ON admin_audit (action, at);

CREATE TRIGGER IF NOT EXISTS admin_audit_no_update
BEFORE UPDATE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'admin_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete
BEFORE DELETE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'admin_audit is append-only');
END;

-- Pre-authn and unauthenticated refusals, aggregated: one row per bucket,
-- code, IP HMAC and 10-minute window. Prunable (no triggers).
CREATE TABLE IF NOT EXISTS audit_refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  code TEXT NOT NULL,
  ip_hmac TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (bucket, code, ip_hmac, window_start)
);
CREATE INDEX IF NOT EXISTS audit_refusals_at ON audit_refusals (window_start);

-- Admin and self-serve sessions, by the hash of the session id.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('admin', 'user')),
  host TEXT NOT NULL,
  email TEXT NOT NULL,
  sub TEXT NOT NULL,
  auth_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- Agent tokens: oat (minted in the panel, by hash) and oauth (an MCP grant;
-- the library holds the token, this row the bookkeeping). oauth_user is the
-- library userId (adm_<hex>), never an email; grant_id is set at code
-- exchange.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oat', 'oauth')),
  token_hash TEXT UNIQUE,
  session_hash TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes TEXT NOT NULL,
  client_id TEXT,
  client_name TEXT,
  oauth_user TEXT,
  grant_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  CHECK ((kind = 'oat') = (token_hash IS NOT NULL)),
  CHECK ((kind = 'oauth') = (client_id IS NOT NULL AND oauth_user IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_tokens_admin ON agent_tokens (admin_email, expires_at);
CREATE INDEX IF NOT EXISTS agent_tokens_session ON agent_tokens (session_hash);
CREATE INDEX IF NOT EXISTS agent_tokens_client ON agent_tokens (admin_email, client_id) WHERE kind = 'oauth' AND revoked_at IS NULL;

-- MCP dynamic client registration bookkeeping; the library keeps the client
-- itself in OAUTH_KV. client_name is sanitized; redirect_hosts is a JSON
-- array of hosts, loopback as "loopback". Unclaimed clients are swept after
-- 24 h.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT NOT NULL PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_hosts TEXT NOT NULL,
  ip_hmac TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  first_grant_at INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_clients_unclaimed ON oauth_clients (registered_at) WHERE first_grant_at IS NULL;

-- Fixed-window D1 counters (atomic upsert RETURNING count).
CREATE TABLE IF NOT EXISTS rate_counters (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- One self-serve install per Google account; freed_at releases the claim.
CREATE TABLE IF NOT EXISTS signup_accounts (
  owner_sub TEXT NOT NULL PRIMARY KEY,
  signup_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  freed_at INTEGER
);

-- The hourly prod-clean monitor's results (inventory POST /prodclean).
CREATE TABLE IF NOT EXISTS prodclean_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  code TEXT NOT NULL,
  install_id TEXT,
  detail TEXT
);

-- The platform-db CI target's tracker: each applied file and its sha256.
CREATE TABLE IF NOT EXISTS platform_migrations (
  name TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- The API state of every install (design 5.1), used by the API, scheduler,
-- inventory and prodClean. Precedence, first match wins: deleted, deleting,
-- suspended, active, failed, provisioning. A signup is found by its
-- install_id, or before reserve writes that, through the install's latest
-- job. With no signup, an install is provisioning while a job is open and
-- failed otherwise. jobs_one_active keeps the active job to one row.
CREATE VIEW IF NOT EXISTS install_status AS
SELECT
  l.install_id AS install_id,
  CASE
    WHEN i.state = 'deleted' OR l.discarded_at IS NOT NULL THEN 'deleted'
    WHEN i.state = 'deleting' OR l.deleted_at IS NOT NULL THEN 'deleting'
    WHEN l.suspended_at IS NOT NULL THEN 'suspended'
    WHEN i.state IN ('active', 'upgrading') THEN 'active'
    WHEN s.status = 'failed' THEN 'failed'
    WHEN s.status IN ('pending', 'waiting_cap', 'queued', 'creating') THEN 'provisioning'
    WHEN a.id IS NOT NULL THEN 'provisioning'
    ELSE 'failed'
  END AS state,
  l.source AS source,
  COALESCE(i.slug, s.slug) AS slug,
  i.app_host AS app_host,
  i.content_host AS content_host,
  COALESCE(l.owner_sub, s.owner_sub) AS owner_sub,
  l.tier AS tier,
  i.version AS version,
  i.state AS install_state,
  s.signup_id AS signup_id,
  s.status AS signup_status,
  l.serving_mode AS serving_mode,
  l.health AS health,
  l.health_at AS health_at,
  l.suspended_at AS suspended_at,
  l.suspend_reason AS suspend_reason,
  l.deleted_at AS deleted_at,
  l.purge_at AS purge_at,
  l.discarded_at AS discarded_at,
  a.id AS active_job_id,
  a.kind AS active_job_kind,
  l.created_at AS created_at,
  l.updated_at AS updated_at
FROM install_lifecycle l
LEFT JOIN installs i ON i.id = l.install_id
LEFT JOIN signups s ON s.signup_id = COALESCE(
  (SELECT signup_id FROM signups WHERE install_id = l.install_id),
  (SELECT signup_id FROM jobs WHERE install_id = l.install_id AND signup_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1)
)
LEFT JOIN jobs a ON a.install_id = l.install_id AND a.status IN ('queued', 'running');

-- Every existing install (staging rl-a and rl-b) gets an admin lifecycle row.
-- Routed states are serving and a deleted install is unmapped; anything else
-- is left for the provisioner's next HOSTS write.
INSERT OR IGNORE INTO install_lifecycle (install_id, source, serving_mode, created_at, updated_at)
SELECT
  id,
  'admin',
  CASE WHEN state IN ('active', 'upgrading') THEN 'serving' WHEN state = 'deleted' THEN 'unmapped' END,
  created_at,
  updated_at
FROM installs;
