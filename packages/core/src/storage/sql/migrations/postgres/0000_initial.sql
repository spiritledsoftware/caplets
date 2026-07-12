CREATE TABLE IF NOT EXISTS authority_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authority_schema_meta (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  logical_schema_version INTEGER NOT NULL,
  auxiliary_watermark INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS authority_heads (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  generation_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  predecessor_id TEXT,
  schema_version INTEGER NOT NULL,
  digest TEXT,
  committed_at TEXT,
  CONSTRAINT authority_heads_singleton CHECK (authority_id <> '')
);
CREATE TABLE IF NOT EXISTS authority_generations (
  authority_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  predecessor_id TEXT,
  schema_version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, generation_id),
  UNIQUE (authority_id, sequence)
);
CREATE TABLE IF NOT EXISTS authority_receipts (
  authority_id TEXT NOT NULL,
  current_host_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (authority_id, current_host_id, principal_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS authority_sessions (
  authority_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (authority_id, session_id)
);
CREATE TABLE IF NOT EXISTS authority_events (
  authority_id TEXT NOT NULL,
  watermark INTEGER NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, watermark)
);
CREATE INDEX IF NOT EXISTS authority_events_after_idx ON authority_events (authority_id, watermark);
