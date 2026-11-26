-- #3024 step 2: one set of account choices. A device row now means "enrolled".
-- Only devices that had Needs you on, for a member whose account Needs you is on
-- (no preference row counts as off), stay. Update pushes are gone: their queued
-- rows go. Data only; the legacy columns stay until step 8.
DELETE FROM `push_subscriptions`
WHERE `needs_you` <> 1
   OR NOT EXISTS (
      SELECT 1 FROM `notification_prefs` AS p
      WHERE p.`user_id` = `push_subscriptions`.`user_id`
        AND p.`needs_you_browser` = 1
   );
--> statement-breakpoint
DELETE FROM `push_pending` WHERE `kind` = 'update';
