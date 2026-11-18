CREATE TABLE `notification_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`needs_you_browser` integer DEFAULT 0 NOT NULL,
	`browser_all_asks` integer DEFAULT 0 NOT NULL,
	`quiet_start` text,
	`quiet_end` text,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`lock_detail` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
