-- oa:non-additive
-- Image format: artifacts.format and versions.format accept 'image'.
--
-- The one exception to the additive-only rule. Both columns carry a CHECK
-- (format in (...)) from 0000_init and 0002, and SQLite can't alter a CHECK in
-- place: widening it needs a table rebuild. An app-only check (no CHECK) would
-- leave two CHECKs that lie about the data; the owner chose a clean schema.
-- Widening is still rollback safe: the previous release never writes 'image',
-- and every value it writes passes the wider CHECK.
--
-- Hand-written, not the drizzle-kit output. drizzle-kit emits
-- `PRAGMA foreign_keys=OFF`, `INSERT ... SELECT` without rowids, DROP and
-- `ALTER TABLE ... RENAME`. None of that is safe on D1:
--   * D1 can't turn foreign keys off (the PRAGMA is a no-op there), and
--     `PRAGMA defer_foreign_keys` doesn't help either: DROP TABLE artifacts
--     runs an implicit DELETE that fires ON DELETE CASCADE on shares and
--     versions, which would empty both.
--   * ALTER TABLE ... RENAME rewrites the FK references in child tables, so a
--     rename dance leaves children pointing at the wrong name.
--   * artifact_search (FTS5) rows use rowid = artifacts.rowid; a copy without
--     rowids would detach every search row from its artifact.
--
-- So: no RENAME, children dropped before their parent, rowids kept.
--   1. Copy artifacts, versions and shares (with rowid) into holding tables
--      (_oa0017_*, CREATE TABLE AS: no constraints, no FKs).
--   2. Drop shares and versions (nothing references them), then artifacts
--      (nothing references it any more, so its implicit DELETE cascades
--      nowhere). Their indexes and triggers go with them.
--   3. Recreate each table with its exact sqlite_master SQL, the format CHECK
--      widened and nothing else changed; copy the rows back with their rowids
--      (parents first, so every FK holds at every step); recreate every index
--      (partial ones included) and both 0009 triggers on artifacts
--      (artifacts_space_default, artifacts_space_not_null) with their exact
--      sqlite_master SQL, after the copy so they don't fire on it.
--   4. Drop the holding tables.
-- Only artifacts, versions and shares are rebuilt: they are the only tables
-- with an FK into artifacts or versions (PRAGMA foreign_key_list on every
-- table). uploads.artifact_id, reserved_artifacts, artifact_search, R2
-- thumbnails and DO data reference artifacts by value or rowid only, with no
-- FK, so nothing touches them; artifact_search keeps working because rowids
-- are preserved.
--
-- Rehearsed by test/migration-0017.test.ts (a populated D1 migrated to 0016,
-- then this file: row counts, key sets, foreign_key_check, integrity_check,
-- sqlite_master and an FTS query match). Production runs are checked with
-- scripts/verify-migration.ts capture (before) and verify (after); restore
-- the D1 Time Travel bookmark if verify fails.
CREATE TABLE `_oa0017_artifacts` AS SELECT rowid AS `_oa_rowid`, * FROM `artifacts`;--> statement-breakpoint
CREATE TABLE `_oa0017_versions` AS SELECT rowid AS `_oa_rowid`, * FROM `versions`;--> statement-breakpoint
CREATE TABLE `_oa0017_shares` AS SELECT rowid AS `_oa_rowid`, * FROM `shares`;--> statement-breakpoint
DROP TABLE `shares`;--> statement-breakpoint
DROP TABLE `versions`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`format` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`capabilities` text DEFAULT '{"db":false,"viewer":false,"storage":false}' NOT NULL,
	`allow_anonymous_writes` integer DEFAULT 0 NOT NULL,
	`has_thumbnail` integer DEFAULT 0 NOT NULL,
	`last_agent_name` text,
	`last_agent_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer, `purge_attempts` integer DEFAULT 0 NOT NULL, `purge_after` integer, `thumbnail_version` integer, `space_id` text REFERENCES spaces(id), `data_writers` text DEFAULT 'viewers' NOT NULL CONSTRAINT "artifacts_data_writers_check" CHECK("data_writers" in ('viewers', 'editors')),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifacts_allow_anon_check" CHECK("artifacts"."allow_anonymous_writes" in (0, 1)),
	CONSTRAINT "artifacts_thumbnail_check" CHECK("artifacts"."has_thumbnail" in (0, 1)),
	CONSTRAINT "artifacts_capabilities_json_check" CHECK(json_valid("artifacts"."capabilities")),
	CONSTRAINT "artifacts_format_check" CHECK("format" in ('html', 'markdown', 'code', 'pdf', 'image')),
	CONSTRAINT "artifacts_visibility_check" CHECK("visibility" in ('private', 'team', 'public'))
);
--> statement-breakpoint
INSERT INTO `artifacts` (rowid, `id`, `owner_id`, `title`, `description`, `format`, `visibility`, `current_version`, `capabilities`, `allow_anonymous_writes`, `has_thumbnail`, `last_agent_name`, `last_agent_version`, `created_at`, `updated_at`, `deleted_at`, `purge_attempts`, `purge_after`, `thumbnail_version`, `space_id`, `data_writers`)
SELECT `_oa_rowid`, `id`, `owner_id`, `title`, `description`, `format`, `visibility`, `current_version`, `capabilities`, `allow_anonymous_writes`, `has_thumbnail`, `last_agent_name`, `last_agent_version`, `created_at`, `updated_at`, `deleted_at`, `purge_attempts`, `purge_after`, `thumbnail_version`, `space_id`, `data_writers` FROM `_oa0017_artifacts` ORDER BY `_oa_rowid`;--> statement-breakpoint
CREATE INDEX `artifacts_deleted_idx` ON `artifacts` (`deleted_at`) WHERE "artifacts"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX `artifacts_owner_deleted_idx` ON `artifacts` (`owner_id`,`deleted_at`) WHERE "artifacts"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX `artifacts_owner_updated_live_idx` ON `artifacts` (`owner_id`,`updated_at`) WHERE "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `artifacts_space_live_idx` ON `artifacts` (`space_id`) WHERE "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `artifacts_visibility_updated_live_idx` ON `artifacts` (`visibility`,`updated_at`) WHERE "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE TRIGGER `artifacts_space_default`
AFTER INSERT ON `artifacts`
WHEN new.`space_id` IS NULL
BEGIN
	UPDATE `artifacts` SET `space_id` = new.`owner_id` WHERE `id` = new.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `artifacts_space_not_null`
BEFORE UPDATE OF `space_id` ON `artifacts`
WHEN new.`space_id` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'space_id cannot be null');
END;--> statement-breakpoint
CREATE TABLE `versions` (
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`entry` text NOT NULL,
	`manifest` text DEFAULT '[]' NOT NULL,
	`language` text,
	`message` text,
	`agent_name` text,
	`agent_version` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`text_indexed` integer DEFAULT 0 NOT NULL, `format` text CONSTRAINT "versions_format_check" CHECK("format" in ('html', 'markdown', 'code', 'pdf', 'image')), `agent_via` text, `index_failed` integer DEFAULT 0 NOT NULL, `thumb_failed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`artifact_id`, `version`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "versions_manifest_json_check" CHECK(json_valid("versions"."manifest"))
);
--> statement-breakpoint
INSERT INTO `versions` (rowid, `artifact_id`, `version`, `entry`, `manifest`, `language`, `message`, `agent_name`, `agent_version`, `created_by`, `created_at`, `text_indexed`, `format`, `agent_via`, `index_failed`, `thumb_failed`)
SELECT `_oa_rowid`, `artifact_id`, `version`, `entry`, `manifest`, `language`, `message`, `agent_name`, `agent_version`, `created_by`, `created_at`, `text_indexed`, `format`, `agent_via`, `index_failed`, `thumb_failed` FROM `_oa0017_versions` ORDER BY `_oa_rowid`;--> statement-breakpoint
CREATE TABLE `shares` (
	`artifact_id` text NOT NULL,
	`email` text NOT NULL COLLATE NOCASE,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `email`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shares_role_check" CHECK("role" in ('viewer', 'editor'))
);
--> statement-breakpoint
INSERT INTO `shares` (rowid, `artifact_id`, `email`, `role`, `created_by`, `created_at`)
SELECT `_oa_rowid`, `artifact_id`, `email`, `role`, `created_by`, `created_at` FROM `_oa0017_shares` ORDER BY `_oa_rowid`;--> statement-breakpoint
CREATE INDEX `shares_email_idx` ON `shares` (`email`);--> statement-breakpoint
DROP TABLE `_oa0017_artifacts`;--> statement-breakpoint
DROP TABLE `_oa0017_versions`;--> statement-breakpoint
DROP TABLE `_oa0017_shares`;
