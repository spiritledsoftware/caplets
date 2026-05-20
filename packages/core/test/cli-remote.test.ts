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
});
