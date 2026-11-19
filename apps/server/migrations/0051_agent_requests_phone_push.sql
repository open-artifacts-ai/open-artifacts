CREATE TABLE `listed_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`receiver_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`agent_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`receiver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listed_deliveries_comment_idx` ON `listed_deliveries` (`comment_id`,`agent_key`);--> statement-breakpoint
CREATE INDEX `listed_deliveries_receiver_idx` ON `listed_deliveries` (`receiver_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `phone_push` integer DEFAULT 0 NOT NULL;