import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dispatchRemoteCliRequest } from "../src/remote-control/dispatch";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dispatchRemoteCliRequest", () => {
  it("lists Caplets from the server-side config", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      { command: "list", arguments: { includeDisabled: true } },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toEqual([
      expect.objectContaining({
        server: "server_status",
        backend: "http",
        source: "global-config",
      }),
    ]);
  });

  it("executes get_caplet through the server engine", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "get_caplet",
        arguments: { caplet: "server_status", request: { operation: "get_caplet" } },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toMatchObject({
      structuredContent: {
        result: { id: "server_status", backend: { type: "http" }, name: "Server Status" },
      },
    });
  });

  it("executes nested search_tools requests through the server engine", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "search_tools",
        arguments: {
          caplet: "server_status",
          request: { operation: "search_tools", query: "check", limit: 1 },
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toMatchObject({
      structuredContent: {
        result: {
          query: "check",
          tools: [expect.objectContaining({ tool: "check" })],
        },
      },
    });
  });

  it("adds MCP Caplets to the server-side project Caplets root", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_fixture",
          options: { command: "node", arg: ["server.js"] },
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true, result: { remote: true, label: "MCP" } });
    const capletPath = join(context.projectCapletsRoot, "remote_fixture.md");
    expect(existsSync(capletPath)).toBe(true);
    expect(readFileSync(capletPath, "utf8")).toContain("mcpServer:");
  });

  it("rejects remote add output because the server owns the destination", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_escape",
          options: { command: "node", output: join(context.tempRoot, "outside.md") },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: expect.stringContaining("output is not supported remotely"),
      },
    });
  });

  it("rejects remote add destinationRoot because the server owns the destination", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_destination_root",
          options: { command: "node", destinationRoot: context.tempRoot },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: expect.stringContaining("destinationRoot is not supported remotely"),
      },
    });
  });

  it("rejects remote add print because the server owns write behavior", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_print",
          options: { command: "node", print: true },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: expect.stringContaining("print is not supported remotely"),
      },
    });
  });

  it("rejects invalid remote add option types before calling helpers", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_bad_force",
          options: { command: "node", force: "yes" },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID", message: expect.stringContaining("force") },
    });
  });

  it("accepts valid remote add nested options", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_valid",
          options: { command: "node", arg: ["server.js"], env: ["A=B"], force: true },
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true, result: { remote: true, label: "MCP" } });
    expect(existsSync(join(context.projectCapletsRoot, "remote_valid.md"))).toBe(true);
  });

  it("marks init and install mutation responses as remote", async () => {
    const initContext = testContext({ writeConfig: false });

    await expect(
      dispatchRemoteCliRequest({ command: "init", arguments: {} }, initContext),
    ).resolves.toMatchObject({ ok: true, result: { remote: true, path: initContext.configPath } });

    const installContext = testContext();
    const sourceRepo = join(installContext.tempRoot, "source");
    const sourceCaplets = join(sourceRepo, "caplets");
    mkdirSync(sourceCaplets, { recursive: true });
    writeFileSync(
      join(sourceCaplets, "sample.md"),
      [
        "---",
        "name: Sample",
        "description: Sample Caplet.",
        "httpApi:",
        "  baseUrl: http://127.0.0.1:1",
        "  auth:",
        "    type: none",
        "  actions:",
        "    check:",
        "      method: GET",
        "      path: /check",
        "---",
        "",
        "# Sample",
        "",
      ].join("\n"),
    );

    await expect(
      dispatchRemoteCliRequest(
        { command: "install", arguments: { repo: sourceRepo } },
        installContext,
      ),
    ).resolves.toMatchObject({ ok: true, result: { remote: true } });
  });
});

function testContext(options: { writeConfig?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "caplets-dispatch-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  if (options.writeConfig !== false) {
    writeFileSync(
      configPath,
      JSON.stringify({
        httpApis: {
          server_status: {
            name: "Server Status",
            description: "Server-side status API.",
            baseUrl: "http://127.0.0.1:1",
            auth: { type: "none" },
            actions: { check: { method: "GET", path: "/check" } },
          },
        },
      }),
    );
  }
  return {
    tempRoot: dir,
    configPath,
    projectConfigPath,
    projectCapletsRoot: projectRoot,
    watch: false,
  };
}
