-- #2426 B, #2536: an ask shown in a page's [data-oa-ask] slot.
CREATE TABLE `artifact_ask_slots` (
	`artifact_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`home_artifact_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`note` text,
	`placed_by` text,
	`placed_agent` text,
	`created_at` text NOT NULL,
	PRIMARY KEY (`artifact_id`, `slot_key`)
);
--> statement-breakpoint
CREATE INDEX `artifact_ask_slots_home_idx` ON `artifact_ask_slots` (`home_artifact_id`,`thread_id`,`comment_id`);
