-- P3 T9: restricted_groups.created_at, for RestrictedGroup.createdAt (the
-- spaces API's restricted-groups list). Nullable and additive: rows from
-- before T9 (none are written before it) read as the epoch. drizzle-kit output,
-- unedited apart from this header.
ALTER TABLE `restricted_groups` ADD `created_at` integer;
