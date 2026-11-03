-- #1204, additive (drizzle-kit output plus this header). users.erased_at:
-- when an admin erased this removed person (ms; null = never). It makes erase
-- idempotent, lets restore refuse an erased row with its own code, and keeps
-- erased rows off the Departed list. No backfill.
-- The previous release neither reads nor writes it, so a rollback is safe.
ALTER TABLE `users` ADD `erased_at` integer;
