import { integer, pgSchema, text } from "drizzle-orm/pg-core";

export const POSTGRES_LOGICAL_SCHEMA_VERSION = 3;

export const capletsSchema = pgSchema("caplets");

export const authoritySchemaMeta = capletsSchema.table("authority_schema_meta", {
  authorityId: text("authority_id").primaryKey(),
  namespace: text("namespace").notNull(),
  logicalSchemaVersion: integer("logical_schema_version").notNull(),
  auxiliaryWatermark: integer("auxiliary_watermark").notNull().default(0),
});

export const authorityMigrations = capletsSchema.table("authority_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const authorityHeads = capletsSchema.table("authority_heads", {
  authorityId: text("authority_id").primaryKey(),
  namespace: text("namespace").notNull(),
  generationId: text("generation_id"),
  sequence: integer("sequence").notNull().default(0),
  predecessorId: text("predecessor_id"),
  schemaVersion: integer("schema_version").notNull(),
  digest: text("digest"),
  committedAt: text("committed_at"),
});

export const authorityGenerations = capletsSchema.table("authority_generations", {
  authorityId: text("authority_id").notNull(),
  generationId: text("generation_id").notNull(),
  sequence: integer("sequence").notNull(),
  predecessorId: text("predecessor_id"),
  schemaVersion: integer("schema_version").notNull(),
  digest: text("digest").notNull(),
  committedAt: text("committed_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
});

export const authorityReceipts = capletsSchema.table("authority_receipts", {
  authorityId: text("authority_id").notNull(),
  currentHostId: text("current_host_id").notNull(),
  principalId: text("principal_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  generationId: text("generation_id").notNull(),
  resultJson: text("result_json").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const authoritySessions = capletsSchema.table("authority_sessions", {
  authorityId: text("authority_id").notNull(),
  sessionId: text("session_id").notNull(),
  revision: integer("revision").notNull().default(0),
  lastUsedAt: text("last_used_at").notNull(),
  revoked: integer("revoked").notNull().default(0),
});

export const authorityEvents = capletsSchema.table("authority_events", {
  authorityId: text("authority_id").notNull(),
  watermark: integer("watermark").notNull(),
  kind: text("kind").notNull(),
  occurredAt: text("occurred_at").notNull(),
  eventJson: text("event_json").notNull(),
});

export const authorityMaintenanceLeases = capletsSchema.table("authority_maintenance_leases", {
  authorityId: text("authority_id").primaryKey(),
  namespace: text("namespace").notNull(),
  owner: text("owner").notNull(),
  token: text("token").notNull(),
  deadlineAt: text("deadline_at").notNull(),
  version: integer("version").notNull().default(1),
});

export const postgresSchema = {
  authoritySchemaMeta,
  authorityMigrations,
  authorityHeads,
  authorityGenerations,
  authorityReceipts,
  authoritySessions,
  authorityEvents,
  authorityMaintenanceLeases,
};
