-- Self-serve step 1: small platform state the scheduler keeps between ticks.
-- One row per key; value is epoch milliseconds. Keys today:
--   billing_health_ok_at   the last time oa-<p>-billing answered /health
--   billing_alert_at       the last "billing unreachable" alert (once per hour)
-- Holds no customer data. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS platform_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
