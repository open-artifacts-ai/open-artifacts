-- #681, additive. Hand-edited from the drizzle-kit output:
-- - The data_writers CHECK is inline in the ADD COLUMN; schema.ts can't
--   express a column-level check without a table rebuild.
-- - Backfill: a public artifact with anonymous writes off becomes "editors",
--   so no page gains writers it didn't have. Every other row keeps the
--   default "viewers". Idempotent.
-- allow_anonymous_writes stays for one release (release-before-use): new
-- code writes it in step (viewers 1, editors 0).
ALTER TABLE `artifacts` ADD `data_writers` text DEFAULT 'viewers' NOT NULL CONSTRAINT "artifacts_data_writers_check" CHECK("data_writers" in ('viewers', 'editors'));--> statement-breakpoint
UPDATE `artifacts` SET `data_writers` = 'editors' WHERE `visibility` = 'public' AND `allow_anonymous_writes` = 0 AND `data_writers` = 'viewers';
