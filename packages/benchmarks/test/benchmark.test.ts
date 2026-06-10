import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PROCESS_TERMINATION_BEHAVIOR,
  parseJsonEvents,
  redactOutput,
  runProcess,
} from "../lib/live-agent";
import { createBenchmarkCapletsConfig } from "../lib/config";
import { PI_CONFIG_MODES, createPiMcpConfigs, detectPiCli, piRunner } from "../lib/pi-runner";
import {
  OPENCODE_CONFIG_MODES,
  createOpenCodeMcpConfigs,
  detectOpenCodeCli,
  opencodeRunner,
} from "../lib/opencode-runner";
import { buildLiveMatrix, loadTasks, parseLiveArgs, runLiveBenchmark } from "../run-live";
import { resolveInside, scoreTaskRun, transcriptMetrics } from "../lib/scoring";
import {
  SURFACE_THRESHOLDS,
  computeSurfaceBenchmark,
  validateSurfaceBenchmark,
} from "../lib/surface";
import {
  CODE_MODE_BENCHMARK_THRESHOLDS,
  computeCodeModeBenchmark,
  validateCodeModeBenchmark,
} from "../lib/code-mode";
import {
  EXECUTOR_MCP_DIRECT_TOOLS_ENV,
  EXECUTOR_PI_EVAL_ADAPTER_EXPOSURE,
  PI_EVAL_MODES,
  PI_MCP_ADAPTER_EXTENSION_SOURCE,
  VANILLA_MCP_DIRECT_TOOLS_ENV,
  VANILLA_MCP_PI_EVAL_ADAPTER_EXPOSURE,
  buildPiEvalCommand,
  buildPiEvalPrewarmPrompt,
  buildPiEvalPrompt,
  createExecutorMcpAdapterConfig,
  createPiEvalRunConfig,
  createVanillaMcpAdapterConfig,
  piEvalModeProduct,
} from "../lib/pi-eval/config";
import {
  computeDomainCoverage,
  requiredEvidenceScore,
  summarizePiEvalMetrics,
} from "../lib/pi-eval/metrics";
import piEvalInstrumentation from "../lib/pi-eval/instrumentation-extension";
import { renderPiEvalMarkdownReport, summarizePiEvalResults } from "../lib/pi-eval/report";
import {
  buildPiEvalMatrix,
  parsePiEvalArgs,
  prewarmMcpAdapterDirectTools,
  runPiEvalBenchmark,
} from "../run-pi-eval";
import {
  createExecutorFixtureSourcePayloads,
  detectExecutorCli,
  setupExecutorFixtureSources,
} from "../lib/pi-eval/executor";
import { createNativeCapletsService } from "@caplets/core/native";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const capletsCliPath = join(repoRoot, "packages", "cli", "dist", "index.js");
const fixtureServerPath = join(packageRoot, "fixtures", "mcp-server.ts");

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
  it("exposes a much smaller initial tool list than direct aggregation", async () => {
    const result = await computeSurfaceBenchmark();

    expect(validateSurfaceBenchmark(result)).toEqual([]);
    expect(result.direct.toolCount).toBeGreaterThan(result.caplets.toolCount);
    expect(result.reductions.initialPayloadReduction).toBeGreaterThanOrEqual(
      SURFACE_THRESHOLDS.minInitialPayloadReduction,
    );
    expect(result.collisions.directDuplicateToolNameCount).toBeGreaterThan(0);
    expect(result.collisions.capletsTopLevelDuplicateToolNameCount).toBe(0);
    expect(result.runtime).toMatchObject({
      duplicatedStructuredContentBytes: expect.any(Number),
      compactStructuredContentBytes: expect.any(Number),
    });
    expect(result.runtime.compactStructuredContentBytes).toBeLessThan(
      result.runtime.duplicatedStructuredContentBytes,
    );
    expect(result.runtime.compactReduction).toBeGreaterThan(0.5);
  });

  it("covers Code Mode V1 round-trip and token-efficiency evaluation categories", () => {
    const result = computeCodeModeBenchmark();

    expect(validateCodeModeBenchmark(result)).toEqual([]);
    expect(result.tasks).toHaveLength(CODE_MODE_BENCHMARK_THRESHOLDS.minTaskCount);
    expect(new Set(result.tasks.map((task) => task.category))).toEqual(
      new Set([
        "single-caplet",
        "multi-caplet",
        "discovery-fallback",
        "project-binding",
        "hosted-sandbox",
        "validation-recovery",
      ]),
    );
    expect(result.totals.roundTripReduction).toBeGreaterThanOrEqual(
      CODE_MODE_BENCHMARK_THRESHOLDS.minRoundTripReduction,
    );
    expect(result.totals.contextTokenReduction).toBeGreaterThanOrEqual(0);
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
    expect(result.jsonEvents).toEqual([{ type: "tool_call", toolName: "policy_get" }]);
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

  it("parses JSONL events from the full stream even when stdout is capped", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ type: 'message_end', usage: { totalTokens: 12 } })); console.log('x'.repeat(2000));",
      ],
      timeoutMs: 5_000,
      outputMaxBytes: 16,
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toHaveLength(16);
    expect(result.jsonEvents).toEqual([{ type: "message_end", usage: { totalTokens: 12 } }]);
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
      expect(directPolicy.command).toBe("tsx");
      expect(isAbsolute(directPolicy.args[0])).toBe(true);
      expect(directPolicy.args).toEqual([
        join(root, "pi", "mcp", "support", "mcp-server.ts"),
        "--server",
        "policy",
      ]);
      expect(isAbsolute(directPolicy.cwd)).toBe(true);
      expect(directPolicy.cwd).toBe(join(root, "pi", "mcp", "support"));
      expect(directPolicy.directTools).toBe(true);

      const proxyPolicy = result.configs["pi-proxy"]?.mcpServers.policy;
      expect(proxyPolicy.command).toBe("tsx");
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
      expect(projectMcp.mcpServers.policy.command).toBe("tsx");
      expect(isAbsolute(projectMcp.mcpServers.policy.args[0])).toBe(true);
      expect(projectMcp.mcpServers.policy.args[0]).toBe(
        join(root, "pi", "mcp", "support", "mcp-server.ts"),
      );
      expect(isAbsolute(projectMcp.mcpServers.policy.cwd)).toBe(true);
      expect(projectMcp.mcpServers.policy.cwd).toBe(join(root, "pi", "mcp", "support"));
      expect(result.configs["pi-proxy"]?.path).not.toBe(projectMcpPath);
      expectNoHiddenBenchmarkPaths(projectMcp);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      expect(directPolicy.command[0]).toBe("tsx");
      expect(isAbsolute(directPolicy.command[1])).toBe(true);
      expect(directPolicy.command[1]).toBe(
        join(root, "opencode", "mcp", "support", "mcp-server.ts"),
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
      expect(result.fixtureServerPath).toBe(join(root, "support", "mcp-server.ts"));
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
        expect(definition.command).toBe("tsx");
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

  it("returns a JSON-RPC parse error for malformed fixture MCP input", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), fixtureServerPath, "--server", "policy"],
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
        "--import",
        import.meta.resolve("tsx"),
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

