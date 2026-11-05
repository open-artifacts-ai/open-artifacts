-- Agent identity cards, additive. Hand-edited from the drizzle-kit output:
-- IF NOT EXISTS on the table and index (upgrades are additive only).
-- * agent_grants: per OAuth grant, the owner's label, last use (written at
--   most once a minute), the MCP clientInfo.version and a published-versions
--   counter. Grants themselves stay in OAUTH_KV.
-- * agent_grants_user_idx: member removal deletes a user's rows by user_id.
-- * tokens.versions_published: the same counter for PATs.
-- * versions.agent_via: the grant (`g:<id>`) or token (`t:<id>`) that
--   published the version; NULL for sessions and older rows.
CREATE TABLE IF NOT EXISTS `agent_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`last_used_at` integer,
	`client_version` text,
	`versions_published` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_grants_user_idx` ON `agent_grants` (`user_id`);--> statement-breakpoint
ALTER TABLE `tokens` ADD `versions_published` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `versions` ADD `agent_via` text;