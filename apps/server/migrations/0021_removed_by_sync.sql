-- #829 review item 1, additive (drizzle-kit output plus this header and the
-- backfill). users.removed_by_sync: 1 while the row is removed because
-- directory sync removed it, so restore can refuse it (409 directory_managed)
-- without reading the audit log, which retention sweeps.
-- - Backfill: a removed row whose latest user.status audit row has a
--   directory_* reason. Rows whose audit row was already swept stay 0.
--   Idempotent.
-- - The backfill reads the audit log once per removed row, and audit_events
--   is indexed only on `at`: on a large install that was a full scan per
--   row (#1161, measured: 2k removed rows over 1M audit rows, 278 s). A
--   temporary index makes each lookup a search (the same data, 59 ms); it is
--   dropped after, so the schema is unchanged.
-- The previous release neither reads nor writes it, so a rollback is safe.
ALTER TABLE `users` ADD `removed_by_sync` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tmp_0021_audit_target` ON `audit_events` (`target_type`, `target_id`, `action`);--> statement-breakpoint
UPDATE `users` SET `removed_by_sync` = 1 WHERE `status` = 'removed' AND `removed_by_sync` = 0 AND (
  SELECT json_extract(`detail`, '$.reason') FROM `audit_events`
  WHERE `target_type` = 'user' AND `target_id` = `users`.`id` AND `action` = 'user.status'
  ORDER BY `at` DESC, `id` DESC LIMIT 1
) LIKE 'directory\_%' ESCAPE '\';--> statement-breakpoint
DROP INDEX IF EXISTS `tmp_0021_audit_target`;
