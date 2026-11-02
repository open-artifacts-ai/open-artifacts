-- OAuth store move (post-M1), additive: drizzle-kit output plus this header
-- and one hand-edit, WITHOUT ROWID on oauth_kv (the DSL can't express it):
-- the primary key is the only b-tree, so a put writes one row, not two.
-- oauth_kv holds the OAuth provider's KV records when OAUTH_STORE is dual or
-- d1 (mcp/oauth-store.ts). The previous release never reads it, so a
-- rollback is safe.
CREATE TABLE `oauth_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer,
	`metadata` text
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `oauth_kv_exp` ON `oauth_kv` (`expires_at`) WHERE "oauth_kv"."expires_at" is not null;
