CREATE TABLE `comment_pictures` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`r2_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`w` integer DEFAULT 0 NOT NULL,
	`h` integer DEFAULT 0 NOT NULL,
	`expected_sha256` text,
	`alt` text,
	`comment_id` text,
	`thread_id` text,
	`created_at` integer NOT NULL,
	`received_at` integer
);
--> statement-breakpoint
CREATE INDEX `comment_pictures_artifact_idx` ON `comment_pictures` (`artifact_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `comment_pictures_user_idx` ON `comment_pictures` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comment_pictures_thread_idx` ON `comment_pictures` (`thread_id`);