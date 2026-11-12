CREATE TABLE `passkey_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ask_merge` integer DEFAULT 1 NOT NULL,
	`ask_deploy` integer DEFAULT 1 NOT NULL,
	`ask_delete` integer DEFAULT 1 NOT NULL,
	`ask_share` integer DEFAULT 1 NOT NULL,
	`ask_public` integer DEFAULT 1 NOT NULL,
	`ask_command` integer DEFAULT 1 NOT NULL,
	`every_pick` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`alg` integer NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`removal_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `pick_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`binding` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pick_assertions_kind_check" CHECK("pick_assertions"."kind" in ('register', 'pick', 'settings', 'remove'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pick_assertions_scope_idx` ON `pick_assertions` (`user_id`,`scope`);