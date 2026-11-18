CREATE TABLE `push_pending` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`asker_name` text NOT NULL,
	`excerpt` text NOT NULL,
	`asker_ref` text,
	`agent_key` text,
	`send_after` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "push_pending_kind" CHECK("kind" in ('ask', 'later'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_pending_key_idx` ON `push_pending` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `push_pending_due_idx` ON `push_pending` (`send_after`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`last_sent_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TRIGGER `users_end_push`
AFTER UPDATE OF `status`, `session_epoch` ON `users`
WHEN new.`status` <> old.`status` OR new.`session_epoch` <> old.`session_epoch`
BEGIN
	DELETE FROM `push_subscriptions` WHERE `user_id` = new.`id`;
	DELETE FROM `push_pending` WHERE `user_id` = new.`id`;
END;
