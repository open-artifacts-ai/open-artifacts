-- P3 T15, additive. Hand-edited from the drizzle-kit output: IF NOT EXISTS
-- and WITHOUT ROWID (0009's precedent for text-PK tables).
-- * frozen_edits: a space member an admin edited by hand while sync was
--   frozen, first edit wins. kind override (a synced row changed;
--   manual_role is the manual row from before it, null: none), delete (an
--   explicit removal: final) or manual (a manual row with no synced row:
--   kept). The first reconcile after sync returns applies the outcome,
--   derives the synced role again and deletes the row.
CREATE TABLE IF NOT EXISTS `frozen_edits` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`at` integer NOT NULL,
	`manual_role` text,
	`kind` text DEFAULT 'override' NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "frozen_edits_manual_role_check" CHECK("manual_role" is null or "manual_role" in ('viewer', 'editor', 'manager')),
	CONSTRAINT "frozen_edits_kind_check" CHECK("kind" in ('override', 'delete', 'manual'))
) WITHOUT ROWID;
