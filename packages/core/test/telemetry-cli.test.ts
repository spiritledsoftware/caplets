import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { completeCliWords } from "../src/cli/completion";
import { readTelemetryIdentity, readTelemetryNotice, TelemetryDebugSink } from "../src/telemetry";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-telemetry-cli-"));
  dirs.push(dir);
  return dir;
}

describe("telemetry CLI", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports status with disable instructions and env precedence", async () => {
    const dir = tempDir();
    const out: string[] = [];

    await runCli(["telemetry", "status"], {
      env: { CAPLETS_DISABLE_TELEMETRY: "1" },
      telemetryStateDir: join(dir, "state"),
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toContain("Telemetry: disabled");
    expect(out.join("")).toContain("Decision: env");
    expect(out.join("")).toContain("CAPLETS_DISABLE_TELEMETRY=1");
  });

  it("enable and disable mutate only the user config", async () => {
    const dir = tempDir();
    const userConfig = join(dir, "user", "config.json");
    const projectConfig = join(dir, "project", ".caplets", "config.json");
    mkdirSync(join(dir, "user"), { recursive: true });
    mkdirSync(join(dir, "project", ".caplets"), { recursive: true });
    const env = { CAPLETS_CONFIG: userConfig, CAPLETS_PROJECT_CONFIG: projectConfig };

    await runCli(["telemetry", "disable"], { env, writeOut: () => {} });
    expect(JSON.parse(readFileSync(userConfig, "utf8")).telemetry).toBe(false);
    expect(existsSync(projectConfig)).toBe(false);

    await runCli(["telemetry", "enable"], { env, writeOut: () => {} });
    expect(JSON.parse(readFileSync(userConfig, "utf8")).telemetry).toBe(true);
  });

  it("delete-id and rotate-id manage only local identity state", async () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    const first = readTelemetryIdentity({ stateDir, create: true });
    const out: string[] = [];

    await runCli(["telemetry", "rotate-id"], {
      telemetryStateDir: stateDir,
      writeOut: (value) => out.push(value),
    });
    const rotated = readTelemetryIdentity({ stateDir, create: false });
    expect(rotated.id).not.toBe(first.id);
    expect(out.join("")).toContain("does not delete provider-side historical anonymous events");

    await runCli(["telemetry", "delete-id"], {
      telemetryStateDir: stateDir,
      writeOut: (value) => out.push(value),
    });
    expect(readTelemetryIdentity({ stateDir, create: false }).kind).toBe("ephemeral");
  });

  it("prints first-run notice to stderr only for eligible TTY commands", async () => {
    const dir = tempDir();
    const out: string[] = [];
    const err: string[] = [];

    await runCli(["serve"], {
      env: {},
      telemetryStateDir: join(dir, "state"),
      stderrIsTTY: true,
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
      serve: async () => {},
    });

    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("Caplets collects anonymous telemetry");
    expect(err.join("")).toContain("CAPLETS_DISABLE_TELEMETRY=1");
    expect(readTelemetryNotice({ stateDir: join(dir, "state") }).shown).toBe(true);

    await runCli(["serve"], {
      env: {},
      telemetryStateDir: join(dir, "state"),
      stderrIsTTY: true,
      writeErr: (value) => err.push(value),
      serve: async () => {},
    });
    expect(err.join("").match(/Caplets collects anonymous telemetry/gu)).toHaveLength(1);
  });

  it("does not mark notice shown when stderr is redirected", async () => {
    const dir = tempDir();
    const err: string[] = [];

    await runCli(["serve"], {
      env: {},
      telemetryStateDir: join(dir, "state"),
      stderrIsTTY: false,
      writeErr: (value) => err.push(value),
      serve: async () => {},
    });

    expect(err.join("")).toBe("");
    expect(readTelemetryNotice({ stateDir: join(dir, "state") }).shown).toBe(false);
  });

  it("does not let enable override CAPLETS_DISABLE_TELEMETRY for current status", async () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const env = { CAPLETS_CONFIG: configPath, CAPLETS_DISABLE_TELEMETRY: "1" };

    await runCli(["telemetry", "enable"], { env, writeOut: () => {} });
    await runCli(["telemetry", "status"], { env, writeOut: (value) => out.push(value) });

    expect(out.join("")).toContain("Telemetry: disabled");
    expect(out.join("")).toContain("Decision: env");
  });

  it("debug prints local sanitized telemetry events", async () => {
    const dir = tempDir();
    const out: string[] = [];

    await runCli(["telemetry", "debug", "--", "setup"], {
      telemetryStateDir: join(dir, "state"),
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toContain('"name": "caplets_cli_command"');
    expect(out.join("")).toContain('"command_family": "setup"');
    expect(out.join("")).not.toContain(dir);
  });

  it("prints the first-run notice for tracked commands without command-local notice calls", async () => {
    const dir = tempDir();
    const err: string[] = [];
    const configPath = join(dir, "config.json");

    await runCli(["init", "--global"], {
      env: { CAPLETS_CONFIG: configPath },
      telemetryStateDir: join(dir, "state"),
      stderrIsTTY: true,
      writeOut: () => {},
      writeErr: (value) => err.push(value),
    });

    expect(err.join("")).toContain("Caplets collects anonymous telemetry");
    expect(readTelemetryNotice({ stateDir: join(dir, "state") }).shown).toBe(true);
  });

  it("captures sanitized reliability but no product event for parse errors in debug mode", async () => {
    const dir = tempDir();
    const sink = new TelemetryDebugSink();

    await expect(
      runCli(["init", "--typo"], {
        env: { CAPLETS_TELEMETRY_DEBUG: "1" },
        telemetryStateDir: join(dir, "state"),
        telemetryDebugSink: sink,
        writeErr: () => {},
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.event).toMatchObject({
      provider: "sentry",
      tags: expect.objectContaining({
        command_family: "init",
        error_code: "REQUEST_INVALID",
        diagnostic_category: "validation",
      }),
    });
  });

  it("completion includes telemetry subcommands", async () => {
    await expect(completeCliWords(["telemetry", ""])).resolves.toEqual([
      "status",
      "enable",
      "disable",
      "delete-id",
      "rotate-id",
      "debug",
    ]);
  });
});
