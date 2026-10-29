-- The tier store (self-serve step 1), D1 oa-<p>-billing. Written only by
-- oa-<p>-billing. Installs see tier, status and dates; the Stripe ids never
-- leave this Worker. Times are epoch milliseconds.
CREATE TABLE tiers (
  install_id TEXT PRIMARY KEY,
  tier TEXT CHECK (tier IN ('free', 'trial', 'team', 'business')),
  status TEXT CHECK (status IN ('active', 'past_due', 'lapsed', 'suspended')),
  trial_ends_at INTEGER,
  grace_until INTEGER,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_read_at INTEGER,
  updated_at INTEGER NOT NULL,
  last_event_created INTEGER
);

-- Webhook idempotency: one row per Stripe event id (step 2 writes it).
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- The monthly usage report, kept as the basis for disputes.
CREATE TABLE usage (
  install_id TEXT,
  month TEXT,
  creators_json TEXT,
  count INTEGER,
  received_at INTEGER,
  PRIMARY KEY (install_id, month)
);
