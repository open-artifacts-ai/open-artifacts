-- P4 item 9, additive (drizzle-kit output plus this header). A shared
-- space's trash listing (R.trash) walks (space_id, deleted_at) on deleted rows
-- only. The previous release never reads it, so a rollback is safe.
CREATE INDEX IF NOT EXISTS `artifacts_space_deleted_idx` ON `artifacts` (`space_id`,`deleted_at`) WHERE "artifacts"."deleted_at" is not null;
