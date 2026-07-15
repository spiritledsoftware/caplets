import {
  CONTROL_PLANE_ENTITY_INVENTORY,
  RELATIONAL_MODEL_CHECKLIST,
  canonicalFields,
  type CanonicalFieldType,
  type ControlPlaneEntityKind,
} from "../model";

export const CONTROL_PLANE_POSTGRES_SCHEMA = "caplets" as const;
export const CONTROL_PLANE_SCHEMA_VERSION = 1 as const;

export type SqlColumnDefinition = {
  property: string;
  name: string;
  type: CanonicalFieldType;
  required: boolean;
};

export type SqlRelationDefinition = {
  name: string;
  columns: readonly string[];
  target: "storage-identity" | ControlPlaneEntityKind;
  targetColumns: readonly string[];
};

export type SqlIndexDefinition = {
  name: string;
  columns: readonly string[];
  unique?: boolean;
};

export type EntitySqlDefinition = {
  kind: ControlPlaneEntityKind;
  tableName: string;
  columns: readonly SqlColumnDefinition[];
  relations: readonly SqlRelationDefinition[];
  indexes: readonly SqlIndexDefinition[];
  invariants: readonly string[];
};

const SEMANTIC_KEYS: Partial<Record<ControlPlaneEntityKind, readonly string[]>> = {
  "host-setting": ["key"],
  caplet: ["portableAggregateId"],
  "caplet-provenance": ["capletId", "contentHash"],
  "operation-namespace": ["namespaceId"],
  "operation-reservation": ["namespaceId", "operationId"],
  "operation-outcome": ["operationId"],
  "operation-tombstone": ["namespaceId", "operationId"],
  confirmation: ["confirmationId"],
  client: ["clientId"],
  credential: ["credentialId"],
  "pending-approval": ["approvalId"],
  "dashboard-session": ["sessionId"],
  "project-binding-workspace": ["workspaceId"],
  "project-binding-lease": ["workspaceId", "leaseId"],
  "project-binding-receipt": ["workspaceId", "receiptId"],
  "vault-value": ["referenceName"],
  "vault-grant": ["referenceName", "capletId"],
  "operator-activity": ["activityId"],
  "authority-version": ["generation"],
  "effective-version": ["generation"],
  "security-version": ["epoch"],
  "cluster-node-lease": ["nodeId"],
  "writer-fence": ["leaseId", "writerEpoch"],
  migration: ["migrationId"],
  backup: ["backupId"],
  recovery: ["recoveryId"],
  retention: ["retentionId"],
  "external-destruction": ["destructionId"],
  "recovery-checkpoint": ["checkpointId"],
  quarantine: ["quarantineId"],
};

/** Semantic keys that are referenced by a physical foreign key and therefore must be inline constraints. */
export const ENTITY_RELATION_TARGET_KEYS: Partial<
  Record<ControlPlaneEntityKind, readonly string[]>
> = {
  "operation-namespace": ["logicalHostId", "namespaceId"],
  confirmation: ["logicalHostId", "confirmationId"],
  client: ["logicalHostId", "clientId"],
  "project-binding-workspace": ["logicalHostId", "workspaceId"],
  backup: ["logicalHostId", "backupId"],
};

const QUERY_INDEXES: Partial<Record<ControlPlaneEntityKind, readonly (readonly string[])[]>> = {
  "host-setting": [["logicalHostId", "effective"]],
  caplet: [
    ["logicalHostId", "name"],
    ["logicalHostId", "effective"],
  ],
  "operation-reservation": [["logicalHostId", "state", "reservedAt"]],
  confirmation: [["logicalHostId", "state", "expiresAt"]],
  "oauth-token": [
    ["logicalHostId", "serverName", "ownerId"],
    ["logicalHostId", "expiresAt"],
  ],
  client: [["logicalHostId", "status"]],
  credential: [["logicalHostId", "clientId", "expiresAt"]],
  "pending-approval": [["logicalHostId", "state", "expiresAt"]],
  "dashboard-session": [["logicalHostId", "expiresAt", "revokedAt"]],
  "project-binding-lease": [["logicalHostId", "workspaceId", "expiresAt"]],
  "operator-activity": [
    ["logicalHostId", "occurredAt"],
    ["logicalHostId", "action"],
  ],
  "cluster-node-lease": [["logicalHostId", "state", "expiresAt"]],
  "writer-fence": [["logicalHostId", "state", "expiresAt"]],
  migration: [["logicalHostId", "phase"]],
  backup: [["logicalHostId", "retentionUntil", "state"]],
  retention: [["logicalHostId", "retainUntil", "destroyedAt"]],
  quarantine: [
    ["logicalHostId", "sourceDomain", "rawDigest"],
    ["logicalHostId", "disposition"],
  ],
};

