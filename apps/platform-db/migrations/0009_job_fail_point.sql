-- Provisioning API (#995): where a job's last failed attempt stopped, so a
-- failure is diagnosable from the job alone. fail_at is one of the fixed
-- failure points (JOB_FAIL_POINTS in @oa/shared/provisioning), fail_status
-- the HTTP status of the failing call, and fail_reason a test hook's refusal
-- (TEST_HOOK_REFUSALS, from its 404 body's error.details.reason): never error
-- text, a body or a request value. All three are rewritten on every failed
-- attempt (NULL when the attempt had none). Additive only.
ALTER TABLE jobs ADD COLUMN fail_at TEXT;
ALTER TABLE jobs ADD COLUMN fail_status INTEGER CHECK (fail_status IS NULL OR fail_status BETWEEN 100 AND 599);
ALTER TABLE jobs ADD COLUMN fail_reason TEXT;
