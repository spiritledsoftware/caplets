import { sql } from "drizzle-orm";
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
  type AnySQLiteTable,
  type SQLiteColumnBuilderBase,
  type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";
import { STORAGE_IDENTITY_TABLE, type ControlPlaneEntityKind } from "../model";
import {
  CAPLET_CHILD_SQL_DEFINITIONS,
  ENTITY_SQL_DEFINITIONS,
  ENTITY_RELATION_TARGET_KEYS,
  SQL_SCHEMA_INVENTORY,
  type ChildSqlDefinition,
  type EntitySqlDefinition,
  type SqlColumnDefinition,
} from "./definition";

export { SQL_SCHEMA_INVENTORY as sqliteSchemaInventory };

type DynamicSqliteTable = AnySQLiteTable & Record<string, AnySQLiteColumn>;

export const storageIdentity = sqliteTable(
  STORAGE_IDENTITY_TABLE,
  {
    singleton: integer("singleton").notNull(),
    logicalHostId: text("logical_host_id").notNull(),
    storeId: text("store_id").notNull(),
  },
  (table) => [
    primaryKey({ name: "caplets_storage_identity_pk", columns: [table.singleton] }),
    unique("caplets_storage_identity_scope_uq").on(table.logicalHostId, table.storeId),
    check("caplets_storage_identity_singleton_check", sql`${table.singleton} = 1`),
    check(
      "caplets_storage_identity_nonempty_check",
      sql`length(${table.logicalHostId}) > 0 AND length(${table.storeId}) > 0`,
    ),
  ],
);

const entityTableByKind = new Map<ControlPlaneEntityKind, DynamicSqliteTable>();

function definition(kind: ControlPlaneEntityKind): EntitySqlDefinition {
  const value = ENTITY_SQL_DEFINITIONS.find((candidate) => candidate.kind === kind);
  if (!value) throw new Error(`Missing SQL definition for ${kind}`);
  return value;
}

function buildSqliteColumn(column: SqlColumnDefinition): SQLiteColumnBuilderBase {
  if (column.type === "version" || column.type === "boolean") {
    const builder = integer(column.name);
    return column.required ? builder.notNull() : builder;
  }
  if (column.type === "bytes") {
    const builder = blob(column.name, { mode: "buffer" });
    return column.required ? builder.notNull() : builder;
  }
  const builder = text(column.name);
  return column.required ? builder.notNull() : builder;
}

function requireColumn(table: DynamicSqliteTable, property: string): AnySQLiteColumn {
  const column = table[property];
  if (!column) throw new Error(`Missing SQLite column ${property}`);
  return column;
}

