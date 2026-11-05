-- #682, additive. Hand-edited from the drizzle-kit output: the comments CHECK
-- is inline in the ADD COLUMN (schema.ts can't express a column-level check
-- without a table rebuild), as 0014 does for data_writers. No backfill: every
-- existing artifact gets the default, 1 (comments on). The previous release
-- neither reads nor writes the column, so a rollback is safe.
ALTER TABLE `artifacts` ADD `comments` integer DEFAULT 1 NOT NULL CONSTRAINT "artifacts_comments_check" CHECK("comments" in (0, 1));
