-- #1292, additive (drizzle-kit output plus this header). follows: an agent
-- address in a member's bus follows an artifact (200 per member).
-- share_notice_agents: the member's "agents that get share notices".
-- No backfill. The previous release neither reads nor writes them, so a
-- rollback is safe; the artifacts and users cascades only remove rows here.
CREATE TABLE `follows` (
	`user_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`namespace` text NOT NULL,
	`agent_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_notice_at` integer,
	PRIMARY KEY(`user_id`, `artifact_id`, `namespace`, `agent_name`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `follows_artifact_idx` ON `follows` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `follows_address_idx` ON `follows` (`user_id`,`namespace`,`agent_name`);--> statement-breakpoint
CREATE TABLE `share_notice_agents` (
	`user_id` text NOT NULL,
	`namespace` text NOT NULL,
	`agent_name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `namespace`, `agent_name`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