function entityChecks(
  definitionValue: EntitySqlDefinition,
  table: DynamicSqliteTable,
): SQLiteTableExtraConfigValue[] {
  const checks: SQLiteTableExtraConfigValue[] = [];
  for (const columnDefinition of definitionValue.columns) {
    const column = requireColumn(table, columnDefinition.property);
    const prefix = `${definitionValue.tableName}_${columnDefinition.name}`;
    if (columnDefinition.type === "version") {
      checks.push(check(`${prefix}_version_check`, sql`${column} >= 0`));
    } else if (columnDefinition.type === "boolean") {
      checks.push(check(`${prefix}_boolean_check`, sql`${column} IN (0, 1)`));
    } else if (columnDefinition.type === "bytes") {
      checks.push(check(`${prefix}_bytes_check`, sql`length(${column}) > 0`));
    } else if (columnDefinition.type === "hash") {
      checks.push(
        check(
          `${prefix}_hash_check`,
          sql`length(${column}) = 64 AND NOT ${column} GLOB '*[^0-9a-f]*'`,
        ),
      );
    } else if (columnDefinition.type === "json") {
      checks.push(check(`${prefix}_json_check`, sql`json_valid(${column})`));
    } else {
      checks.push(check(`${prefix}_nonempty_check`, sql`length(${column}) > 0`));
    }
  }
  checks.push(
    check(
      `${definitionValue.tableName}_model_version_check`,
      sql`${requireColumn(table, "modelVersion")} = 1`,
    ),
  );
  if (definitionValue.kind === "host-setting") {
    const key = requireColumn(table, "key");
    const value = requireColumn(table, "value");
    checks.push(
      check(
        "cp_host_setting_typed_value_check",
        sql`(
          (
            ${key} = 'native.daemon-url'
            AND json_type(${value}, '$') = 'object'
            AND json_extract(${value}, '$.source') = 'setup'
            AND json_type(${value}, '$.url') = 'text'
            AND json_remove(${value}, '$.source', '$.url') = '{}'
          )
          OR (${key} = 'telemetry' AND json_type(${value}, '$') IN ('true', 'false'))
          OR (
            ${key} IN (
              'options.defaultSearchLimit',
              'options.exposureDiscoveryTimeoutMs',
              'options.completion.discoveryTimeoutMs',
              'options.completion.overallTimeoutMs'
            )
            AND json_type(${value}, '$') = 'integer'
            AND json_extract(${value}, '$') > 0
          )
          OR (
            ${key} = 'options.maxSearchLimit'
            AND json_type(${value}, '$') = 'integer'
            AND json_extract(${value}, '$') BETWEEN 1 AND 50
          )
          OR (
            ${key} = 'options.exposureDiscoveryConcurrency'
            AND json_type(${value}, '$') = 'integer'
            AND json_extract(${value}, '$') BETWEEN 1 AND 32
          )
          OR (
            ${key} IN (
              'options.completion.cacheTtlMs',
              'options.completion.negativeCacheTtlMs'
            )
            AND json_type(${value}, '$') = 'integer'
            AND json_extract(${value}, '$') >= 0
          )
          OR (
            ${key} = 'options.exposure'
            AND json_type(${value}, '$') = 'text'
            AND json_extract(${value}, '$') IN (
              'direct',
              'progressive',
              'code_mode',
              'direct_and_code_mode',
              'progressive_and_code_mode'
            )
          )
          OR (
            ${key} = 'namespaceAliases'
            AND json_type(${value}, '$') = 'object'
            AND json_type(${value}, '$.upstreams') = 'object'
            AND json_remove(${value}, '$.local', '$.upstreams') = '{}'
            AND (
              json_type(${value}, '$.local') IS NULL
              OR (
                json_type(${value}, '$.local') = 'text'
                AND length(json_extract(${value}, '$.local')) BETWEEN 1 AND 32
                AND substr(json_extract(${value}, '$.local'), 1, 1) GLOB '[a-z]'
                AND NOT json_extract(${value}, '$.local') GLOB '*[^a-z0-9-]*'
                AND (
                  length(json_extract(${value}, '$.local')) = 1
                  OR substr(json_extract(${value}, '$.local'), -1, 1) GLOB '[a-z0-9]'
                )
              )
            )
            AND json_extract(${value}, '$.upstreams') NOT GLOB '*:[^"]*'
            AND json_extract(${value}, '$.upstreams') NOT GLOB '*:""*[},]'
            AND json_extract(${value}, '$.upstreams') NOT GLOB '*:"[^a-z]*'
            AND json_extract(${value}, '$.upstreams') NOT GLOB '*-"[},]*'
          )
        )`,
      ),
    );
  }
  if (definitionValue.kind === "operation-namespace") {
    checks.push(
      check(
        "cp_operation_namespace_state_check",
        sql`${requireColumn(table, "state")} IN ('active', 'replaced')`,
      ),
    );
  }
  if (definitionValue.kind === "operation-reservation") {
    checks.push(
      check(
        "cp_operation_reservation_state_check",
        sql`${requireColumn(table, "state")} IN ('reserved', 'committed')`,
      ),
    );
  }
  if (definitionValue.kind === "confirmation") {
    checks.push(
      check(
        "cp_confirmation_state_check",
        sql`${requireColumn(table, "state")} IN ('previewed', 'consumed', 'expired', 'invalidated')`,
      ),
    );
  }
  if (definitionValue.kind === "migration") {
    checks.push(
      check(
        "cp_migration_phase_check",
        sql`${requireColumn(table, "phase")} IN ('discovered', 'staged', 'verified', 'activated', 'failed', 'rejected', 'finalized', 'rolled-back')`,
      ),
    );
  }
  if (definitionValue.kind === "key-inventory") {
    checks.push(
      check(
        "cp_key_inventory_provider_check",
        sql`${requireColumn(table, "provider")} = 'file-v1'`,
      ),
      check(
        "cp_key_inventory_state_check",
        sql`${requireColumn(table, "state")} IN ('active', 'decrypt-only', 'retired', 'destruction-intended', 'destroyed')`,
      ),
    );
  }
  if (definitionValue.kind === "key-canary") {
    const protection = requireColumn(table, "protection");
    const nonce = requireColumn(table, "nonce");
    const ciphertext = requireColumn(table, "ciphertext");
    const authTag = requireColumn(table, "authTag");
    const verifier = requireColumn(table, "verifier");
    checks.push(
      check("cp_key_canary_state_check", sql`${requireColumn(table, "state")} = 'active'`),
      check(
        "cp_key_canary_protection_check",
        sql`(${protection} = 'aead' AND ${nonce} IS NOT NULL AND ${ciphertext} IS NOT NULL AND ${authTag} IS NOT NULL AND ${verifier} IS NULL) OR (${protection} = 'hmac' AND ${nonce} IS NULL AND ${ciphertext} IS NULL AND ${authTag} IS NULL AND ${verifier} IS NOT NULL)`,
      ),
    );
  }
  if (definitionValue.kind === "external-destruction") {
    checks.push(
      check(
        "cp_external_destruction_phase_check",
        sql`${requireColumn(table, "phase")} IN ('intended', 'confirmed', 'in-progress', 'completed', 'failed', 'cancelled')`,
      ),
    );
  }
  return checks;
}

