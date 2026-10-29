-- Self-serve billing (post-M1), additive (drizzle-kit output plus this
-- header): creator_months, one row per user and UTC month, the creator list
-- behind each bill. Only HOSTED=1 writes or reads it, and the previous
-- release never names it, so a rollback is safe.
CREATE TABLE `creator_months` (
	`month` text NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`first_at` integer NOT NULL,
	PRIMARY KEY(`month`, `user_id`),
	CONSTRAINT "creator_months_source_check" CHECK("creator_months"."source" in ('version', 'data'))
);
