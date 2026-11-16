-- Hand edit: the old switches are not carried over (#2661): everyone starts with high_stakes on and every_pick ("every answer") off. Additive: no table is rebuilt.
ALTER TABLE `passkey_settings` ADD `high_stakes` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `passkey_settings` ADD `own_rule` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `passkey_settings` SET `every_pick` = 0;
