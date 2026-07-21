import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const capletsSchema = pgTable("caplets_schema", {
  singleton: integer("singleton").primaryKey(),
  version: integer("version").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const capletRecords = pgTable(
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
  (table) => [
    uniqueIndex("caplet_records_caplet_id_unique").on(table.capletId),
    index("caplet_records_updated_key_idx").on(table.updatedAt, table.recordKey),
  ],
);

export const capletRevisions = pgTable(
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
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
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

export const capletRevisionTags = pgTable(
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

export const capletRevisionBackends = pgTable(
  "caplet_revision_backends",
  {
    revisionKey: text("revision_key")
      .notNull()
      .references(() => capletRevisions.revisionKey, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    family: text("family").notNull(),
    childId: text("child_id"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.revisionKey, table.position] })],
);

export const capletAssetBlobs = pgTable("caplet_asset_blobs", {
  hash: text("hash").primaryKey(),
  size: integer("size").notNull(),
  payload: bytea("payload"),
  objectKey: text("object_key"),
  verificationStatus: text("verification_status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const capletBundleEntries = pgTable(
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
    executable: boolean("executable").notNull(),
  },
  (table) => [primaryKey({ columns: [table.revisionKey, table.path] })],
);

export const capletInstallations = pgTable(
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

export const capletInstallationObservations = pgTable(
  "caplet_installation_observations",
  {
    observationKey: text("observation_key").primaryKey(),
    installationKey: text("installation_key")
      .notNull()
      .references(() => capletInstallations.installationKey, { onDelete: "cascade" }),
    resolvedRevision: text("resolved_revision"),
    contentHash: text("content_hash"),
    risk: jsonb("risk").$type<Record<string, unknown>>(),
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

export const operatorActivity = pgTable(
  "operator_activity",
  {
    activityKey: text("activity_key").primaryKey(),
    operatorClientId: text("operator_client_id").notNull(),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetKey: text("target_key").notNull(),
    outcome: text("outcome").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("operator_activity_created_idx").on(table.createdAt)],
);

export const vaultAccessGrants = pgTable(
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
    resourceVersion: text("resource_version").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectKind, table.subjectKey, table.referenceName] })],
);

export const vaultValues = pgTable("vault_values", {
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

export const remotePairingCodes = pgTable("remote_pairing_codes", {
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

export const remoteClients = pgTable(
  "remote_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientLabel: text("client_label").notNull(),
    role: text("role").notNull(),
    hostUrl: text("host_url").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    accessExpiresAt: text("access_expires_at").notNull(),
    generation: integer("generation").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [uniqueIndex("remote_clients_access_token_hash_unique").on(table.accessTokenHash)],
);

export const remoteClientTokenFamilies = pgTable(
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

export const remoteClientSupersededRefreshTokens = pgTable(
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

export const remotePendingLogins = pgTable(
  "remote_pending_logins",
  {
    flowId: text("flow_id").primaryKey(),
    hostUrl: text("host_url").notNull(),
    hostIdentity: text("host_identity"),
    operatorCodeHash: text("operator_code_hash").notNull(),
    pendingRefreshHash: text("pending_refresh_hash").notNull(),
    pendingRefreshReplay: jsonb("pending_refresh_replay").$type<unknown>(),
    pendingCompletionHash: text("pending_completion_hash").notNull(),
    completionReplay: jsonb("completion_replay").$type<unknown>(),
    clientLabel: text("client_label").notNull(),
    requestedRole: text("requested_role").notNull(),
    grantedRole: text("granted_role"),
    clientFingerprint: text("client_fingerprint"),
    sourceHint: text("source_hint"),
    createdAt: text("created_at").notNull(),
    codeExpiresAt: text("code_expires_at").notNull(),
    flowExpiresAt: text("flow_expires_at").notNull(),
    generation: integer("generation").notNull(),
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
    index("remote_pending_logins_status_created_idx").on(
      table.status,
      table.createdAt,
      table.flowId,
    ),
  ],
);

export const remotePendingSupersededRefreshTokens = pgTable(
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

export const dashboardSessions = pgTable(
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

export const backendAuthStates = pgTable("backend_auth_states", {
  server: text("server").primaryKey(),
  generation: integer("generation").notNull(),
  tokenBundle: jsonb("token_bundle").$type<unknown>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const backendAuthFlows = pgTable(
  "backend_auth_flows",
  {
    flowId: text("flow_id").primaryKey(),
    server: text("server").notNull(),
    status: text("status").notNull(),
    envelopeVersion: integer("envelope_version").notNull(),
    encryptedPayload: jsonb("encrypted_payload").$type<unknown>(),
    startingBackendAuthGeneration: integer("starting_backend_auth_generation"),
    completionCorrelation: text("completion_correlation"),
    completedBackendAuthGeneration: integer("completed_backend_auth_generation"),
    claimToken: text("claim_token"),
    claimedAt: text("claimed_at"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    terminalAt: text("terminal_at"),
  },
  (table) => [
    uniqueIndex("backend_auth_flows_claim_token_unique").on(table.claimToken),
    uniqueIndex("backend_auth_flows_completion_correlation_unique").on(table.completionCorrelation),
    index("backend_auth_flows_server_created_at_idx").on(table.server, table.createdAt),
    index("backend_auth_flows_status_expires_at_idx").on(table.status, table.expiresAt),
    index("backend_auth_flows_status_terminal_at_idx").on(table.status, table.terminalAt),
  ],
);

export const setupApprovals = pgTable(
  "setup_approvals",
  {
    projectFingerprint: text("project_fingerprint").notNull(),
    capletId: text("caplet_id").notNull(),
    contentHash: text("content_hash").notNull(),
    targetKind: text("target_kind").notNull(),
    generation: integer("generation").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
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

export const setupAttemptSets = pgTable(
  "setup_attempt_sets",
  {
    projectFingerprint: text("project_fingerprint").notNull(),
    capletId: text("caplet_id").notNull(),
    generation: integer("generation").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectFingerprint, table.capletId] })],
);

export const projectBindings = pgTable(
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
    active: boolean("active").notNull(),
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

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    principalClientId: text("principal_client_id").notNull(),
    operationId: text("operation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull(),
    ownerToken: text("owner_token"),
    reconciliationLinks: text("reconciliation_links").notNull(),
    responseStatus: integer("response_status"),
    responseContentType: text("response_content_type"),
    responseBody: text("response_body"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    heartbeatAt: text("heartbeat_at"),
    terminalAt: text("terminal_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.principalClientId, table.operationId, table.idempotencyKey],
    }),
    index("idempotency_records_principal_created_idx").on(table.principalClientId, table.createdAt),
    index("idempotency_records_state_heartbeat_idx").on(table.state, table.heartbeatAt),
    index("idempotency_records_state_expiry_idx").on(table.state, table.expiresAt),
  ],
);

export const hostIdentity = pgTable("host_identity", {
  singleton: integer("singleton").primaryKey(),
  hostId: text("host_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const hostNodes = pgTable("host_nodes", {
  nodeId: text("node_id").primaryKey(),
  startedAt: text("started_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  globalFileManifest: text("global_file_manifest").notNull(),
  runtimeFingerprint: text("runtime_fingerprint").notNull(),
  ready: boolean("ready").notNull(),
});

export const hostConfigGenerations = pgTable("host_config_generations", {
  generation: integer("generation").primaryKey(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const maintenanceLeases = pgTable("maintenance_leases", {
  leaseName: text("lease_name").primaryKey(),
  ownerNodeId: text("owner_node_id").notNull(),
  fencingToken: integer("fencing_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const maintenanceCursors = pgTable("maintenance_cursors", {
  jobName: text("job_name").primaryKey(),
  cursor: text("cursor"),
  updatedAt: text("updated_at").notNull(),
});

export const postgresSchema = {
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
  idempotencyRecords,
  hostIdentity,
  hostNodes,
  hostConfigGenerations,
  maintenanceLeases,
  maintenanceCursors,
};