function createEntityTable(definitionValue: EntitySqlDefinition): DynamicSqliteTable {
  const builders = Object.fromEntries(
    definitionValue.columns.map((column) => [column.property, buildSqliteColumn(column)]),
  );
  const created = sqliteTable(definitionValue.tableName, builders, (columns) => {
    const table = columns as unknown as DynamicSqliteTable;
    const extras: SQLiteTableExtraConfigValue[] = [
      primaryKey({
        name: `${definitionValue.tableName}_pk`,
        columns: [requireColumn(table, "logicalHostId"), requireColumn(table, "id")],
      }),
      foreignKey({
        name: `${definitionValue.tableName}_root_fk`,
        columns: [requireColumn(table, "logicalHostId"), requireColumn(table, "storeId")],
        foreignColumns: [storageIdentity.logicalHostId, storageIdentity.storeId],
      }).onDelete("restrict"),
      ...entityChecks(definitionValue, table),
    ];
    const relationTargetKey = ENTITY_RELATION_TARGET_KEYS[definitionValue.kind];
    if (relationTargetKey) {
      const targetColumns = relationTargetKey.map((property) => requireColumn(table, property)) as [
        AnySQLiteColumn,
        ...AnySQLiteColumn[],
      ];
      extras.push(unique(`${definitionValue.tableName}_relation_target_uq`).on(...targetColumns));
    }
    for (const indexDefinition of definitionValue.indexes) {
      const indexColumns = indexDefinition.columns.map((property) =>
        requireColumn(table, property),
      ) as [AnySQLiteColumn, ...AnySQLiteColumn[]];
      extras.push(
        indexDefinition.unique
          ? uniqueIndex(indexDefinition.name).on(...indexColumns)
          : index(indexDefinition.name).on(...indexColumns),
      );
    }
    for (const relation of definitionValue.relations.slice(1)) {
      const target = entityTableByKind.get(relation.target as ControlPlaneEntityKind);
      if (!target) throw new Error(`Missing SQLite relation target ${relation.target}`);
      extras.push(
        foreignKey({
          name: relation.name,
          columns: relation.columns.map((property) => requireColumn(table, property)) as [
            AnySQLiteColumn,
            ...AnySQLiteColumn[],
          ],
          foreignColumns: relation.targetColumns.map((property) =>
            requireColumn(target, property),
          ) as [AnySQLiteColumn, ...AnySQLiteColumn[]],
        }).onDelete("restrict"),
      );
    }
    return extras;
  }) as DynamicSqliteTable;
  entityTableByKind.set(definitionValue.kind, created);
  return created;
}

