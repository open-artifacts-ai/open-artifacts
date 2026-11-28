ALTER TABLE push_subscriptions ADD COLUMN installation_id TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_provider_status INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_provider_reason TEXT;
CREATE UNIQUE INDEX push_subscriptions_installation_idx ON push_subscriptions(user_id, installation_id);
