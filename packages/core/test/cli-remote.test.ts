import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp, type CapletsHttpApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("remote CLI routing", () => {
  it("routes list --json through remote control in remote mode", async () => {
    const requests: unknown[] = [];
    const out: string[] = [];
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body });
      return Response.json({
        ok: true,
        result: [
          {
            server: "github",
            backend: "mcp",
            name: "GitHub",
            description: "GitHub tools",
            disabled: false,
            status: "not_started",
            source: "global-config",
            path: null,
            shadows: [],
          },
        ],
      });
    });

    await runCli(["list", "--json"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
      },
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:5387/caplets/control",
        body: JSON.stringify({ command: "list", arguments: { includeDisabled: false } }),
      },
    ]);
    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "github", backend: "mcp" }),
    ]);
  });

  it("routes call-tool through remote control and preserves JSON formatting", async () => {
    const requests: unknown[] = [];
    const out: string[] = [];
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body });
      return Response.json({
        ok: true,
        result: {
          content: [{ type: "text", text: "done" }],
          structuredContent: { ok: true, count: 2 },
        },
      });
    });

    await runCli(
      ["call-tool", "github.search", "--args", '{"query":"caplets"}', "--format", "json"],
      {
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
        },
        fetch,
        writeOut: (value) => out.push(value),
      },
    );

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:5387/caplets/control",
        body: JSON.stringify({
          command: "call_tool",
          arguments: {
            caplet: "github",
            request: {
              operation: "call_tool",
              tool: "search",
              arguments: { query: "caplets" },
            },
          },
        }),
      },
    ]);
    expect(out.join("")).toBe(
      `${JSON.stringify(
        {
          content: [{ type: "text", text: "done" }],
          structuredContent: { ok: true, count: 2 },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("keeps config path local-only in remote mode", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, result: null }));
    const out: string[] = [];

    await runCli(["config", "path"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
        CAPLETS_CONFIG: "/tmp/caplets-local-config.json",
      },
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(out.join("")).toBe("/tmp/caplets-local-config.json\n");
  });

  it("keeps config paths local-only in remote mode", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, result: null }));
    const out: string[] = [];

    await runCli(["config", "paths", "--json"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
        CAPLETS_CONFIG: "/tmp/caplets-local-config.json",
      },
      fetch,
      authDir: "/tmp/caplets-auth",
      writeOut: (value) => out.push(value),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(""))).toMatchObject({
      userConfig: "/tmp/caplets-local-config.json",
      envConfig: "/tmp/caplets-local-config.json",
      authDir: "/tmp/caplets-auth",
    });
  });
  it("routes add mcp through remote control and labels the remote path", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              remote: true,
              label: "MCP",
              path: "/srv/caplets/.caplets/github.md",
              text: "mcpServer:\n",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runCli(
      ["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--transport", "http"],
      {
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
        },
        fetch: fetchMock as typeof fetch,
        writeOut: (value) => out.push(value),
      },
    );

    expect(out.join("")).toBe("Wrote remote MCP Caplet to /srv/caplets/.caplets/github.md\n");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({
          command: "add",
          arguments: {
            kind: "mcp",
            id: "github",
            options: {
              arg: [],
              env: [],
              url: "https://mcp.example.com/mcp",
              transport: "http",
            },
          },
        }),
      }),
    );
  });

  it("uses a remote in-process control app without mutating local config", async () => {
    const remote = remoteServerFixture();
    const local = clientFixture();
    const out: string[] = [];
    const localConfigBefore = readFileSync(local.configPath, "utf8");

    try {
      await runCli(["add", "mcp", "remote-tools", "--url", "https://mcp.example.com/mcp"], {
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
          CAPLETS_CONFIG: local.configPath,
        },
        fetch: async (input, init) => remote.app.fetch(new Request(input, init)),
        writeOut: (value) => out.push(value),
      });

      expect(existsSync(join(remote.projectCapletsRoot, "remote-tools.md"))).toBe(true);
      expect(existsSync(join(local.projectCapletsRoot, "remote-tools.md"))).toBe(false);
      expect(readFileSync(local.configPath, "utf8")).toBe(localConfigBefore);
      expect(out.join("")).toContain("remote");
    } finally {
      await remote.app.closeCapletsSessions();
      await remote.engine.close();
    }
  });

  it("rejects local destination fields for remote add mcp requests", async () => {
    await expect(
      runRemoteAdd([
        "mcp",
        "github",
        "--url",
        "https://mcp.example.com/mcp",
        "--transport",
        "http",
        "--arg",
        "--verbose",
        "--env",
        "TOKEN=secret",
        "--token-env",
        "GITHUB_TOKEN",
        "--global",
        "--print",
        "--output",
        "/tmp/github.md",
        "--force",
      ]),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("--global is not supported in remote mode"),
    });
  });

  it.each([
    [
      "cli",
      ["cli", "repo-tools", "--repo", "/work/repo", "--command", "git"],
      { repo: "/work/repo", command: "git" },
    ],
    [
      "openapi",
      [
        "openapi",
        "users",
        "--spec",
        "./openapi.yaml",
        "--base-url",
        "https://api.example.com",
        "--token-env",
        "API_TOKEN",
      ],
      { spec: "./openapi.yaml", baseUrl: "https://api.example.com", tokenEnv: "API_TOKEN" },
    ],
    [
      "graphql",
      [
        "graphql",
        "catalog",
        "--endpoint-url",
        "https://api.example.com/graphql",
        "--schema",
        "./schema.graphql",
        "--introspection",
        "--token-env",
        "GRAPHQL_TOKEN",
      ],
      {
        endpointUrl: "https://api.example.com/graphql",
        schema: "./schema.graphql",
        introspection: true,
        tokenEnv: "GRAPHQL_TOKEN",
      },
    ],
    [
      "http",
      [
        "http",
        "users",
        "--base-url",
        "https://api.example.com",
        "--action",
        "list:GET:/users",
        "--token-env",
        "HTTP_TOKEN",
      ],
      {
        action: ["list:GET:/users"],
        baseUrl: "https://api.example.com",
        tokenEnv: "HTTP_TOKEN",
      },
    ],
  ])("routes add %s through remote control", async (kind, args, options) => {
    const request = await runRemoteAdd(args);

    expect(request).toEqual({
      command: "add",
      arguments: {
        kind,
        id: args[1],
        options,
      },
    });
  });

  it("routes install through remote control", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              remote: true,
              installed: [
                {
                  id: "github",
                  destination: "/srv/caplets/.caplets/github",
                  source: "repo#caplets/github",
                  kind: "directory",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runCli(["install", "spiritledsoftware/caplets", "github"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toBe("Installed github to remote /srv/caplets/.caplets/github\n");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({
          command: "install",
          arguments: {
            repo: "spiritledsoftware/caplets",
            capletIds: ["github"],
            force: false,
          },
        }),
      }),
    );
  });

  it("warns when remote install receives --global", async () => {
    const err: string[] = [];
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          remote: true,
          installed: [{ id: "github", destination: "/srv/caplets/.caplets/github" }],
        },
      }),
    );

    await runCli(["install", "spiritledsoftware/caplets", "github", "--global"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeErr: (value) => err.push(value),
      writeOut: () => {},
    });

    expect(err.join("")).toContain("--global is not supported in remote mode");
  });

  it("routes init through remote control", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { remote: true, path: "/srv/caplets/config.json" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runCli(["init", "--force"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toBe("Created remote Caplets config at /srv/caplets/config.json\n");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({ command: "init", arguments: { force: true } }),
      }),
    );
  });

  it("routes auth list and logout through remote control", async () => {
    const out: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [{ server: "remote", status: "authenticated" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { server: "remote", deleted: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const io = {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value: string) => out.push(value),
    };

    await runCli(["auth", "list", "--json"], io);
    await runCli(["auth", "logout", "remote"], io);

    expect(JSON.parse(out[0]!)).toEqual([{ server: "remote", status: "authenticated" }]);
    expect(out[1]).toBe("Deleted remote OAuth credentials for `remote`.\n");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({ command: "auth_list", arguments: {} }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({ command: "auth_logout", arguments: { server: "remote" } }),
      }),
    );
  });

  it("does not print or open an auth URL when remote auth is already complete", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, result: { server: "remote", authenticated: true } }),
    );

    await runCli(["auth", "login", "remote"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toBe("Authenticated `remote`.\n");
  });

  it("prints pending instructions instead of authenticated when remote auth needs browser completion", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          server: "remote",
          flowId: "flow-1",
          authorizationUrl: "https://auth.example/authorize",
        },
      }),
    );

    await runCli(["auth", "login", "remote", "--no-open"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toBe(
      "Open this URL to authorize remote:\n" +
        "https://auth.example/authorize\n" +
        "Complete authentication in your browser. The server callback will store credentials.\n",
    );
  });
});

async function runRemoteAdd(args: string[]): Promise<unknown> {
  const requests: unknown[] = [];
  const fetchMock = vi.fn(
    async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) });
      return Response.json({
        ok: true,
        result: {
          remote: true,
          path: "/srv/caplets/.caplets/generated.md",
          text: "generated\n",
        },
      });
    },
  );

  await runCli(["add", ...args], {
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
    },
    fetch: fetchMock as typeof fetch,
    writeOut: () => {},
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ url: "http://127.0.0.1:5387/control" });
  return JSON.parse((requests[0] as { body: string }).body);
}

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/caplets",
    auth: { enabled: false, user: "caplets" },
    warnUnauthenticatedNetwork: false,
    loopback: true,
    ...overrides,
  };
}

function remoteServerFixture(): {
  app: CapletsHttpApp;
  engine: CapletsEngine;
  projectCapletsRoot: string;
} {
  const context = testContext("caplets-cli-remote-server-");
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    watch: false,
  });
  const app = createHttpServeApp(httpOptions(), engine, {
    writeErr: () => {},
    control: context,
  });
  return { app, engine, projectCapletsRoot: context.projectCapletsRoot };
}

function clientFixture(): { configPath: string; projectCapletsRoot: string } {
  const context = testContext("caplets-cli-remote-client-");
  return { configPath: context.configPath, projectCapletsRoot: context.projectCapletsRoot };
}

function testContext(prefix: string): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
  watch: false;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectCapletsRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectCapletsRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectCapletsRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "Fixture server.",
          transport: "stdio",
          command: "node",
          disabled: true,
        },
      },
    }),
  );
  return { configPath, projectConfigPath, projectCapletsRoot, watch: false };
}
