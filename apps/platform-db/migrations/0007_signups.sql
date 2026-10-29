-- Self-serve step 3: the hosted provisioner's signup queue.
-- signups: one row per signup, written pending by the sign-up service (SS4)
-- with its signup_secret row before it enqueues { signupId }; the provisioner
-- walks it pending | waiting_cap -> queued -> creating -> ready | failed.
-- admitted_at is set when it is admitted under the daily cap (the cap counts
-- a UTC day's admitted_at). install_id is set once the install exists (UNIQUE).
-- welcome_claimed_at / welcome_sent_at make the welcome email send once.
-- signup_secret: the owner's email, kept apart from the queue row and
-- removed after the welcome is sent.
-- Additive only. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS signups (
  signup_id TEXT NOT NULL PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  slug TEXT NOT NULL,
  install_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','waiting_cap','creating','ready','failed')),
  admitted_at INTEGER,
  welcome_claimed_at INTEGER,
  welcome_sent_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS signup_secret (
  signup_id TEXT NOT NULL PRIMARY KEY,
  owner_email TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signups_admitted_at ON signups (admitted_at);
