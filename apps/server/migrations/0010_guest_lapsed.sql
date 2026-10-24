-- P3 T6: users.guest_lapsed marks the one removal a new share undoes (a guest
-- deactivated because their last share went). Hand-edited from the
-- drizzle-kit output:
-- - Dropped the generated spaces table rebuild. It comes from snapshot drift
--   (0009's hand-written CHECKs), not from a schema change, and a rebuild
--   would break the additive-only rule.
-- - The CHECK (0 or 1) is inline in the ADD COLUMN; schema.ts can't express
--   a column-level check without a table rebuild.
-- - Backfill: before this release the only way a guest row became 'removed'
--   was the last-share cleanup (an admin removal deleted the row), so every
--   existing removed guest is a lapsed one. Idempotent.
-- restricted_manual and restricted_sync get no CHECK here: adding one to an
-- existing column needs a table rebuild. They are read fail closed (!== 0).
ALTER TABLE `users` ADD `guest_lapsed` integer DEFAULT 0 NOT NULL CONSTRAINT "users_guest_lapsed_check" CHECK("guest_lapsed" in (0, 1));--> statement-breakpoint
UPDATE `users` SET `guest_lapsed` = 1 WHERE `role` = 'guest' AND `status` = 'removed' AND `guest_lapsed` = 0;