export const hostSettings = createEntityTable(definition("host-setting"));
export const caplets = createEntityTable(definition("caplet"));
export const capletProvenance = createEntityTable(definition("caplet-provenance"));
export const operationNamespaces = createEntityTable(definition("operation-namespace"));
export const operationReservations = createEntityTable(definition("operation-reservation"));
export const operationOutcomes = createEntityTable(definition("operation-outcome"));
export const operationTombstones = createEntityTable(definition("operation-tombstone"));
export const confirmations = createEntityTable(definition("confirmation"));
export const oauthTokens = createEntityTable(definition("oauth-token"));
export const clients = createEntityTable(definition("client"));
export const credentials = createEntityTable(definition("credential"));
export const pendingApprovals = createEntityTable(definition("pending-approval"));
export const dashboardSessions = createEntityTable(definition("dashboard-session"));
export const projectBindingWorkspaces = createEntityTable(definition("project-binding-workspace"));
export const projectBindingLeases = createEntityTable(definition("project-binding-lease"));
export const projectBindingReceipts = createEntityTable(definition("project-binding-receipt"));
export const vaultValues = createEntityTable(definition("vault-value"));
export const vaultGrants = createEntityTable(definition("vault-grant"));
export const operatorActivities = createEntityTable(definition("operator-activity"));
export const authorityVersions = createEntityTable(definition("authority-version"));
export const effectiveVersions = createEntityTable(definition("effective-version"));
export const securityVersions = createEntityTable(definition("security-version"));
export const keyInventory = createEntityTable(definition("key-inventory"));
export const keyCanaries = createEntityTable(definition("key-canary"));
export const clusterNodeLeases = createEntityTable(definition("cluster-node-lease"));
export const writerFences = createEntityTable(definition("writer-fence"));
export const migrations = createEntityTable(definition("migration"));
export const backups = createEntityTable(definition("backup"));
export const recoveries = createEntityTable(definition("recovery"));
export const retentions = createEntityTable(definition("retention"));
export const externalDestructions = createEntityTable(definition("external-destruction"));
export const recoveryCheckpoints = createEntityTable(definition("recovery-checkpoint"));
export const quarantines = createEntityTable(definition("quarantine"));

function childChecks(
  definitionValue: ChildSqlDefinition,
  table: DynamicSqliteTable,
): SQLiteTableExtraConfigValue[] {
  const checks: SQLiteTableExtraConfigValue[] = [];
  for (const columnDefinition of definitionValue.columns) {
    const column = requireColumn(table, columnDefinition.property);
    const prefix = `${definitionValue.tableName}_${columnDefinition.name}`;
    if (columnDefinition.type === "version") {
      checks.push(check(`${prefix}_version_check`, sql`${column} >= 0`));
    } else if (columnDefinition.type === "bytes") {
      checks.push(check(`${prefix}_bytes_check`, sql`length(${column}) > 0`));
    } else if (columnDefinition.type === "hash") {
      checks.push(
        check(
          `${prefix}_hash_check`,
          sql`length(${column}) = 64 AND NOT ${column} GLOB '*[^0-9a-f]*'`,
        ),
      );
    } else if (columnDefinition.type === "json") {
      checks.push(check(`${prefix}_json_check`, sql`json_valid(${column})`));
    } else {
      checks.push(check(`${prefix}_nonempty_check`, sql`length(${column}) > 0`));
    }
  }
  if (definitionValue.key === "backend") {
    const kind = requireColumn(table, "kind");
    const childId = requireColumn(table, "childId");
    checks.push(
      check(
        "cp_caplet_backend_kind_check",
        sql`${kind} IN ('mcp','openapi','googleDiscovery','graphql','http','cli','caplets') AND ((${kind} = 'caplets' AND ${childId} IS NOT NULL) OR (${kind} <> 'caplets' AND ${childId} IS NULL))`,
      ),
    );
  }
  if (definitionValue.key === "asset") {
    checks.push(
      check(
        "cp_caplet_asset_length_check",
        sql`length(${requireColumn(table, "bytes")}) = ${requireColumn(table, "byteLength")}`,
      ),
    );
  }
  if (definitionValue.key === "catalog") {
    const iconType = requireColumn(table, "iconType");
    const iconPath = requireColumn(table, "iconPath");
    const iconUrl = requireColumn(table, "iconUrl");
    checks.push(
      check(
        "cp_caplet_catalog_icon_check",
        sql`(${iconType} IS NULL AND ${iconPath} IS NULL AND ${iconUrl} IS NULL) OR (${iconType} = 'local' AND ${iconPath} IS NOT NULL AND ${iconUrl} IS NULL) OR (${iconType} = 'external' AND ${iconPath} IS NULL AND ${iconUrl} IS NOT NULL)`,
      ),
    );
  }
  if (definitionValue.key === "declaredInput" || definitionValue.key === "reference") {
    const referenceType = requireColumn(table, "referenceType");
    const path = requireColumn(table, "path");
    const url = requireColumn(table, "url");
    const setupName = requireColumn(table, "setupName");
    checks.push(
      check(
        `${definitionValue.tableName}_target_check`,
        sql`(${referenceType} = 'local' AND ${path} IS NOT NULL AND ${url} IS NULL AND ${setupName} IS NULL) OR (${referenceType} = 'external' AND ${path} IS NULL AND ${url} IS NOT NULL AND ${setupName} IS NULL) OR (${referenceType} = 'unresolved-setup' AND ${path} IS NULL AND ${url} IS NULL AND ${setupName} IS NOT NULL)`,
      ),
    );
  }
  if (definitionValue.key === "activationHistory") {
    checks.push(
      check(
        "cp_caplet_activation_history_sequence_check",
        sql`${requireColumn(table, "sequence")} > 0`,
      ),
    );
  }
  return checks;
}

