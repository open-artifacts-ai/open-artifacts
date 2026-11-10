CREATE TABLE `artifact_asks` (
	`artifact_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`addressee` text NOT NULL,
	`open` integer NOT NULL,
	`answered` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`artifact_id`, `comment_id`, `addressee`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_asks_thread_idx` ON `artifact_asks` (`artifact_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `artifact_asks_open_idx` ON `artifact_asks` (`addressee`,`artifact_id`) WHERE "artifact_asks"."open" = 1;