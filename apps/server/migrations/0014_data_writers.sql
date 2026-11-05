-- #681, additive. Hand-edited from the drizzle-kit output:
-- - The data_writers CHECK is inline in the ADD COLUMN; schema.ts can't
--   express a column-level check without a table rebuild.
-- - Backfill: a public artifact with anonymous writes off becomes "editors",
--   so no page gains writers it didn't have. Every other row keeps the
--   default "viewers". Idempotent.
-- - Alignment: allow_anonymous_writes = (data_writers = 'viewers') on every
--   row, private and team included, so the two columns agree everywhere.
--   Idempotent. The server reads "viewers" only when both say so (fail
--   closed), so a row the previous release writes during a rollback
--   (allow_anonymous_writes 0) reads as "editors" after the roll forward.
-- allow_anonymous_writes stays for one release (release-before-use): new
-- code writes it in step (viewers 1, editors 0).
ALTER TABLE `artifacts` ADD `data_writers` text DEFAULT 'viewers' NOT NULL CONSTRAINT "artifacts_data_writers_check" CHECK("data_writers" in ('viewers', 'editors'));--> statement-breakpoint
UPDATE `artifacts` SET `data_writers` = 'editors' WHERE `visibility` = 'public' AND `allow_anonymous_writes` = 0 AND `data_writers` = 'viewers';--> statement-breakpoint
UPDATE `artifacts` SET `allow_anonymous_writes` = CASE WHEN `data_writers` = 'viewers' THEN 1 ELSE 0 END WHERE `allow_anonymous_writes` <> CASE WHEN `data_writers` = 'viewers' THEN 1 ELSE 0 END;
