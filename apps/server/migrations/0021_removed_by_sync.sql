-- #829 review item 1, additive (drizzle-kit output plus this header and the
-- backfill). users.removed_by_sync: 1 while the row is removed because
-- directory sync removed it, so restore can refuse it (409 directory_managed)
-- without reading the audit log, which retention sweeps.
-- - Backfill: a removed row whose latest user.status audit row has a
--   directory_* reason. Rows whose audit row was already swept stay 0.
--   Idempotent.
-- The previous release neither reads nor writes it, so a rollback is safe.
ALTER TABLE `users` ADD `removed_by_sync` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `users` SET `removed_by_sync` = 1 WHERE `status` = 'removed' AND `removed_by_sync` = 0 AND (
  SELECT json_extract(`detail`, '$.reason') FROM `audit_events`
  WHERE `target_type` = 'user' AND `target_id` = `users`.`id` AND `action` = 'user.status'
  ORDER BY `at` DESC, `id` DESC LIMIT 1
) LIKE 'directory\_%' ESCAPE '\';