describe("Pi live tool surface eval harness", () => {
  it("parses modes and builds the complete Pi eval matrix", () => {
    expect(buildPiEvalMatrix({}).map((entry) => entry.mode)).toEqual([...PI_EVAL_MODES]);
    expect(buildPiEvalMatrix({}).find((entry) => entry.mode === "vanilla-mcp")).toMatchObject({
      mode: "vanilla-mcp",
      product: "mcp",
    });
    expect(buildPiEvalMatrix({}).find((entry) => entry.mode === "executor-mcp")).toMatchObject({
      mode: "executor-mcp",
      product: "executor",
    });
    expect(piEvalModeProduct("caplets-code-mode")).toBe("caplets");
    expect(piEvalModeProduct("vanilla-mcp")).toBe("mcp");
    expect(piEvalModeProduct("executor-mcp")).toBe("executor");
    expect(
      parsePiEvalArgs(["--mode", "caplets-code-mode,caplets-progressive-code-mode", "--runs", "2"]),
    ).toMatchObject({
      modes: ["caplets-code-mode", "caplets-progressive-code-mode"],
      runs: 2,
      concurrency: 1,
    });
    expect(parsePiEvalArgs(["--concurrency", "3"])).toMatchObject({ concurrency: 3 });
    expect(() => parsePiEvalArgs(["--concurrency", "0"])).toThrow(/positive integer/u);
    expect(
      parsePiEvalArgs([
        "--mode",
        "executor-mcp",
        "--executor-command",
        "executor-test",
        "--skip-missing-competitors",
      ]),
    ).toMatchObject({
      modes: ["executor-mcp"],
      executorCommand: "executor-test",
      skipMissingCompetitors: true,
    });
    expect(() => parsePiEvalArgs(["--mode", "unknown"])).toThrow(/Unknown Pi eval mode/u);
  });

  it("builds mode-specific prompts and Pi commands without user context files", () => {
    const task = { prompt: "Fix checkout retries." };
    expect(buildPiEvalPrompt(task, "caplets-direct")).toContain("caplets__<server>__<tool>");
    expect(buildPiEvalPrompt(task, "caplets-progressive-code-mode")).toContain(
      "Both Caplets capability tools and caplets_code_mode are available",
    );
    expect(buildPiEvalPrompt(task, "vanilla-mcp")).toContain("issues_...");
    expect(buildPiEvalPrompt(task, "vanilla-mcp")).toContain("without Caplets or Executor");
    expect(buildPiEvalPrompt(task, "vanilla-mcp")).not.toContain("caplets_code_mode");
    expect(buildPiEvalPrompt(task, "vanilla-mcp")).not.toContain("executor_...");
    expect(buildPiEvalPrompt(task, "executor-mcp")).toContain("executor_...");
    expect(buildPiEvalPrompt(task, "executor-mcp")).not.toContain("caplets_code_mode");
    expect(buildPiEvalPrewarmPrompt()).toContain("configured server(s)");

    const command = buildPiEvalCommand({
      command: "pi-test",
      prompt: "hello",
      model: "provider/model",
      extensionPaths: ["/tmp/a.js", "/tmp/b.js"],
      extraArgs: ["--mcp-config", "/tmp/mcp.json"],
    });
    expect(command).toEqual({
      command: "pi-test",
      args: [
        "--mode",
        "json",
        "-p",
        "hello",
        "--approve",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--model",
        "provider/model",
        "-e",
        "/tmp/a.js",
        "-e",
        "/tmp/b.js",
        "--mcp-config",
        "/tmp/mcp.json",
      ],
    });
  });

  it("creates isolated vanilla MCP eval config with pi-mcp-adapter direct tools only", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-vanilla-mcp-config-test-"));
    const sourceAgentDir = join(root, "source-agent");
    try {
      await mkdir(sourceAgentDir, { recursive: true });
      await writeFile(join(sourceAgentDir, "auth.json"), '{"token":"secret"}\n');
      await writeFile(join(sourceAgentDir, "models.json"), '{"default":"model"}\n');
      await writeFile(join(sourceAgentDir, "plugin.js"), "throw new Error('must not copy')\n");

      const config = await createPiEvalRunConfig({
        rootDir: root,
        mode: "vanilla-mcp",
        piAgentSourceDir: sourceAgentDir,
      });

      expect(config.product).toBe("mcp");
      expect(config.adapterExposure).toBe(VANILLA_MCP_PI_EVAL_ADAPTER_EXPOSURE);
      expect(config.extensionPaths).toEqual([
        config.instrumentationPath,
        PI_MCP_ADAPTER_EXTENSION_SOURCE,
      ]);
      expect(config.extraArgs).toEqual(["--mcp-config", config.adapterConfigPath]);
      expect(config.env.MCP_DIRECT_TOOLS).toBe(VANILLA_MCP_DIRECT_TOOLS_ENV);
      expect(config.env.CAPLETS_CONFIG).toBeUndefined();
      expect(config.env.HOME).toBeUndefined();
      expect(config.executorCommand).toBeUndefined();
      expect(config.executorDataDir).toBeUndefined();
      expect(config.adapterConfig.settings).toMatchObject({
        directTools: true,
        disableProxyTool: true,
        sampling: false,
        elicitation: false,
      });
      expect(Object.keys(config.adapterConfig.mcpServers).sort()).toEqual([
        "api",
        "ci",
        "code-map",
        "docs",
        "issues",
      ]);
      expect(config.adapterConfig.mcpServers.issues).toMatchObject({
        command: "tsx",
        args: [config.fixtureServerPath, "--server", "issues"],
        lifecycle: "eager",
        directTools: true,
        cwd: config.supportDir,
      });
      expect(config.adapterConfig).toEqual(
        createVanillaMcpAdapterConfig({
          fixtureServerPath: config.fixtureServerPath,
          supportDir: config.supportDir,
          path: config.env.PATH,
        }),
      );
      await expect(access(join(config.agentDir, "auth.json"))).resolves.toBeUndefined();
      await expect(access(join(config.agentDir, "models.json"))).resolves.toBeUndefined();
      await expect(access(join(config.agentDir, "plugin.js"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const adapterConfig = JSON.parse(await readFile(config.adapterConfigPath, "utf8"));
      expect(adapterConfig).toEqual(config.adapterConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates isolated Executor MCP eval config with pi-mcp-adapter direct tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-executor-config-test-"));
    const sourceAgentDir = join(root, "source-agent");
    try {
      await mkdir(sourceAgentDir, { recursive: true });
      await writeFile(join(sourceAgentDir, "auth.json"), '{"token":"secret"}\n');
      await writeFile(join(sourceAgentDir, "models.json"), '{"default":"model"}\n');
      await writeFile(join(sourceAgentDir, "plugin.js"), "throw new Error('must not copy')\n");

      const config = await createPiEvalRunConfig({
        rootDir: root,
        mode: "executor-mcp",
        piAgentSourceDir: sourceAgentDir,
        executorCommand: "executor-test",
      });

      expect(config.product).toBe("executor");
      expect(config.adapterExposure).toBe(EXECUTOR_PI_EVAL_ADAPTER_EXPOSURE);
      expect(config.extensionPaths).toEqual([
        config.instrumentationPath,
        PI_MCP_ADAPTER_EXTENSION_SOURCE,
      ]);
      expect(config.extraArgs).toEqual(["--mcp-config", config.adapterConfigPath]);
      expect(config.env.HOME).toBe(config.adapterHomeDir);
      expect(config.env.PI_CODING_AGENT_DIR).toBe(config.agentDir);
      expect(config.env.MCP_DIRECT_TOOLS).toBe(EXECUTOR_MCP_DIRECT_TOOLS_ENV);
      expect(config.env.CAPLETS_CONFIG).toBeUndefined();
      expect(config.adapterConfig.settings).toMatchObject({
        directTools: true,
        disableProxyTool: true,
        sampling: false,
        elicitation: false,
      });
      expect(config.adapterConfig.mcpServers.executor).toMatchObject({
        command: "executor-test",
        args: ["mcp"],
        lifecycle: "eager",
        directTools: true,
        cwd: config.supportDir,
      });
      expect(config.adapterConfig.mcpServers.executor.env).toMatchObject({
        EXECUTOR_DATA_DIR: config.executorDataDir,
        EXECUTOR_SCOPE_DIR: config.executorScopeDir,
      });
      expect(config.adapterConfig).toEqual(
        createExecutorMcpAdapterConfig({
          executorCommand: "executor-test",
          executorDataDir: config.executorDataDir,
          executorScopeDir: config.executorScopeDir,
          supportDir: config.supportDir,
          path: config.env.PATH,
        }),
      );
      await expect(access(join(config.agentDir, "auth.json"))).resolves.toBeUndefined();
      await expect(access(join(config.agentDir, "models.json"))).resolves.toBeUndefined();
      await expect(access(join(config.agentDir, "plugin.js"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const adapterConfig = JSON.parse(await readFile(config.adapterConfigPath, "utf8"));
      expect(adapterConfig).toEqual(config.adapterConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds Executor fixture source payloads and setup commands", async () => {
    const payloads = createExecutorFixtureSourcePayloads({
      fixtureServerPath: "/tmp/mcp-server.ts",
      supportDir: "/tmp/support",
      sourceCommand: "tsx-test",
    });
    expect(payloads).toHaveLength(5);
    expect(payloads[0]).toEqual({
      transport: "stdio",
      name: "issues",
      command: "tsx-test",
      args: ["/tmp/mcp-server.ts", "--server", "issues"],
      cwd: "/tmp/support",
    });

    const calls: any[] = [];
    await expect(
      setupExecutorFixtureSources({
        executorCommand: "executor-test",
        fixtureServerPath: "/tmp/mcp-server.ts",
        supportDir: "/tmp/support",
        sourceCommand: "tsx-test",
        env: { EXECUTOR_DATA_DIR: "/tmp/executor-data" },
        processRunner: async (call: any) => {
          calls.push(call);
          return {
            ...emptyProcessResult({ command: call.command, args: call.args }),
            stdout: JSON.stringify({
              namespace: JSON.parse(call.args[4]).name,
              source: { id: JSON.parse(call.args[4]).name, scope: "scope-test" },
              toolCount: 28,
              discovery: { status: "ok" },
            }),
          };
        },
      }),
    ).resolves.toMatchObject({ payloads });
    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatchObject({
      command: "executor-test",
      args: ["call", "executor", "mcp", "addSource", JSON.stringify(payloads[0])],
      cwd: "/tmp/support",
    });
  });

  it("resumes paused Executor fixture source setup and rejects missing tool registration", async () => {
    const calls: any[] = [];
    await expect(
      setupExecutorFixtureSources({
        executorCommand: "executor-test",
        fixtureServerPath: "/tmp/mcp-server.ts",
        supportDir: "/tmp/support",
        servers: ["issues"],
        processRunner: async (call: any) => {
          calls.push(call);
          if (call.args[0] === "resume") {
            return {
              ...emptyProcessResult({ command: call.command, args: call.args }),
              stdout: JSON.stringify({
                ok: true,
                data: {
                  namespace: "issues",
                  source: { id: "issues", scope: "scope-test" },
                  toolCount: 28,
                  discovery: { status: "ok" },
                },
              }),
            };
          }
          return {
            ...emptyProcessResult({ command: call.command, args: call.args }),
            stdout: [
              "Execution paused: Add an MCP source",
              "executionId: exec_1",
              "Approve in browser:",
              "  http://localhost:49181/resume/exec_1",
            ].join("\n"),
          };
        },
      }),
    ).resolves.toMatchObject({
      results: [
        expect.objectContaining({
          output: expect.objectContaining({
            ok: true,
            data: expect.objectContaining({ toolCount: 28 }),
          }),
        }),
      ],
    });
    expect(calls.map((call) => call.args[0])).toEqual(["call", "resume"]);
    expect(calls[1].args).toEqual([
      "resume",
      "--execution-id",
      "exec_1",
      "--base-url",
      "http://localhost:49181",
      "--action",
      "accept",
      "--content",
      "{}",
    ]);

    await expect(
      setupExecutorFixtureSources({
        executorCommand: "executor-test",
        fixtureServerPath: "/tmp/mcp-server.ts",
        supportDir: "/tmp/support",
        servers: ["issues"],
        processRunner: async (call: any) => ({
          ...emptyProcessResult({ command: call.command, args: call.args }),
          stdout: JSON.stringify({
            namespace: "issues",
            toolCount: 0,
            discovery: { status: "ok" },
          }),
        }),
      }),
    ).rejects.toThrow(/expected registered tools/u);
  });

  it("detects Executor CLI availability and missing CLI failures", async () => {
    await expect(
      detectExecutorCli({
        command: "executor-test",
        runProcess: async () => ({ ...emptyProcessResult(), stdout: "executor 1.2.3\n" }),
      }),
    ).resolves.toMatchObject({
      available: true,
      command: "executor-test",
      version: "executor 1.2.3",
    });

    await expect(
      detectExecutorCli({
        command: "missing-executor",
        runProcess: async () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      }),
    ).resolves.toMatchObject({ available: false, command: "missing-executor" });
  });

  it("prewarms Executor direct tools with separate unmeasured metrics and sessions", async () => {
    const calls: any[] = [];
    const runConfig = {
      extensionPaths: ["/tmp/instrumentation.ts", PI_MCP_ADAPTER_EXTENSION_SOURCE],
      extraArgs: ["--mcp-config", "/tmp/executor-mcp.json"],
      env: {
        HOME: "/tmp/home",
        PI_CODING_AGENT_DIR: "/tmp/agent",
        PI_CODING_AGENT_SESSION_DIR: "/tmp/sessions",
        CAPLETS_PI_EVAL_METRICS: "/tmp/metrics.jsonl",
        MCP_DIRECT_TOOLS: EXECUTOR_MCP_DIRECT_TOOLS_ENV,
      },
      prewarmMetricsPath: "/tmp/prewarm-metrics.jsonl",
      prewarmSessionsDir: "/tmp/prewarm-sessions",
    };

    const result = await prewarmMcpAdapterDirectTools({
      piCommand: "pi-test",
      model: "provider/model",
      runConfig,
      candidateWorkspace: "/tmp/workspace",
      env: { CAPLETS_BENCH_LIVE: "1", HOME: "/tmp/outer-home" },
      processRunner: async (call: any) => {
        calls.push(call);
        return emptyProcessResult({ command: call.command, args: call.args });
      },
    });

    expect(result.command).toBe("pi-test");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--mcp-config");
    expect(calls[0].args).toContain("/tmp/executor-mcp.json");
    expect(calls[0].args).toContain(PI_MCP_ADAPTER_EXTENSION_SOURCE);
    expect(calls[0].env.CAPLETS_PI_EVAL_METRICS).toBe("/tmp/prewarm-metrics.jsonl");
    expect(calls[0].env.PI_CODING_AGENT_SESSION_DIR).toBe("/tmp/prewarm-sessions");
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe("/tmp/agent");
    expect(calls[0].env.HOME).toBe("/tmp/home");
    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("creates isolated Pi eval config and copies only auth-bearing Pi files", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-config-test-"));
    const sourceAgentDir = join(root, "source-agent");
    const fakePiExtension = join(root, "pi-extension.js");
    try {
      await mkdir(sourceAgentDir, { recursive: true });
      await writeFile(fakePiExtension, "export default function extension() {}\n");
      await writeFile(join(sourceAgentDir, "auth.json"), '{"token":"secret"}\n');
      await writeFile(join(sourceAgentDir, "models.json"), '{"default":"model"}\n');
      await writeFile(join(sourceAgentDir, "plugin.js"), "throw new Error('must not copy')\n");

      const config = await createPiEvalRunConfig({
        rootDir: root,
        mode: "caplets-progressive-code-mode",
        piExtensionPath: fakePiExtension,
        piAgentSourceDir: sourceAgentDir,
      });

      expect(config.config.options.exposure).toBe("progressive_and_code_mode");
      expect(Object.keys(config.config.mcpServers).sort()).toEqual([
        "api",
        "ci",
        "code-map",
        "docs",
        "issues",
      ]);
      expect(config.copiedPiAuthFiles.sort()).toEqual(["auth.json", "models.json"]);
      await expect(access(join(config.agentDir, "auth.json"))).resolves.toBeUndefined();
      await expect(access(join(config.agentDir, "models.json"))).resolves.toBeUndefined();
      await expect(access(join(config.agentDir, "plugin.js"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(config.env.CAPLETS_CONFIG).toBe(config.configPath);
      expect(config.env.PI_CODING_AGENT_DIR).toBe(config.agentDir);
      expect(config.extensionPaths).toEqual([config.instrumentationPath, resolve(fakePiExtension)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes direct Caplets tools from the Pi eval fixture servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-direct-test-"));
    const sourceAgentDir = join(root, "source-agent");
    const fakePiExtension = join(root, "pi-extension.js");
    const previousPath = process.env.PATH;
    try {
      await mkdir(sourceAgentDir, { recursive: true });
      await writeFile(fakePiExtension, "export default function extension() {}\n");
      const config = await createPiEvalRunConfig({
        rootDir: root,
        mode: "caplets-direct",
        piExtensionPath: fakePiExtension,
        piAgentSourceDir: sourceAgentDir,
      });
      process.env.PATH = config.env.PATH;
      const service = createNativeCapletsService({
        mode: "local",
        configPath: config.configPath,
        watch: false,
      });

      try {
        await expect(service.reload()).resolves.toBe(true);
        const names = service.listTools().map((tool) => tool.toolName);
        expect(names).toContain("caplets__issues__search");
        expect(names).toContain("caplets__ci__get_run");
        expect(names).toContain("caplets__docs__idempotency_guidance");
        expect(names).toContain("caplets__api__get_endpoint");
        expect(names).toContain("caplets__code-map__target_files");
      } finally {
        await service.close();
      }
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts real tool executions and classifies direct, progressive, and Code Mode choices", () => {
    const events = [
      {
        type: "before_provider_request",
        model: "test-model",
        requestPayloadBytes: 100,
        requestPayloadEstimatedTokens: 25,
        toolSurfaceBytes: 40,
        toolSurfaceEstimatedTokens: 10,
        messagePayloadBytes: 60,
        messagePayloadEstimatedTokens: 15,
      },
      { type: "tool_execution_start", toolName: "caplets__issues__search" },
      { type: "tool_execution_end", toolName: "caplets__issues__search" },
      { type: "tool_execution_start", toolName: "caplets_code_mode" },
      { type: "tool_execution_end", toolName: "caplets_code_mode" },
      { type: "tool_execution_start", toolName: "caplets_docs" },
      { type: "tool_execution_end", toolName: "caplets_docs" },
      { type: "after_provider_response", usage: { input_tokens: 1, output_tokens: 2 } },
    ];

    const metrics = summarizePiEvalMetrics(events, [
      { type: "tool_execution_start", toolName: "caplets_code_mode" },
    ]);

    expect(metrics.toolCallCount).toBe(3);
    expect(metrics.toolCallEventSource).toBe("metrics-jsonl");
    expect(metrics.toolEventCount).toBe(6);
    expect(metrics.toolNames).toEqual([
      "caplets__issues__search",
      "caplets_code_mode",
      "caplets_docs",
    ]);
    expect(metrics.hybridChoice).toBe("mixed-direct-progressive-code-mode");
    expect(metrics.requestPayloadEstimatedTokens).toBe(25);
    expect(metrics.toolSurfaceEstimatedTokens).toBe(10);
    expect(metrics.nonSurfaceEstimatedTokens).toBe(15);
    expect(metrics.requestTokenBuckets).toMatchObject({
      requestCount: 1,
      totals: {
        requestPayloadEstimatedTokens: 25,
        toolSurfaceEstimatedTokens: 10,
        nonSurfaceEstimatedTokens: 15,
        messagePayloadEstimatedTokens: 15,
        attributedNonSurfaceEstimatedTokens: 15,
        requestOverheadEstimatedTokens: 0,
      },
    });
    expect(metrics.providerUsage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  it("uses Pi JSON message usage when instrumented provider usage is unavailable", () => {
    const metrics = summarizePiEvalMetrics(
      [],
      [
        {
          type: "message_end",
          message: {
            role: "assistant",
            usage: { input: 10, output: 3, cacheRead: 20, totalTokens: 33 },
          },
        },
        {
          type: "turn_end",
          message: {
            role: "assistant",
            usage: { input: 10, output: 3, cacheRead: 20, totalTokens: 33 },
          },
        },
      ],
    );

    expect(metrics.providerUsage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      totalTokens: 33,
    });
  });

  it("preserves per-request token buckets for prompt attribution", () => {
    const metrics = summarizePiEvalMetrics([
      {
        type: "before_provider_request",
        requestPayloadEstimatedTokens: 100,
        toolSurfaceEstimatedTokens: 30,
        messagePayloadEstimatedTokens: 50,
        requestTokenBuckets: {
          requestPayloadEstimatedTokens: 100,
          toolSurfaceEstimatedTokens: 30,
          nonSurfaceEstimatedTokens: 70,
          messagePayloadEstimatedTokens: 50,
          instructionEstimatedTokens: 10,
          userMessageEstimatedTokens: 20,
          assistantMessageEstimatedTokens: 15,
          toolCallMessageEstimatedTokens: 2,
          toolResultMessageEstimatedTokens: 13,
          attributedNonSurfaceEstimatedTokens: 60,
          requestOverheadEstimatedTokens: 10,
        },
      },
      {
        type: "before_provider_request",
        requestPayloadEstimatedTokens: 80,
        toolSurfaceEstimatedTokens: 20,
        messagePayloadEstimatedTokens: 45,
        requestTokenBuckets: {
          requestPayloadEstimatedTokens: 80,
          toolSurfaceEstimatedTokens: 20,
          nonSurfaceEstimatedTokens: 60,
          messagePayloadEstimatedTokens: 45,
          instructionEstimatedTokens: 10,
          userMessageEstimatedTokens: 15,
          assistantMessageEstimatedTokens: 20,
          toolResultMessageEstimatedTokens: 10,
          attributedNonSurfaceEstimatedTokens: 55,
          requestOverheadEstimatedTokens: 5,
        },
      },
    ]);

    expect(metrics.requestTokenBuckets).toMatchObject({
      requestCount: 2,
      totals: {
        requestPayloadEstimatedTokens: 180,
        toolSurfaceEstimatedTokens: 50,
        nonSurfaceEstimatedTokens: 130,
        messagePayloadEstimatedTokens: 95,
        instructionEstimatedTokens: 20,
        userMessageEstimatedTokens: 35,
        assistantMessageEstimatedTokens: 35,
        toolCallMessageEstimatedTokens: 2,
        toolResultMessageEstimatedTokens: 23,
        attributedNonSurfaceEstimatedTokens: 115,
        requestOverheadEstimatedTokens: 15,
      },
      averagesPerRequest: {
        requestPayloadEstimatedTokens: 90,
        toolSurfaceEstimatedTokens: 25,
        nonSurfaceEstimatedTokens: 65,
      },
    });
    expect(metrics.requestTokenBuckets.sharesOfRequest.toolSurfaceEstimatedTokens).toBeCloseTo(
      50 / 180,
    );
  });

  it("instruments OpenAI Responses input payloads into request token buckets", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-instrumentation-test-"));
    const metricsPath = join(root, "metrics.jsonl");
    const previousMetricsPath = process.env.CAPLETS_PI_EVAL_METRICS;
    const handlers = new Map<string, (event: any) => void>();
    try {
      process.env.CAPLETS_PI_EVAL_METRICS = metricsPath;
      piEvalInstrumentation({
        on: (event: string, handler: (payload: any) => void) => handlers.set(event, handler),
      });

      handlers.get("before_provider_request")?.({
        provider: "openai",
        payload: {
          model: "test-model",
          instructions: "Use tools only when they provide external evidence.",
          input: [
            { role: "system", content: "System prompt with benchmark rules." },
            { role: "user", content: "Investigate BENCH-451 and CI-9182." },
            {
              role: "assistant",
              content: "I will inspect the incident and CI state.",
            },
            { type: "function_call", name: "issues_active_incidents", arguments: "{}" },
            {
              type: "function_call_output",
              call_id: "call-1",
              output: "BENCH-451 checkout retry hardening incident.",
            },
          ],
          tools: [
            {
              type: "function",
              name: "issues_active_incidents",
              description: "List active incidents.",
            },
          ],
        },
      });
      handlers.get("tool_result")?.({
        toolName: "issues_active_incidents",
        input: { query: "BENCH-451 must not be attributed from input" },
        result: [{ id: "BENCH-451", title: "Checkout retry hardening" }],
      });

      const events = (await readFile(metricsPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      const request = events.find((event) => event.type === "before_provider_request");
      expect(request.messagePayloadBytes).toBeGreaterThan(2);
      expect(request.requestTokenBuckets.messagePayloadEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.instructionEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.instructionMessageEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.userMessageEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.assistantMessageEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.toolCallMessageEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.toolResultMessageEstimatedTokens).toBeGreaterThan(0);
      expect(request.requestTokenBuckets.requestOverheadEstimatedTokens).toBeGreaterThanOrEqual(0);

      const toolResult = events.find((event) => event.type === "tool_result");
      expect(toolResult.resultPreview).toContain("BENCH-451");
      expect(toolResult.resultPreview).not.toContain("must not be attributed from input");
    } finally {
      if (previousMetricsPath == null) delete process.env.CAPLETS_PI_EVAL_METRICS;
      else process.env.CAPLETS_PI_EVAL_METRICS = previousMetricsPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not classify direct Caplets tools as progressive wrappers", () => {
    expect(
      summarizePiEvalMetrics([
        { type: "tool_execution_start", toolName: "caplets__issues__active_incidents" },
        { type: "tool_execution_start", toolName: "caplets__api__get_endpoint" },
        { type: "tool_execution_start", toolName: "bash" },
      ]).hybridChoice,
    ).toBe("direct-only");

    expect(
      summarizePiEvalMetrics([
        { type: "tool_execution_start", toolName: "caplets_issues" },
        { type: "tool_execution_start", toolName: "caplets_api" },
      ]).hybridChoice,
    ).toBe("progressive-only");
  });

  it("classifies pi-mcp-adapter direct tools and flags measured proxy fallback", () => {
    const directMetrics = summarizePiEvalMetrics(
      [{ type: "tool_execution_start", toolName: "executor_search" }],
      [],
      { mode: "executor-mcp", adapterExposure: "direct-tools" },
    );
    expect(directMetrics.hybridChoice).toBe("executor-only");
    expect(directMetrics.directToolsPrewarmFailure).toBe(false);

    const vanillaMetrics = summarizePiEvalMetrics(
      [
        { type: "tool_execution_start", toolName: "issues_active_incidents" },
        { type: "tool_execution_start", toolName: "api_get_endpoint" },
      ],
      [],
      { mode: "vanilla-mcp", adapterExposure: "direct-tools" },
    );
    expect(vanillaMetrics.hybridChoice).toBe("vanilla-mcp-only");
    expect(vanillaMetrics.directToolsPrewarmFailure).toBe(false);

    const proxyMetrics = summarizePiEvalMetrics(
      [{ type: "tool_execution_start", toolName: "mcp" }],
      [],
      { mode: "executor-mcp", adapterExposure: "direct-tools" },
    );
    expect(proxyMetrics.hybridChoice).toBe("executor-proxy-fallback");
    expect(proxyMetrics.directToolsPrewarmFailure).toBe(true);

    const vanillaProxyMetrics = summarizePiEvalMetrics(
      [{ type: "tool_execution_start", toolName: "mcp" }],
      [],
      { mode: "vanilla-mcp", adapterExposure: "direct-tools" },
    );
    expect(vanillaProxyMetrics.hybridChoice).toBe("vanilla-mcp-proxy-fallback");
    expect(vanillaProxyMetrics.directToolsPrewarmFailure).toBe(true);
  });

  it("scores required checkout evidence from observed domain coverage", () => {
    const coverage = computeDomainCoverage([
      { text: "BENCH-451 from issues" },
      { text: "CI-9182 failingTests" },
      { text: "checkout retry runbook idempotency guidance" },
      { text: "/checkout/authorize API" },
    ]);

    expect(coverage).toMatchObject({ issues: true, ci: true, docs: true, api: true });
    expect(
      requiredEvidenceScore(
        { domainCoverage: coverage },
        { id: "checkout-incident-retry-hardening" },
      ),
    ).toMatchObject({ required: true, success: true, missingDomains: [] });
  });

  it("counts domain coverage from tool results, not prompt or tool input text", () => {
    const inputOnlyCoverage = computeDomainCoverage([
      {
        type: "tool_result",
        toolName: "executor_execute",
        input: {
          code: "search for BENCH-451 CI-9182 runbook /checkout/authorize code-map",
        },
        resultPreview: "[]",
      },
    ]);
    expect(inputOnlyCoverage).toMatchObject({
      issues: false,
      ci: false,
      docs: false,
      api: false,
      codeMap: false,
      requiredComplete: false,
    });

    const resultCoverage = computeDomainCoverage([
      {
        type: "tool_result",
        toolName: "executor_execute",
        resultPreview:
          "BENCH-451 CI-9182 checkout retry runbook idempotency guidance /checkout/authorize targetFiles",
      },
    ]);
    expect(resultCoverage).toMatchObject({
      issues: true,
      ci: true,
      docs: true,
      api: true,
      codeMap: true,
      requiredComplete: true,
    });
  });

  it("refuses live Pi eval runs unless explicitly enabled", async () => {
    await expect(
      runPiEvalBenchmark({
        options: { outputDir: join(tmpdir(), "caplets-pi-eval-refuse") },
        env: {},
        piDetector: async () => ({ available: true, command: "pi" }),
      }),
    ).rejects.toThrow(/CAPLETS_BENCH_LIVE=1/u);
  });

  it("requires Executor only when executor-mcp is selected", async () => {
    await expect(
      runPiEvalBenchmark({
        options: {
          outputDir: join(tmpdir(), "caplets-pi-eval-missing-executor"),
          modes: ["executor-mcp"],
        },
        env: { CAPLETS_BENCH_LIVE: "1" },
        piDetector: async () => ({ available: true, command: "pi-test" }),
        executorDetector: async () => ({
          available: false,
          command: "executor-test",
          reason: "Executor CLI is missing.",
        }),
      }),
    ).rejects.toThrow(/Executor CLI is missing/u);
  });

  it("does not require Executor for vanilla-mcp mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-vanilla-no-executor-test-"));
    const fixtureWorkspace = join(root, "workspace-fixture");
    const outputDir = join(root, "reports");
    const tasksPath = join(root, "tasks.json");
    let executorDetectorCalled = false;

    try {
      await mkdir(fixtureWorkspace, { recursive: true });
      await writeFile(join(fixtureWorkspace, "package.json"), '{"type":"module"}\n');
      await writeFile(tasksPath, JSON.stringify([{ id: "task-a", prompt: "Do task A." }], null, 2));

      const result = await runPiEvalBenchmark({
        options: {
          outputDir,
          modes: ["vanilla-mcp"],
          tasks: ["task-a"],
          runs: 1,
          timeoutMs: 10_000,
        },
        env: { CAPLETS_BENCH_LIVE: "1" },
        fixtureWorkspaceRoot: fixtureWorkspace,
        tasksPath,
        piDetector: async () => ({ available: true, command: "pi-test", version: "pi-test 1" }),
        executorDetector: async () => {
          executorDetectorCalled = true;
          return { available: false, reason: "Executor is intentionally unavailable." };
        },
        runConfigFactory: async ({ mode }: any) => {
          const runRoot = await mkdtemp(join(root, "run-"));
          return {
            runRoot,
            mode,
            product: "mcp",
            adapterExposure: "direct-tools",
            configPath: null,
            adapterConfigPath: join(runRoot, "vanilla-mcp.json"),
            xdgConfigHome: null,
            xdgCapletsConfigPath: null,
            supportDir: runRoot,
            fixtureServerPath: null,
            metricsPath: join(runRoot, "metrics.jsonl"),
            prewarmMetricsPath: join(runRoot, "prewarm-metrics.jsonl"),
            sessionsDir: join(runRoot, "sessions"),
            prewarmSessionsDir: join(runRoot, "prewarm-sessions"),
            agentDir: join(runRoot, "agent"),
            copiedPiAuthFiles: [],
            extensionPaths: [PI_MCP_ADAPTER_EXTENSION_SOURCE],
            extraArgs: ["--mcp-config", join(runRoot, "vanilla-mcp.json")],
            env: { PI_CODING_AGENT_DIR: join(runRoot, "agent") },
          };
        },
        processRunner: async (call: any) =>
          emptyProcessResult({ command: call.command, args: call.args }),
      });

      expect(executorDetectorCalled).toBe(false);
      expect(result.report.results[0]).toMatchObject({ mode: "vanilla-mcp", product: "mcp" });
      expect(result.report.results[0].prewarm).toMatchObject({ unmeasured: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs Pi eval mode/task/run jobs with bounded concurrency and stable result ordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-concurrency-test-"));
    const fixtureWorkspace = join(root, "workspace-fixture");
    const outputDir = join(root, "reports");
    const tasksPath = join(root, "tasks.json");
    const runRoots: string[] = [];
    let activeAgentRuns = 0;
    let maxActiveAgentRuns = 0;
    const progress: string[] = [];

    try {
      await mkdir(fixtureWorkspace, { recursive: true });
      await writeFile(join(fixtureWorkspace, "package.json"), '{"type":"module"}\n');
      await writeFile(
        tasksPath,
        JSON.stringify(
          [
            { id: "task-a", prompt: "Do task A." },
            { id: "task-b", prompt: "Do task B." },
          ],
          null,
          2,
        ),
      );

      const result = await runPiEvalBenchmark({
        options: {
          outputDir,
          modes: ["caplets-code-mode"],
          tasks: ["task-a", "task-b"],
          runs: 2,
          concurrency: 2,
          timeoutMs: 10_000,
        },
        env: { CAPLETS_BENCH_LIVE: "1" },
        fixtureWorkspaceRoot: fixtureWorkspace,
        tasksPath,
        piDetector: async () => ({ available: true, command: "pi-test", version: "pi-test 1" }),
        runConfigFactory: async ({ mode }: any) => {
          const runRoot = await mkdtemp(join(root, "run-"));
          runRoots.push(runRoot);
          return {
            runRoot,
            mode,
            product: "caplets",
            adapterExposure: null,
            configPath: null,
            adapterConfigPath: null,
            xdgConfigHome: null,
            xdgCapletsConfigPath: null,
            supportDir: runRoot,
            fixtureServerPath: null,
            metricsPath: join(runRoot, "metrics.jsonl"),
            prewarmMetricsPath: null,
            sessionsDir: join(runRoot, "sessions"),
            prewarmSessionsDir: null,
            agentDir: join(runRoot, "agent"),
            copiedPiAuthFiles: [],
            extensionPaths: [],
            extraArgs: [],
            env: { PI_CODING_AGENT_DIR: join(runRoot, "agent") },
          };
        },
        processRunner: async (call: any) => {
          activeAgentRuns += 1;
          maxActiveAgentRuns = Math.max(maxActiveAgentRuns, activeAgentRuns);
          await sleep(30);
          activeAgentRuns -= 1;
          return emptyProcessResult({ command: call.command, args: call.args });
        },
        onProgress: (message: string) => progress.push(message),
      });

      expect(maxActiveAgentRuns).toBe(2);
      expect(result.report.options.concurrency).toBe(2);
      expect(result.report.results.map((row: any) => `${row.taskId}:${row.run}`)).toEqual([
        "task-a:1",
        "task-a:2",
        "task-b:1",
        "task-b:2",
      ]);
      expect(progress[0]).toContain("concurrency 2");
      expect(await readFile(result.markdownPath, "utf8")).toContain("Concurrency: 2");
      for (const runRoot of runRoots)
        await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("summarizes Pi eval reports with token, round-trip, and tool-call comparisons", () => {
    const result = {
      mode: "caplets-code-mode",
      product: "caplets",
      adapterExposure: null,
      taskId: "checkout-incident-retry-hardening",
      run: 1,
      score: { success: true },
      agentResult: { durationMs: 1000 },
      metrics: {
        providerRequestCount: 1,
        requestPayloadEstimatedTokens: 100,
        nonSurfaceEstimatedTokens: 40,
        toolSurfaceEstimatedTokens: 60,
        requestTokenBuckets: {
          totals: {
            requestPayloadEstimatedTokens: 100,
            toolSurfaceEstimatedTokens: 60,
            nonSurfaceEstimatedTokens: 40,
            instructionEstimatedTokens: 4,
            instructionMessageEstimatedTokens: 3,
            userMessageEstimatedTokens: 10,
            assistantMessageEstimatedTokens: 8,
            toolCallMessageEstimatedTokens: 2,
            toolResultMessageEstimatedTokens: 12,
            otherMessageEstimatedTokens: 1,
            requestOverheadEstimatedTokens: 0,
          },
        },
        toolCallCount: 1,
        toolEventCount: 2,
        hybridChoice: "code-mode-only",
        domainCoverage: { issues: true, ci: true, docs: true, api: true, codeMap: false },
        providerUsage: { totalTokens: 120 },
      },
    };
    const executorResult = {
      ...result,
      mode: "executor-mcp",
      product: "executor",
      adapterExposure: "direct-tools",
      metrics: {
        ...result.metrics,
        toolCallCount: 2,
        toolEventCount: 4,
        hybridChoice: "executor-only",
        providerUsage: { totalTokens: 180 },
      },
    };
    const summary = summarizePiEvalResults([result, executorResult]);
    const markdown = renderPiEvalMarkdownReport({
      completedAt: "2026-06-09T00:00:00.000Z",
      options: { model: "test-model", runs: 1, timeoutMs: 1000, concurrency: 2 },
      summary,
      results: [result, executorResult],
    });

    expect(summary.byMode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: "caplets-code-mode",
          product: "caplets",
          adapterExposure: null,
          passed: 1,
          total: 1,
          averageProviderRequestCount: 1,
          averageToolCalls: 1,
          averageRequestTokenBuckets: expect.objectContaining({
            requestPayloadEstimatedTokens: 100,
            toolSurfaceEstimatedTokens: 60,
            toolResultMessageEstimatedTokens: 12,
          }),
          hybridChoice: { "code-mode-only": 1 },
        }),
        expect.objectContaining({
          mode: "executor-mcp",
          product: "executor",
          adapterExposure: "direct-tools",
          averageToolCalls: 2,
          hybridChoice: { "executor-only": 1 },
        }),
      ]),
    );
    expect(summary.comparisons.map((comparison: any) => comparison.label)).toContain(
      "executor-mcp vs caplets-code-mode",
    );
    expect(markdown).toContain("# Pi Live Tool Gateway Eval");
    expect(markdown).toContain("Concurrency: 2");
    expect(markdown).toContain("| Mode | Product | Adapter exposure |");
    expect(markdown).toContain("## Token Bucket Breakdown");
    expect(markdown).toContain("| Mode | Total | Tool surface | Non-surface |");
    expect(markdown).toContain("Avg LLM round trips");
    expect(markdown).toContain("Avg non-surface estimated tokens");
    expect(markdown).toContain("caplets-code-mode");
    expect(markdown).toContain("executor-mcp");
  });
});
