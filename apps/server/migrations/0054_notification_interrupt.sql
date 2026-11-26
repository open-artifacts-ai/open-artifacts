-- Preserve explicit browser opt-outs from before account interrupt levels.
ALTER TABLE notification_prefs ADD COLUMN interrupt text NOT NULL DEFAULT 'mentions'
  CHECK (interrupt IN ('mentions', 'everything', 'none'));
--> statement-breakpoint
UPDATE notification_prefs SET interrupt = 'none' WHERE needs_you_browser = 0;
--> statement-breakpoint
ALTER TABLE notification_prefs ADD COLUMN paused_until integer;
--> statement-breakpoint
-- Independent of send_after so clearing a pause keeps quiet hours and bundling intact.
ALTER TABLE push_pending ADD COLUMN pause_until integer;