function createChildTable(definitionValue: ChildSqlDefinition): DynamicSqliteTable {
  const builders = Object.fromEntries(
    definitionValue.columns.map((column) => [column.property, buildSqliteColumn(column)]),
  );
  return sqliteTable(definitionValue.tableName, builders, (columns) => {
    const table = columns as unknown as DynamicSqliteTable;
    const extras: SQLiteTableExtraConfigValue[] = [
      primaryKey({
        name: `${definitionValue.tableName}_pk`,
        columns: definitionValue.primaryKey.map((property) => requireColumn(table, property)) as [
          AnySQLiteColumn,
          ...AnySQLiteColumn[],
        ],
      }),
      foreignKey({
        name: `${definitionValue.tableName}_caplet_fk`,
        columns: [requireColumn(table, "logicalHostId"), requireColumn(table, "capletId")],
        foreignColumns: [requireColumn(caplets, "logicalHostId"), requireColumn(caplets, "id")],
      }).onDelete("cascade"),
      ...childChecks(definitionValue, table),
    ];
    for (const indexDefinition of definitionValue.indexes) {
      const indexColumns = indexDefinition.columns.map((property) =>
        requireColumn(table, property),
      ) as [AnySQLiteColumn, ...AnySQLiteColumn[]];
      extras.push(
        indexDefinition.unique
          ? uniqueIndex(indexDefinition.name).on(...indexColumns)
          : index(indexDefinition.name).on(...indexColumns),
      );
    }
    return extras;
  }) as DynamicSqliteTable;
}

function childDefinition(key: string): ChildSqlDefinition {
  const value = CAPLET_CHILD_SQL_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!value) throw new Error(`Missing Caplet child SQL definition ${key}`);
  return value;
}

export const capletDocuments = createChildTable(childDefinition("document"));
export const capletBackends = createChildTable(childDefinition("backend"));
export const capletCatalogs = createChildTable(childDefinition("catalog"));
export const capletCatalogTags = createChildTable(childDefinition("catalogTag"));
export const capletDeclaredInputs = createChildTable(childDefinition("declaredInput"));
export const capletReferences = createChildTable(childDefinition("reference"));
export const capletAssets = createChildTable(childDefinition("asset"));
export const capletActivationHistory = createChildTable(childDefinition("activationHistory"));

export const sqliteControlPlaneSchema = {
  storageIdentity,
  hostSettings,
  caplets,
  capletProvenance,
  operationNamespaces,
  operationReservations,
  operationOutcomes,
  operationTombstones,
  confirmations,
  oauthTokens,
  clients,
  credentials,
  pendingApprovals,
  dashboardSessions,
  projectBindingWorkspaces,
  projectBindingLeases,
  projectBindingReceipts,
  vaultValues,
  vaultGrants,
  operatorActivities,
  authorityVersions,
  effectiveVersions,
  securityVersions,
  keyInventory,
  keyCanaries,
  clusterNodeLeases,
  writerFences,
  migrations,
  backups,
  recoveries,
  retentions,
  externalDestructions,
  recoveryCheckpoints,
  quarantines,
  capletDocuments,
  capletBackends,
  capletCatalogs,
  capletCatalogTags,
  capletDeclaredInputs,
  capletReferences,
  capletAssets,
  capletActivationHistory,
} as const;
