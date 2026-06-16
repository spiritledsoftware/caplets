import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGoogleDiscoveryUploadUrl,
  buildGoogleDiscoveryUrl,
  discoveryOperations,
  GoogleDiscoveryManager,
  googleDiscoveryScopesForOperations,
} from "../src/google-discovery";
import { writeTokenBundle } from "../src/auth";
import { parseConfig } from "../src/config";
import { DownstreamManager } from "../src/downstream";
import { ServerRegistry } from "../src/registry";
import { handleServerTool } from "../src/tools";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/google-discovery/drive.discovery.json"), "utf8"),
);

let server: ReturnType<typeof createServer> | undefined;
let baseUrl = "";
const requests: Array<{
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> = [];

beforeEach(async () => {
  requests.length = 0;
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk) => bodyChunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const url = request.url ?? "/";
      requests.push({
        method: request.method ?? "GET",
        url,
        body: Buffer.concat(bodyChunks).toString("utf8"),
        headers: request.headers,
      });
      response.setHeader("content-type", "application/json");
      if (url === "/drive.discovery.json") {
        response.end(JSON.stringify(fixture));
        return;
      }
      if (url === "/drive-inferred.discovery.json") {
        response.end(
          JSON.stringify({
            ...fixture,
            baseUrl: undefined,
            rootUrl: `${baseUrl}/`,
            servicePath: "drive/v3/",
          }),
        );
        return;
      }
      if (url === "/reserved.discovery.json") {
        response.end(
          JSON.stringify({
            kind: "discovery#restDescription",
            rootUrl: `${baseUrl}/`,
            servicePath: "drive/v3/",
            schemas: {
              File: {
                id: "File",
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
            resources: {
              files: {
                methods: {
                  getReserved: {
                    id: "drive.files.getReserved",
                    path: "files/{+name}",
                    httpMethod: "GET",
                    parameters: {
                      name: { type: "string", location: "path", required: true },
                    },
                    response: { $ref: "File" },
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (url === "/upload-path.discovery.json") {
        response.end(
          JSON.stringify({
            kind: "discovery#restDescription",
            rootUrl: `${baseUrl}/`,
            servicePath: "drive/v3/",
            schemas: {
              File: {
                id: "File",
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
            resources: {
              files: {
                methods: {
                  update: {
                    id: "drive.files.update",
                    path: "files/{fileId}",
                    httpMethod: "PATCH",
                    supportsMediaUpload: true,
                    parameters: {
                      fileId: { type: "string", location: "path", required: true },
                      fields: { type: "string", location: "query" },
                    },
                    mediaUpload: {
                      protocols: {
                        simple: {
                          path: "/upload/drive/v3/files/{fileId}",
                          multipart: false,
                        },
                      },
                    },
                    response: { $ref: "File" },
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (url === "/upload-resumable.discovery.json") {
        response.end(
          JSON.stringify({
            kind: "discovery#restDescription",
            rootUrl: `${baseUrl}/`,
            servicePath: "drive/v3/",
            schemas: {
              File: {
                id: "File",
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
            resources: {
              files: {
                methods: {
                  create: {
                    id: "drive.files.create",
                    path: "files",
                    httpMethod: "POST",
                    request: { $ref: "File" },
                    supportsMediaUpload: true,
                    mediaUpload: {
                      protocols: {
                        simple: { path: "/upload/drive/v3/files", multipart: false },
                        resumable: { path: "/upload/drive/v3/files", multipart: true },
                      },
                    },
                    response: { $ref: "File" },
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (url === "/auth-error.discovery.json") {
        response.end(
          JSON.stringify({
            kind: "discovery#restDescription",
            rootUrl: `${baseUrl}/`,
            servicePath: "drive/v3/",
            resources: {
              files: {
                methods: {
                  protected: {
                    id: "drive.files.protected",
                    path: "protected",
                    httpMethod: "GET",
                    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (url === "/redirect.discovery.json") {
        response.statusCode = 302;
        response.setHeader("location", "/drive.discovery.json");
        response.end("{}");
        return;
      }
      if (url.startsWith("/drive/v3/files?")) {
        response.end(JSON.stringify({ files: [{ id: "1", name: "Report" }] }));
        return;
      }
      if (url === "/drive/v3/files" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: "2", name: "Created" }));
        return;
      }
      if (url === "/drive/v3/files/1/download") {
        response.setHeader("content-type", "application/pdf");
        response.end("%PDF bytes");
        return;
      }
      if (url === "/drive/v3/files/text/download") {
        response.setHeader("content-type", "text/plain");
        response.end("plain text export");
        return;
      }
      if (url === "/drive/v3/files/large/download") {
        const bytes = Buffer.alloc(1024 * 1024 + 1, "x");
        response.setHeader("content-type", "application/pdf");
        response.setHeader("content-length", String(bytes.byteLength));
        response.end(bytes);
        return;
      }
      if (url === "/drive/v3/files/folders/1") {
        response.end(JSON.stringify({ id: "folders/1" }));
        return;
      }
      if (url === "/drive/v3/protected") {
        response.statusCode = 401;
        response.statusMessage = "Unauthorized";
        response.setHeader(
          "www-authenticate",
          'Bearer error="invalid_token", access_token="secret-google-token"',
        );
        response.end(JSON.stringify({ error: "secret-google-token" }));
        return;
      }
      if (url === "/upload/drive/v3/files?uploadType=media" && request.method === "POST") {
        response.end(JSON.stringify({ id: "uploaded-media" }));
        return;
      }
      if (
        url.startsWith("/upload/drive/v3/files/1?") &&
        url.includes("uploadType=media") &&
        url.includes("fields=id") &&
        request.method === "PATCH"
      ) {
        response.end(JSON.stringify({ id: "1" }));
        return;
      }
      if (url === "/upload/drive/v3/files?uploadType=multipart" && request.method === "POST") {
        response.end(JSON.stringify({ id: "uploaded" }));
        return;
      }
      if (url === "/upload/drive/v3/files?uploadType=resumable" && request.method === "POST") {
        response.statusCode = 200;
        response.setHeader("location", `${baseUrl}/upload/session/abc`);
        response.end("{}");
        return;
      }
      if (url === "/upload/session/abc" && request.method === "PUT") {
        response.end(JSON.stringify({ id: "uploaded-resumable" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Google Discovery test server did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("Google Discovery parser", () => {
  it("maps resources and methods to Caplets operations", () => {
    const operations = discoveryOperations({
      server: "drive",
      document: fixture,
      includeOperations: ["drive.files.*"],
      excludeOperations: ["drive.files.delete"],
    });

    expect(operations.map((operation) => operation.name)).toEqual([
      "drive.files.create",
      "drive.files.download",
      "drive.files.list",
    ]);
    expect(operations.find((operation) => operation.name === "drive.files.list")).toMatchObject({
      method: "get",
      path: "files",
      readOnlyHint: true,
      destructiveHint: false,
      inputSchema: {
        type: "object",
        properties: {
          header: {
            properties: {
              quotaUser: { type: "string" },
            },
          },
          query: {
            properties: {
              fields: { type: "string" },
              pageSize: { type: "integer", default: 100 },
              prettyPrint: { type: "boolean", default: true },
            },
          },
        },
      },
      outputSchema: {
        properties: {
          files: {
            items: {
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
      },
    });
  });

  it("marks destructive operations and resolves filtered scopes", () => {
    const operations = discoveryOperations({
      server: "drive",
      document: fixture,
      excludeOperations: ["*.delete"],
    });

    expect(operations.find((operation) => operation.name === "drive.files.delete")).toBeUndefined();
    expect(googleDiscoveryScopesForOperations(operations)).toEqual([
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);

    const deleteOperation = discoveryOperations({ server: "drive", document: fixture }).find(
      (operation) => operation.name === "drive.files.delete",
    );
    expect(deleteOperation).toMatchObject({
      destructiveHint: true,
      inputSchema: {
        required: ["path"],
        properties: {
          path: {
            required: ["fileId"],
            properties: {
              fileId: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("walks nested resources and uses stable fallback operation names", () => {
    const operations = discoveryOperations({
      server: "drive",
      document: fixture,
      includeOperations: ["drive.permissions.*", "drive.changes.*"],
    });

    expect(operations.map((operation) => operation.name)).toEqual([
      "drive.changes.getStartPageToken",
      "drive.permissions.list",
    ]);
  });

  it("preserves media upload and download metadata", () => {
    const operations = discoveryOperations({ server: "drive", document: fixture });

    expect(operations.find((operation) => operation.name === "drive.files.create")).toMatchObject({
      supportsMediaUpload: true,
      supportsMediaDownload: false,
      mediaUpload: {
        accept: ["image/png"],
        maxSize: "10MB",
      },
      mediaUploadProtocols: {
        simple: { path: "/upload/drive/v3/files", multipart: false },
        multipart: { path: "/upload/drive/v3/files", multipart: true },
        resumable: { path: "/upload/drive/v3/files", multipart: true },
      },
      inputSchema: {
        properties: {
          body: {
            properties: {
              name: { type: "string" },
              parents: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          media: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              artifact: { type: "string" },
              dataUrl: { type: "string" },
              mimeType: { type: "string" },
              filename: { type: "string" },
            },
          },
        },
      },
    });
    expect(operations.find((operation) => operation.name === "drive.files.download")).toMatchObject(
      {
        supportsMediaDownload: true,
        inputSchema: {
          properties: {
            filename: { type: "string" },
            outputPath: { type: "string" },
          },
        },
      },
    );
  });

  it("rejects invalid discovery documents clearly", () => {
    expect(() =>
      discoveryOperations({
        server: "drive",
        document: { kind: "not-discovery", resources: {} },
      }),
    ).toThrow(/Invalid Google Discovery document/);
  });

  it("maps top-level Discovery methods", () => {
    const operations = discoveryOperations({
      server: "oauth2",
      document: {
        kind: "discovery#restDescription",
        methods: {
          tokeninfo: {
            path: "tokeninfo",
            httpMethod: "GET",
            scopes: ["openid"],
          },
        },
      },
    });

    expect(operations).toEqual([
      expect.objectContaining({
        name: "oauth2.tokeninfo",
        method: "get",
        path: "tokeninfo",
        scopes: ["openid"],
      }),
    ]);
  });
});

describe("GoogleDiscoveryManager", () => {
  it("lists, describes, searches, resolves scopes, and calls Google Discovery operations", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
          includeOperations: ["drive.files.*"],
          excludeOperations: ["drive.files.delete"],
        },
      },
    });
    const registry = new ServerRegistry(config);
    const manager = new GoogleDiscoveryManager(registry);
    const caplet = config.googleDiscoveryApis.drive!;

    await expect(manager.listTools(caplet)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "drive.files.list" }),
        expect.objectContaining({ name: "drive.files.create" }),
      ]),
    );
    await expect(manager.getTool(caplet, "drive.files.list")).resolves.toMatchObject({
      inputSchema: { properties: { query: { properties: { pageSize: { type: "integer" } } } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(
      manager.search(caplet, await manager.listTools(caplet), "list", 5).map((tool) => tool.name),
    ).toContain("drive.files.list");
    await expect(manager.resolveAuthScopes(caplet)).resolves.toEqual([
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);

    await expect(
      manager.callTool(caplet, "drive.files.list", { query: { pageSize: 2 } }),
    ).resolves.toMatchObject({
      structuredContent: { status: 200, body: { files: [{ id: "1", name: "Report" }] } },
      isError: false,
    });
    expect(requests.find((request) => request.url.startsWith("/drive/v3/files?"))?.url).toContain(
      "pageSize=2",
    );
  });

  it("infers the request base URL from Discovery rootUrl and servicePath", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive-inferred.discovery.json`,
          auth: { type: "none" },
          includeOperations: ["drive.files.list"],
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));

    await expect(
      manager.callTool(config.googleDiscoveryApis.drive!, "drive.files.list", {
        query: { pageSize: 2 },
      }),
    ).resolves.toMatchObject({
      structuredContent: { status: 200, body: { files: [{ id: "1", name: "Report" }] } },
    });
    expect(requests.find((request) => request.url.startsWith("/drive/v3/files?"))?.url).toContain(
      "pageSize=2",
    );
  });

  it("expands reserved Discovery path templates without flattening resource names", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/reserved.discovery.json`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));

    await expect(
      manager.callTool(config.googleDiscoveryApis.drive!, "drive.files.getReserved", {
        path: { name: "folders/1" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { status: 200, body: { id: "folders/1" } },
    });
    expect(requests.find((request) => request.url === "/drive/v3/files/folders/1")).toBeDefined();
  });

  it("rejects Discovery operation paths that escape the configured base path", () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const caplet = config.googleDiscoveryApis.drive!;
    const operation = {
      name: "drive.escape",
      method: "get" as const,
      path: "../admin",
      description: "Escape",
      inputSchema: {},
      readOnlyHint: true,
      destructiveHint: false,
      scopes: [],
      supportsMediaUpload: false,
      supportsMediaDownload: false,
      mediaUploadProtocols: {},
      parameterOrder: [],
    };

    expect(() => buildGoogleDiscoveryUrl(caplet, operation, {})).toThrow(/cannot escape baseUrl/u);
    expect(() =>
      buildGoogleDiscoveryUrl(caplet, { ...operation, path: "%2e%2e/admin" }, {}),
    ).toThrow(/cannot escape baseUrl/u);
    expect(() =>
      buildGoogleDiscoveryUrl(
        caplet,
        { ...operation, path: "files/{+name}" },
        {
          path: { name: "../admin" },
        },
      ),
    ).toThrow(/cannot escape baseUrl/u);
  });

  it("serializes repeated query parameters from arrays", () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const caplet = config.googleDiscoveryApis.drive!;
    const operation = {
      name: "drive.files.list",
      method: "get" as const,
      path: "files",
      inputSchema: {},
      readOnlyHint: true,
      destructiveHint: false,
      scopes: [],
      supportsMediaUpload: false,
      supportsMediaDownload: false,
      mediaUploadProtocols: {},
      parameterOrder: [],
    };

    const url = buildGoogleDiscoveryUrl(caplet, operation, {
      query: { label: ["starred", "ownedByMe"] },
    });

    expect(url.searchParams.getAll("label")).toEqual(["starred", "ownedByMe"]);
  });

  it("builds safe media upload URLs with path and query arguments", () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const caplet = config.googleDiscoveryApis.drive!;
    const operation = {
      name: "drive.files.update",
      method: "patch" as const,
      path: "files/{fileId}",
      inputSchema: {},
      readOnlyHint: false,
      destructiveHint: false,
      scopes: [],
      supportsMediaUpload: true,
      supportsMediaDownload: false,
      mediaUploadProtocols: {},
      parameterOrder: [],
    };

    const url = buildGoogleDiscoveryUploadUrl(
      caplet,
      operation,
      "/upload/drive/v3/files/{fileId}",
      "media",
      { path: { fileId: "1" }, query: { fields: "id" } },
    );

    expect(url.toString()).toBe(`${baseUrl}/upload/drive/v3/files/1?fields=id&uploadType=media`);
    expect(() =>
      buildGoogleDiscoveryUploadUrl(caplet, operation, "https://evil.example/upload", "media", {}),
    ).toThrow(/cannot change origin/u);
  });

  it("rejects redirected discovery documents", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/redirect.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));

    await expect(manager.listTools(config.googleDiscoveryApis.drive!)).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
  });

  it("executes Google Discovery operations through handleServerTool", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const manager = new GoogleDiscoveryManager(registry);
    const downstream = new DownstreamManager(registry);
    const caplet = config.googleDiscoveryApis.drive!;

    const list = await handleServerTool(
      caplet,
      { operation: "tools" },
      registry,
      downstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      manager,
    );

    expect(
      list.structuredContent.result.items.map((tool: { name: string }) => tool.name),
    ).toContain("drive.files.list");

    await downstream.close();
  });

  it("writes Google media downloads as artifacts", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));
    const result = await manager.callTool(
      config.googleDiscoveryApis.drive!,
      "drive.files.download",
      {
        path: { fileId: "1" },
        filename: "report.pdf",
      },
    );

    expect(result.structuredContent).toMatchObject({
      status: 200,
      body: { artifact: { filename: "report.pdf", mimeType: "application/pdf" } },
    });
  });

  it("honors outputPath for inlineable Google media downloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-google-download-"));
    try {
      const outputPath = join(dir, "drive", "call", "export.txt");
      const config = parseConfig({
        googleDiscoveryApis: {
          drive: {
            name: "Google Drive",
            description: "Access Google Drive files.",
            discoveryUrl: `${baseUrl}/drive.discovery.json`,
            baseUrl: `${baseUrl}/drive/v3/`,
            auth: { type: "none" },
          },
        },
      });
      const manager = new GoogleDiscoveryManager(new ServerRegistry(config), { artifactDir: dir });
      const result = await manager.callTool(
        config.googleDiscoveryApis.drive!,
        "drive.files.download",
        {
          path: { fileId: "text" },
          outputPath,
        },
      );

      expect(existsSync(outputPath)).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 200,
        body: { artifact: { path: outputPath, filename: "export.txt", mimeType: "text/plain" } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes large Google media downloads as artifacts", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));
    const result = await manager.callTool(
      config.googleDiscoveryApis.drive!,
      "drive.files.download",
      {
        path: { fileId: "large" },
        filename: "large.pdf",
      },
    );

    expect(result.structuredContent).toMatchObject({
      status: 200,
      body: {
        artifact: {
          filename: "large.pdf",
          mimeType: "application/pdf",
          byteLength: 1024 * 1024 + 1,
        },
      },
    });
  });

  it("uploads media from dataUrl using multipart when metadata body is present", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/drive.discovery.json`,
          baseUrl: `${baseUrl}/drive/v3/`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));
    const result = await manager.callTool(config.googleDiscoveryApis.drive!, "drive.files.create", {
      body: { name: "report.pdf" },
      media: { dataUrl: "data:application/pdf;base64,cGRm", filename: "report.pdf" },
    });

    expect(result.structuredContent).toMatchObject({ status: 200, body: { id: "uploaded" } });
    const upload = requests.find((request) => request.url.includes("uploadType=multipart"));
    expect(upload?.headers["content-type"]).toContain("multipart/related");
    expect(upload?.body).not.toContain("cGRm");
  });

  it("uses resumable upload to preserve metadata when multipart is unavailable", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/upload-resumable.discovery.json`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));
    const result = await manager.callTool(config.googleDiscoveryApis.drive!, "drive.files.create", {
      body: { name: "report.pdf" },
      media: { dataUrl: "data:application/pdf;base64,cGRm", filename: "report.pdf" },
    });

    expect(result.structuredContent).toMatchObject({
      status: 200,
      body: { id: "uploaded-resumable" },
    });
    const start = requests.find((request) => request.url.includes("uploadType=resumable"));
    expect(start?.body).toBe(JSON.stringify({ name: "report.pdf" }));
    expect(start?.headers["x-upload-content-type"]).toBe("application/pdf");
    expect(requests.find((request) => request.url.includes("uploadType=media"))).toBeUndefined();
  });

  it("substitutes path and query args into media upload URLs", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/upload-path.discovery.json`,
          auth: { type: "none" },
        },
      },
    });
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config));
    const result = await manager.callTool(config.googleDiscoveryApis.drive!, "drive.files.update", {
      path: { fileId: "1" },
      query: { fields: "id" },
      media: { dataUrl: "data:text/plain;base64,aGVsbG8=", filename: "hello.txt" },
    });

    expect(result.structuredContent).toMatchObject({ status: 200, body: { id: "1" } });
    expect(
      requests.find((request) => request.url.startsWith("/upload/drive/v3/files/1?"))?.url,
    ).toContain("fields=id");
  });

  it("surfaces Google OAuth failures as auth-required errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-google-auth-error-"));
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          discoveryUrl: `${baseUrl}/auth-error.discovery.json`,
          auth: {
            type: "oauth2",
            tokenUrl: `${baseUrl}/token`,
            clientId: "client",
          },
        },
      },
    });
    writeTokenBundle(
      {
        server: "drive",
        authType: "oauth2",
        accessToken: "expired-access-token",
        tokenType: "Bearer",
        expiresAt: "2999-01-01T00:00:00.000Z",
        clientId: "client",
        protectedResourceOrigin: baseUrl,
        metadata: {
          requestedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
        },
      },
      dir,
    );
    const manager = new GoogleDiscoveryManager(new ServerRegistry(config), { authDir: dir });

    try {
      await expect(
        manager.callTool(config.googleDiscoveryApis.drive!, "drive.files.protected", {}),
      ).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        details: {
          server: "drive",
          status: 401,
          nextAction: "run_caplets_auth_login",
          challenge: "[REDACTED]",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
