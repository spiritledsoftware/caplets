import { describe, expect, it } from "vitest";
import {
  allocatePortablePath,
  decodePortableCaplet,
  decodePortableCapletArtifact,
  encodePortableCapletArtifact,
  portableCapletFromBundle,
  portableCapletFromCapletDocument,
  type PortableCapletBundle,
} from "../src/control-plane/caplets/portable-codec";

function validBundle(): PortableCapletBundle {
  return {
    entryPath: "CAPLET.md",
    frontmatter: {
      id: "safe",
      name: "Safe",
      description: "Safe portable Caplet",
      backend: { kind: "mcp", config: { transport: "stdio" } },
      catalog: { icon: { type: "external", url: "https://cdn.example.com/icon.svg" } },
      declaredInputs: [],
    },
    body: "# Safe\n",
    files: [],
    references: [{ type: "external", owner: "catalog", url: "https://example.com/docs" }],
  };
}

describe("portable Caplet rejection boundaries", () => {
  it.each([
    [
      "traversal",
      () => ({
        ...validBundle(),
        files: [
          { path: "../secret", role: "asset", mediaType: "text/plain", content: new Uint8Array() },
        ],
      }),
    ],
    ["absolute host path", () => ({ ...validBundle(), entryPath: "/etc/CAPLET.md" })],
    [
      "interpolated host path",
      () => ({
        ...validBundle(),
        files: [
          {
            path: "${HOME}/secret",
            role: "asset",
            mediaType: "text/plain",
            content: new Uint8Array(),
          },
        ],
      }),
    ],
    [
      "credentials in URL",
      () => ({
        ...validBundle(),
        references: [
          {
            type: "external" as const,
            owner: "backend",
            url: "https://user:pass@example.com/spec",
          },
        ],
      }),
    ],
    ["private key", () => ({ ...validBundle(), body: "-----BEGIN PRIVATE KEY-----\nsecret" })],
    [
      "embedded secret",
      () => ({
        ...validBundle(),
        frontmatter: { ...validBundle().frontmatter, clientSecret: "secret" },
      }),
    ],
    [
      "dangling reference",
      () => ({
        ...validBundle(),
        references: [{ type: "local" as const, owner: "body", path: "missing.txt" }],
      }),
    ],
    [
      "unsupported field",
      () => ({
        ...validBundle(),
        frontmatter: {
          ...validBundle().frontmatter,
          deployment: { databaseUrl: "postgres://host/db" },
        },
      }),
    ],
    ["dangling body link", () => ({ ...validBundle(), body: "[missing](missing.txt)" })],
    ["body traversal", () => ({ ...validBundle(), body: "[secret](../secret.txt)" })],
    ["unsafe body URL", () => ({ ...validBundle(), body: "[docs](http://example.com/docs)" })],
  ])("rejects %s before storage", (_name, create) => {
    expect(() => portableCapletFromBundle(create() as PortableCapletBundle)).toThrow();
  });

  it("rejects NFC and case-fold path collisions", () => {
    const content = new TextEncoder().encode("x");
    expect(() =>
      portableCapletFromBundle({
        ...validBundle(),
        files: [
          { path: "assets/Café.txt", role: "asset", mediaType: "text/plain", content },
          { path: "assets/Cafe\u0301.txt", role: "asset", mediaType: "text/plain", content },
        ],
      }),
    ).toThrow(/collision/i);
    expect(() =>
      portableCapletFromBundle({
        ...validBundle(),
        files: [
          { path: "assets/Icon.svg", role: "asset", mediaType: "image/svg+xml", content },
          { path: "assets/icon.svg", role: "asset", mediaType: "image/svg+xml", content },
        ],
      }),
    ).toThrow(/collision/i);
  });

  it("enforces file, asset, and aggregate expansion limits", () => {
    const bytes = new Uint8Array(65);
    expect(() =>
      portableCapletFromBundle(
        {
          ...validBundle(),
          files: [
            {
              path: "large.bin",
              role: "asset",
              mediaType: "application/octet-stream",
              content: bytes,
            },
          ],
        },
        { maxAssetBytes: 64 },
      ),
    ).toThrow(/limit/i);
    expect(() =>
      portableCapletFromBundle(
        {
          ...validBundle(),
          files: Array.from({ length: 3 }, (_, index) => ({
            path: `f${index}.txt`,
            role: "asset" as const,
            mediaType: "text/plain",
            content: new Uint8Array([index]),
          })),
        },
        { maxFiles: 2 },
      ),
    ).toThrow(/limit/i);
    expect(() =>
      decodePortableCaplet(new TextEncoder().encode("{" + " ".repeat(128)), {
        maxEnvelopeBytes: 64,
      }),
    ).toThrow(/limit/i);
  });

  it("bounds ZIP artifacts and rejects traversal before extracting entries", () => {
    const portable = portableCapletFromCapletDocument({
      id: "safe",
      path: "CAPLET.md",
      text: [
        "---",
        "name: Safe ZIP",
        "description: A safe portable ZIP boundary fixture",
        "mcpServer:",
        "  command: node",
        "---",
        "# Safe ZIP",
        "",
      ].join("\n"),
      files: [
        {
          path: "asset.txt",
          role: "asset",
          mediaType: "text/plain",
          content: new TextEncoder().encode("asset"),
        },
      ],
    });
    const artifact = encodePortableCapletArtifact(portable);
    expect(() =>
      decodePortableCapletArtifact(artifact.bytes, {
        maxEnvelopeBytes: artifact.bytes.byteLength - 1,
      }),
    ).toThrow(/limit/iu);

    const traversal = Buffer.from(artifact.bytes);
    const original = Buffer.from("safe/CAPLET.md");
    const replacement = Buffer.from("../x/CAPLET.md");
    for (
      let offset = traversal.indexOf(original);
      offset >= 0;
      offset = traversal.indexOf(original, offset + replacement.byteLength)
    ) {
      replacement.copy(traversal, offset);
    }
    expect(() => decodePortableCapletArtifact(traversal)).toThrow(/path traversal/iu);
  });

  it("allocates collision-safe normalized export paths", () => {
    const occupied = ["assets/icon.svg", "assets/icon-2.svg"];
    expect(allocatePortablePath("assets/ICON.svg", occupied)).toBe("assets/ICON-3.svg");
    expect(allocatePortablePath("assets/cafe\u0301.svg", ["assets/Café.svg"])).toBe(
      "assets/café-2.svg",
    );
  });

  it("rejects filesystem-only source kinds in the pure codec", () => {
    expect(() =>
      portableCapletFromBundle({
        ...validBundle(),
        files: [
          {
            path: "link",
            role: "asset",
            mediaType: "text/plain",
            content: new Uint8Array(),
            sourceKind: "symlink",
          },
        ],
      }),
    ).toThrow(/symlink/i);
    expect(() =>
      portableCapletFromBundle({
        ...validBundle(),
        files: [
          {
            path: "device",
            role: "asset",
            mediaType: "text/plain",
            content: new Uint8Array(),
            sourceKind: "device",
          },
        ],
      }),
    ).toThrow(/device/i);
    expect(() =>
      portableCapletFromBundle({
        ...validBundle(),
        files: [
          {
            path: "hard",
            role: "asset",
            mediaType: "text/plain",
            content: new Uint8Array(),
            sourceKind: "hardlink",
          },
        ],
      }),
    ).toThrow(/hardlink/i);
  });
});
