import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const SQLITE_LOGICAL_SCHEMA_VERSION = 3;

export const authoritySchemaMeta = sqliteTable("authority_schema_meta", {
  authorityId: text("authority_id").primaryKey(),
  namespace: text("namespace").notNull(),
  logicalSchemaVersion: integer("logical_schema_version").notNull(),
  auxiliaryWatermark: integer("auxiliary_watermark").notNull().default(0),
});

export const authorityMigrations = sqliteTable("authority_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const authorityHeads = sqliteTable("authority_heads", {
  authorityId: text("authority_id").primaryKey(),
  namespace: text("namespace").notNull(),
  generationId: text("generation_id"),
  sequence: integer("sequence").notNull().default(0),
  predecessorId: text("predecessor_id"),
  schemaVersion: integer("schema_version").notNull(),
  digest: text("digest"),
  committedAt: text("committed_at"),
});

export const authorityGenerations = sqliteTable("authority_generations", {
  authorityId: text("authority_id").notNull(),
  generationId: text("generation_id").notNull(),
  sequence: integer("sequence").notNull(),
  predecessorId: text("predecessor_id"),
  schemaVersion: integer("schema_version").notNull(),
  digest: text("digest").notNull(),
  committedAt: text("committed_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
});

export const authorityReceipts = sqliteTable("authority_receipts", {
  authorityId: text("authority_id").notNull(),
  currentHostId: text("current_host_id").notNull(),
  principalId: text("principal_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  generationId: text("generation_id").notNull(),
  resultJson: text("result_json").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const authoritySessions = sqliteTable("authority_sessions", {
  authorityId: text("authority_id").notNull(),
  sessionId: text("session_id").notNull(),
  revision: integer("revision").notNull().default(0),
  lastUsedAt: text("last_used_at").notNull(),
  revoked: integer("revoked").notNull().default(0),
});

export const authorityEvents = sqliteTable("authority_events", {
  authorityId: text("authority_id").notNull(),
  watermark: integer("watermark").notNull(),
  kind: text("kind").notNull(),
  occurredAt: text("occurred_at").notNull(),
  eventJson: text("event_json").notNull(),
});

export const authorityMaintenanceLeases = sqliteTable("authority_maintenance_leases", {
  authorityId: text("authority_id").primaryKey(),
  namespace: text("namespace").notNull(),
  owner: text("owner").notNull(),
  token: text("token").notNull(),
  deadlineAt: text("deadline_at").notNull(),
  version: integer("version").notNull().default(1),
});

export const sqliteSchema = {
  authoritySchemaMeta,
  authorityMigrations,
  authorityHeads,
  authorityGenerations,
  authorityReceipts,
  authoritySessions,
  authorityEvents,
  authorityMaintenanceLeases,
};
