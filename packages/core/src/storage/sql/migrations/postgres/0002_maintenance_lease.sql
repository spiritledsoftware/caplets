CREATE TABLE IF NOT EXISTS caplets.authority_maintenance_leases (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
