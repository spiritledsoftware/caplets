import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { capabilityDescription, parseConfig, ServerRegistry } from "@caplets/core";
import {
  PROCESS_TERMINATION_BEHAVIOR,
  parseJsonEvents,
  redactOutput,
  runProcess,
} from "../lib/live-agent";
import {
  createBenchmarkCapletsConfig,
  createBenchmarkFixtureMcpServers,
  getBenchmarkPaths,
} from "../lib/config";
import {
  PI_CONFIG_MODES,
  buildPiCommand,
  createPiMcpConfigs,
  detectPiCli,
  piRunner,
} from "../lib/pi-runner";
import {
  OPENCODE_CONFIG_MODES,
  buildOpenCodeCommand,
  createOpenCodeMcpConfigs,
  detectOpenCodeCli,
  opencodeRunner,
} from "../lib/opencode-runner";
import { buildLiveMatrix, loadTasks, parseLiveArgs, runLiveBenchmark } from "../run-live";
import { resolveInside, scoreTaskRun, transcriptMetrics } from "../lib/scoring";
import {
  SURFACE_THRESHOLDS,
  benchmarkServerDefinitions,
  computeSurfaceBenchmark,
  directFlatPayload,
  validateSurfaceBenchmark,
} from "../lib/surface";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const capletsCliPath = join(repoRoot, "packages", "cli", "dist", "index.js");
const fixtureServerPath = join(packageRoot, "fixtures", "mcp-server.mjs");

function expectNoHiddenBenchmarkPaths(value: unknown, { allowCapletsDist = false } = {}) {
  const distPath = join(repoRoot, "packages", "cli", "dist", "index.js");
  let serialized = JSON.stringify(value) ?? "";
  if (allowCapletsDist) {
    serialized = serialized.split(distPath).join("<caplets-dist>");
  }

  expect(serialized).not.toContain(repoRoot);
  expect(serialized).not.toContain("tasks.json");
  expect(serialized).not.toContain("validators");
}

