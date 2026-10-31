-- Provisioning API: small platform state the scheduler keeps between ticks.
-- One row per key; value is epoch milliseconds. Keys:
--   scheduler_tick_at      the scheduler's last */2 tick (the monitor's dead-man)
--   <alert>_opened_at      while an operator alert is open (scheduler alerts.ts)
--   <alert>_notified_at    its last open or reminder email (0: one is owed)
--   <alert>_cleared_at     a clear email is owed
-- with <alert> one of ALERT_KEYS (packages/shared/src/provisioning/alerts.ts).
-- Same shape as #849's 0006. Holds no customer data. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS platform_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
