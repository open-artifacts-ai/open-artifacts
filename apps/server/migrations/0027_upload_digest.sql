-- #1490, additive: sha256 (hex) of an uploaded file, set by the signed PUT and copied into the
-- manifest digest at publish. Nullable, no backfill; the previous release ignores the column.
ALTER TABLE `uploads` ADD `digest` text;