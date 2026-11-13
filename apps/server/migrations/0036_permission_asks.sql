CREATE TABLE `permission_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent_key` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`done_at` integer,
	`consumed_at` integer,
	`withdrawn_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `permission_asks_agent_idx` ON `permission_asks` (`agent_key`,`created_at`);--> statement-breakpoint
ALTER TABLE `pick_assertions` ADD `req_hash` text;