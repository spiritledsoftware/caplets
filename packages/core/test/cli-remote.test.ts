import { once } from "node:events";
import { scheduler } from "node:timers/promises";

import { createServer, type Server } from "node:http";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli";
import { normalizeRemoteProfileHostUrl } from "../src/remote/options";
import { remoteProfileKey } from "../src/remote/profiles";

const roots: string[] = [];
const servers: Server[] = [];
const v1 = {
  version: 1,
  path: "/caplets/v1",
  links: {
    admin: "/caplets/v1/admin",
    attachManifest: "/caplets/v1/attach/manifest",
    attachInvoke: "/caplets/v1/attach/invoke",
  },
};
const v2 = {
  version: 2,
  path: "/caplets/v2",
  links: { admin: "/caplets/v2/admin" },
};

function fixture(remoteUrl = "http://127.0.0.1:5387/caplets") {
  const root = mkdtempSync(join(tmpdir(), "caplets-cli-remote-"));
  roots.push(root);
  const authDir = join(root, "auth");
  const hostUrl = normalizeRemoteProfileHostUrl(remoteUrl);
  const key = remoteProfileKey({ kind: "self-hosted", hostUrl });
  const profileRoot = join(authDir, "remote-profiles");
  mkdirSync(join(profileRoot, "profiles"), { recursive: true });
  mkdirSync(join(profileRoot, "credentials"), { recursive: true });
  writeFileSync(
    join(profileRoot, "profiles", `${encodeURIComponent(key)}.json`),
    JSON.stringify({
      version: 1,
      kind: "self-hosted",
      key,
      hostUrl,
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

function serviceRoot(versions: unknown[] = [v1, v2]) {
  return {
    name: "caplets",
    transport: "http",
    base: "/caplets/",
    versions,
    auth: { type: "remote" },
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

describe("remote CLI transport migration", () => {
  it("discovers Admin v2 and preserves install output with the paired profile credential", async () => {
    const context = fixture();
    const out: string[] = [];
    const adminRequests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/caplets/") return Response.json(serviceRoot());
      if (path === "/caplets/v2") return Response.json(v2);
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
    expect(adminRequests[0]?.url).toBe(
      "http://127.0.0.1:5387/caplets/v2/admin/catalog/installations",
    );
    expect(adminRequests[0]?.headers.get("authorization")).toBe("Bearer paired-operator-token");
  });

  it("streams filesystem descriptors through a backpressured Admin HTTP upload", async () => {
    let uploadContentType: string | undefined;
    let uploadBody = "";
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      response.setHeader("Content-Type", "application/json");
      if (path === "/caplets/") {
        response.end(JSON.stringify(serviceRoot()));
        return;
      }
      if (path === "/caplets/v2") {
        response.end(JSON.stringify(v2));
        return;
      }
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

    const context = fixture(`http://127.0.0.1:${address.port}/caplets`);
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

  it("uses frozen v1 only after definitive legacy discovery", async () => {
    const context = fixture();
    const out: string[] = [];
    const legacyRequests: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/caplets/") return Response.json(serviceRoot([v1]));
      if (path === "/caplets/v1") return Response.json(v1);
      legacyRequests.push(await request.json());
      return Response.json({
        ok: true,
        result: {
          remote: true,
          installed: [{ id: "github", destination: "/legacy/github", status: "installed" }],
        },
      });
    });

    await runCli(["install", "spiritledsoftware/caplets", "github", "--remote"], {
      ...remoteOptions(context, fetch),
      writeOut: (value) => out.push(value),
    });

    expect(legacyRequests).toEqual([
      {
        command: "install",
        arguments: {
          repo: "spiritledsoftware/caplets",
          capletIds: ["github"],
          force: false,
        },
      },
    ]);
    expect(out.join("")).toBe("Installed github to remote /legacy/github\n");
  });

  it("routes runtime list and completion through Attach on a v2 Host", async () => {
    const context = fixture();
    const listOut: string[] = [];
    const completionOut: string[] = [];
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/caplets/") return Response.json(serviceRoot());
      if (path === "/caplets/v2") return Response.json(v2);
      if (path === "/caplets/v1/attach/manifest") return Response.json(attachManifest());
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
    expect(paths).not.toContain("/caplets/v1/admin");
    expect(paths).not.toContain("/caplets/v2/admin");
  });

  it("routes runtime execution through Attach and preserves JSON formatting", async () => {
    const context = fixture();
    const out: string[] = [];
    const invokes: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/caplets/") return Response.json(serviceRoot());
      if (path === "/caplets/v2") return Response.json(v2);
      if (path === "/caplets/v1/attach/manifest") return Response.json(attachManifest());
      if (path === "/caplets/v1/attach/sessions") {
        return Response.json({ sessionId: "attach-session" }, { status: 201 });
      }
      if (path === "/caplets/v1/attach/invoke") {
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

  it.each(["init", "add"])("rejects remote %s locally without discovery", async (command) => {
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
  });

  it("does not downgrade after malformed discovery", async () => {
    const context = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));

    await expect(
      runCli(["install", "spiritledsoftware/caplets", "github", "--remote"], {
        ...remoteOptions(context, fetch),
        writeOut: () => {},
      }),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade or retry when an Access client reaches Admin v2", async () => {
    const context = fixture();
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = requestFor(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/caplets/") return Response.json(serviceRoot());
      if (path === "/caplets/v2") return Response.json(v2);
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
    expect(paths).toEqual(["/caplets/", "/caplets/v2", "/caplets/v2/admin/catalog/installations"]);
  });
});
