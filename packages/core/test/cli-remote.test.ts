import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  it("routes hidden completion through remote control in remote mode", async () => {
    const context = testContext("caplets-cli-remote-complete-only-");
    const requests: unknown[] = [];
    const out: string[] = [];
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true, result: ["github", "linear"] });
      },
    );

    await runCli(["__complete", "--shell", "bash", "--", "get-caplet", ""], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
        CAPLETS_CONFIG: join(dirname(context.configPath), "missing-config.json"),
        CAPLETS_PROJECT_CONFIG: context.projectConfigPath,
      },
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(requests).toEqual([
      { command: "complete_cli", arguments: { shell: "bash", words: ["get-caplet", ""] } },
    ]);
    expect(out.join("")).toBe("github\nlinear\n");
  });

  it("includes local overlay suggestions before remote suggestions in remote completion", async () => {
    const context = testContext("caplets-cli-remote-complete-overlay-");
    const requests: unknown[] = [];
    const out: string[] = [];
    writeCliCapletConfig(context.configPath, "local", "Local CLI");
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true, result: ["remote"] });
      },
    );

    await runCli(["__complete", "--shell", "bash", "--", "get-caplet", ""], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(requests).toEqual([
      { command: "complete_cli", arguments: { shell: "bash", words: ["get-caplet", ""] } },
    ]);
    expect(out.join("")).toBe("local\nremote\n");
  });

  it("does not append remote qualified completions for locally shadowed caplets", async () => {
    const context = testContext("caplets-cli-remote-complete-shadowed-");
    const requests: unknown[] = [];
    const out: string[] = [];
    writeCliCapletConfig(context.configPath, "shared", "Shared Local");
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true, result: ["shared.remote_only"] });
      },
    );

    await runCli(["__complete", "--shell", "bash", "--", "call-tool", "shared."], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(requests).toEqual([]);
    expect(out.join("")).toBe("shared.echo\n");
  });

  it("keeps hidden remote completion quiet when remote control fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const fetch = vi.fn(async () => Response.json({ ok: false, error: "server unavailable" }));

    await runCli(["__complete", "--shell", "bash", "--", "get-caplet", ""], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
      },
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it("keeps hidden remote completion quiet when local overlay has warnings", async () => {
    const context = testContext("caplets-cli-remote-complete-warning-quiet-");
    const out: string[] = [];
    const err: string[] = [];
    const fetch = vi.fn(async () => Response.json({ ok: true, result: ["remote"] }));
    writeFileSync(context.configPath, "{ invalid json");

    await runCli(["__complete", "--shell", "bash", "--", "get-caplet", ""], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(out.join("")).toBe("remote\n");
    expect(err).toEqual([]);
  });

  it("routes list --json through remote control in remote mode", async () => {
    const context = testContext("caplets-cli-remote-list-only-");
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
        CAPLETS_CONFIG: join(dirname(context.configPath), "missing-config.json"),
        CAPLETS_PROJECT_CONFIG: context.projectConfigPath,
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

  it("falls back to remote list when local overlay loading warns", async () => {
    const context = testContext("caplets-cli-remote-list-overlay-invalid-");
    const out: string[] = [];
    const err: string[] = [];
    writeFileSync(context.configPath, "{ invalid json", "utf8");
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, result: [remoteListRow("remote-only", "Remote Only")] }),
    );

    await runCli(["list", "--json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "remote-only", source: "remote" }),
    ]);
    expect(err.join("")).toContain("Warning: global-config");
  });

  it("merges remote, global, and project rows for list in remote mode", async () => {
    const context = testContext("caplets-cli-remote-list-merge-");
    const out: string[] = [];
    writeCliCapletConfig(context.configPath, "global-only", "Global Only");
    writeProjectMcpCaplet(context.projectCapletsRoot, "project-only", "Project Only");
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        result: [remoteListRow("remote-only", "Remote Only")],
      }),
    );

    await runCli(["list", "--json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "global-only", source: "global-config" }),
      expect.objectContaining({ server: "project-only", source: "project-file" }),
      expect.objectContaining({ server: "remote-only", source: "remote" }),
    ]);
  });

  it("lists local Caplet sets in merged remote mode output", async () => {
    const context = testContext("caplets-cli-remote-list-caplet-set-");
    const out: string[] = [];
    writeCapletSetConfig(context.configPath, "toolkit", "Toolkit");
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, result: [remoteListRow("remote-only", "Remote Only")] }),
    );

    await runCli(["list", "--json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "remote-only", source: "remote" }),
      expect.objectContaining({ server: "toolkit", backend: "caplets", source: "global-config" }),
    ]);
  });

  it("lets disabled local overlay rows shadow remote rows before default list filtering", async () => {
    const context = testContext("caplets-cli-remote-list-disabled-shadow-");
    const out: string[] = [];
    const err: string[] = [];
    writeCliCapletConfig(context.configPath, "shared", "Disabled Shared", { disabled: true });
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, result: [remoteListRow("shared", "Remote Shared")] }),
    );

    await runCli(["list", "--json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([]);
    expect(err.join("")).toContain("global Caplet shared shadows remote Caplet");
  });

  it("lets project list rows shadow remote rows and warns on stderr", async () => {
    const context = testContext("caplets-cli-remote-list-project-shadow-");
    const out: string[] = [];
    const err: string[] = [];
    writeProjectMcpCaplet(context.projectCapletsRoot, "shared", "Project Shared");
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, result: [remoteListRow("shared", "Remote Shared")] }),
    );

    await runCli(["list", "--json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "shared", name: "Project Shared", source: "project-file" }),
    ]);
    expect(err.join("")).toContain("project Caplet shared shadows remote Caplet");
  });

  it("lets global list rows shadow remote rows and warns on stderr", async () => {
    const context = testContext("caplets-cli-remote-list-global-shadow-");
    const out: string[] = [];
    const err: string[] = [];
    writeCliCapletConfig(context.configPath, "shared", "Global Shared");
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, result: [remoteListRow("shared", "Remote Shared")] }),
    );

    await runCli(["list", "--json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "shared", name: "Global Shared", source: "global-config" }),
    ]);
    expect(err.join("")).toContain("global Caplet shared shadows remote Caplet");
  });

  it("routes call-tool through remote control and preserves JSON formatting", async () => {
    const context = testContext("caplets-cli-remote-call-only-");
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
          CAPLETS_CONFIG: join(dirname(context.configPath), "missing-config.json"),
          CAPLETS_PROJECT_CONFIG: context.projectConfigPath,
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

  it("executes a local overlay caplet locally in remote mode", async () => {
    const context = testContext("caplets-cli-remote-local-exec-");
    const out: string[] = [];
    const err: string[] = [];
    const fetch = vi.fn(async () => Response.json({ ok: false, error: "should not call remote" }));
    writeCliCapletConfig(context.configPath, "local", "Local CLI");

    await runCli(
      ["call-tool", "local.echo", "--args", '{"message":"from local"}', "--format", "json"],
      {
        env: remoteEnv(context),
        fetch,
        writeOut: (value) => out.push(value),
        writeErr: (value) => err.push(value),
      },
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(""))).toMatchObject({
      structuredContent: { json: { message: "from local" } },
    });
    expect(err).toEqual([]);
  });

  it("executes a disabled local overlay caplet locally instead of falling back to remote", async () => {
    const context = testContext("caplets-cli-remote-disabled-local-exec-");
    const out: string[] = [];
    const fetch = vi.fn(async () => Response.json({ ok: false, error: "should not call remote" }));
    let exitCode: number | undefined;
    writeCliCapletConfig(context.configPath, "shared", "Disabled Shared", { disabled: true });

    await runCli(["call-tool", "shared.echo", "--format", "json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({ isError: true });
  });

  it("falls back to remote control when no local overlay contains the caplet", async () => {
    const context = testContext("caplets-cli-remote-fallback-");
    const requests: unknown[] = [];
    const out: string[] = [];
    writeCliCapletConfig(context.configPath, "local", "Local CLI");
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true, result: { content: [{ type: "text", text: "remote" }] } });
      },
    );

    await runCli(["call-tool", "remote.echo", "--format", "json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
    });

    expect(requests).toEqual([
      {
        command: "call_tool",
        arguments: {
          caplet: "remote",
          request: { operation: "call_tool", tool: "echo", arguments: {} },
        },
      },
    ]);
    expect(JSON.parse(out.join(""))).toEqual({ content: [{ type: "text", text: "remote" }] });
  });

  it("falls back to remote execution when local overlay loading warns", async () => {
    const context = testContext("caplets-cli-remote-exec-overlay-invalid-");
    const requests: unknown[] = [];
    const out: string[] = [];
    const err: string[] = [];
    writeFileSync(context.configPath, "{ invalid json", "utf8");
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ ok: true, result: { content: [{ type: "text", text: "remote" }] } });
      },
    );

    await runCli(["call-tool", "remote.echo", "--format", "json"], {
      env: remoteEnv(context),
      fetch,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(requests).toEqual([
      {
        command: "call_tool",
        arguments: {
          caplet: "remote",
          request: { operation: "call_tool", tool: "echo", arguments: {} },
        },
      },
    ]);
    expect(JSON.parse(out.join(""))).toEqual({ content: [{ type: "text", text: "remote" }] });
    expect(err.join("")).toContain("Warning: global-config");
  });

  it("formats new MCP commands as markdown by default and honors --format", async () => {
    const requests: unknown[] = [];
    const out: string[] = [];
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { command: string };
      requests.push({ url: String(url), body: init?.body });
      if (body.command === "list_resources") {
        return Response.json({
          ok: true,
          result: {
            structuredContent: {
              result: {
                id: "docs",
                resources: [{ kind: "resource", uri: "file:///repo/README.md", name: "README" }],
                resourceTemplates: [
                  { kind: "resourceTemplate", uriTemplate: "file:///repo/{path}", name: "File" },
                ],
              },
            },
          },
        });
      }
      if (body.command === "read_resource") {
        return Response.json({
          ok: true,
          result: { contents: [{ uri: "file:///repo/README.md", text: "# Hello" }] },
        });
      }
      return Response.json({
        ok: true,
        result: { completion: { values: ["src/index.ts"] } },
      });
    });

    const io = {
      env: { CAPLETS_MODE: "remote", CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets" },
      fetch,
      writeOut: (value: string) => out.push(value),
    };

    await runCli(["list-resources", "docs"], io);
    await runCli(["read-resource", "docs", "file:///repo/README.md", "--format", "plain"], io);
    await runCli(
      [
        "complete",
        "docs",
        "--resource-template",
        "file:///repo/{path}",
        "--argument",
        "path",
        "--value",
        "src/",
        "--format",
        "json",
      ],
      io,
    );

    expect(out[0]).toContain("## MCP resources for `docs`");
    expect(out[0]).toContain("- resource: `file:///repo/README.md`");
    expect(out[0]).not.toContain('"resources"');
    expect(out[1]).toContain("Resource file:///repo/README.md");
    expect(out[1]).toContain("# Hello");
    expect(JSON.parse(out[2] ?? "{}")).toEqual({ completion: { values: ["src/index.ts"] } });
    expect(
      requests.map((request) => JSON.parse(String((request as { body: string }).body)).command),
    ).toEqual(["list_resources", "read_resource", "complete"]);
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
  it("adds mcp to the project by default in remote mode", async () => {
    const context = testContext("caplets-cli-remote-add-project-");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));

    await runCli(["add", "mcp", "github", "--url", "https://mcp.example.com/mcp"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    const output = join(context.projectCapletsRoot, "github.md");
    expect(readFileSync(output, "utf8")).toContain('url: "https://mcp.example.com/mcp"');
    expect(out.join("")).toBe(`Wrote MCP Caplet to ${output}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds mcp to the project with --project in remote mode", async () => {
    const context = testContext("caplets-cli-remote-add-explicit-project-");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));

    await runCli(["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--project"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    const output = join(context.projectCapletsRoot, "github.md");
    expect(readFileSync(output, "utf8")).toContain('url: "https://mcp.example.com/mcp"');
    expect(existsSync(join(dirname(context.configPath), "github.md"))).toBe(false);
    expect(out.join("")).toBe(`Wrote MCP Caplet to ${output}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds mcp globally with --global in remote mode", async () => {
    const context = testContext("caplets-cli-remote-add-global-");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));

    await runCli(["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--global"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    const output = join(dirname(context.configPath), "github.md");
    expect(readFileSync(output, "utf8")).toContain('url: "https://mcp.example.com/mcp"');
    expect(existsSync(join(context.projectCapletsRoot, "github.md"))).toBe(false);
    expect(out.join("")).toBe(`Wrote MCP Caplet to ${output}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes add mcp through remote control with --remote and labels the remote path", async () => {
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
      [
        "add",
        "mcp",
        "github",
        "--url",
        "https://mcp.example.com/mcp",
        "--transport",
        "http",
        "--remote",
      ],
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

  it("uses a remote in-process control app with --remote without mutating local config", async () => {
    const remote = remoteServerFixture();
    const local = clientFixture();
    const out: string[] = [];
    const localConfigBefore = readFileSync(local.configPath, "utf8");

    try {
      await runCli(
        ["add", "mcp", "remote-tools", "--url", "https://mcp.example.com/mcp", "--remote"],
        {
          env: {
            CAPLETS_MODE: "remote",
            CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
            CAPLETS_CONFIG: local.configPath,
          },
          fetch: async (input, init) => remote.app.fetch(new Request(input, init)),
          writeOut: (value) => out.push(value),
        },
      );

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
        "--remote",
      ]),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("Cannot combine mutation target flags"),
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
  ])("routes add %s through remote control with --remote", async (kind, args, options) => {
    const request = await runRemoteAdd([...args, "--remote"]);

    expect(request).toEqual({
      command: "add",
      arguments: {
        kind,
        id: args[1],
        options,
      },
    });
  });

  it("installs to the project by default in remote mode", async () => {
    const context = testContext("caplets-cli-remote-install-project-");
    const repo = join(context.projectCapletsRoot, "repo");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));
    writeInstallableRepo(repo);

    await runCli(["install", repo, "github"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(readFileSync(join(context.projectCapletsRoot, "github", "CAPLET.md"), "utf8")).toContain(
      "name: GitHub",
    );
    expect(out.join("")).toContain(
      `Installed github to ${join(context.projectCapletsRoot, "github")}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("installs to the project with --project in remote mode", async () => {
    const context = testContext("caplets-cli-remote-install-explicit-project-");
    const repo = join(context.projectCapletsRoot, "repo");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));
    writeInstallableRepo(repo);

    await runCli(["install", "--project", repo, "github"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(readFileSync(join(context.projectCapletsRoot, "github", "CAPLET.md"), "utf8")).toContain(
      "name: GitHub",
    );
    expect(existsSync(join(dirname(context.configPath), "github"))).toBe(false);
    expect(out.join("")).toContain(
      `Installed github to ${join(context.projectCapletsRoot, "github")}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("installs globally in remote mode with --global", async () => {
    const context = testContext("caplets-cli-remote-install-global-");
    const repo = join(context.projectCapletsRoot, "repo");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));
    writeInstallableRepo(repo);

    await runCli(["install", "--global", repo, "github"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(
      readFileSync(join(dirname(context.configPath), "github", "CAPLET.md"), "utf8"),
    ).toContain("name: GitHub");
    expect(existsSync(join(context.projectCapletsRoot, "github"))).toBe(false);
    expect(out.join("")).toContain(
      `Installed github to ${join(dirname(context.configPath), "github")}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes install through remote control with --remote", async () => {
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

    await runCli(["install", "spiritledsoftware/caplets", "github", "--remote"], {
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

  it("creates the project config by default in remote mode", async () => {
    const context = testContext("caplets-cli-remote-init-project-");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));

    await runCli(["init"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(existsSync(context.projectConfigPath)).toBe(true);
    expect(out.join("")).toBe(`Created Caplets config at ${context.projectConfigPath}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the project config with --project in remote mode", async () => {
    const context = testContext("caplets-cli-remote-init-explicit-project-");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));

    await runCli(["init", "--project"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(existsSync(context.projectConfigPath)).toBe(true);
    expect(existsSync(join(dirname(context.configPath), "config.json"))).toBe(true);
    expect(out.join("")).toBe(`Created Caplets config at ${context.projectConfigPath}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the user config in remote mode with --global", async () => {
    const context = testContext("caplets-cli-remote-init-global-");
    const out: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));
    rmSync(context.configPath, { force: true });

    await runCli(["init", "--global"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(existsSync(context.configPath)).toBe(true);
    expect(existsSync(context.projectConfigPath)).toBe(false);
    expect(out.join("")).toBe(`Created Caplets config at ${context.configPath}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes init through remote control with --remote", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { remote: true, path: "/srv/caplets/config.json" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runCli(["init", "--force", "--remote"], {
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

  it.each([
    ["init", "--project --global", ["init", "--project", "--global"]],
    ["init", "--project --remote", ["init", "--project", "--remote"]],
    ["init", "--global --remote", ["init", "--global", "--remote"]],
    [
      "add",
      "--project --global",
      ["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--project", "--global"],
    ],
    [
      "add",
      "--project --remote",
      ["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--project", "--remote"],
    ],
    [
      "add",
      "--global --remote",
      ["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--global", "--remote"],
    ],
    ["install", "--project --global", ["install", "repo", "--project", "--global"]],
    ["install", "--project --remote", ["install", "repo", "--project", "--remote"]],
    ["install", "--global --remote", ["install", "repo", "--global", "--remote"]],
  ])("rejects conflicting mutation targets for %s %s", async (_command, _flags, args) => {
    await expect(runCli(args, { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
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

    await runCli(["auth", "list", "--remote", "--json"], io);
    await runCli(["auth", "logout", "remote"], io);

    expect(JSON.parse(out[0]!)).toEqual([
      { server: "remote", status: "authenticated", source: "remote" },
    ]);
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

  it("combines local and remote auth list rows with source metadata in remote mode", async () => {
    const context = testContext("caplets-cli-remote-auth-list-merge-");
    writeAuthConfig(context.configPath, "local-auth");
    const out: string[] = [];
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, result: [{ server: "remote-auth", status: "authenticated" }] }),
    );

    await runCli(["auth", "list", "--json"], {
      env: remoteEnv(context),
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual([
      expect.objectContaining({ server: "local-auth", source: "global" }),
      expect.objectContaining({ server: "remote-auth", source: "remote" }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/caplets/control"),
      expect.objectContaining({ body: JSON.stringify({ command: "auth_list", arguments: {} }) }),
    );
  });

  it("rejects auth target ambiguity between local and remote scopes", async () => {
    const context = testContext("caplets-cli-remote-auth-ambiguous-");
    writeAuthConfig(context.configPath, "shared");
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, result: [{ server: "shared", status: "authenticated" }] }),
    );

    await expect(
      runCli(["auth", "logout", "shared"], {
        env: remoteEnv(context),
        fetch: fetchMock as typeof fetch,
        writeOut: () => {},
      }),
    ).rejects.toThrow(/--project.*--global.*--remote/s);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/caplets/control"),
      expect.objectContaining({ body: JSON.stringify({ command: "auth_list", arguments: {} }) }),
    );
  });

  it("does not fall back to remote auth targets when local auth config is malformed", async () => {
    const context = testContext("caplets-cli-remote-auth-invalid-local-");
    writeFileSync(context.configPath, "{ invalid json", "utf8");
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, result: [{ server: "remote", status: "authenticated" }] }),
    );

    await expect(
      runCli(["auth", "logout", "remote"], {
        env: remoteEnv(context),
        fetch: fetchMock as typeof fetch,
        writeOut: () => {},
      }),
    ).rejects.toThrow(/not valid JSON/u);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses explicit --remote for auth login and logout remote requests", async () => {
    const out: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { server: "remote", authenticated: true } }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { server: "remote", deleted: true } }),
      );

    const io = {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value: string) => out.push(value),
    };

    await runCli(["auth", "login", "remote", "--remote", "--no-open"], io);
    await runCli(["auth", "logout", "remote", "--remote"], io);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({ command: "auth_login_start", arguments: { server: "remote" } }),
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
    trustProxy: false,
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

function remoteEnv(context: {
  configPath: string;
  projectConfigPath: string;
}): Record<string, string> {
  return {
    CAPLETS_MODE: "remote",
    CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
    CAPLETS_CONFIG: context.configPath,
    CAPLETS_PROJECT_CONFIG: context.projectConfigPath,
  };
}

function remoteListRow(server: string, name: string): Record<string, unknown> {
  return {
    server,
    backend: "mcp",
    name,
    description: `${name} tools`,
    disabled: false,
    status: "not_started",
    source: "remote",
    path: null,
    shadows: [],
  };
}

function writeCliCapletConfig(
  path: string,
  id: string,
  name: string,
  options: { disabled?: boolean } = {},
): void {
  const dir = dirname(path);
  const script = join(dir, `${id}-tool.mjs`);
  writeFileSync(script, "console.log(JSON.stringify({ message: process.argv[2] }));\n");
  writeFileSync(
    path,
    JSON.stringify({
      cliTools: {
        [id]: {
          name,
          description: `${name} tools`,
          disabled: Boolean(options.disabled),
          actions: {
            echo: {
              command: process.execPath,
              args: [script, "$input.message"],
              output: { type: "json" },
            },
          },
        },
      },
    }),
  );
}

function writeAuthConfig(path: string, id: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        [id]: {
          name: id,
          description: `${id} auth`,
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "client" },
        },
      },
    }),
  );
}

function writeCapletSetConfig(path: string, id: string, name: string): void {
  const capletsRoot = join(dirname(path), `${id}-caplets`);
  mkdirSync(capletsRoot, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      capletSets: {
        [id]: {
          name,
          description: `${name} collection`,
          capletsRoot,
        },
      },
    }),
  );
}

function writeProjectMcpCaplet(root: string, id: string, name: string): void {
  writeFileSync(
    join(root, `${id}.md`),
    [
      "---",
      `name: ${name}`,
      `description: ${name} tools`,
      "mcpServer:",
      "  command: node",
      "  disabled: false",
      "---",
      `# ${name}`,
    ].join("\n"),
  );
}

function writeInstallableRepo(repo: string): void {
  const root = join(repo, "caplets");
  mkdirSync(join(root, "github"), { recursive: true });
  writeFileSync(
    join(root, "github", "CAPLET.md"),
    [
      "---",
      "name: GitHub",
      "description: Work with GitHub repositories and pull requests.",
      "mcpServer:",
      "  command: npx",
      "  args:",
      "    - -y",
      "    - github-mcp-server",
      "---",
      "# GitHub",
    ].join("\n"),
  );
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
