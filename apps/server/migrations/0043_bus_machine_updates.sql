CREATE TABLE `bus_machine_updates` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`rescue_version` integer DEFAULT 0 NOT NULL,
	`reported_at` integer NOT NULL,
	`switching_at` integer,
	`last_hello_at` integer,
	`stopped_at` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `bus_machines`(`id`) ON UPDATE no action ON DELETE cascade
);
