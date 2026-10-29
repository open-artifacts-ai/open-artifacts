-- Self-serve step 1: small platform state the scheduler keeps between ticks.
-- One row per key; value is epoch milliseconds. Keys today:
--   billing_health_ok_at   the last time oa-<p>-billing answered /health
--   <alert>_opened_at      while an operator alert is open (scheduler alerts.ts)
--   <alert>_notified_at    its last open or reminder email (0: one is owed)
--   <alert>_cleared_at     a clear email is owed
-- with <alert> billing_unreachable or email_quota.
-- Holds no customer data. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS platform_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
