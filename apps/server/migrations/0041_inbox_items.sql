CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`level` text NOT NULL,
	`key` text NOT NULL,
	`artifact_id` text NOT NULL,
	`thread_id` text,
	`comment_id` text,
	`actor` text NOT NULL,
	`excerpt` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbox_items_kind" CHECK("kind" in ('mention', 'reply', 'comment', 'share', 'decision')),
	CONSTRAINT "inbox_items_level" CHECK("level" in ('needs_you', 'update'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_key_idx` ON `inbox_items` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `inbox_items_read_idx` ON `inbox_items` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `inbox_items_created_idx` ON `inbox_items` (`user_id`,`created_at`);