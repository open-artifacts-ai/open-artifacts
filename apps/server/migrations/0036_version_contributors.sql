CREATE TABLE `version_contributors` (
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`user_id` text,
	`agent_name` text,
	`agent_version` text,
	`agent_via` text,
	PRIMARY KEY(`artifact_id`, `version`, `kind`, `key`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "version_contributors_kind_check" CHECK("kind" in ('person', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `version_contributors_user_idx` ON `version_contributors` (`user_id`);