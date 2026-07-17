import { describe, expect, it } from "vitest";
import { parseCapletFileDocument } from "../src/caplet-files-bundle";
import { deterministicPortableExport } from "../src/control-plane/caplets/export";
import { relationalProjection } from "../src/control-plane/caplets/import";
import {
  decodePortableCaplet,
  decodePortableCapletArtifact,
  encodePortableCaplet,
  portableCapletFromBundle,
  portableCapletFromCapletDocument,
  type PortableCapletBundle,
} from "../src/control-plane/caplets/portable-codec";
import type { CanonicalCapletAggregate, PortableCaplet } from "../src/control-plane/caplets/model";
import { PORTABLE_BACKEND_KINDS_FIXTURE } from "./fixtures/control-plane-corpus";

function corpusBundle(
  backendKind: (typeof PORTABLE_BACKEND_KINDS_FIXTURE)[number],
): PortableCapletBundle {
  return {
    entryPath: "CAPLET.md",
    frontmatter: {
      id: `portable-${backendKind}`,
      name: `Portable ${backendKind}`,
      description: "Portable corpus",
      backend: {
        kind: backendKind,
        config:
          backendKind === "openapi"
            ? { spec: { type: "local", path: "documents/openapi.yaml" } }
            : {},
      },
      catalog: { tags: ["portable"], icon: { type: "local", path: "assets/icon.svg" } },
      declaredInputs: [
        { name: "schema", reference: { type: "local", path: "documents/schema.graphql" } },
      ],
    },
    body: "# Portable\r\n\r\n[guide](documents/guide.txt)\r\n",
    files: [
      {
        path: "assets/icon.svg",
        role: "icon",
        mediaType: "image/svg+xml",
        content: new TextEncoder().encode("<svg/>\r\n"),
      },
      {
        path: "documents/openapi.yaml",
        role: "openapi",
        mediaType: "application/yaml",
        content: new TextEncoder().encode("openapi: 3.1.0\n"),
      },
      {
        path: "documents/schema.graphql",
        role: "graphql-schema",
        mediaType: "application/graphql",
        content: new TextEncoder().encode("type Query { ok: Boolean! }\n"),
      },
      {
        path: "documents/guide.txt",
        role: "document",
        mediaType: "text/plain",
        content: new TextEncoder().encode("guide\r\n"),
      },
      {
        path: "assets/pixel.bin",
        role: "asset",
        mediaType: "application/octet-stream",
        content: Uint8Array.from([0, 255, 1, 2]),
      },
    ],
    references: [
      { type: "local", owner: "body", path: "documents/guide.txt" },
      { type: "external", owner: "backend", url: "https://example.com/api" },
      { type: "unresolved-setup", owner: "setup", name: "API_TOKEN" },
    ],
  };
}

