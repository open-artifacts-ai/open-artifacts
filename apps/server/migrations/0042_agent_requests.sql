CREATE TABLE `agent_listens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`scope` text NOT NULL,
	`artifact_id` text,
	`space_id` text,
	`until` integer NOT NULL,
	`created_via` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_listens_scope" CHECK("scope" in ('page', 'space', 'all'))
);
--> statement-breakpoint
CREATE INDEX `agent_listens_owner_idx` ON `agent_listens` (`owner_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `held_request_items` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`agent_key` text NOT NULL,
	`way` text NOT NULL,
	`state` text DEFAULT 'held' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `held_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "held_items_way" CHECK("way" in ('mention', 'reply', 'ask', 'page')),
	CONSTRAINT "held_items_state" CHECK("state" in ('held', 'allowed', 'lapsed', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `held_items_comment_idx` ON `held_request_items` (`comment_id`,`agent_key`);--> statement-breakpoint
CREATE INDEX `held_items_request_idx` ON `held_request_items` (`request_id`,`state`);--> statement-breakpoint
CREATE INDEX `held_items_expiry_idx` ON `held_request_items` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `held_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`receiver_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`quiet_until` integer,
	FOREIGN KEY (`receiver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `held_requests_pair_idx` ON `held_requests` (`receiver_id`,`sender_id`,`artifact_id`);--> statement-breakpoint
CREATE INDEX `held_requests_receiver_idx` ON `held_requests` (`receiver_id`,`last_at`);--> statement-breakpoint
ALTER TABLE `artifact_asks` ADD `held` integer DEFAULT 0 NOT NULL;