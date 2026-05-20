import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

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
});
