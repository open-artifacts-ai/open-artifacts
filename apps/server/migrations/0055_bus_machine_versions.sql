ALTER TABLE bus_machines ADD COLUMN bus_version TEXT;
ALTER TABLE bus_machines ADD COLUMN lag_since INTEGER;
ALTER TABLE bus_machines ADD COLUMN failure_version TEXT;
ALTER TABLE bus_machines ADD COLUMN failure_at INTEGER;
CREATE INDEX bus_machines_version_idx ON bus_machines(bus_version) WHERE revoked_at IS NULL;
