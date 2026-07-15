import { describe, expect, it } from "vitest";
import {
  CANONICAL_MODEL_VERSION,
  CONTROL_PLANE_ENTITY_INVENTORY,
  RELATIONAL_MODEL_CHECKLIST,
  canonicalFields,
  validateCanonicalEntityShape,
  assertControlPlaneTransition,
  assertVersionVector,
  operationState,
  assertControlPlaneStorageIdentity,
  assertStoreScopedIdentity,
  parseCanonicalHostSetting,
} from "../src/control-plane/model";
import type { CanonicalFieldDefinition } from "../src/control-plane/model";
import { classifyCapletPlacement } from "../src/control-plane/caplets/model";
import {
  validateCapletRelationalProjection,
  type CanonicalCapletAggregate,
  type CanonicalCapletRelationalProjection,
} from "../src/control-plane/caplets/model";
import {
  LEGACY_MAPPING_MANIFEST,
  assertLegacyMappingManifestAligned,
  mapLegacyRecord,
  type LegacyFieldRule,
} from "../src/control-plane/migration/legacy-model";
import {
  CANONICAL_ENTITY_KINDS_FIXTURE,
  LEGACY_DOMAINS_FIXTURE,
} from "./fixtures/control-plane-corpus";

function fixtureValue(rule: LegacyFieldRule): unknown {
  if (rule.category === "clock") return "2026-01-02T00:00:00.000Z";
  if (rule.category === "version") return 3;
  if (rule.codec === "daemon-url") return { url: "http://127.0.0.1:7777" };
  if (rule.category === "extensible-map") return { retained: true };
  if (rule.category === "repeating-child") return [{ id: "child-1" }];
  if (rule.category === "encryption") return "encrypted-value";
  return `${rule.source}-value`;
}

function canonicalFixtureValue(definition: CanonicalFieldDefinition): unknown {
  if (definition.type === "version") return definition.name === "modelVersion" ? 1 : 0;
  if (definition.type === "timestamp") return "2026-01-02T00:00:00.000Z";
  if (definition.type === "boolean") return true;
  if (definition.type === "hash") return "a".repeat(64);
  if (definition.type === "bytes") return Uint8Array.from([1, 2, 3]);
  if (definition.type === "json") return { retained: true };
  return `${definition.name}-value`;
}

function invalidCanonicalFixtureValue(definition: CanonicalFieldDefinition): unknown {
  if (definition.type === "version") return -1;
  if (definition.type === "timestamp") return "not-a-clock";
  if (definition.type === "boolean") return "true";
  if (definition.type === "hash") return "short";
  if (definition.type === "bytes") return new Uint8Array();
  if (definition.type === "json") return undefined;
  return "";
}

