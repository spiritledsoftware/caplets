import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliToolsManager } from "../src/cli-tools";
import { parseConfig } from "../src/config";
import { CapletsError } from "../src/errors";
import { ServerRegistry } from "../src/registry";
import { handleServerTool } from "../src/tools";
import { DownstreamManager } from "../src/downstream";

describe("CliToolsManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists, searches, and reads CLI action tools", async () => {
    const { config, caplet } = cliConfig();
    const registry = new ServerRegistry(config);
    const manager = new CliToolsManager(registry);

    expect(await manager.checkTools(caplet)).toMatchObject({
      id: "local",
      status: "available",
      toolCount: 3,
    });
    const tools = await manager.listTools(caplet);
    expect(tools.map((tool) => tool.name)).toEqual(["echo_json", "fail", "fail_json"]);
    expect(manager.search(caplet, tools, "echo", 5)).toMatchObject([
      { name: "echo_json", readOnlyHint: true },
    ]);
    expect(await manager.getTool(caplet, "echo_json")).toMatchObject({
      name: "echo_json",
      inputSchema: expect.objectContaining({ type: "object" }),
      annotations: { readOnlyHint: true },
    });
  });

  it("does not fail checks for runtime-templated commands", async () => {
    const { config, caplet } = cliConfig();
    caplet.actions.templated = {
      command: "$input.command",
      cwd: "$input.cwd",
    };
    const manager = new CliToolsManager(new ServerRegistry(config));

    expect(await manager.checkTools(caplet)).toMatchObject({
      status: "available",
      toolCount: 4,
    });
  });

  it("spawns commands without a shell and returns parsed JSON output", async () => {
    const { config, caplet } = cliConfig();
    const manager = new CliToolsManager(new ServerRegistry(config));

    const result = await manager.callTool(caplet, "echo_json", { message: "hello" });
    const literal = "$(echo owned) && rm -rf /";
    const literalResult = await manager.callTool(caplet, "echo_json", { message: literal });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      exitCode: 0,
      json: { message: "hello" },
    });
    expect(literalResult.isError).toBe(false);
    expect(literalResult.structuredContent).toMatchObject({
      exitCode: 0,
      json: { message: literal },
    });
  });

  it("runs project-bound CLI actions in the bound project root by default", async () => {
    const { config, caplet } = cliConfig({
      projectBinding: { required: true },
      actions: {
        cwd: {
          command: process.execPath,
          args: ["-e", "console.log(JSON.stringify({ cwd: process.cwd() }))"],
          output: { type: "json" },
        },
      },
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "caplets-cli-project-"));
    dirs.push(projectRoot);
    const manager = new CliToolsManager(new ServerRegistry(config), {
      projectBindingContext: projectBindingContext(projectRoot),
    });

    const result = await manager.callTool(caplet, "cwd", {});

    expect(result.structuredContent).toMatchObject({
      json: { cwd: projectRoot },
    });
  });

  it("rejects project-bound CLI cwd escapes before spawning", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "caplets-cli-project-"));
    const outside = mkdtempSync(join(tmpdir(), "caplets-cli-outside-"));
    dirs.push(projectRoot, outside);
    mkdirSync(join(projectRoot, "tools"));
    const { config, caplet } = cliConfig({
      projectBinding: { required: true },
      cwd: outside,
      actions: {
        cwd: {
          command: process.execPath,
          args: ["-e", "console.log(process.cwd())"],
        },
      },
    });
    const manager = new CliToolsManager(new ServerRegistry(config), {
      projectBindingContext: projectBindingContext(projectRoot),
    });

    await expect(manager.callTool(caplet, "cwd", {})).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        projectBinding: expect.objectContaining({ reason: "invalid_cwd" }),
      },
    });
  });

  it("returns non-zero exits as tool errors with stdout and stderr", async () => {
    const { config, caplet } = cliConfig();
    const manager = new CliToolsManager(new ServerRegistry(config));

    const result = await manager.callTool(caplet, "fail", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      exitCode: 7,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("returns non-zero invalid JSON output as a tool error", async () => {
    const { config, caplet } = cliConfig();
    const manager = new CliToolsManager(new ServerRegistry(config));

    const result = await manager.callTool(caplet, "fail_json", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      exitCode: 7,
      stdout: "out\n",
      stderr: "err\n",
      jsonParseError: expect.objectContaining({ message: expect.any(String) }),
    });
  });

  it("validates basic input schemas before spawning", async () => {
    const { config, caplet } = cliConfig();
    const manager = new CliToolsManager(new ServerRegistry(config));

    await expect(manager.callTool(caplet, "echo_json", {})).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await expect(manager.callTool(caplet, "echo_json", { message: 42 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await expect(manager.callTool(caplet, "echo_json", { message: null })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });

  it("enforces output byte limits and timeouts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-"));
    dirs.push(dir);
    const config = parseConfig({
      cliTools: {
        local: {
          name: "Local CLI",
          description: "Run local CLI fixtures.",
          maxOutputBytes: 8,
          actions: {
            large: {
              command: process.execPath,
              args: ["-e", "process.stdout.write('x'.repeat(32))"],
            },
            slow: {
              command: process.execPath,
              args: ["-e", "setTimeout(() => {}, 1000)"],
              timeoutMs: 10,
            },
          },
        },
      },
    });
    const caplet = config.cliTools.local!;
    const manager = new CliToolsManager(new ServerRegistry(config));

    await expect(manager.callTool(caplet, "large", {})).rejects.toMatchObject({
      code: "DOWNSTREAM_TOOL_ERROR",
    });
    await expect(manager.callTool(caplet, "slow", {})).rejects.toMatchObject({
      code: "TOOL_CALL_TIMEOUT",
    });
  });

  it("routes through handleServerTool with field selection", async () => {
    const { config, caplet } = cliConfig();
    const registry = new ServerRegistry(config);
    const manager = new CliToolsManager(registry);

    const result = await handleServerTool(
      caplet,
      {
        operation: "call_tool",
        name: "echo_json",
        args: { message: "hello" },
        fields: ["json.message"],
      },
      registry,
      new DownstreamManager(registry),
      undefined,
      undefined,
      undefined,
      manager,
    );

    expect(result.structuredContent).toEqual({ json: { message: "hello" } });
  });

  it("parses CLI tools config", () => {
    const { config } = cliConfig();
    expect(config.cliTools.local).toMatchObject({
      backend: "cli",
      timeoutMs: 60000,
      maxOutputBytes: 200000,
      actions: {
        echo_json: {
          command: process.execPath,
        },
      },
    });
    expect(() =>
      parseConfig({
        mcpServers: {
          local: {
            name: "MCP",
            description: "Local MCP server fixture.",
            command: "node",
          },
        },
        cliTools: {
          local: {
            name: "Duplicate",
            description: "Duplicate CLI tools fixture.",
            actions: { echo: { command: "node" } },
          },
        },
      }),
    ).toThrow(CapletsError);
  });

  function cliConfig(overrides: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-"));
    dirs.push(dir);
    const script = join(dir, "echo.mjs");
    writeFileSync(
      script,
      [
        "const message = process.argv[2];",
        "if (message === 'fail') { console.log('out'); console.error('err'); process.exit(7); }",
        "console.log(JSON.stringify({ message }));",
      ].join("\n"),
    );
    const config = parseConfig({
      cliTools: {
        local: {
          name: "Local CLI",
          description: "Run local CLI fixtures.",
          ...overrides,
          actions: {
            echo_json: {
              description: "Echo one JSON message.",
              command: process.execPath,
              args: [script, "$input.message"],
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  exitCode: { type: "integer" },
                  stdout: { type: "string" },
                  stderr: { type: "string" },
                  elapsedMs: { type: "number" },
                  json: {
                    type: "object",
                    properties: { message: { type: "string" } },
                  },
                },
              },
              output: { type: "json" },
              annotations: { readOnlyHint: true },
            },
            fail: {
              description: "Return a non-zero exit.",
              command: process.execPath,
              args: [script, "fail"],
            },
            fail_json: {
              description: "Return a non-zero exit with invalid JSON.",
              command: process.execPath,
              args: [script, "fail"],
              output: { type: "json" },
            },
            ...(overrides.actions as Record<string, unknown> | undefined),
          },
        },
      },
    });
    return { config, caplet: config.cliTools.local! };
  }

  function projectBindingContext(projectRoot: string) {
    return {
      sessionId: "session_1",
      bindingId: "binding_1",
      projectRoot,
      projectFingerprint: `sha256:${projectRoot}`,
    };
  }
});
