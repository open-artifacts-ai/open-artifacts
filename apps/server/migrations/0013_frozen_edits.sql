-- P3 T15, additive. Hand-edited from the drizzle-kit output: IF NOT EXISTS
-- and WITHOUT ROWID (0009's precedent for text-PK tables).
-- * frozen_edits: a synced space_members row an admin changed or removed by
--   hand while sync was frozen, with the pair's manual role from before the
--   first such edit (null: none). The first reconcile after sync returns
--   restores that manual role, derives the synced role again and deletes
--   the row.
CREATE TABLE IF NOT EXISTS `frozen_edits` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`at` integer NOT NULL,
	`manual_role` text,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "frozen_edits_manual_role_check" CHECK("manual_role" is null or "manual_role" in ('viewer', 'editor', 'manager'))
) WITHOUT ROWID;