describe("canonical control-plane model corpus", () => {
  it("freezes every SQL-owned entity family and relational invariant before schemas exist", () => {
    expect(CANONICAL_MODEL_VERSION).toBe(1);
    const kinds = new Set(CONTROL_PLANE_ENTITY_INVENTORY.map((entry) => entry.kind));
    expect([...kinds].toSorted()).toEqual(CANONICAL_ENTITY_KINDS_FIXTURE.toSorted());
    expect(CONTROL_PLANE_ENTITY_INVENTORY.every((entry) => entry.fieldCategories.length > 0)).toBe(
      true,
    );
    expect(RELATIONAL_MODEL_CHECKLIST.every((item) => item.primaryKey.length > 0)).toBe(true);
    expect(
      RELATIONAL_MODEL_CHECKLIST.some((item) =>
        item.invariants.includes("effective-and-dormant-distinct"),
      ),
    ).toBe(true);
  });

  it("binds every entity to the U2 singleton storage identity parent", () => {
    const parent = {
      singleton: 1 as const,
      logicalHostId: "host-1",
      storeId: "store-1",
    };
    expect(() => assertControlPlaneStorageIdentity(parent)).not.toThrow();
    expect(() =>
      assertControlPlaneStorageIdentity({
        ...parent,
        backend: "sqlite",
      }),
    ).toThrow(/unsupported/i);
    expect(
      RELATIONAL_MODEL_CHECKLIST.every((item) =>
        item.foreignKeys.includes("__caplets_storage_identity_v1(logicalHostId,storeId)"),
      ),
    ).toBe(true);
    expect(() =>
      assertStoreScopedIdentity(parent, { logicalHostId: "host-1", storeId: "store-1" }),
    ).not.toThrow();
    expect(() =>
      assertStoreScopedIdentity(parent, { logicalHostId: "host-1", storeId: "other-store" }),
    ).toThrow(/storage identity/i);
  });

  it("strictly discriminates SQL-owned host settings from deployment and project configuration", () => {
    expect(
      parseCanonicalHostSetting({
        version: 1,
        key: "native.daemon-url",
        value: { source: "setup", url: "http://127.0.0.1:7777" },
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toMatchObject({ key: "native.daemon-url" });
    for (const key of [
      "serve.storage",
      "serve.http",
      "credentials.postgres",
      "key.provider",
      "mcpServers",
      "openapiEndpoints",
      "backend.mcp",
      "project.config",
    ]) {
      expect(() =>
        parseCanonicalHostSetting({
          version: 1,
          key,
          value: {},
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      ).toThrow(/cannot be SQL-owned/i);
    }
  });

  it("freezes Caplet child ownership, ordering, bytes, and activation history", () => {
    const aggregate: CanonicalCapletAggregate = {
      modelVersion: 1,
      id: "caplet-1",
      aggregateVersion: 1,
      ownership: "sql",
      activation: "setup-required",
      effective: false,
      portable: {
        portableVersion: 1,
        canonicalModelVersion: 1,
        id: "caplet-1",
        name: "Caplet",
        description: "Canonical Caplet fixture",
        sourcePath: "CAPLET.md",
        frontmatter: {
          source: {},
          backend: { kind: "mcp", config: {} },
          declaredInputs: [],
        },
        body: "# Caplet\n",
        assets: [],
        references: [],
      },
      updateState: "current",
    };
    const projection: CanonicalCapletRelationalProjection = {
      capletId: "caplet-1",
      sourceFrontmatter: {},
      body: "# Caplet\n",
      backends: [{ capletId: "caplet-1", ordinal: 0, kind: "mcp", config: {} }],
      assets: [
        {
          capletId: "caplet-1",
          ordinal: 0,
          path: "asset.bin",
          role: "asset",
          mediaType: "application/octet-stream",
          content: Uint8Array.from([0, 255]),
          contentHash: "a".repeat(64),
        },
      ],
      references: [],
      activationHistory: [
        {
          capletId: "caplet-1",
          sequence: 1,
          from: "absent",
          to: "setup-required",
          reason: "setup-required",
          actorId: "operator-1",
          aggregateVersion: 1,
          authorityVersion: 1,
          effectiveVersion: 0,
          occurredAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    };
    expect(() => validateCapletRelationalProjection(aggregate, projection)).not.toThrow();
    expect(() =>
      validateCapletRelationalProjection(aggregate, {
        ...projection,
        backends: [{ ...projection.backends[0]!, ordinal: 1 }],
      }),
    ).toThrow(/ordering/i);
    expect(() =>
      validateCapletRelationalProjection(aggregate, { ...projection, activationHistory: [] }),
    ).toThrow(/history/i);
  });

  it("accepts and rejects positive/negative boundaries for every canonical field", () => {
    for (const kind of CANONICAL_ENTITY_KINDS_FIXTURE) {
      const definitions = canonicalFields(kind);
      const fixture = Object.fromEntries(
        definitions.map((definition) => [definition.name, canonicalFixtureValue(definition)]),
      );
      expect(() => validateCanonicalEntityShape(kind, fixture), kind).not.toThrow();
      for (const definition of definitions) {
        if (definition.required) {
          const missing = { ...fixture };
          delete missing[definition.name];
          expect(
            () => validateCanonicalEntityShape(kind, missing),
            `${kind}.${definition.name} missing`,
          ).toThrow();
        }
        expect(
          () =>
            validateCanonicalEntityShape(kind, {
              ...fixture,
              [definition.name]: invalidCanonicalFixtureValue(definition),
            }),
          `${kind}.${definition.name} invalid`,
        ).toThrow();
      }
      expect(() => validateCanonicalEntityShape(kind, { ...fixture, unsupported: true })).toThrow(
        /unsupported/i,
      );
    }
    const vaultFixture = Object.fromEntries(
      canonicalFields("vault-value").map((definition) => [
        definition.name,
        canonicalFixtureValue(definition),
      ]),
    );
    expect(() =>
      validateCanonicalEntityShape("vault-value", {
        ...vaultFixture,
        ciphertext: "legacy-string-is-not-canonical-bytes",
      }),
    ).toThrow(/ciphertext/i);
  });

  it("makes operation absence, replay, supersession, restore, and namespace replacement unambiguous", () => {
    const base = {
      operationId: "op-1",
      namespaceId: "ns-1",
      target: "host:h/store:s",
      requestHash: "a".repeat(64),
    };
    expect(operationState(base)).toBe("unseen");
    expect(
      operationState({
        ...base,
        reservation: { state: "reserved", reservedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ).toBe("reserved");
    expect(
      operationState({
        ...base,
        reservation: {
          state: "committed",
          reservedAt: "2026-01-01T00:00:00.000Z",
          committedAt: "2026-01-01T00:00:01.000Z",
          receiptHash: "b".repeat(64),
        },
      }),
    ).toBe("committed");
    expect(
      operationState({
        ...base,
        tombstone: { reason: "authoritative-absence", consumedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ).toBe("not_committed");
    expect(
      operationState({
        ...base,
        tombstone: { reason: "superseded", consumedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ).toBe("superseded");
    expect(
      operationState({
        ...base,
        tombstone: { reason: "namespace-replaced", consumedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ).toBe("stale_namespace");
    expect(() =>
      operationState({
        ...base,
        reservation: { state: "reserved", reservedAt: "2026-01-01T00:00:00.000Z" },
        tombstone: { reason: "superseded", consumedAt: "2026-01-01T00:00:01.000Z" },
      }),
    ).toThrow();
    expect(() => assertControlPlaneTransition("operation", "committed", "reserved")).toThrow(
      /transition/i,
    );
    expect(() => assertControlPlaneTransition("operation", "not_committed", "committed")).toThrow(
      /transition/i,
    );
    expect(() => assertControlPlaneTransition("authority", "active", "restored")).not.toThrow();
    expect(() =>
      assertControlPlaneTransition("operation-namespace", "active", "replaced"),
    ).not.toThrow();
    for (const [domain, from, to] of [
      ["confirmation", "previewed", "consumed"],
      ["destruction", "intended", "confirmed"],
      ["migration", "verified", "activated"],
    ] as const) {
      expect(() => assertControlPlaneTransition(domain, from, to)).not.toThrow();
      expect(() => assertControlPlaneTransition(domain, to, from)).toThrow(/transition/i);
    }
    expect(() =>
      assertVersionVector({
        aggregateVersion: 0,
        authorityVersion: 1,
        effectiveVersion: 2,
        securityVersion: 3,
      }),
    ).not.toThrow();
    expect(() =>
      assertVersionVector({
        aggregateVersion: -1,
        authorityVersion: 1,
        effectiveVersion: 2,
        securityVersion: 3,
      }),
    ).toThrow(/non-negative/i);
  });

  it("distinguishes setup, collision, replacement, filesystem rejection, and dormant ownership", () => {
    expect(
      classifyCapletPlacement({
        existingSql: false,
        filesystemOwned: false,
        replacingSql: false,
        setupComplete: false,
      }).state,
    ).toBe("setup-required");
    expect(
      classifyCapletPlacement({
        existingSql: true,
        filesystemOwned: false,
        replacingSql: false,
        setupComplete: true,
      }).state,
    ).toBe("default-sql-id-collision");
    expect(
      classifyCapletPlacement({
        existingSql: true,
        filesystemOwned: false,
        replacingSql: true,
        setupComplete: true,
      }),
    ).toEqual({ state: "sql-replacement-approved", effective: true });
    expect(
      classifyCapletPlacement({
        existingSql: false,
        filesystemOwned: true,
        replacingSql: false,
        setupComplete: true,
      }).state,
    ).toBe("filesystem-ownership-rejected");
    expect(
      classifyCapletPlacement({
        existingSql: true,
        filesystemOwned: true,
        replacingSql: false,
        setupComplete: true,
        inspectingExisting: true,
      }).state,
    ).toBe("dormant-shadowed");
  });

  it("maps each accepted legacy field exactly once or quarantines the whole record", () => {
    const fixture = {
      server: "github",
      authType: "oauth2",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-01-02T00:00:00.000Z",
      issuer: "https://issuer.example.com",
      subject: "user-1",
      clientId: "client-1",
      clientSecret: "client-secret",
      metadata: { retained: true },
    };
    const mapped = mapLegacyRecord("oauth-token", fixture, { sourcePath: "auth/github.json" });
    expect(mapped.status).toBe("accepted");
    if (mapped.status !== "accepted") throw new Error("expected accepted mapping");
    expect(Object.keys(mapped.fieldDestinations).toSorted()).toEqual(
      Object.keys(fixture).toSorted(),
    );
    expect(mapped.canonical.identity).toEqual({ serverName: "github" });
    expect(mapped.canonical.fields.expiresAt).toBe(fixture.expiresAt);
    expect(mapped.canonical.fields.accessCiphertext).toEqual(
      new TextEncoder().encode("access-token"),
    );
    expect(mapped.canonical.fields.clientSecretCiphertext).toEqual(
      new TextEncoder().encode("client-secret"),
    );

    const malformed = mapLegacyRecord(
      "oauth-token",
      { ...fixture, mystery: true },
      { sourcePath: "auth/github.json" },
    );
    expect(malformed).toMatchObject({ status: "quarantined", reason: "unsupported-field" });
    expect(
      LEGACY_MAPPING_MANIFEST.domains.every(
        (domain) =>
          new Set(domain.fields.map((field) => field.source)).size === domain.fields.length,
      ),
    ).toBe(true);
  });

  it("covers every legacy domain, optional absence, empty required values, and destination uniqueness", () => {
    expect(LEGACY_MAPPING_MANIFEST.domains.map((domain) => domain.domain).toSorted()).toEqual(
      LEGACY_DOMAINS_FIXTURE.toSorted(),
    );
    expect(() => assertLegacyMappingManifestAligned()).not.toThrow();
    for (const domain of LEGACY_MAPPING_MANIFEST.domains) {
      const fullFixture = Object.fromEntries(
        domain.fields.map((rule) => [rule.source, fixtureValue(rule)]),
      );
      const accepted = mapLegacyRecord(domain.domain, fullFixture, {
        sourcePath: `legacy/${domain.domain}.json`,
      });
      expect(accepted.status, domain.domain).toBe("accepted");
      if (accepted.status !== "accepted") continue;
      expect(Object.keys(accepted.fieldDestinations).toSorted()).toEqual(
        domain.fields.map((field) => field.source).toSorted(),
      );
      expect(new Set(Object.values(accepted.fieldDestinations)).size).toBe(
        Object.values(accepted.fieldDestinations).length,
      );
      if (domain.domain === "vault-value") {
        expect(accepted.canonical.fields.nonce).toBeInstanceOf(Uint8Array);
        expect(accepted.canonical.fields.ciphertext).toBeInstanceOf(Uint8Array);
        expect(accepted.canonical.fields.authTag).toBeInstanceOf(Uint8Array);
      }
      if (domain.domain === "operator-activity") {
        expect(accepted.canonical.fields.occurredAt).toBe("2026-01-02T00:00:00.000Z");
      }
      if (domain.domain === "host-setting") {
        expect(accepted.canonical.identity).toEqual({ key: "native.daemon-url" });
        expect(accepted.canonical.fields["value.url"]).toBe("http://127.0.0.1:7777");
      }

      const requiredOnly = Object.fromEntries(
        domain.fields
          .filter((rule) => rule.presence === "required")
          .map((rule) => [rule.source, fixtureValue(rule)]),
      );
      expect(
        mapLegacyRecord(domain.domain, requiredOnly, {
          sourcePath: `legacy/${domain.domain}-minimal.json`,
        }).status,
      ).toBe("accepted");

      const firstRequired = domain.fields.find((rule) => rule.presence === "required");
      if (firstRequired) {
        expect(
          mapLegacyRecord(
            domain.domain,
            { ...requiredOnly, [firstRequired.source]: "" },
            { sourcePath: `legacy/${domain.domain}-empty.json` },
          ),
        ).toMatchObject({ status: "quarantined", reason: "empty-required-field" });
      }
    }
  });
});
