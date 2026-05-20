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
      { command: "get_caplet", arguments: { caplet: "server_status" } },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toMatchObject({
      structuredContent: {
        result: { id: "server_status", backend: { type: "http" }, name: "Server Status" },
      },
    });
  });

  it("adds MCP Caplets to the server-side project Caplets root", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: { kind: "mcp", id: "remote_fixture", command: "node", arg: ["server.js"] },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    const capletPath = join(context.projectCapletsRoot, "remote_fixture.md");
    expect(existsSync(capletPath)).toBe(true);
    expect(readFileSync(capletPath, "utf8")).toContain("mcpServer:");
  });
});

function testContext() {
  const dir = mkdtempSync(join(tmpdir(), "caplets-dispatch-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
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
  return { configPath, projectConfigPath, projectCapletsRoot: projectRoot, watch: false };
}
