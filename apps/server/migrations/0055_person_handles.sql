-- Existing members choose their handle in Profile.
ALTER TABLE users ADD COLUMN handle TEXT COLLATE NOCASE;
--> statement-breakpoint
CREATE UNIQUE INDEX users_handle_unique ON users(handle) WHERE handle IS NOT NULL;
