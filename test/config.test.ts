import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configJsonSchema, loadConfig, parseConfig } from "../src/config.js";
import { CapletsError } from "../src/errors.js";

describe("config", () => {
  const originalEnv = process.env.EXAMPLE_TOKEN;

  beforeEach(() => {
    process.env.EXAMPLE_TOKEN = "secret-value";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXAMPLE_TOKEN;
    } else {
      process.env.EXAMPLE_TOKEN = originalEnv;
    }
  });

  it("loads ~/.caplets-compatible config from a path with defaults and interpolation", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          "my-server_1": {
            name: "My Server",
            description: "A useful downstream server.",
            command: "node",
            args: ["server.js"],
            env: { EXAMPLE_TOKEN: "${EXAMPLE_TOKEN}" },
          },
        },
      }),
    );

    const config = loadConfig(path);
    expect(config.version).toBe(1);
    expect(config.options.defaultSearchLimit).toBe(20);
    expect(config.mcpServers["my-server_1"]?.transport).toBe("stdio");
    expect(config.mcpServers["my-server_1"]?.env?.EXAMPLE_TOKEN).toBe("secret-value");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads project config when user config does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-"));
    const projectConfigPath = join(dir, ".caplets", "config.json");
    mkdirSync(join(dir, ".caplets"), { recursive: true });
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          project: {
            name: "Project Server",
            description: "A useful project downstream server.",
            command: "node",
          },
        },
      }),
    );

    const config = loadConfig(join(dir, "missing-user-config.json"), projectConfigPath);
    expect(config.mcpServers.project?.name).toBe("Project Server");
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges user config with project config and lets project config win", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-"));
    const userConfigPath = join(dir, "user", "config.json");
    const projectConfigPath = join(dir, ".caplets", "config.json");
    mkdirSync(join(dir, "user"), { recursive: true });
    mkdirSync(join(dir, ".caplets"), { recursive: true });
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        defaultSearchLimit: 7,
        maxSearchLimit: 40,
        mcpServers: {
          shared: {
            name: "Project Shared",
            description: "A useful project shared downstream server.",
            command: "project-shared",
          },
          projectOnly: {
            name: "Project Only",
            description: "A useful project-only downstream server.",
            command: "project-only",
          },
        },
      }),
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        defaultSearchLimit: 3,
        mcpServers: {
          shared: {
            name: "User Shared",
            description: "A useful user shared downstream server.",
            command: "user-shared",
          },
          userOnly: {
            name: "User Only",
            description: "A useful user-only downstream server.",
            command: "user-only",
          },
        },
      }),
    );

    const config = loadConfig(userConfigPath, projectConfigPath);
    expect(config.options).toEqual({ defaultSearchLimit: 7, maxSearchLimit: 40 });
    expect(Object.keys(config.mcpServers).sort()).toEqual(["projectOnly", "shared", "userOnly"]);
    expect(config.mcpServers.shared?.command).toBe("project-shared");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads top-level Caplets options", () => {
    const config = parseConfig({
      $schema:
        "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplets-config.schema.json",
      defaultSearchLimit: 5,
      maxSearchLimit: 10,
      mcpServers: {},
    });

    expect(config.options).toEqual({
      defaultSearchLimit: 5,
      maxSearchLimit: 10,
    });
  });

  it("rejects nested Caplets options", () => {
    expect(() =>
      parseConfig({
        caplets: {
          defaultSearchLimit: 5,
          maxSearchLimit: 10,
        },
        mcpServers: {},
      }),
    ).toThrow(CapletsError);
  });

  it("keeps the committed JSON Schema in sync with the Zod schema", () => {
    expect(JSON.parse(readFileSync("schemas/caplets-config.schema.json", "utf8"))).toEqual(
      configJsonSchema(),
    );
  });

  it("rejects unsupported versions and unknown keys", () => {
    expect(() => parseConfig({ version: 2, mcpServers: {} })).toThrow(CapletsError);
    expect(() => parseConfig({ mcpServers: {}, unexpected: true })).toThrow(CapletsError);
    expect(() =>
      parseConfig({
        mcpServers: {
          ok: {
            name: "OK",
            description: "A useful downstream server.",
            command: "node",
            unsupported: true,
          },
        },
      }),
    ).toThrow(CapletsError);
  });

  it("validates server IDs, required names, descriptions, and disabled default", () => {
    const valid = parseConfig({
      mcpServers: {
        "linear-dev_1": {
          name: "Linear",
          description: "A useful downstream server.",
          command: "node",
        },
      },
    });
    expect(valid.mcpServers["linear-dev_1"]?.disabled).toBe(false);

    for (const server of ["has space", "has.dot", "has/slash", "has:colon", "snowman-☃"]) {
      expect(() =>
        parseConfig({
          mcpServers: {
            [server]: {
              name: "Bad",
              description: "A useful downstream server.",
              command: "node",
            },
          },
        }),
      ).toThrow(CapletsError);
    }
  });

  it("validates remote URL and auth shapes", () => {
    process.env.REMOTE_MCP_URL = "https://example.com/mcp";
    expect(
      parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote downstream server.",
            transport: "http",
            url: "$env:REMOTE_MCP_URL",
            auth: { type: "bearer", token: "$env:EXAMPLE_TOKEN" },
          },
        },
      }).mcpServers.remote?.auth,
    ).toEqual({ type: "bearer", token: "secret-value" });

    expect(() =>
      parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote downstream server.",
            transport: "http",
            url: "http://example.com/mcp",
          },
        },
      }),
    ).toThrow(CapletsError);

    expect(() =>
      parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote downstream server.",
            transport: "http",
            url: "https://example.com/mcp",
            auth: { type: "headers", headers: { Connection: "close" } },
          },
        },
      }),
    ).toThrow(CapletsError);
  });
});