describe("portable Caplet corpus", () => {
  it.each(PORTABLE_BACKEND_KINDS_FIXTURE)(
    "round-trips %s with body, metadata, documents, assets, and references",
    (backendKind) => {
      const model = portableCapletFromBundle(corpusBundle(backendKind));
      const first = encodePortableCaplet(model);
      const second = encodePortableCaplet(model);
      expect(second).toEqual(first);
      const decoded = decodePortableCaplet(first);
      expect(decoded).toEqual(model);
      expect(encodePortableCaplet(decoded)).toEqual(first);
      expect(decoded.body).toContain("[guide](documents/guide.txt)");
      expect(
        decoded.assets.some((asset) => asset.encoding === "base64" && asset.path.endsWith(".bin")),
      ).toBe(true);
    },
  );

  it("reuses the Caplet source parser and projects secret placeholders as setup references", () => {
    const model = portableCapletFromCapletDocument({
      id: "parsed-source",
      path: "CAPLET.md",
      text: [
        "---",
        "name: Parsed source",
        "description: A parsed portable source fixture",
        "catalog:",
        "  icon: ./assets/icon.svg",
        "mcpServer:",
        "  transport: http",
        "  url: https://example.com/mcp",
        "  auth:",
        "    type: bearer",
        "    token: ${API_TOKEN}",
        "---",
        "# Parsed",
        "",
      ].join("\n"),
      files: [
        {
          path: "assets/icon.svg",
          role: "icon",
          mediaType: "image/svg+xml",
          content: new TextEncoder().encode("<svg/>"),
        },
      ],
    });
    const bytes = encodePortableCaplet(model);
    expect(decodePortableCaplet(bytes)).toEqual(model);
    expect(model.body).toBe("# Parsed\n");
    expect(model.frontmatter.source).toMatchObject({
      name: "Parsed source",
      mcpServer: { auth: { type: "bearer", token: "${API_TOKEN}" } },
    });
    expect(model.references).toContainEqual({
      type: "unresolved-setup",
      owner: "frontmatter.mcpServer.auth.token",
      name: "API_TOKEN",
    });
    expect(new TextDecoder().decode(bytes)).not.toContain("actual-secret-value");
  });

  it("rejects literal values in credential maps even when their keys look benign", () => {
    expect(() =>
      portableCapletFromCapletDocument({
        id: "credential-map",
        path: "credential-map.md",
        text: [
          "---",
          "name: Credential map",
          "description: Credential map values must not leak into portable state",
          "mcpServer:",
          "  command: node",
          "  env:",
          "    DATABASE_NAME: literal-secret-with-benign-key",
          "---",
          "# Credential map",
          "",
        ].join("\n"),
        files: [],
      }),
    ).toThrow(/credential.*environment reference|environment reference.*credential/iu);

    const portable = portableCapletFromCapletDocument({
      id: "credential-reference",
      path: "credential-reference.md",
      text: [
        "---",
        "name: Credential reference",
        "description: Credential map values become unresolved setup references",
        "mcpServer:",
        "  command: node",
        "  env:",
        "    DATABASE_NAME: ${DATABASE_PASSWORD}",
        "---",
        "# Credential reference",
        "",
      ].join("\n"),
      files: [],
    });

    expect(portable.references).toContainEqual({
      type: "unresolved-setup",
      owner: "frontmatter.mcpServer.env.DATABASE_NAME",
      name: "DATABASE_PASSWORD",
    });
    expect(JSON.stringify(portable)).not.toContain("literal-secret-with-benign-key");
  });

  it("does not treat Object prototype field names as allowlisted fields", () => {
    expect(() =>
      portableCapletFromBundle({
        ...corpusBundle("mcp"),
        frontmatter: {
          ...corpusBundle("mcp").frontmatter,
          toString: "not-an-allowlisted-field",
        },
      }),
    ).toThrow(/unsupported frontmatter field toString/iu);
  });

  it("round-trips CLI tools through advertised Markdown artifacts and SQL projection", () => {
    const portable = portableCapletFromCapletDocument({
      id: "cli-round-trip",
      path: "cli-round-trip.md",
      text: [
        "---",
        "name: CLI round trip",
        "description: A portable CLI tool round-trip fixture",
        "cliTools:",
        "  actions:",
        "    inspect:",
        "      command: node",
        "      args: ['inspect.mjs']",
        "---",
        "# CLI round trip",
        "",
      ].join("\n"),
      files: [],
    });
    const aggregate = sqlAggregate(portable);
    const projection = relationalProjection(portable, 1, testFence(), "actor", new Date(0), false);
    const exported = deterministicPortableExport({ aggregate, projection });

    expect(exported.mimeType).toBe("text/markdown; charset=utf-8");
    expect(exported.suggestedName).toBe("cli-round-trip.md");
    expect(new TextDecoder().decode(exported.bytes)).toMatch(/^---\n/u);
    expect(() =>
      parseCapletFileDocument(exported.suggestedName, new TextDecoder().decode(exported.bytes)),
    ).not.toThrow();

    const decoded = decodePortableCapletArtifact(exported.bytes);
    expect(decoded).toEqual(portable);
    expect(
      relationalProjection(decoded, 1, testFence(), "actor", new Date(0), false).backends,
    ).toMatchObject([{ kind: "cli", config: { actions: { inspect: { command: "node" } } } }]);
  });

  it("emits deterministic directory bundles as standard ZIP archives", () => {
    const portable = portableCapletFromCapletDocument({
      id: "zip-round-trip",
      path: "CAPLET.md",
      text: [
        "---",
        "name: ZIP round trip",
        "description: A portable directory Caplet round-trip fixture",
        "catalog:",
        "  icon: assets/icon.svg",
        "mcpServer:",
        "  command: node",
        "---",
        "# ZIP round trip",
        "",
      ].join("\n"),
      files: [
        {
          path: "assets/icon.svg",
          role: "icon",
          mediaType: "image/svg+xml",
          content: new TextEncoder().encode("<svg/>"),
        },
      ],
    });
    const projection = relationalProjection(portable, 1, testFence(), "actor", new Date(0), false);
    const first = deterministicPortableExport({ aggregate: sqlAggregate(portable), projection });
    const second = deterministicPortableExport({ aggregate: sqlAggregate(portable), projection });

    expect(first.mimeType).toBe("application/zip");
    expect(first.suggestedName).toBe("zip-round-trip.caplet.zip");
    expect(first.bytes).toEqual(second.bytes);
    const entries = readStoredZipEntries(first.bytes);
    expect([...entries.keys()]).toEqual([
      "zip-round-trip/CAPLET.md",
      "zip-round-trip/assets/icon.svg",
    ]);
    expect(() =>
      parseCapletFileDocument(
        "CAPLET.md",
        new TextDecoder().decode(entries.get("zip-round-trip/CAPLET.md")),
      ),
    ).not.toThrow();
    expect(new TextDecoder().decode(entries.get("zip-round-trip/assets/icon.svg"))).toBe("<svg/>");
    expect(decodePortableCapletArtifact(first.bytes)).toEqual(portable);
  });

  it("uses a positive allowlist that cannot represent host security or deployment state", () => {
    const model = portableCapletFromBundle(corpusBundle("mcp"));
    const text = new TextDecoder().decode(encodePortableCaplet(model));
    for (const forbidden of [
      "vaultValue",
      "clientSecret",
      "authorityToken",
      "databaseUrl",
      "hostPath",
      "writerFence",
      "sessionToken",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(model.references).toContainEqual({
      type: "unresolved-setup",
      owner: "setup",
      name: "API_TOKEN",
    });
  });
});

function sqlAggregate(portable: PortableCaplet): CanonicalCapletAggregate {
  const setupRequired = portable.references.some(
    (reference) => reference.type === "unresolved-setup",
  );
  return {
    modelVersion: 1,
    id: portable.id,
    aggregateVersion: 1,
    ownership: "sql",
    activation: setupRequired ? "setup-required" : "active",
    effective: !setupRequired,
    portable,
    updateState: "current",
  };
}

function testFence() {
  return {
    authorityGeneration: 1,
    effectiveGeneration: 1,
    securityEpoch: 1,
    runtimeFingerprint: "f".repeat(64),
    aggregateVersion: 1,
  };
}

function readStoredZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const buffer = Buffer.from(bytes);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    expect(compression).toBe(0);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    entries.set(name, buffer.subarray(contentStart, contentStart + compressedSize));
    offset = contentStart + compressedSize;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}