const RELATIONS: Partial<
  Record<ControlPlaneEntityKind, readonly Omit<SqlRelationDefinition, "name">[]>
> = {
  "caplet-provenance": [
    {
      columns: ["logicalHostId", "capletId"],
      target: "caplet",
      targetColumns: ["logicalHostId", "id"],
    },
  ],
  "operation-namespace": [
    {
      columns: ["logicalHostId", "replacedBy"],
      target: "operation-namespace",
      targetColumns: ["logicalHostId", "namespaceId"],
    },
  ],
  "operation-reservation": [
    {
      columns: ["logicalHostId", "namespaceId"],
      target: "operation-namespace",
      targetColumns: ["logicalHostId", "namespaceId"],
    },
  ],
  "operation-tombstone": [
    {
      columns: ["logicalHostId", "namespaceId"],
      target: "operation-namespace",
      targetColumns: ["logicalHostId", "namespaceId"],
    },
  ],
  credential: [
    {
      columns: ["logicalHostId", "clientId"],
      target: "client",
      targetColumns: ["logicalHostId", "clientId"],
    },
  ],
  "pending-approval": [
    {
      columns: ["logicalHostId", "clientId"],
      target: "client",
      targetColumns: ["logicalHostId", "clientId"],
    },
  ],
  "dashboard-session": [
    {
      columns: ["logicalHostId", "clientId"],
      target: "client",
      targetColumns: ["logicalHostId", "clientId"],
    },
  ],
  "project-binding-lease": [
    {
      columns: ["logicalHostId", "workspaceId"],
      target: "project-binding-workspace",
      targetColumns: ["logicalHostId", "workspaceId"],
    },
  ],
  "project-binding-receipt": [
    {
      columns: ["logicalHostId", "workspaceId"],
      target: "project-binding-workspace",
      targetColumns: ["logicalHostId", "workspaceId"],
    },
  ],
  "vault-grant": [
    {
      columns: ["logicalHostId", "capletId"],
      target: "caplet",
      targetColumns: ["logicalHostId", "id"],
    },
  ],
  recovery: [
    {
      columns: ["logicalHostId", "backupId"],
      target: "backup",
      targetColumns: ["logicalHostId", "backupId"],
    },
  ],
  "external-destruction": [
    {
      columns: ["logicalHostId", "confirmationId"],
      target: "confirmation",
      targetColumns: ["logicalHostId", "confirmationId"],
    },
  ],
  "recovery-checkpoint": [
    {
      columns: ["logicalHostId", "namespaceId"],
      target: "operation-namespace",
      targetColumns: ["logicalHostId", "namespaceId"],
    },
  ],
};

