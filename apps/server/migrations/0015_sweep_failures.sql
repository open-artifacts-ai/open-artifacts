-- #728, additive (drizzle-kit output plus this header). Permanent-failure
-- markers the lost-job sweep (sweepLostIndexJobs) skips, so failures can't
-- hold its batch: index_failed (the DO dropped the index job after
-- INDEX_MAX_ATTEMPTS) and thumb_failed (the thumbnail job ended no_thumb).
-- The previous release neither reads nor writes them, so a rollback is safe.
ALTER TABLE `versions` ADD `index_failed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `versions` ADD `thumb_failed` integer DEFAULT 0 NOT NULL;
