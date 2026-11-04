-- #1291, additive (drizzle-kit output plus this header). The bus:
-- bus_machines (a member's approved machines; only the sha256 of each
-- bus-only machine token) and bus_device_codes (pending device-flow codes,
-- 10 minutes). New tables only, no backfill. The previous release never
-- reads them, so a rollback is safe.
CREATE TABLE `bus_device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`label` text NOT NULL,
	`ip_tag` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_poll_at` integer,
	`user_id` text,
	`approved_at` integer,
	`denied_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bus_device_codes_device_code_hash_unique` ON `bus_device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `bus_device_codes_user_code_unique` ON `bus_device_codes` (`user_code`);--> statement-breakpoint
CREATE INDEX `bus_device_codes_expires_idx` ON `bus_device_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `bus_device_codes_ip_idx` ON `bus_device_codes` (`ip_tag`,`expires_at`);--> statement-breakpoint
CREATE INDEX `bus_device_codes_user_idx` ON `bus_device_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `bus_machines` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bus_machines_token_hash_unique` ON `bus_machines` (`token_hash`);--> statement-breakpoint
CREATE INDEX `bus_machines_user_idx` ON `bus_machines` (`user_id`,`revoked_at`);