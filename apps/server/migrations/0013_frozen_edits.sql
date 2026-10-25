-- P3 T15, additive. Hand-edited from the drizzle-kit output: IF NOT EXISTS
-- and WITHOUT ROWID (0009's precedent for text-PK tables).
-- * frozen_edits: a synced space_members row an admin changed or removed by
--   hand while sync was frozen. The first reconcile after sync returns
--   replaces each with the synced role and deletes the row.
CREATE TABLE IF NOT EXISTS `frozen_edits` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
