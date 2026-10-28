-- #803, additive (drizzle-kit output plus this header, trimmed to the two
-- ALTERs: the generated file also rebuilt artifacts and versions for the
-- format CHECK that 0017 widened by hand, which 0018's snapshot did not carry;
-- this snapshot does). audit_events.actor_cred_kind and actor_cred_id: the
-- credential behind a user's action (session, pat, oauth_grant, system) and
-- its id, never the token. Both nullable; the previous release never reads
-- them and its inserts name their columns, so a rollback is safe.
ALTER TABLE `audit_events` ADD `actor_cred_kind` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `actor_cred_id` text;