describe("progressive disclosure benchmark fixture", () => {
  it("keeps deterministic benchmark freshness in verify without live benchmarks", async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const ciWorkflow = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts["benchmark:check"]).toBe(
      "pnpm --filter @caplets/benchmarks benchmark:check",
    );
    expect(packageJson.scripts.verify).toContain("pnpm benchmark:check");
    expect(packageJson.scripts.verify).not.toContain("benchmark:live");
    expect(ciWorkflow).toContain("pnpm verify");
    expect(ciWorkflow).not.toContain("benchmark:live");
  });

  it("exposes a much smaller initial tool list than direct aggregation", async () => {
    const result = await computeSurfaceBenchmark();

    expect(validateSurfaceBenchmark(result)).toEqual([]);
    expect(result.direct.toolCount).toBeGreaterThan(result.caplets.toolCount);
    expect(result.reductions.initialPayloadReduction).toBeGreaterThanOrEqual(
      SURFACE_THRESHOLDS.minInitialPayloadReduction,
    );
    expect(result.collisions.directDuplicateToolNameCount).toBeGreaterThan(0);
    expect(result.collisions.capletsTopLevelDuplicateToolNameCount).toBe(0);
  });

  it("matches the source Caplets registry top-level payload shape", () => {
    const config = parseConfig({ mcpServers: benchmarkServerDefinitions() });
    const registry = new ServerRegistry(config);
    const capletsToolsPayload = JSON.stringify(
      registry.enabledServers().map((server) => ({
        name: server.server,
        description: capabilityDescription(server),
        inputSchema: {
          properties: {
            operation: {
              enum: [
                "get_caplet",
                "check_mcp_server",
                "list_tools",
                "search_tools",
                "get_tool",
                "call_tool",
              ],
            },
          },
        },
      })),
    );
    const directToolsPayload = JSON.stringify(directFlatPayload().tools);

    const reduction = 1 - capletsToolsPayload.length / directToolsPayload.length;
    expect(reduction).toBeGreaterThanOrEqual(SURFACE_THRESHOLDS.minInitialPayloadReduction);
  });

  it("captures process output, safe env metadata, JSONL events, and truncation state", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ type: 'tool_call', toolName: 'policy_get' })); process.stderr.write('abcdef');",
      ],
      env: { SECRET_TOKEN: "not-recorded" },
      timeoutMs: 5_000,
      outputMaxBytes: 3,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.envKeys).toEqual(["SECRET_TOKEN"]);
    expect(result.stdout).toBe('{"t');
    expect(result.stderr).toBe("abc");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderrBytes).toBe(6);
    expect(result.jsonEvents).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("not-recorded");
    expect(PROCESS_TERMINATION_BEHAVIOR).toContain("process.kill(-pid, signal)");
    expect(PROCESS_TERMINATION_BEHAVIOR).toContain("taskkill");
  });

  it("parses JSON arrays and tolerant JSONL while ignoring non-JSON lines", () => {
    expect(parseJsonEvents('[{"type":"tool_call"}]')).toEqual([{ type: "tool_call" }]);
    expect(parseJsonEvents('{"type":"tool_call"}\n{"type":"message"}')).toEqual([
      { type: "tool_call" },
      { type: "message" },
    ]);
    expect(parseJsonEvents('not json\n{"type":"tool_call"}')).toEqual([{ type: "tool_call" }]);
  });

  it("redacts secret env values and common token patterns from captured output", async () => {
    expect(
      redactOutput("Authorization: Bearer live-token token=abc123 api_key=xyz", {
        SECRET_TOKEN: "live-token",
      }),
    ).toBe("Authorization: Bearer [REDACTED] token=[REDACTED] api_key=[REDACTED]");

    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.log(`secret=${process.env.SECRET_TOKEN}`); console.error('Bearer ' + 'hidden' + '-bearer');",
      ],
      env: { SECRET_TOKEN: "hidden-secret" },
      timeoutMs: 5_000,
    });

    expect(result.stdout).toContain("secret=[REDACTED]");
    expect(result.stderr).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(result)).not.toContain("hidden-secret");
    expect(JSON.stringify(result)).not.toContain("hidden-bearer");
  });

  it("redacts env secrets before truncating captured output", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('prefix ' + process.env.SECRET_TOKEN + ' suffix')"],
      env: { SECRET_TOKEN: "supersecretvalue" },
      timeoutMs: 5_000,
      outputMaxBytes: 17,
    });

    expect(result.stdout).toBe("prefix [REDACTED]");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("super");
    expect(result.stdout).not.toContain("supersecretvalue");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(17);
  });

  it("redacts long repeated env-secret fragments after truncation", async () => {
    const secret = "S".repeat(1000);
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.SECRET_TOKEN + process.env.SECRET_TOKEN)"],
      env: { SECRET_TOKEN: secret },
      timeoutMs: 5_000,
      outputMaxBytes: 100,
    });

    expect(result.stdout).not.toContain("S".repeat(8));
    expect(result.stdout).not.toContain("S".repeat(100));
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("[REDACTED]");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(100);
  });

  it("detects Pi CLI availability through an injected process runner", async () => {
    const available = await detectPiCli({
      runProcess: async (options) => ({
        ...emptyProcessResult(options),
        stdout: "pi 1.2.3\n",
        exitCode: 0,
      }),
    });

    const missing = await detectPiCli({
      runProcess: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });

    expect(available).toEqual({ available: true, command: "pi", version: "pi 1.2.3" });
    expect(missing).toEqual({
      available: false,
      command: "pi",
      reason: "pi CLI was not found in PATH.",
    });
  });

  it("creates best-effort Pi MCP configs for each benchmark mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-config-test-"));
    try {
      const result = await createPiMcpConfigs({ rootDir: root });

      expect(Object.keys(result.configs).sort()).toEqual([...PI_CONFIG_MODES].sort());
      for (const mode of PI_CONFIG_MODES) {
        expect(result.configs[mode]?.path.startsWith(root)).toBe(true);
        expect(result.configs[mode]?.mcpServers).toBeTruthy();
      }
      const directPolicy = result.configs["direct-flat"]?.mcpServers.policy;
      expect(directPolicy.command).toBe(process.execPath);
      expect(isAbsolute(directPolicy.args[0])).toBe(true);
      expect(directPolicy.args[0]).toBe(join(root, "pi", "mcp", "support", "mcp-server.mjs"));
      expect(isAbsolute(directPolicy.cwd)).toBe(true);
      expect(directPolicy.cwd).toBe(join(root, "pi", "mcp", "support"));
      expect(directPolicy.directTools).toBe(true);

      const proxyPolicy = result.configs["pi-proxy"]?.mcpServers.policy;
      expect(proxyPolicy.command).toBe(process.execPath);
      expect(proxyPolicy.args.join(" ")).not.toContain("experimental-pi-proxy");
      expect(result.configs["pi-proxy"]?.settings?.directTools).toBe(false);
      expect(proxyPolicy.directTools).toBe(false);
      expect(Object.keys(result.configs["pi-proxy"]?.supportFiles ?? {})).toContain(
        join(root, "pi", "mcp", "pi-proxy", ".mcp.json"),
      );

      const caplets = result.configs.caplets?.mcpServers.caplets;
      expect(caplets.command).toBe(process.execPath);
      expect(caplets.args).toEqual([capletsCliPath]);
      expect(caplets.env.CAPLETS_CONFIG).toBe(
        join(root, "pi", "mcp", "caplets", "caplets.config.json"),
      );
      expect(caplets.cwd).toBe(join(root, "pi", "mcp", "caplets", "support"));
      expect((caplets.args as string[]).every((arg: string) => arg !== "dist/index.js")).toBe(true);
      expect(Object.keys(result.configs.caplets?.supportFiles ?? {})).toContain(
        join(root, "pi", "mcp", "caplets", "caplets.config.json"),
      );
      expectNoHiddenBenchmarkPaths(result.configs, { allowCapletsDist: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes Pi config support files with absolute server paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-support-test-"));
    try {
      const result = await createPiMcpConfigs({ rootDir: root });
      const projectMcpPath = join(root, "pi", "mcp", "pi-proxy", ".mcp.json");
      const projectMcp = JSON.parse(await readFile(projectMcpPath, "utf8"));

      expect(projectMcp.settings.directTools).toBe(false);
      expect(projectMcp.mcpServers.policy.command).toBe(process.execPath);
      expect(isAbsolute(projectMcp.mcpServers.policy.args[0])).toBe(true);
      expect(projectMcp.mcpServers.policy.args[0]).toBe(
        join(root, "pi", "mcp", "support", "mcp-server.mjs"),
      );
      expect(isAbsolute(projectMcp.mcpServers.policy.cwd)).toBe(true);
      expect(projectMcp.mcpServers.policy.cwd).toBe(join(root, "pi", "mcp", "support"));
      expect(result.configs["pi-proxy"]?.path).not.toBe(projectMcpPath);
      expectNoHiddenBenchmarkPaths(projectMcp);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds a default Pi print JSON command with model and prompt", () => {
    const command = buildPiCommand({
      prompt: "Fix the fixture",
      model: "provider/model",
      mcpConfigPath: "/tmp/pi/mcp.json",
    });

    expect(command.command).toBe("pi");
    expect(command.args).toEqual([
      "-p",
      "Fix the fixture",
      "--mode",
      "json",
      "--model",
      "provider/model",
      "--mcp-config",
      "/tmp/pi/mcp.json",
    ]);
  });

  it("refuses actual Pi runs unless CAPLETS_BENCH_LIVE is enabled", async () => {
    await expect(
      piRunner.run({
        task: { id: "example", prompt: "Do work" },
        candidateWorkspace: tmpdir(),
        mode: "direct-flat",
        env: {},
      }),
    ).rejects.toThrow("CAPLETS_BENCH_LIVE=1");
  });

  it("returns a structured skipped result when Pi is unavailable before spawning", async () => {
    let calls = 0;
    const result = await piRunner.run({
      task: { id: "example", prompt: "Do work" },
      candidateWorkspace: tmpdir(),
      mode: "direct-flat",
      env: { CAPLETS_BENCH_LIVE: "1" },
      runProcess: async () => {
        calls += 1;
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      agent: "pi",
      mode: "direct-flat",
      skipped: true,
      unavailable: true,
      exitCode: null,
      reason: "pi CLI was not found in PATH.",
      cleanedUp: true,
      artifactsPreserved: false,
    });
    await expect(access(result.piCodingAgentDir)).rejects.toThrow();
  });

  it("cleans up Pi runner-owned temp dirs after a successful fake run", async () => {
    const result = await piRunner.run({
      task: { id: "example", prompt: "Do work" },
      candidateWorkspace: tmpdir(),
      mode: "direct-flat",
      env: { CAPLETS_BENCH_LIVE: "1" },
      runProcess: async (options: { args?: string[] }) => {
        if (options.args?.includes("--version")) {
          return { ...emptyProcessResult(options), stdout: "pi 1.2.3\n" };
        }
        return { ...emptyProcessResult(options), stdout: "done\n" };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.cleanedUp).toBe(true);
    expect(result.artifactsPreserved).toBe(false);
    await expect(access(result.piCodingAgentDir)).rejects.toThrow();
  });

  it("redacts secret-looking Pi benchmark args in recorded metadata", async () => {
    const result = await piRunner.run({
      task: { id: "example", prompt: "Do work" },
      candidateWorkspace: tmpdir(),
      mode: "direct-flat",
      model: "provider/model",
      env: { CAPLETS_BENCH_LIVE: "1", PI_BENCH_ARGS: "--api-key super-secret --safe ok" },
      runProcess: async (options: { args?: string[] }) => {
        if (options.args?.includes("--version")) {
          return { ...emptyProcessResult(options), stdout: "pi 1.2.3\n" };
        }
        return { ...emptyProcessResult(options), args: options.args };
      },
    });

    expect(result.args).toContain("[REDACTED]");
    expect(result.commandLine).toContain("--api-key [REDACTED]");
    expect(result.commandLine).toContain("--safe ok");
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("detects OpenCode CLI availability through an injected process runner", async () => {
    const available = await detectOpenCodeCli({
      runProcess: async (options) => ({
        ...emptyProcessResult(options),
        stdout: "opencode 1.2.3\n",
        exitCode: 0,
      }),
    });

    const missing = await detectOpenCodeCli({
      runProcess: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });

    expect(available).toEqual({
      available: true,
      command: "opencode",
      version: "opencode 1.2.3",
    });
    expect(missing).toEqual({
      available: false,
      command: "opencode",
      reason: "opencode CLI was not found in PATH.",
    });
  });

  it("creates isolated OpenCode MCP configs for direct and Caplets modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-opencode-config-test-"));
    const workspace = await mkdtemp(join(tmpdir(), "caplets-opencode-workspace-test-"));
    try {
      const result = await createOpenCodeMcpConfigs({ rootDir: root, workspaceDir: workspace });

      expect(Object.keys(result.configs).sort()).toEqual([...OPENCODE_CONFIG_MODES].sort());
      expect(result.workspaceConfigPath).toBeNull();
      expect(result.assumptions.join("\n")).toContain("OPENCODE_CONFIG_CONTENT");
      expect(result.assumptions.join("\n")).toContain("OPENCODE_CONFIG_DIR");
      for (const mode of OPENCODE_CONFIG_MODES) {
        expect(result.configs[mode]?.path.startsWith(root)).toBe(true);
        expect(result.configs[mode]?.mcp).toBeTruthy();
      }

      const directPolicy = result.configs["direct-flat"]?.mcp.policy;
      expect(directPolicy.type).toBe("local");
      expect(directPolicy.enabled).toBe(true);
      expect(directPolicy.command[0]).toBe(process.execPath);
      expect(isAbsolute(directPolicy.command[1])).toBe(true);
      expect(directPolicy.command[1]).toBe(
        join(root, "opencode", "mcp", "support", "mcp-server.mjs"),
      );
      expect(isAbsolute(directPolicy.cwd)).toBe(true);
      expect(directPolicy.cwd).toBe(join(root, "opencode", "mcp", "support"));

      const caplets = result.configs.caplets?.mcp.caplets;
      expect(caplets.type).toBe("local");
      expect(caplets.command).toEqual([process.execPath, capletsCliPath]);
      expect(caplets.environment.CAPLETS_CONFIG).toBe(
        join(root, "opencode", "mcp", "caplets", "caplets.config.json"),
      );
      expect(caplets.cwd).toBe(join(root, "opencode", "mcp", "caplets", "support"));
      expect((caplets.command as string[]).every((arg: string) => arg !== "dist/index.js")).toBe(
        true,
      );
      expect(Object.keys(result.configs.caplets?.supportFiles ?? {})).toContain(
        join(root, "opencode", "mcp", "caplets", "caplets.config.json"),
      );
      expectNoHiddenBenchmarkPaths(result.configs, { allowCapletsDist: true });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("builds the default OpenCode JSON run command with model, dir, and prompt", () => {
    const command = buildOpenCodeCommand({
      prompt: "Fix the fixture",
      model: "openai/gpt-5.5",
      workspace: "/tmp/workspace",
    });

    expect(command.command).toBe("opencode");
    expect(command.args).toEqual([
      "run",
      "--format",
      "json",
      "--pure",
      "--dangerously-skip-permissions",
      "--model",
      "openai/gpt-5.5",
      "--dir",
      "/tmp/workspace",
      "Fix the fixture",
    ]);
  });

  it("refuses actual OpenCode runs unless CAPLETS_BENCH_LIVE is enabled", async () => {
    await expect(
      opencodeRunner.run({
        task: { id: "example", prompt: "Do work" },
        candidateWorkspace: tmpdir(),
        mode: "direct-flat",
        env: {},
      }),
    ).rejects.toThrow("CAPLETS_BENCH_LIVE=1");
  });

  it("returns a structured skipped result without writing config when OpenCode is unavailable", async () => {
    let calls = 0;
    const workspace = await mkdtemp(join(tmpdir(), "caplets-opencode-unavailable-test-"));
    try {
      const result = await opencodeRunner.run({
        task: { id: "example", prompt: "Do work" },
        candidateWorkspace: workspace,
        mode: "direct-flat",
        env: { CAPLETS_BENCH_LIVE: "1" },
        runProcess: async () => {
          calls += 1;
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        },
      });

      expect(calls).toBe(1);
      expect(result).toMatchObject({
        agent: "opencode",
        mode: "direct-flat",
        skipped: true,
        unavailable: true,
        exitCode: null,
        reason: "opencode CLI was not found in PATH.",
        activeProjectConfigPath: null,
        cleanedUp: true,
        artifactsPreserved: false,
      });
      await expect(access(result.openCodeStateDir)).rejects.toThrow();
      await expect(access(join(workspace, "opencode.json"))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cleans up OpenCode runner-owned temp dirs after success", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-opencode-cleanup-test-"));
    const generatedConfigPath = join(workspace, "opencode.json");
    try {
      const result = await opencodeRunner.run({
        task: { id: "example", prompt: "Do work" },
        candidateWorkspace: workspace,
        mode: "direct-flat",
        env: { CAPLETS_BENCH_LIVE: "1" },
        runProcess: async (options: { args?: string[] }) => {
          if (options.args?.includes("--version")) {
            return { ...emptyProcessResult(options), stdout: "opencode 1.2.3\n" };
          }
          return { ...emptyProcessResult(options), stdout: "done\n" };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.activeProjectConfigPath).toBeNull();
      expect(result.generatedProjectConfigRemoved).toBe(false);
      expect(result.cleanedUp).toBe(true);
      expect(result.artifactsPreserved).toBe(false);
      await expect(access(result.openCodeStateDir)).rejects.toThrow();
      await expect(access(generatedConfigPath)).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves an existing OpenCode project config while using inline config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-opencode-existing-config-test-"));
    const existingConfigPath = join(workspace, "opencode.json");
    const existingConfig = '{"mcp":{"user-owned":{"type":"local"}}}\n';
    try {
      await writeFile(existingConfigPath, existingConfig);

      const result = await opencodeRunner.run({
        task: { id: "example", prompt: "Do work" },
        candidateWorkspace: workspace,
        mode: "direct-flat",
        env: { CAPLETS_BENCH_LIVE: "1" },
        runProcess: async (options: { args?: string[] }) => {
          if (options.args?.includes("--version")) {
            return { ...emptyProcessResult(options), stdout: "opencode 1.2.3\n" };
          }
          return { ...emptyProcessResult(options), stdout: "done\n" };
        },
      });

      expect(result).toMatchObject({
        agent: "opencode",
        mode: "direct-flat",
        exitCode: 0,
        cleanedUp: true,
        artifactsPreserved: false,
        generatedProjectConfigRemoved: false,
      });
      expect(await readFile(existingConfigPath, "utf8")).toBe(existingConfig);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts secret-looking OpenCode benchmark args in recorded metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-opencode-redact-test-"));
    try {
      const result = await opencodeRunner.run({
        task: { id: "example", prompt: "Do work" },
        candidateWorkspace: workspace,
        mode: "direct-flat",
        model: "openai/gpt-5.5",
        env: {
          CAPLETS_BENCH_LIVE: "1",
          OPENCODE_BENCH_ARGS: "--api-key super-secret --safe ok",
        },
        runProcess: async (options: { args?: string[]; env?: Record<string, string> }) => {
          if (options.args?.includes("--version")) {
            return { ...emptyProcessResult(options), stdout: "opencode 1.2.3\n" };
          }
          expect(options.env?.OPENCODE_CONFIG_CONTENT).toContain("policy");
          expect(options.env?.OPENCODE_CONFIG_DIR).toContain("caplets-opencode-agent-");
          expect(options.env?.OPENCODE_CONFIG_DIR).toMatch(/opencode-config$/u);
          expect(options.env?.OPENCODE).toBeUndefined();
          expect(options.env?.OPENCODE_PID).toBeUndefined();
          expect(options.env?.PLAYWRIGHT_MCP_BROWSER).toBeUndefined();
          expect(options.env?.XDG_CONFIG_HOME).toContain("caplets-opencode-agent-");
          expect(options.env?.XDG_CONFIG_HOME).toMatch(/xdg-config$/u);
          expect(options.env?.HOME).toBeUndefined();
          return { ...emptyProcessResult(options), args: options.args };
        },
      });

      expect(result.args).toContain("[REDACTED]");
      expect(result.commandLine).toContain("--api-key [REDACTED]");
      expect(result.commandLine).toContain("--safe ok");
      expect(result.openCodeVersion).toBe("opencode 1.2.3");
      expect(JSON.stringify(result)).not.toContain("super-secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("creates an isolated Caplets benchmark config with absolute fixture server paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-benchmark-config-test-"));
    try {
      const result = await createBenchmarkCapletsConfig({ rootDir: root, requireBuild: false });

      expect(result.configPath).toBe(join(root, "caplets.config.json"));
      expect(result.cleanupPath).toBe(root);
      expect(typeof result.cleanup).toBe("function");
      expect(result.repoRoot).toBe(packageRoot);
      expect(result.supportDir).toBe(join(root, "support"));
      expect(result.fixtureServerPath).toBe(join(root, "support", "mcp-server.mjs"));
      expect(result.caplets.command).toBe(process.execPath);
      expect(result.caplets.args).toEqual([capletsCliPath]);
      expect(result.caplets.cwd).toBe(join(root, "support"));
      expect(result.caplets.env).toEqual({ CAPLETS_CONFIG: result.configPath });
      expect(result.caplets.mcpServer).toEqual({
        command: process.execPath,
        args: [capletsCliPath],
        cwd: join(root, "support"),
        env: { CAPLETS_CONFIG: result.configPath },
      });

      for (const [server, definition] of Object.entries(result.config.mcpServers)) {
        expect(["policy", "tickets", "api"]).toContain(server);
        expect(definition.command).toBe(process.execPath);
        expect(definition.args).toEqual([result.fixtureServerPath, "--server", server]);
        expect(definition.cwd).toBe(result.supportDir);
        expect(isAbsolute(definition.args[0])).toBe(true);
        expect(isAbsolute(definition.cwd)).toBe(true);
        expect(definition.env?.CAPLETS_CONFIG).toBeUndefined();
      }

      expect(Object.keys(result.caplets.env)).toEqual(["CAPLETS_CONFIG"]);
      expectNoHiddenBenchmarkPaths(result.config);
      expectNoHiddenBenchmarkPaths(result.caplets, { allowCapletsDist: true });
      await access(result.configPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can clean up temp Caplets benchmark config directories it creates", async () => {
    const result = await createBenchmarkCapletsConfig({ requireBuild: false });
    await access(result.configPath);

    await result.cleanup();

    await expect(access(result.configPath)).rejects.toThrow();
  });

  it("reports a clear live-run error when the built Caplets CLI is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-benchmark-missing-build-test-"));
    try {
      await expect(
        createBenchmarkCapletsConfig({
          rootDir: root,
          capletsCliPath: join(root, "missing-dist", "index.js"),
          requireBuild: true,
        }),
      ).rejects.toThrow("Run `pnpm build` before live Caplets benchmark runs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates reusable benchmark fixture MCP server definitions", () => {
    const paths = getBenchmarkPaths();
    const servers = createBenchmarkFixtureMcpServers({ directTools: true });

    expect(paths.repoRoot).toBe(packageRoot);
    expect(paths.fixtureServerPath).toBe(fixtureServerPath);
    expect(Object.keys(servers).sort()).toEqual(["api", "policy", "tickets"]);
    expect(servers.policy.command).toBe(process.execPath);
    expect(servers.policy.args).toEqual([paths.fixtureServerPath, "--server", "policy"]);
    expect(servers.policy.cwd).toBe(paths.repoRoot);
    expect(servers.policy.directTools).toBe(true);
  });

  it("returns a JSON-RPC parse error for malformed fixture MCP input", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [fixtureServerPath, "--server", "policy"],
      stdin: "{not json}\n",
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("redacts inherited process.env secret values from captured output", async () => {
    const previous = process.env.CAPLETS_SECRET_REVIEW_TOKEN;
    process.env.CAPLETS_SECRET_REVIEW_TOKEN = "inherited-review-secret";
    try {
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", "console.log(process.env.CAPLETS_SECRET_REVIEW_TOKEN)"],
        timeoutMs: 5_000,
      });

      expect(result.envKeys).toEqual([]);
      expect(result.stdout).toContain("[REDACTED]");
      expect(result.stdout).not.toContain("inherited-review-secret");
      expect(JSON.stringify(result)).not.toContain("inherited-review-secret");
    } finally {
      if (previous === undefined) {
        delete process.env.CAPLETS_SECRET_REVIEW_TOKEN;
      } else {
        process.env.CAPLETS_SECRET_REVIEW_TOKEN = previous;
      }
    }
  });

  it("truncates captured multibyte output on valid UTF-8 byte boundaries", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ééé')"],
      timeoutMs: 5_000,
      outputMaxBytes: 5,
    });

    expect(result.stdout).toBe("éé");
    expect(result.stdout).not.toContain("�");
    expect(result.stdoutBytes).toBe(6);
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(5);
  });

  it("kills the spawned process tree on timeout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-benchmark-timeout-test-"));
    const marker = join(workspace, "child-survived.txt");
    try {
      const result = await runProcess({
        command: process.execPath,
        args: [
          "-e",
          `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700); setTimeout(() => {}, 2000);`)}], { stdio: 'ignore' }); setTimeout(() => {}, 2000);`,
        ],
        timeoutMs: 100,
        killGraceMs: 100,
      });

      expect(result.timedOut).toBe(true);
      await sleep(900);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("resolves hidden validators inside the fixture root only", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-benchmark-fixture-root-"));
    try {
      expect(resolveInside(root, "validators/check.mjs")).toBe(join(root, "validators/check.mjs"));
      expect(() => resolveInside(root, "../outside.mjs")).toThrow(
        "Hidden validator must resolve inside fixture root",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scores transcript metrics and validation commands without live agent execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-benchmark-test-workspace-"));
    const fixtureRoot = await mkdtemp(join(tmpdir(), "caplets-benchmark-test-fixture-"));
    try {
      await writeFile(join(workspace, "candidate.txt"), "ok\n");
      await writeFile(
        join(workspace, "validation.test.mjs"),
        "import { test } from 'node:test';\nimport { readFileSync } from 'node:fs';\ntest('visible validation', () => readFileSync('candidate.txt', 'utf8'));\n",
      );
      await writeFile(
        join(fixtureRoot, "hidden-validator.mjs"),
        "import { test } from 'node:test';\nimport { readFileSync } from 'node:fs';\ntest('hidden validation', () => readFileSync('candidate.txt', 'utf8'));\n",
      );

      const score = await scoreTaskRun({
        task: {
          id: "example",
          validationCommand: `${process.execPath} --test validation.test.mjs`,
          hiddenValidator: "hidden-validator.mjs",
        },
        candidateWorkspace: workspace,
        fixtureRoot,
        agentResult: {
          stdout: '{"type":"tool_call","toolName":"policy_get"}\n',
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 12,
          command: "agent",
          args: ["run"],
          envKeys: ["API_KEY"],
          jsonEvents: [
            { type: "tool_call", toolName: "policy_get" },
            { type: "tool_call", toolName: "distractor_lookup", status: "failed" },
          ],
        },
      });

      expect(score.success).toBe(true);
      expect(score.finalStateValid).toBe(true);
      expect(score.process?.envKeys).toEqual(["API_KEY"]);
      expect(score.hiddenValidation.command).toBe(process.execPath);
      expect(score.hiddenValidation.args).toEqual([
        "--test",
        join(fixtureRoot, "hidden-validator.mjs"),
      ]);
      expect(score.metrics.toolCallCount).toBe(2);
      expect(score.metrics.failedCallCount).toBe(1);
      expect(score.metrics.irrelevantCallCount).toBe(1);
      expect(transcriptMetrics({ transcript: "abcd" }).approxTokenProxy).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not count crashed or timed-out agents as successful when validators pass", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-benchmark-process-score-test-"));
    try {
      await writeFile(
        join(workspace, "validation.test.mjs"),
        "import { test } from 'node:test';\ntest('ok', () => {});\n",
      );

      const crashed = await scoreTaskRun({
        task: {
          id: "example",
          validationCommand: `${process.execPath} --test validation.test.mjs`,
        },
        candidateWorkspace: workspace,
        agentResult: {
          ...emptyProcessResult({ command: "agent" }),
          exitCode: 1,
        },
      });
      const timedOut = await scoreTaskRun({
        task: {
          id: "example",
          validationCommand: `${process.execPath} --test validation.test.mjs`,
        },
        candidateWorkspace: workspace,
        agentResult: {
          ...emptyProcessResult({ command: "agent" }),
          timedOut: true,
        },
      });
      const unavailable = await scoreTaskRun({
        task: {
          id: "example",
          validationCommand: `${process.execPath} --test validation.test.mjs`,
        },
        candidateWorkspace: workspace,
        agentResult: {
          ...emptyProcessResult({ command: "agent" }),
          skipped: true,
          unavailable: true,
        },
      });

      expect(crashed.finalStateValid).toBe(true);
      expect(crashed.processSuccess).toBe(false);
      expect(crashed.success).toBe(false);
      expect(timedOut.finalStateValid).toBe(true);
      expect(timedOut.processSuccess).toBe(false);
      expect(timedOut.success).toBe(false);
      expect(unavailable.finalStateValid).toBe(true);
      expect(unavailable.processSuccess).toBe(false);
      expect(unavailable.success).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not count agent JSON error events as successful", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-benchmark-agent-error-test-"));
    try {
      await writeFile(
        join(workspace, "validation.test.mjs"),
        "import { test } from 'node:test';\ntest('ok', () => {});\n",
      );

      const score = await scoreTaskRun({
        task: {
          id: "example",
          validationCommand: `${process.execPath} --test validation.test.mjs`,
        },
        candidateWorkspace: workspace,
        agentResult: {
          ...emptyProcessResult({ command: "agent" }),
          jsonEvents: [
            {
              type: "error",
              error: {
                name: "APIError",
                data: { message: "Insufficient Balance", statusCode: 402 },
              },
            },
          ],
        },
      });

      expect(score.finalStateValid).toBe(true);
      expect(score.processSuccess).toBe(false);
      expect(score.processFailureReason).toBe("APIError (402): Insufficient Balance");
      expect(score.success).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not treat a missing agent exit code as a process failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caplets-benchmark-missing-exit-code-test-"));
    try {
      await writeFile(
        join(workspace, "validation.test.mjs"),
        "import { test } from 'node:test';\ntest('ok', () => {});\n",
      );

      const score = await scoreTaskRun({
        task: {
          id: "example",
          validationCommand: `${process.execPath} --test validation.test.mjs`,
        },
        candidateWorkspace: workspace,
        agentResult: withoutExitCode(emptyProcessResult({ command: "agent" })),
      });

      expect(score.processSuccess).toBe(true);
      expect(score.success).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("parses live benchmark args and builds the supported agent/mode matrix", () => {
    const options = parseLiveArgs([
      "--agent",
      "all",
      "--",
      "--mode=direct-flat,caplets",
      "--model",
      "provider/model",
      "--tasks",
      "discount-policy,retry-policy",
      "--runs",
      "2",
      "--timeout-ms",
      "1234",
      "--output-dir",
      "benchmark-results/custom-live",
      "--preserve-artifacts",
    ]);

    expect(options).toMatchObject({
      agent: "all",
      modes: ["direct-flat", "caplets"],
      model: "provider/model",
      tasks: ["discount-policy", "retry-policy"],
      runs: 2,
      timeoutMs: 1234,
      preserveArtifacts: true,
    });
    expect(options.outputDir).toBe(resolve("benchmark-results/custom-live"));
    expect(buildLiveMatrix(options)).toEqual([
      { agent: "pi", mode: "direct-flat" },
      { agent: "pi", mode: "caplets" },
      { agent: "opencode", mode: "direct-flat" },
      { agent: "opencode", mode: "caplets" },
    ]);
    expect(buildLiveMatrix({ agent: "pi" }).map((entry) => entry.mode)).toEqual([
      "direct-flat",
      "pi-proxy",
      "caplets",
    ]);
    expect(buildLiveMatrix({ agent: "opencode" }).map((entry) => entry.mode)).toEqual([
      "direct-flat",
      "caplets",
    ]);
    expect(() => buildLiveMatrix({ agent: "opencode", modes: ["pi-proxy"] })).toThrow(
      "opencode does not support benchmark mode pi-proxy",
    );
    expect(() => buildLiveMatrix({ agent: "opencode", runs: 0 })).toThrow(
      "runs must be a positive integer",
    );
    expect(() => buildLiveMatrix({ agent: "opencode", timeoutMs: Number.NaN })).toThrow(
      "timeoutMs must be a positive integer",
    );
  });

  it("rejects duplicate live benchmark task ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-live-duplicate-tasks-test-"));
    const tasksPath = join(root, "tasks.json");
    try {
      await writeFile(
        tasksPath,
        JSON.stringify([
          { id: "duplicate", prompt: "One" },
          { id: "duplicate", prompt: "Two" },
        ]),
      );

      await expect(loadTasks(tasksPath)).rejects.toThrow("Duplicate benchmark task id: duplicate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs live benchmark orchestration with fake runners and writes JSON/Markdown reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-live-orchestrator-test-"));
    const fixtureRoot = join(root, "fixtures");
    const fixtureWorkspace = join(fixtureRoot, "workspace");
    const outputDir = join(root, "reports");
    const tasksPath = join(fixtureRoot, "tasks.json");
    const hiddenValidatorPath = join(fixtureRoot, "hidden-validator.mjs");
    const runnerTasks: Record<string, unknown>[] = [];
    try {
      await mkdir(fixtureWorkspace, { recursive: true });
      await writeFile(join(fixtureWorkspace, "answer.txt"), "pending\n");
      await writeFile(
        join(fixtureWorkspace, "visible.test.mjs"),
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('visible', () => assert.equal(readFileSync('answer.txt', 'utf8'), 'fixed\\n'));\n",
      );
      await writeFile(
        hiddenValidatorPath,
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('hidden', () => assert.equal(readFileSync('answer.txt', 'utf8'), 'fixed\\n'));\n",
      );
      await writeFile(
        tasksPath,
        JSON.stringify([
          {
            id: "fix-answer",
            prompt: "Fix the answer file.",
            validationCommand: "node --test visible.test.mjs",
            hiddenValidator: "hidden-validator.mjs",
            requiredFact: "The answer must be fixed.",
            expectedFiles: ["answer.txt"],
          },
        ]),
      );

      const result = await runLiveBenchmark({
        options: {
          agent: "opencode",
          modes: ["direct-flat", "caplets"],
          runs: 1,
          timeoutMs: 5_000,
          outputDir,
        },
        env: { CAPLETS_BENCH_LIVE: "1" },
        fixtureRoot,
        fixtureWorkspaceRoot: fixtureWorkspace,
        tasksPath,
        now: fixedClock([
          new Date("2026-05-14T12:00:00.000Z"),
          new Date("2026-05-14T12:00:02.000Z"),
        ]),
        runners: {
          opencode: {
            run: async ({ task, candidateWorkspace, mode }) => {
              await access(outputDir);
              runnerTasks.push(task);
              await writeFile(join(candidateWorkspace, "answer.txt"), "fixed\n");
              return {
                ...emptyProcessResult({ command: "fake-opencode", args: [mode] }),
                agent: "opencode",
                mode,
                stdout: '{"type":"tool_call","toolName":"policy_get"}\n',
                stdoutBytes: 45,
                jsonEvents: [{ type: "tool_call", toolName: "policy_get" }],
              };
            },
          },
        },
      });

      expect(result.jsonPath).toBe(join(outputDir, "2026-05-14T12-00-00-000Z.json"));
      expect(result.markdownPath).toBe(join(outputDir, "2026-05-14T12-00-00-000Z.md"));
      expect(result.report.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
      expect(result.report.summary.byAgentMode).toHaveLength(2);
      const liveRuns = result.report.results as {
        mode: string;
        candidateWorkspace: string | null;
      }[];
      expect(liveRuns.map((run) => run.mode)).toEqual(["direct-flat", "caplets"]);
      expect(liveRuns.every((run) => run.candidateWorkspace === null)).toBe(true);
      expect(runnerTasks).toEqual([
        {
          id: "fix-answer",
          prompt: "Fix the answer file.",
          validationCommand: "node --test visible.test.mjs",
          expectedFiles: ["answer.txt"],
        },
        {
          id: "fix-answer",
          prompt: "Fix the answer file.",
          validationCommand: "node --test visible.test.mjs",
          expectedFiles: ["answer.txt"],
        },
      ]);
      expect(JSON.stringify(runnerTasks)).not.toContain("requiredFact");
      expect(JSON.stringify(runnerTasks)).not.toContain("hiddenValidator");

      const jsonReport = JSON.parse(await readFile(result.jsonPath, "utf8"));
      const markdownReport = await readFile(result.markdownPath, "utf8");
      expect(jsonReport.tasks).toEqual([
        {
          id: "fix-answer",
          prompt: "Fix the answer file.",
          validationCommand: "node --test visible.test.mjs",
          expectedFiles: ["answer.txt"],
        },
      ]);
      expect(JSON.stringify(jsonReport.tasks)).not.toContain("requiredFact");
      expect(JSON.stringify(jsonReport.tasks)).not.toContain("hiddenValidator");
      expect(markdownReport).toContain("| opencode | direct-flat | 1/1 | 100% |");
      expect(markdownReport).toContain("- None");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses live orchestration without the explicit env guard", async () => {
    await expect(
      runLiveBenchmark({
        options: { agent: "pi" },
        env: {},
        runners: {},
      }),
    ).rejects.toThrow("CAPLETS_BENCH_LIVE=1");
  });

  it("cleans candidate workspaces when a live runner throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-live-cleanup-on-throw-test-"));
    const fixtureRoot = join(root, "fixtures");
    const fixtureWorkspace = join(fixtureRoot, "workspace");
    const outputDir = join(root, "reports");
    const tasksPath = join(fixtureRoot, "tasks.json");
    let observedWorkspace: string | undefined;
    try {
      await mkdir(fixtureWorkspace, { recursive: true });
      await writeFile(join(fixtureWorkspace, "answer.txt"), "ok\n");
      await writeFile(
        join(fixtureWorkspace, "visible.test.mjs"),
        "import { test } from 'node:test';\ntest('ok', () => {});\n",
      );
      await writeFile(
        tasksPath,
        JSON.stringify([
          {
            id: "runner-throws",
            prompt: "Run and fail.",
            validationCommand: "node --test visible.test.mjs",
          },
        ]),
      );

      const result = await runLiveBenchmark({
        options: { agent: "opencode", modes: ["direct-flat"], outputDir },
        env: { CAPLETS_BENCH_LIVE: "1" },
        fixtureRoot,
        fixtureWorkspaceRoot: fixtureWorkspace,
        tasksPath,
        runners: {
          opencode: {
            run: async ({ candidateWorkspace }) => {
              observedWorkspace = candidateWorkspace;
              throw new Error("agent crashed before scoring");
            },
          },
        },
      });

      expect(result.report.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
      expect(result.report.results[0].score.finalStateValid).toBe(true);
      expect(result.report.results[0].score.success).toBe(false);
      expect(observedWorkspace).toBeTruthy();
      await expect(access(observedWorkspace!)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fixedClock(dates: Date[]) {
  let index = 0;
  return () => dates[Math.min(index++, dates.length - 1)] ?? dates[dates.length - 1]!;
}

function emptyProcessResult(options: { command?: string; args?: string[] } = {}) {
  return {
    command: options.command ?? "pi",
    args: options.args ?? [],
    envKeys: [],
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputMaxBytes: 1024,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    jsonEvents: [],
  };
}

function withoutExitCode<T extends { exitCode?: unknown }>(result: T): Omit<T, "exitCode"> {
  const { exitCode: _exitCode, ...rest } = result;
  return rest;
}
