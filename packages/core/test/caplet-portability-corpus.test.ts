import { describe, expect, it } from "vitest";
import {
  decodePortableCaplet,
  encodePortableCaplet,
  portableCapletFromBundle,
  portableCapletFromCapletDocument,
  type PortableCapletBundle,
} from "../src/control-plane/caplets/portable-codec";
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
    expect(model.frontmatter.source).toMatchObject({ name: "Parsed source" });
    expect(model.references).toContainEqual({
      type: "unresolved-setup",
      owner: "frontmatter.mcpServer.auth.token",
      name: "API_TOKEN",
    });
    expect(new TextDecoder().decode(bytes)).not.toContain('"token"');
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
