import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const capletsSchema = sqliteTable("caplets_schema", {
  singleton: integer("singleton").primaryKey(),
  version: integer("version").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const capletRecords = sqliteTable(
  "caplet_records",
  {
    recordKey: text("record_key").primaryKey(),
    capletId: text("caplet_id").notNull(),
    currentRevisionKey: text("current_revision_key"),
    headGeneration: integer("head_generation").notNull(),
    historyLimit: integer("history_limit"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("caplet_records_caplet_id_unique").on(table.capletId)],
);

export const capletRevisions = sqliteTable(
  "caplet_revisions",
  {
    revisionKey: text("revision_key").primaryKey(),
    recordKey: text("record_key")
      .notNull()
      .references(() => capletRecords.recordKey, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    schemaUrl: text("schema_url"),
    content: text("content", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    sourceRevision: text("source_revision"),
    sourceContentHash: text("source_content_hash"),
    createdAt: text("created_at").notNull(),
    actor: text("actor").notNull(),
  },
  (table) => [
    uniqueIndex("caplet_revisions_record_sequence_unique").on(table.recordKey, table.sequence),
  ],
);

export const capletRevisionTags = sqliteTable(
  "caplet_revision_tags",
  {
    revisionKey: text("revision_key")
      .notNull()
      .references(() => capletRevisions.revisionKey, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.revisionKey, table.position] })],
);

export const capletRevisionBackends = sqliteTable(
  "caplet_revision_backends",
  {
    revisionKey: text("revision_key")
      .notNull()
      .references(() => capletRevisions.revisionKey, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    family: text("family").notNull(),
    childId: text("child_id"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.revisionKey, table.position] })],
);

export const capletAssetBlobs = sqliteTable("caplet_asset_blobs", {
  hash: text("hash").primaryKey(),
  size: integer("size").notNull(),
  payload: blob("payload", { mode: "buffer" }),
  objectKey: text("object_key"),
  verificationStatus: text("verification_status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const capletBundleEntries = sqliteTable(
  "caplet_bundle_entries",
  {
    revisionKey: text("revision_key")
      .notNull()
      .references(() => capletRevisions.revisionKey, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => capletAssetBlobs.hash),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    executable: integer("executable", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.revisionKey, table.path] })],
);

export const capletInstallations = sqliteTable(
  "caplet_installations",
  {
    installationKey: text("installation_key").primaryKey(),
    recordKey: text("record_key")
      .notNull()
      .references(() => capletRecords.recordKey, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    status: text("status").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    channel: text("channel"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    detachedAt: text("detached_at"),
    detachedBy: text("detached_by"),
  },
  (table) => [
    index("caplet_installations_record_status_idx").on(table.recordKey, table.status),
    uniqueIndex("caplet_installations_key_generation_unique").on(
      table.installationKey,
      table.generation,
    ),
  ],
);

export const capletInstallationObservations = sqliteTable(
  "caplet_installation_observations",
  {
    observationKey: text("observation_key").primaryKey(),
    installationKey: text("installation_key")
      .notNull()
      .references(() => capletInstallations.installationKey, { onDelete: "cascade" }),
    resolvedRevision: text("resolved_revision"),
    contentHash: text("content_hash"),
    risk: text("risk", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status").notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    index("caplet_installation_observations_installation_idx").on(
      table.installationKey,
      table.observedAt,
    ),
  ],
);

export const operatorActivity = sqliteTable(
  "operator_activity",
  {
    activityKey: text("activity_key").primaryKey(),
    operatorClientId: text("operator_client_id").notNull(),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetKey: text("target_key").notNull(),
    outcome: text("outcome").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("operator_activity_created_idx").on(table.createdAt)],
);

export const vaultAccessGrants = sqliteTable(
  "vault_access_grants",
  {
    subjectKind: text("subject_kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    recordKey: text("record_key").references(() => capletRecords.recordKey, {
      onDelete: "cascade",
    }),
    capletId: text("caplet_id"),
    vaultKey: text("vault_key").notNull(),
    referenceName: text("reference_name").notNull(),
    originKind: text("origin_kind").notNull(),
    originPath: text("origin_path"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectKind, table.subjectKey, table.referenceName] })],
);

export const vaultValues = sqliteTable("vault_values", {
  vaultKey: text("vault_key").primaryKey(),
  generation: integer("generation").notNull(),
  version: integer("version").notNull(),
  algorithm: text("algorithm").notNull(),
  nonce: text("nonce").notNull(),
  ciphertext: text("ciphertext").notNull(),
  authTag: text("auth_tag").notNull(),
  valueBytes: integer("value_bytes").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const remotePairingCodes = sqliteTable("remote_pairing_codes", {
  codeId: text("code_id").primaryKey(),
  hostUrl: text("host_url").notNull(),
  secretHash: text("secret_hash").notNull(),
  clientLabel: text("client_label"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  attempts: integer("attempts").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  usedAt: text("used_at"),
});

export const remoteClients = sqliteTable(
  "remote_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientLabel: text("client_label").notNull(),
    role: text("role").notNull(),
    hostUrl: text("host_url").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    accessExpiresAt: text("access_expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [uniqueIndex("remote_clients_access_token_hash_unique").on(table.accessTokenHash)],
);

export const remoteClientTokenFamilies = sqliteTable(
  "remote_client_token_families",
  {
    familyId: text("family_id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => remoteClients.clientId, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("remote_client_token_families_client_unique").on(table.clientId),
    uniqueIndex("remote_client_token_families_refresh_hash_unique").on(table.refreshTokenHash),
  ],
);

export const remoteClientSupersededRefreshTokens = sqliteTable(
  "remote_client_superseded_refresh_tokens",
  {
    familyId: text("family_id")
      .notNull()
      .references(() => remoteClientTokenFamilies.familyId, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    supersededAt: text("superseded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.familyId, table.tokenHash] }),
    uniqueIndex("remote_client_superseded_refresh_hash_unique").on(table.tokenHash),
  ],
);

export const remotePendingLogins = sqliteTable(
  "remote_pending_logins",
  {
    flowId: text("flow_id").primaryKey(),
    hostUrl: text("host_url").notNull(),
    hostIdentity: text("host_identity"),
    operatorCodeHash: text("operator_code_hash").notNull(),
    pendingRefreshHash: text("pending_refresh_hash").notNull(),
    pendingRefreshReplay: text("pending_refresh_replay", { mode: "json" }).$type<unknown>(),
    pendingCompletionHash: text("pending_completion_hash").notNull(),
    completionReplay: text("completion_replay", { mode: "json" }).$type<unknown>(),
    clientLabel: text("client_label").notNull(),
    requestedRole: text("requested_role").notNull(),
    grantedRole: text("granted_role"),
    clientFingerprint: text("client_fingerprint"),
    sourceHint: text("source_hint"),
    createdAt: text("created_at").notNull(),
    codeExpiresAt: text("code_expires_at").notNull(),
    flowExpiresAt: text("flow_expires_at").notNull(),
    status: text("status").notNull(),
    operatorCodeFingerprint: text("operator_code_fingerprint"),
    approvedAt: text("approved_at"),
    deniedAt: text("denied_at"),
    cancelledAt: text("cancelled_at"),
    exchangedAt: text("exchanged_at"),
  },
  (table) => [
    uniqueIndex("remote_pending_logins_operator_code_hash_unique").on(table.operatorCodeHash),
    uniqueIndex("remote_pending_logins_refresh_hash_unique").on(table.pendingRefreshHash),
    uniqueIndex("remote_pending_logins_completion_hash_unique").on(table.pendingCompletionHash),
  ],
);

export const remotePendingSupersededRefreshTokens = sqliteTable(
  "remote_pending_superseded_refresh_tokens",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => remotePendingLogins.flowId, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    supersededAt: text("superseded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.flowId, table.tokenHash] }),
    uniqueIndex("remote_pending_superseded_refresh_hash_unique").on(table.tokenHash),
  ],
);

export const dashboardSessions = sqliteTable(
  "dashboard_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    secretHash: text("secret_hash").notNull(),
    operatorClientId: text("operator_client_id").notNull(),
    role: text("role").notNull(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("dashboard_sessions_expires_at_idx").on(table.expiresAt),
    index("dashboard_sessions_last_used_at_idx").on(table.lastUsedAt),
  ],
);

export const backendAuthStates = sqliteTable("backend_auth_states", {
  server: text("server").primaryKey(),
  generation: integer("generation").notNull(),
  tokenBundle: text("token_bundle", { mode: "json" }).$type<unknown>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const setupApprovals = sqliteTable(
  "setup_approvals",
  {
    projectFingerprint: text("project_fingerprint").notNull(),
    capletId: text("caplet_id").notNull(),
    contentHash: text("content_hash").notNull(),
    targetKind: text("target_kind").notNull(),
    generation: integer("generation").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    approvedAt: text("approved_at").notNull(),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectFingerprint, table.capletId, table.contentHash, table.targetKind],
    }),
  ],
);

export const setupAttemptSets = sqliteTable(
  "setup_attempt_sets",
  {
    projectFingerprint: text("project_fingerprint").notNull(),
    capletId: text("caplet_id").notNull(),
    generation: integer("generation").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectFingerprint, table.capletId] })],
);

export const projectBindings = sqliteTable(
  "project_bindings",
  {
    bindingId: text("binding_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    projectFingerprint: text("project_fingerprint").notNull(),
    projectRoot: text("project_root").notNull(),
    serverProjectRoot: text("server_project_root").notNull(),
    ownerNodeId: text("owner_node_id").notNull(),
    generation: integer("generation").notNull(),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    syncState: text("sync_state").notNull(),
    readiness: text("readiness").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    lastHeartbeatAt: text("last_heartbeat_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    quarantinedAt: text("quarantined_at"),
    quarantineReason: text("quarantine_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("project_bindings_owner_expiry_idx").on(table.ownerNodeId, table.expiresAt),
    index("project_bindings_active_expiry_idx").on(table.active, table.expiresAt),
  ],
);

export const hostIdentity = sqliteTable("host_identity", {
  singleton: integer("singleton").primaryKey(),
  hostId: text("host_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const hostNodes = sqliteTable("host_nodes", {
  nodeId: text("node_id").primaryKey(),
  startedAt: text("started_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  globalFileManifest: text("global_file_manifest").notNull(),
  runtimeFingerprint: text("runtime_fingerprint").notNull(),
  ready: integer("ready", { mode: "boolean" }).notNull(),
});

export const hostConfigGenerations = sqliteTable("host_config_generations", {
  generation: integer("generation").primaryKey(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const maintenanceLeases = sqliteTable("maintenance_leases", {
  leaseName: text("lease_name").primaryKey(),
  ownerNodeId: text("owner_node_id").notNull(),
  fencingToken: integer("fencing_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const maintenanceCursors = sqliteTable("maintenance_cursors", {
  jobName: text("job_name").primaryKey(),
  cursor: text("cursor"),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteSchema = {
  capletsSchema,
  capletRecords,
  capletRevisions,
  capletRevisionTags,
  capletRevisionBackends,
  capletAssetBlobs,
  capletBundleEntries,
  capletInstallations,
  capletInstallationObservations,
  operatorActivity,
  vaultAccessGrants,
  vaultValues,
  remotePairingCodes,
  remoteClients,
  remoteClientTokenFamilies,
  remoteClientSupersededRefreshTokens,
  remotePendingLogins,
  remotePendingSupersededRefreshTokens,
  dashboardSessions,
  setupApprovals,
  setupAttemptSets,
  projectBindings,
  hostIdentity,
  hostNodes,
  hostConfigGenerations,
  maintenanceLeases,
  maintenanceCursors,
};