function sqlName(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

export const ENTITY_SQL_DEFINITIONS: readonly EntitySqlDefinition[] =
  CONTROL_PLANE_ENTITY_INVENTORY.map((inventory) => {
    const tableName = `cp_${inventory.kind.replaceAll("-", "_")}`;
    const semanticKey = SEMANTIC_KEYS[inventory.kind];
    const relations: SqlRelationDefinition[] = [
      {
        name: `${tableName}_root_fk`,
        columns: ["logicalHostId", "storeId"],
        target: "storage-identity",
        targetColumns: ["logicalHostId", "storeId"],
      },
      ...(RELATIONS[inventory.kind] ?? []).map((relation, index) => ({
        ...relation,
        name: `${tableName}_relation_${index + 1}_fk`,
      })),
    ];
    const indexes: SqlIndexDefinition[] = [
      ...(semanticKey
        ? [
            {
              name: `${tableName}_semantic_uq`,
              columns: ["logicalHostId", ...semanticKey],
              unique: true,
            },
          ]
        : []),
      ...(QUERY_INDEXES[inventory.kind] ?? []).map((columns, index) => ({
        name: `${tableName}_query_${index + 1}_idx`,
        columns,
      })),
    ];
    return {
      kind: inventory.kind,
      tableName,
      columns: canonicalFields(inventory.kind).map((definition) => ({
        property: definition.name,
        name: sqlName(definition.name),
        type: definition.type,
        required: definition.required,
      })),
      relations,
      indexes,
      invariants: RELATIONAL_MODEL_CHECKLIST.find((item) => item.entity === inventory.kind)!
        .invariants,
    };
  });

export type ChildSqlDefinition = {
  key: string;
  tableName: string;
  columns: readonly SqlColumnDefinition[];
  primaryKey: readonly string[];
  indexes: readonly SqlIndexDefinition[];
};

const childColumn = (
  property: string,
  type: CanonicalFieldType,
  required = true,
): SqlColumnDefinition => ({ property, name: sqlName(property), type, required });

const ownedChildColumns = [
  childColumn("logicalHostId", "id"),
  childColumn("capletId", "id"),
] as const;

export const CAPLET_CHILD_SQL_DEFINITIONS: readonly ChildSqlDefinition[] = [
  {
    key: "document",
    tableName: "cp_caplet_document",
    columns: [
      ...ownedChildColumns,
      childColumn("portableVersion", "version"),
      childColumn("canonicalModelVersion", "version"),
      childColumn("sourcePath", "string"),
      childColumn("sourceFrontmatter", "json"),
      childColumn("body", "string"),
    ],
    primaryKey: ["logicalHostId", "capletId"],
    indexes: [],
  },
  {
    key: "backend",
    tableName: "cp_caplet_backend",
    columns: [
      ...ownedChildColumns,
      childColumn("ordinal", "version"),
      childColumn("kind", "string"),
      childColumn("childId", "id", false),
      childColumn("config", "json"),
    ],
    primaryKey: ["logicalHostId", "capletId", "ordinal"],
    indexes: [{ name: "cp_caplet_backend_child_idx", columns: ["logicalHostId", "childId"] }],
  },
  {
    key: "catalog",
    tableName: "cp_caplet_catalog",
    columns: [
      ...ownedChildColumns,
      childColumn("displayName", "string", false),
      childColumn("summary", "string", false),
      childColumn("iconType", "string", false),
      childColumn("iconPath", "string", false),
      childColumn("iconUrl", "string", false),
    ],
    primaryKey: ["logicalHostId", "capletId"],
    indexes: [],
  },
  {
    key: "catalogTag",
    tableName: "cp_caplet_catalog_tag",
    columns: [
      ...ownedChildColumns,
      childColumn("ordinal", "version"),
      childColumn("tag", "string"),
    ],
    primaryKey: ["logicalHostId", "capletId", "ordinal"],
    indexes: [],
  },
  {
    key: "declaredInput",
    tableName: "cp_caplet_declared_input",
    columns: [
      ...ownedChildColumns,
      childColumn("ordinal", "version"),
      childColumn("name", "string"),
      childColumn("referenceType", "string"),
      childColumn("path", "string", false),
      childColumn("url", "string", false),
      childColumn("setupName", "string", false),
    ],
    primaryKey: ["logicalHostId", "capletId", "ordinal"],
    indexes: [
      {
        name: "cp_caplet_declared_input_name_uq",
        columns: ["logicalHostId", "capletId", "name"],
        unique: true,
      },
    ],
  },
  {
    key: "reference",
    tableName: "cp_caplet_reference",
    columns: [
      ...ownedChildColumns,
      childColumn("ordinal", "version"),
      childColumn("owner", "string"),
      childColumn("referenceType", "string"),
      childColumn("path", "string", false),
      childColumn("url", "string", false),
      childColumn("setupName", "string", false),
    ],
    primaryKey: ["logicalHostId", "capletId", "ordinal"],
    indexes: [],
  },
  {
    key: "asset",
    tableName: "cp_caplet_asset",
    columns: [
      ...ownedChildColumns,
      childColumn("ordinal", "version"),
      childColumn("path", "string"),
      childColumn("role", "string"),
      childColumn("mediaType", "string"),
      childColumn("bytes", "bytes"),
      childColumn("contentHash", "hash"),
      childColumn("byteLength", "version"),
    ],
    primaryKey: ["logicalHostId", "capletId", "ordinal"],
    indexes: [
      {
        name: "cp_caplet_asset_path_uq",
        columns: ["logicalHostId", "capletId", "path"],
        unique: true,
      },
    ],
  },
  {
    key: "activationHistory",
    tableName: "cp_caplet_activation_history",
    columns: [
      ...ownedChildColumns,
      childColumn("sequence", "version"),
      childColumn("fromState", "string"),
      childColumn("toState", "string"),
      childColumn("reason", "string"),
      childColumn("actorId", "id"),
      childColumn("aggregateVersion", "version"),
      childColumn("authorityVersion", "version"),
      childColumn("effectiveVersion", "version"),
      childColumn("occurredAt", "timestamp"),
    ],
    primaryKey: ["logicalHostId", "capletId", "sequence"],
    indexes: [],
  },
];

export const SQL_SCHEMA_INVENTORY = {
  version: CONTROL_PLANE_SCHEMA_VERSION,
  entities: ENTITY_SQL_DEFINITIONS,
  capletChildren: CAPLET_CHILD_SQL_DEFINITIONS,
} as const;
