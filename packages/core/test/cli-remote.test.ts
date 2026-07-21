import { once } from "node:events";
import { scheduler } from "node:timers/promises";

import { createServer, type Server } from "node:http";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli";
import { remoteProfileKey } from "../src/remote/profiles";

const roots: string[] = [];
const servers: Server[] = [];

function fixture(remoteUrl = "http://127.0.0.1:5387") {
  const root = mkdtempSync(join(tmpdir(), "caplets-cli-remote-"));
  roots.push(root);
  const authDir = join(root, "auth");
  const origin = new URL(remoteUrl).origin;
  const key = remoteProfileKey({ origin });
  const profileRoot = join(authDir, "remote-profiles");
  mkdirSync(join(profileRoot, "profiles"), { recursive: true });
  mkdirSync(join(profileRoot, "credentials"), { recursive: true });
  writeFileSync(
    join(profileRoot, "profiles", `${encodeURIComponent(key)}.json`),
    JSON.stringify({
      version: 2,
      key,
      origin,
      clientId: "rcli_operator",
      clientLabel: "CLI migration test",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(profileRoot, "credentials", `${encodeURIComponent(key)}.json`),
    JSON.stringify({
      accessToken: "paired-operator-token",
      refreshToken: "paired-refresh-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }),
  );
  return {
    authDir,
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_REMOTE_URL: remoteUrl,
      CAPLETS_CONFIG: join(root, "missing-config.json"),
      CAPLETS_PROJECT_CONFIG: join(root, "missing-project.json"),
      XDG_STATE_HOME: join(root, "state"),
    },
  };
}

function attachManifest() {
  return {
    version: 1,
    revision: "attach-revision",
    generatedAt: "2026-07-20T00:00:00.000Z",
    caplets: [
      {
        stableId: "progressive:github",
        exportId: "github-export",
        kind: "caplet",
        name: "github",
        title: "GitHub",
        description: "GitHub tools",
        inputSchema: { type: "object" },
        schemaHash: "sha256:github",
        capletId: "github",
        shadowing: "allow",
      },
    ],
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    completions: [],
    codeModeCaplets: [],
    diagnostics: [],
  };
}

function remoteOptions(context: ReturnType<typeof fixture>, fetch: typeof globalThis.fetch) {
  return {
    authDir: context.authDir,
    env: context.env,
    fetch,
  };
}

function requestFor(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("remote CLI canonical transports", () => {
  it("uses generated Admin operations and preserves install output with the paired profile credential", async () => {
    const context = fixture();
    const out: string[] = [];
    const adminRequests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      adminRequests.push(request);
      return Response.json(
        {
          installed: [
            {
              id: "github",
              destination: "/srv/caplets/.caplets/github",
              source: "repo#caplets/github",
              kind: "directory",
            },
          ],
          setupActions: [],
        },
        { status: 201 },
      );
    });

    await runCli(["install", "spiritledsoftware/caplets", "github", "--remote"], {
      ...remoteOptions(context, fetch),
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toBe("Installed github to remote /srv/caplets/.caplets/github\n");
    expect(adminRequests).toHaveLength(1);
    expect(adminRequests[0]?.url).toBe("http://127.0.0.1:5387/api/v2/admin/catalog/installations");
    expect(adminRequests[0]?.headers.get("authorization")).toBe("Bearer paired-operator-token");
  });

  it("streams filesystem descriptors through a backpressured Admin HTTP upload", async () => {
    let uploadContentType: string | undefined;
    let uploadBody = "";
    let uploadPath: string | undefined;
    const server = createServer(async (request, response) => {
      uploadPath = new URL(request.url ?? "/", "http://localhost").pathname;
      response.setHeader("Content-Type", "application/json");
      uploadContentType = request.headers["content-type"];
      const decoder = new TextDecoder();
      for await (const chunk of request) {
        uploadBody += decoder.decode(chunk, { stream: true });
        await scheduler.yield();
      }
      uploadBody += decoder.decode();
      response.statusCode = 201;
      response.end(JSON.stringify({ id: "remote-record", currentRevision: {} }));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server address missing.");

    const context = fixture(`http://127.0.0.1:${address.port}`);
    const bundlePath = join(context.authDir, "bundle");
    mkdirSync(bundlePath);
    writeFileSync(join(bundlePath, "CAPLET.md"), "# Remote\n");
    const out: string[] = [];

    await runCli(
      ["storage", "records", "import", bundlePath, "--id", "remote-record", "--remote"],
      {
        ...remoteOptions(context, globalThis.fetch),
        writeOut: (value) => out.push(value),
      },
    );

    expect(uploadPath).toBe("/api/v2/admin/caplet-records/remote-record/bundle");
    expect(uploadContentType).toMatch(/^multipart\/form-data; boundary=caplets-/u);
    expect(uploadBody).not.toContain("contentBase64");
    expect(uploadBody).not.toContain("IyBSZW1vdGUK");
    expect(uploadBody).toContain("# Remote\n");
    const serializedManifest = uploadBody.match(
      /name="manifest"\r\nContent-Type: application\/json\r\n\r\n(.+?)\r\n--/su,
    )?.[1];
    expect(serializedManifest).toBeDefined();
    expect(JSON.parse(serializedManifest!)).toMatchObject({
      version: 1,
      files: [
        {
          path: "CAPLET.md",
          size: 9,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          executable: false,
        },
      ],
    });
    expect(JSON.parse(out.join(""))).toMatchObject({ id: "remote-record" });
  });

  it("routes runtime list and completion through canonical Attach", async () => {
    const context = fixture();
    const listOut: string[] = [];
    const completionOut: string[] = [];
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/api/v1/attach/manifest") return Response.json(attachManifest());
      throw new Error(`Unexpected Attach request ${path}`);
    });

    await runCli(["list", "--json"], {
      ...remoteOptions(context, fetch),
      writeOut: (value) => listOut.push(value),
    });
    await runCli(["__complete", "--shell", "bash", "--", "inspect", ""], {
      ...remoteOptions(context, fetch),
      writeOut: (value) => completionOut.push(value),
    });

    expect(JSON.parse(listOut.join(""))).toEqual([
      expect.objectContaining({ server: "github", backend: "attach", name: "GitHub" }),
    ]);
    expect(completionOut.join("")).toBe("github\n");
  });

  it("routes runtime execution through Attach and preserves JSON formatting", async () => {
    const context = fixture();
    const out: string[] = [];
    const invokes: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/attach/manifest") return Response.json(attachManifest());
      if (path === "/api/v1/attach/sessions") {
        return Response.json({ sessionId: "attach-session" }, { status: 201 });
      }
      if (path === "/api/v1/attach/invoke") {
        invokes.push(await request.json());
        return Response.json({
          ok: true,
          data: {
            content: [{ type: "text", text: "done" }],
            structuredContent: { ok: true, count: 2 },
          },
        });
      }
      throw new Error(`Unexpected Attach request ${path}`);
    });

    await runCli(
      ["call-tool", "github.search", "--args", '{"query":"caplets"}', "--format", "json"],
      {
        ...remoteOptions(context, fetch),
        writeOut: (value) => out.push(value),
      },
    );

    expect(invokes).toEqual([
      expect.objectContaining({
        kind: "caplet",
        input: { operation: "call_tool", name: "search", args: { query: "caplets" } },
      }),
    ]);
    expect(JSON.parse(out.join(""))).toEqual({
      content: [{ type: "text", text: "done" }],
      structuredContent: { ok: true, count: 2 },
    });
  });

  it.each(["init", "add"])(
    "rejects remote %s locally without network activity",
    async (command) => {
      const context = fixture();
      const fetch = vi.fn<typeof globalThis.fetch>();
      const args =
        command === "init"
          ? ["init", "--remote"]
          : [
              "add",
              "mcp",
              "github",
              "--url",
              "https://mcp.example.com/mcp",
              "--transport",
              "http",
              "--remote",
            ];

      await expect(
        runCli(args, {
          ...remoteOptions(context, fetch),
          writeOut: () => {},
        }),
      ).rejects.toThrow(`Remote ${command} is local-only`);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not downgrade or retry when an Access client reaches canonical Admin", async () => {
    const context = fixture();
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json(
        {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "Operator role required.",
          code: "AUTH_FAILED",
        },
        { status: 403, headers: { "content-type": "application/problem+json" } },
      );
    });

    await expect(
      runCli(["install", "spiritledsoftware/caplets", "github", "--remote"], {
        ...remoteOptions(context, fetch),
        writeOut: () => {},
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(paths).toEqual(["/api/v2/admin/catalog/installations"]);
  });
});
