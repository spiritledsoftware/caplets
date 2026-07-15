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
} from "../src/control-plane/model";
import type { CanonicalFieldDefinition } from "../src/control-plane/model";
import { classifyCapletPlacement } from "../src/control-plane/caplets/model";
import {
  LEGACY_MAPPING_MANIFEST,
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
      serverName: "github",
      accessToken: "ciphertext",
      refreshToken: "refresh-ciphertext",
      expiresAt: "2026-01-02T00:00:00.000Z",
      version: 3,
      keyVersion: 7,
      ownerId: "client-1",
    };
    const mapped = mapLegacyRecord("oauth-token", fixture, { sourcePath: "auth/github.json" });
    expect(mapped.status).toBe("accepted");
    if (mapped.status !== "accepted") throw new Error("expected accepted mapping");
    expect(Object.keys(mapped.fieldDestinations).toSorted()).toEqual(
      Object.keys(fixture).toSorted(),
    );
    expect(mapped.canonical.identity).toEqual({ serverName: "github" });
    expect(mapped.canonical.fields.expiresAt).toBe(fixture.expiresAt);
    expect(mapped.canonical.fields.keyVersion).toBe(7);
    expect(mapped.canonical.fields.ownerId).toBe("client-1");

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
