-- P3 T9, additive. Hand-edited from the drizzle-kit output: IF NOT EXISTS on
-- the index (upgrades are additive only).
-- * restricted_groups.created_at, for RestrictedGroup.createdAt. Nullable:
--   rows from before T9 (none are written before it) read as the epoch.
-- * spaces_kind_name_idx: GET R.spaces walks shared spaces by name without
--   reading every personal space. Partial (shared only), so a user insert
--   (the users_personal_space trigger) writes no index entry.
ALTER TABLE `restricted_groups` ADD `created_at` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spaces_kind_name_idx` ON `spaces` (`kind`,`name`,`id`) WHERE "spaces"."kind" = 'shared';
