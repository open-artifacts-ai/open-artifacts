-- oa:additive-reviewed
-- oa:verify Compare all users and shares before and after migration. Compatibility rows must match exactly the prior owner, admin and member Viewer shares with can_comment = 0.
-- Preserve the rights attached to pre-3269 Viewer shares without changing
-- any existing grant. Revoking a share also discards its compatibility row.
CREATE TABLE legacy_viewer_comments (
  id INTEGER PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  can_comment INTEGER NOT NULL,
  FOREIGN KEY (artifact_id, email) REFERENCES shares (artifact_id, email) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX legacy_viewer_by_share ON legacy_viewer_comments (artifact_id, email, id);
--> statement-breakpoint
INSERT INTO legacy_viewer_comments (artifact_id, email, can_comment)
SELECT s.artifact_id, s.email, 1 FROM shares s
JOIN users u ON u.email = s.email
WHERE s.role = 'viewer' AND s.can_comment = 0 AND u.role IN ('owner', 'admin', 'member');
--> statement-breakpoint
-- Old Workers may still assign Viewer between migration and deployment.
-- Capture the membership at assignment. New Workers consume this metadata
-- in the same transaction as an explicit role assignment. Later legacy writes
-- append their decision; the most recent one wins.
CREATE TRIGGER legacy_viewer_insert AFTER INSERT ON shares
WHEN NEW.role = 'viewer' AND NEW.can_comment = 0 BEGIN
  INSERT INTO legacy_viewer_comments (artifact_id, email, can_comment)
  SELECT NEW.artifact_id, NEW.email, 1
  WHERE EXISTS (SELECT 1 FROM users WHERE email = NEW.email AND role IN ('owner', 'admin', 'member'));
END;
--> statement-breakpoint
CREATE TRIGGER legacy_viewer_change AFTER UPDATE OF role, can_comment ON shares
WHEN NEW.role = 'viewer' AND NEW.can_comment = 0 BEGIN
  INSERT INTO legacy_viewer_comments (artifact_id, email, can_comment)
  VALUES (NEW.artifact_id, NEW.email, EXISTS (
    SELECT 1 FROM users WHERE email = NEW.email AND role IN ('owner', 'admin', 'member')
  ));
END;
