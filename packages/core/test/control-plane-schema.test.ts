import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { parseCanonicalHostSetting } from "../src/control-plane/model/host-settings";
import {
  CAPLET_CHILD_SQL_DEFINITIONS,
  ENTITY_SQL_DEFINITIONS,
  SQL_SCHEMA_INVENTORY,
} from "../src/control-plane/schema/definition";
import {
  postgresControlPlaneSchema,
  postgresSchemaInventory,
} from "../src/control-plane/schema/postgres";
import {
  sqliteControlPlaneSchema,
  sqliteSchemaInventory,
} from "../src/control-plane/schema/sqlite";

function physicalInventory(
  schema: Record<string, unknown>,
  getConfig: (table: never) => {
    name: string;
    columns: Array<{ name: string; getSQLType(): string }>;
    foreignKeys: Array<{ getName(): string }>;
    indexes: Array<{ config: { name: string; unique: boolean } }>;
  },
) {
  return Object.values(schema)
    .map((table) => getConfig(table as never))
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe("paired control-plane schemas", () => {
  it("covers the complete canonical inventory and every normalized Caplet child", () => {
    expect(sqliteSchemaInventory).toBe(SQL_SCHEMA_INVENTORY);
    expect(postgresSchemaInventory).toBe(SQL_SCHEMA_INVENTORY);
    expect(ENTITY_SQL_DEFINITIONS).toHaveLength(37);
    expect(CAPLET_CHILD_SQL_DEFINITIONS.map((child) => child.key)).toEqual([
      "document",
      "backend",
      "catalog",
      "catalogTag",
      "declaredInput",
      "reference",
      "asset",
      "activationHistory",
    ]);

    const sqlite = physicalInventory(sqliteControlPlaneSchema, getSqliteTableConfig as never);
    const postgres = physicalInventory(postgresControlPlaneSchema, getPostgresTableConfig as never);
    expect(sqlite.map((table) => table.name)).toEqual(postgres.map((table) => table.name));
    expect(sqlite).toHaveLength(
      1 + ENTITY_SQL_DEFINITIONS.length + CAPLET_CHILD_SQL_DEFINITIONS.length,
    );

    for (const definition of ENTITY_SQL_DEFINITIONS) {
      const sqliteTable = sqlite.find((table) => table.name === definition.tableName)!;
      const postgresTable = postgres.find((table) => table.name === definition.tableName)!;
      const expectedColumns = definition.columns.map((column) => column.name).sort();
      expect(sqliteTable.columns.map((column) => column.name).sort()).toEqual(expectedColumns);
      expect(postgresTable.columns.map((column) => column.name).sort()).toEqual(expectedColumns);
      expect(sqliteTable.foreignKeys.map((key) => key.getName()).sort()).toEqual(
        definition.relations.map((relation) => relation.name).sort(),
      );
      expect(postgresTable.foreignKeys.map((key) => key.getName()).sort()).toEqual(
        definition.relations.map((relation) => relation.name).sort(),
      );
      expect(sqliteTable.indexes.map((index) => index.config.name).sort()).toEqual(
        definition.indexes.map((index) => index.name).sort(),
      );
      expect(postgresTable.indexes.map((index) => index.config.name).sort()).toEqual(
        definition.indexes.map((index) => index.name).sort(),
      );
    }
  });

  it("keeps binary assets and canonical ciphertext in native binary columns", () => {
    const sqlite = physicalInventory(sqliteControlPlaneSchema, getSqliteTableConfig as never);
    const postgres = physicalInventory(postgresControlPlaneSchema, getPostgresTableConfig as never);
    for (const definition of [...ENTITY_SQL_DEFINITIONS, ...CAPLET_CHILD_SQL_DEFINITIONS]) {
      for (const binary of definition.columns.filter((column) => column.type === "bytes")) {
        const sqliteColumn = sqlite
          .find((table) => table.name === definition.tableName)!
          .columns.find((column) => column.name === binary.name)!;
        const postgresColumn = postgres
          .find((table) => table.name === definition.tableName)!
          .columns.find((column) => column.name === binary.name)!;
        expect(sqliteColumn.getSQLType().toLowerCase()).toBe("blob");
        expect(postgresColumn.getSQLType().toLowerCase()).toBe("bytea");
      }
    }
  });

  it("rejects deployment-owned host settings before SQL encoding", () => {
    const base = {
      version: 1,
      value: { source: "setup", url: "http://127.0.0.1:3100" },
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    for (const key of [
      "serve.storage",
      "serve.http.port",
      "credentials.database",
      "keys.provider",
      "backend.caplets",
      "project.root",
      "mcpServers",
      "openapiEndpoints",
      "graphqlEndpoints",
      "httpApis",
      "cliTools",
      "capletSets",
    ]) {
      expect(() => parseCanonicalHostSetting({ ...base, key })).toThrow(/cannot be SQL-owned/u);
    }
    expect(parseCanonicalHostSetting({ ...base, key: "native.daemon-url" })).toMatchObject({
      key: "native.daemon-url",
      value: { source: "setup" },
    });
  });
});
