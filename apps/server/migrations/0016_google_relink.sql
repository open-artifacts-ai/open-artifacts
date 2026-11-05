-- P2 item 4, additive (drizzle-kit output plus this header). users.google_relink:
-- 1 after an admin reset the user's Google link, so the next directory users
-- page relinks that same row by email instead of deleting it as a recycled
-- address. The previous release neither reads nor writes it, so a rollback is
-- safe.
ALTER TABLE `users` ADD `google_relink` integer DEFAULT 0 NOT NULL;
