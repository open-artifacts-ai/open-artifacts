CREATE TABLE `inbox_later` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`until` integer NOT NULL,
	`used` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
