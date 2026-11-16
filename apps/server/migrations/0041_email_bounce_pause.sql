CREATE TABLE `share_email_events_seen` (
	`event_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `share_email_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`bounced_at` integer
);
--> statement-breakpoint
CREATE TABLE `share_email_pauses` (
	`user_id` text PRIMARY KEY NOT NULL,
	`until_at` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
