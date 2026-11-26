-- Existing team members could comment through a Viewer share before #3269.
UPDATE shares SET can_comment = 1
WHERE role = 'viewer' AND can_comment = 0 AND email IN (
  SELECT email FROM users WHERE role IN ('owner', 'admin', 'member')
);
