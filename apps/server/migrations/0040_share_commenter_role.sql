-- Hand edit: email keeps COLLATE NOCASE (the DSL cannot express it). Adds 'commenter' to shares_role_check; nothing references shares.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shares` (
	`artifact_id` text NOT NULL,
	`email` text NOT NULL COLLATE NOCASE,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `email`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shares_role_check" CHECK("role" in ('viewer', 'commenter', 'editor'))
);
--> statement-breakpoint
INSERT INTO `__new_shares`("artifact_id", "email", "role", "created_by", "created_at") SELECT "artifact_id", "email", "role", "created_by", "created_at" FROM `shares`;--> statement-breakpoint
DROP TABLE `shares`;--> statement-breakpoint
ALTER TABLE `__new_shares` RENAME TO `shares`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `shares_email_idx` ON `shares` (`email`);
