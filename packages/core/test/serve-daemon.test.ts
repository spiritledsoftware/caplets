import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import type { CapletsError } from "../src/errors";
import {
  createNativeDaemonManager,
  daemonServeArgs,
  daemonLogs,
  daemonClientBaseUrl,
  daemonStatus,
  installDaemon,
  resolveDaemonHttpServeOptions,
  resolveDaemonPaths,
  restartDaemon,
  startDaemon,
  stopDaemon,
  uninstallDaemon,
  type DaemonConfig,
  type DaemonCommandRunner,
  type DaemonManager,
} from "../src/daemon";
import { daemonHostPath } from "../src/daemon/host-path";
import { serviceCommand } from "../src/daemon/shell";
import {
  allocateLoopbackPort,
  validateDaemonCommand,
  validationSpawnCommand,
} from "../src/daemon/validation";

function cwdBackslashEntriesContaining(marker: string): string[] {
  return readdirSync(process.cwd()).filter(
    (entry) => entry.includes("\\") && entry.includes(marker),
  );
}

function removeCwdEntries(entries: string[]): void {
  for (const entry of entries) rmSync(join(process.cwd(), entry), { recursive: true, force: true });
}

function daemonPathExists(path: string): boolean {
  return existsSync(daemonHostPath(path));
}

describe("caplets daemon CLI", () => {
  it("shows daemon help and removes daemon lifecycle from serve help", async () => {
    const daemonOut: string[] = [];
    const serveOut: string[] = [];

    await runCli(["daemon", "--help"], { writeOut: (value) => daemonOut.push(value) });
    await runCli(["serve", "--help"], { writeOut: (value) => serveOut.push(value) });

    const daemonHelp = daemonOut.join("");
    expect(daemonHelp).toContain("install");
    expect(daemonHelp).toContain("uninstall");
    expect(daemonHelp).toContain("start");
    expect(daemonHelp).toContain("restart");
    expect(daemonHelp).toContain("stop");
    expect(daemonHelp).toContain("status");
    expect(daemonHelp).toContain("logs");

    const serveHelp = serveOut.join("");
    expect(serveHelp).not.toContain("enable");
    expect(serveHelp).not.toContain("disable");
    expect(serveHelp).not.toContain("Start the default Caplets HTTP daemon");
  });

  it("rejects daemon install transport before writing artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-"));
    try {
      await expect(
        runCli(["daemon", "install", "--transport", "http"], {
          env: testEnv(dir),
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

      expect(existsSync(join(dir, "config", "caplets", "daemon", "default.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives daemon client base URLs from loopback and wildcard HTTP config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-client-url-"));
    try {
      const loopback = await installDaemon(
        { host: "127.0.0.1", port: 5387, validate: false },
        { env: testEnv(dir), platform: "linux", commandRunner: fakeRunner() },
      );
      expect(daemonClientBaseUrl(loopback.config)).toEqual(new URL("http://127.0.0.1:5387"));
      expect(loopback.config.serve).not.toHaveProperty("path");
      expect(loopback.config.command.args).not.toContain("--path");

      const wildcard = {
        ...loopback.config,
        serve: { ...loopback.config.serve, host: "0.0.0.0" },
      };
      expect(daemonClientBaseUrl(wildcard)).toEqual(new URL("http://127.0.0.1:5387"));

      const network = {
        ...loopback.config,
        serve: { ...loopback.config.serve, host: "192.0.2.10" },
      };
      expect(() => daemonClientBaseUrl(network)).toThrow(/loopback/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes upstream URL through daemon install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-upstream-"));
    const upstreamUrl = "https://upstream.caplets.example.com";
    try {
      const out: string[] = [];
      await runCli(
        ["daemon", "install", "--json", "--no-validate", "--upstream-url", upstreamUrl],
        {
          env: testEnv(dir),
          writeOut: (value) => out.push(value),
          daemon: { platform: "linux", commandRunner: fakeRunner() },
        },
      );

      const result = JSON.parse(out.join("")) as {
        config: { serve: { upstreamUrl: string }; command: { args: string[] } };
      };
      const upstreamArgIndex = result.config.command.args.indexOf("--upstream-url");
      expect(result.config.serve.upstreamUrl).toBe(upstreamUrl);
      expect(upstreamArgIndex).toBeGreaterThanOrEqual(0);
      expect(result.config.command.args[upstreamArgIndex + 1]).toBe(upstreamUrl);

      const updateOut: string[] = [];
      await runCli(["daemon", "install", "--dry-run", "--json"], {
        env: testEnv(dir),
        writeOut: (value) => updateOut.push(value),
        daemon: { platform: "linux", commandRunner: fakeRunner() },
      });

      const updateResult = JSON.parse(updateOut.join("")) as {
        config: { serve: { upstreamUrl: string }; command: { args: string[] } };
      };
      const updateUpstreamArgIndex = updateResult.config.command.args.indexOf("--upstream-url");
      expect(updateResult.config.serve.upstreamUrl).toBe(upstreamUrl);
      expect(updateUpstreamArgIndex).toBeGreaterThanOrEqual(0);
      expect(updateResult.config.command.args[updateUpstreamArgIndex + 1]).toBe(upstreamUrl);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes and preserves admin upload settings through daemon install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-admin-uploads-"));
    try {
      const out: string[] = [];
      await runCli(
        [
          "daemon",
          "install",
          "--json",
          "--no-validate",
          "--admin-upload-staging-dir",
          "/srv/caplets/uploads",
          "--admin-upload-max-concurrent",
          "4",
          "--admin-upload-max-staged-bytes",
          "400000000",
        ],
        {
          env: testEnv(dir),
          writeOut: (value) => out.push(value),
          daemon: { platform: "linux", commandRunner: fakeRunner() },
        },
      );

      const result = JSON.parse(out.join("")) as {
        config: {
          serve: {
            adminUploads: {
              stagingDir: string;
              maxConcurrent: number;
              maxStagedBytes: number;
            };
          };
          command: { args: string[] };
        };
      };
      expect(result.config.serve.adminUploads).toEqual({
        stagingDir: "/srv/caplets/uploads",
        maxConcurrent: 4,
        maxStagedBytes: 400_000_000,
      });
      expect(result.config.command.args).toEqual(
        expect.arrayContaining([
          "--admin-upload-staging-dir",
          "/srv/caplets/uploads",
          "--admin-upload-max-concurrent",
          "4",
          "--admin-upload-max-staged-bytes",
          "400000000",
        ]),
      );

      const updateOut: string[] = [];
      await runCli(["daemon", "install", "--dry-run", "--json"], {
        env: testEnv(dir),
        writeOut: (value) => updateOut.push(value),
        daemon: { platform: "linux", commandRunner: fakeRunner() },
      });
      const updated = JSON.parse(updateOut.join("")) as typeof result;
      expect(updated.config.serve.adminUploads).toEqual(result.config.serve.adminUploads);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves removed serve daemon subcommands to daemon guidance", async () => {
    await expect(runCli(["serve", "start"], { writeErr: () => {} })).rejects.toThrow(
      /Use caplets daemon start/u,
    );
    await expect(runCli(["serve", "enable"], { writeErr: () => {} })).rejects.toThrow(
      /Use caplets daemon install/u,
    );
  });

  it("does not expose enable or disable aliases", async () => {
    await expect(runCli(["daemon", "enable"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
    await expect(runCli(["daemon", "disable"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("maps --no-restart through daemon install option validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-no-restart-"));
    try {
      await expect(
        runCli(["daemon", "install", "--start", "--no-restart", "--dry-run"], {
          env: testEnv(dir),
          writeErr: () => {},
        }),
      ).rejects.toThrow(/--start, --restart, and --no-restart are mutually exclusive/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps daemon install --json noninteractive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-json-"));
    try {
      const out: string[] = [];
      const runner = fakeRunner({ active: true });
      await installDaemon(
        { validate: false },
        {
          env: testEnv(dir),
          platform: "linux",
          commandRunner: runner,
        },
      );

      await expect(
        runCli(["daemon", "install", "--json"], {
          env: testEnv(dir),
          writeOut: (value) => out.push(value),
          writeErr: () => {},
          readStdin: async () => "y\n",
          daemon: { platform: "linux", commandRunner: runner },
        }),
      ).rejects.toThrow(/rerun with --restart, --start, or --no-restart/u);

      expect(out.join("")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints JSON status with remote credential auth config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-"));
    const out: string[] = [];
    try {
      const runner = fakeRunner();
      await installDaemon(
        { remoteStatePath: join(dir, "remote-state"), validate: false },
        {
          env: testEnv(dir),
          platform: "linux",
          commandRunner: runner,
        },
      );

      await runCli(["daemon", "status", "--json"], {
        env: testEnv(dir),
        writeOut: (value) => out.push(value),
        daemon: { platform: "linux", commandRunner: runner },
      });

      const status = JSON.parse(out.join("")) as {
        config: { serve: { auth: { type: string }; remoteCredentialStateDir: string } };
      };
      expect(status.config.serve.auth.type).toBe("remote_credentials");
      expect(status.config.serve.remoteCredentialStateDir).toBe("[REDACTED]");
      expect(out.join("")).not.toContain(join(dir, "remote-state"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts legacy daemon Basic Auth passwords from JSON status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-legacy-auth-redaction-"));
    try {
      const runner = fakeRunner();
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      await installDaemon({ validate: false }, options);
      const paths = resolveDaemonPaths(options);
      const config = JSON.parse(readFileSync(paths.configFile, "utf8")) as {
        serve: { auth: unknown };
      };
      config.serve.auth = {
        enabled: true,
        user: "caplets",
        password: "legacy-password-secret",
      };
      writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
      const out: string[] = [];

      await runCli(["daemon", "status", "--json"], {
        env: testEnv(dir),
        writeOut: (value) => out.push(value),
        daemon: options,
      });

      const serialized = out.join("");
      const status = JSON.parse(serialized) as {
        config: { serve: { auth: { password?: string } } };
      };
      expect(status.config.serve.auth.password).toBe("[redacted]");
      expect(serialized).not.toContain("legacy-password-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports daemon start as a restart when the service is already running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-start-restart-"));
    try {
      const out: string[] = [];
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => new Response("ok"),
      };
      await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      await runCli(["daemon", "start"], {
        env: testEnv(dir),
        writeOut: (value) => out.push(value),
        daemon: options,
      });

      expect(out.join("")).toBe("Restarted Caplets daemon.\n");
      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "restart",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts daemon install --json config and descriptors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-json-redaction-"));
    try {
      const out: string[] = [];

      await runCli(
        [
          "daemon",
          "install",
          "--json",
          "--dry-run",
          "--remote-state-path",
          join(dir, 'remote "state'),
          "--env",
          'TOKEN=a&b"c',
          "--env",
          "QUOTE=a'b",
          "--inherit-env",
        ],
        {
          env: { ...testEnv(dir), SHELL: "/bin/bash" },
          writeOut: (value) => out.push(value),
          writeErr: () => {},
          daemon: { platform: "linux", commandRunner: fakeRunner() },
        },
      );

      const serialized = out.join("");
      const parsed = JSON.parse(serialized) as {
        descriptor?: { contents?: string };
      };
      expect(serialized).toContain("[redacted]");
      expect(serialized).not.toContain(join(dir, 'remote "state'));
      expect(serialized).not.toContain('a&b"c');
      expect(parsed.descriptor?.contents).not.toContain('remote \\"state');
      expect(parsed.descriptor?.contents).not.toContain('a&b\\"c');
      expect(parsed.descriptor?.contents).not.toContain("a'\\\\''b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon paths and config", () => {
  it("uses daemon/default paths on macOS and Linux", () => {
    const paths = resolveDaemonPaths({
      env: { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" },
      home: "/home/alice",
      platform: "linux",
    });

    expect(paths.stateFile).toBe(
      posix.join("/state", "caplets", "daemon", "default", "state.json"),
    );
    expect(paths.stdoutLog).toBe(
      posix.join("/state", "caplets", "daemon", "default", "logs", "stdout.log"),
    );
    expect(paths.configFile).toBe(posix.join("/config", "caplets", "daemon", "default.json"));
    expect(paths.descriptorFile).toBe(
      posix.join("/config", "systemd", "user", "caplets-daemon-default.service"),
    );
  });

  it("uses daemon/default paths on Windows", () => {
    const paths = resolveDaemonPaths({
      env: {
        APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
      },
      home: "C:\\Users\\Alice",
      platform: "win32",
    });

    expect(paths.stateFile).toBe(
      win32.join(
        "C:\\Users\\Alice\\AppData\\Local",
        "Caplets",
        "State",
        "daemon",
        "default",
        "state.json",
      ),
    );
    expect(paths.configFile).toBe(
      win32.join("C:\\Users\\Alice\\AppData\\Roaming", "Caplets", "daemon", "default.json"),
    );
  });

  it("does not leak Windows-emulated daemon files into the current working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-cwd-"));
    const marker = dir.split(/[\\/]/u).at(-1)!;
    let leakedEntries: string[] = [];
    try {
      try {
        await installDaemon(
          { validate: false },
          {
            env: {
              APPDATA: join(dir, "AppData", "Roaming"),
              LOCALAPPDATA: join(dir, "AppData", "Local"),
            },
            home: "C:\\Users\\Alice",
            platform: "win32",
            commandRunner: fakeRunner(),
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
        leakedEntries = cwdBackslashEntriesContaining(marker);
      }

      expect(leakedEntries).toEqual([]);
    } finally {
      removeCwdEntries(leakedEntries);
    }
  });

  it("installs with HTTP serve config, env overrides, and home working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-install-"));
    try {
      const runner = fakeRunner();
      const result = await installDaemon(
        {
          host: "127.0.0.1",
          port: "5480",
          env: ["NAME=value=with=equals", "EMPTY="],
          inheritEnv: true,
          validate: false,
        },
        {
          env: testEnv(dir),
          home: "/home/alice",
          platform: "linux",
          commandRunner: runner,
        },
      );

      expect(result.config.serve.transport).toBe("http");
      expect(result.config.serve.port).toBe(5480);
      expect(result.config.command.workingDirectory).toBe("/home/alice");
      expect(result.config.env.values).toMatchObject({ NAME: "value=with=equals", EMPTY: "" });
      expect(result.config.env.inherit).toBe(true);
      expect(result.descriptor.kind).toBe("systemd-user");
      expect(readFileSync(result.config.paths.configFile, "utf8")).toContain(
        '"instance": "default"',
      );
      expect(runner.commands.slice(0, 2)).toEqual([
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "caplets-daemon-default.service"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forces managed service update notices off even when installer opts in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-update-check-env-"));
    try {
      const result = await installDaemon(
        {
          env: ["CAPLETS_UPDATE_NOTICE_STDERR=1"],
          inheritEnv: true,
          validate: false,
          dryRun: true,
        },
        {
          env: {
            ...testEnv(dir),
            CAPLETS_UPDATE_NOTICE_STDERR: "1",
          },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.env.CAPLETS_DISABLE_UPDATE_CHECK).toBe("1");
      expect(result.descriptor.kind).toBe("systemd-user");
      if (result.descriptor.kind !== "systemd-user") throw new Error("expected systemd descriptor");
      expect(result.descriptor.contents).toContain("CAPLETS_DISABLE_UPDATE_CHECK=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces failed health checks in plain daemon status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-status-health-"));
    try {
      const out: string[] = [];
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => new Response("nope", { status: 503 }),
      };
      await installDaemon({ validate: false }, options);

      await runCli(["daemon", "status"], {
        env: testEnv(dir),
        writeOut: (value) => out.push(value),
        daemon: options,
      });

      expect(out.join("")).toMatch(
        /^Caplets daemon is running \(running\)\.\nHealth check failed for http:\/\/127\.0\.0\.1:\d+\/api\/v1\/healthz with HTTP 503\.\n$/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves selected config paths in the daemon service environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-config-env-"));
    try {
      const configPath = join(dir, "selected", "config.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");

      const explicit = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: {
            ...testEnv(dir),
            CAPLETS_CONFIG: configPath,
            CAPLETS_PROJECT_CONFIG: projectConfigPath,
          },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      expect(explicit.config.command.env).toMatchObject({
        CAPLETS_CONFIG: configPath,
        CAPLETS_PROJECT_CONFIG: projectConfigPath,
      });

      const xdg = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: testEnv(join(dir, "xdg")),
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      expect(xdg.config.command.env.CAPLETS_CONFIG).toBe(
        join(dir, "xdg", "config", "caplets", "config.json"),
      );
      expect(xdg.config.command.env.XDG_CONFIG_HOME).toBe(join(dir, "xdg", "config"));
      expect(xdg.config.command.env.XDG_STATE_HOME).toBe(join(dir, "xdg", "state"));

      const windows = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: {
            APPDATA: win32.join(dir, "AppData", "Roaming"),
            LOCALAPPDATA: win32.join(dir, "AppData", "Local"),
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );
      expect(windows.config.command.env.CAPLETS_CONFIG).toBe(
        win32.join(dir, "AppData", "Roaming", "caplets", "config.json"),
      );
      expect(windows.config.command.env.APPDATA).toBe(win32.join(dir, "AppData", "Roaming"));
      expect(windows.config.command.env.LOCALAPPDATA).toBe(win32.join(dir, "AppData", "Local"));

      const overridden = await installDaemon(
        { validate: false, dryRun: true, env: ["CAPLETS_CONFIG=/explicit/service.json"] },
        {
          env: { ...testEnv(dir), CAPLETS_CONFIG: configPath },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      expect(overridden.config.command.env.CAPLETS_CONFIG).toBe("/explicit/service.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves current global serve defaults when restarting defaulted daemons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-global-restart-"));
    try {
      const env = testEnv(dir);
      const configPath = join(env.XDG_CONFIG_HOME!, "caplets", "config.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ serve: { port: 5480 } }));
      const installOptions = {
        env,
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner({ active: true }),
      };

      const installed = await installDaemon({ validate: false }, installOptions);
      expect(installed.config.serve.port).toBe(5480);

      writeFileSync(configPath, JSON.stringify({ serve: { port: 5481 } }));
      const restarted: DaemonConfig[] = [];
      const manager = captureRestartManager(restarted);

      await restartDaemon({
        ...installOptions,
        manager,
        fetch: async () => new Response("ok"),
      });

      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.serve.port).toBe(5481);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps explicit daemon serve settings ahead of changed global defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-explicit-restart-"));
    try {
      const env = testEnv(dir);
      const configPath = join(env.XDG_CONFIG_HOME!, "caplets", "config.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ serve: { port: 5480 } }));
      const installOptions = {
        env,
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner({ active: true }),
      };

      const installed = await installDaemon({ validate: false, port: "6000" }, installOptions);
      expect(installed.config.serve.port).toBe(6000);

      writeFileSync(configPath, JSON.stringify({ serve: { port: 5481 } }));
      const restarted: DaemonConfig[] = [];
      const manager = captureRestartManager(restarted);

      await restartDaemon({
        ...installOptions,
        manager,
        fetch: async () => new Response("ok"),
      });

      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.serve.port).toBe(6000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets setup-style explicit loopback unauthenticated daemon options override unsafe globals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-safe-setup-globals-"));
    try {
      const env = testEnv(dir);
      const configPath = join(env.XDG_CONFIG_HOME!, "caplets", "config.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          serve: { host: "0.0.0.0", port: 5480, allowUnauthenticatedHttp: false },
        }),
      );

      const installed = await installDaemon(
        { validate: false, host: "127.0.0.1", allowUnauthenticatedHttp: true },
        {
          env,
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner({ active: true }),
        },
      );

      expect(installed.config.serve.host).toBe("127.0.0.1");
      expect(installed.config.serve.port).toBe(5480);
      expect(installed.config.serve.allowUnauthenticatedHttp).toBe(true);
      expect(installed.config.serve.auth.type).toBe("development_unauthenticated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits remote credential state and no Basic Auth flags for default daemon serve", () => {
    const serve = resolveDaemonHttpServeOptions({});

    const args = daemonServeArgs(serve);
    expect(args).toContain("--remote-state-path");
    expect(args).toContain(serve.remoteCredentialStateDir);
    expect(args).not.toContain("--user");
    expect(args).not.toContain("--password");
    expect(args).not.toContain("--path");
  });

  it("validates updates to running daemons on a temporary loopback port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-"));
    try {
      const options = {
        env: testEnv(dir),
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner({ active: true }),
      };
      await installDaemon({ port: "5480", validate: false }, options);

      const validatedPorts: number[] = [];
      await installDaemon(
        {
          port: "5480",
          noRestart: true,
        },
        {
          ...options,
          validateCommand: async (config) => {
            validatedPorts.push(config.serve.port);
            expect(config.serve.host).toBe("127.0.0.1");
            return { ok: true, url: `http://127.0.0.1:${config.serve.port}/api/v1/healthz` };
          },
        },
      );

      expect(validatedPorts).toHaveLength(1);
      expect(validatedPorts[0]).not.toBe(5480);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the requested bind host when a running daemon update changes host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-host-change-"));
    try {
      const runner = fakeRunner({ active: true });
      const initialEnv = testEnv(dir);
      const options = {
        env: initialEnv,
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: runner,
      };
      await installDaemon({ host: "127.0.0.1", port: "5480", validate: false }, options);

      const validated: Array<{ host: string; port: number }> = [];
      await installDaemon(
        {
          reset: true,
          noRestart: true,
        },
        {
          ...options,
          env: { ...initialEnv, CAPLETS_SERVER_URL: "https://caplets.example.com:5480" },
          validateCommand: async (config) => {
            validated.push({ host: config.serve.host, port: config.serve.port });
            return {
              ok: true,
              url: `http://${config.serve.host}:${config.serve.port}/api/v1/healthz`,
            };
          },
        },
      );

      expect(validated).toEqual([{ host: "caplets.example.com", port: 5480 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries temporary validation ports when an update validation fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-retry-"));
    try {
      const options = {
        env: testEnv(dir),
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner({ active: true }),
      };
      await installDaemon({ port: "5480", validate: false }, options);

      const validatedPorts: number[] = [];
      await installDaemon(
        {
          port: "5480",
          noRestart: true,
        },
        {
          ...options,
          validateCommand: async (config) => {
            validatedPorts.push(config.serve.port);
            return validatedPorts.length === 1
              ? { ok: false, url: `http://127.0.0.1:${config.serve.port}/api/v1/healthz` }
              : { ok: true, url: `http://127.0.0.1:${config.serve.port}/api/v1/healthz` };
          },
        },
      );

      expect(validatedPorts).toHaveLength(2);
      expect(validatedPorts[0]).not.toBe(5480);
      expect(validatedPorts[1]).not.toBe(5480);
      expect(validatedPorts[1]).not.toBe(validatedPorts[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates stale-config recovery installs on a temporary loopback port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-stale-config-"));
    try {
      const options = {
        env: testEnv(dir),
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner({ active: true }),
      };
      const installed = await installDaemon({ port: "5480", validate: false }, options);
      rmSync(installed.config.paths.configFile, { force: true });

      const validatedPorts: number[] = [];
      await installDaemon(
        {
          port: "5480",
          noRestart: true,
        },
        {
          ...options,
          validateCommand: async (config) => {
            validatedPorts.push(config.serve.port);
            return { ok: true, url: `http://127.0.0.1:${config.serve.port}/api/v1/healthz` };
          },
        },
      );

      expect(validatedPorts).toHaveLength(1);
      expect(validatedPorts[0]).not.toBe(5480);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders native daemon identities for launchd, systemd, and Windows tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-descriptor-"));
    try {
      const common = {
        host: "127.0.0.1",
        port: "5480",
        validate: false,
        dryRun: true,
      };
      const launchd = await installDaemon(common, {
        env: testEnv(dir),
        home: "/Users/alice",
        platform: "darwin",
        commandRunner: fakeRunner(),
      });
      expect(launchd.descriptor.kind).toBe("launchd-user-agent");
      expect(launchd.descriptor.path).toContain("dev.caplets.daemon.default.plist");
      if (launchd.descriptor.kind !== "launchd-user-agent") throw new Error("expected launchd");
      expect(launchd.descriptor.contents).toContain("dev.caplets.daemon.default");
      expect(launchd.descriptor.contents).toContain("<key>RunAtLoad</key>");
      expect(launchd.descriptor.contents).toContain("<key>KeepAlive</key>");
      expect(launchd.descriptor.contents).toContain("<key>WorkingDirectory</key>");

      const systemd = await installDaemon(
        { ...common, env: ["PATH=/custom/bin", "MULTI=line\nExecStartPre=/bin/false"] },
        {
          env: testEnv(dir),
          home: "/home/alice with space",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      expect(systemd.descriptor.kind).toBe("systemd-user");
      if (systemd.descriptor.kind !== "systemd-user") throw new Error("expected systemd");
      expect(systemd.descriptor.unitName).toBe("caplets-daemon-default.service");
      expect(systemd.descriptor.contents).toContain("WorkingDirectory=/home/alice with space");
      expect(systemd.descriptor.contents).toContain('Environment="PATH=/custom/bin"');
      expect(systemd.descriptor.contents).toContain(
        'Environment="MULTI=line\\nExecStartPre=/bin/false"',
      );
      expect(systemd.descriptor.contents).not.toContain("\nExecStartPre=/bin/false");
      const systemdWithCarriageReturn = await installDaemon(
        { ...common, env: ["MULTI=line\rExecStartPre=/bin/false"] },
        {
          env: testEnv(join(dir, "carriage-return")),
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      expect(systemdWithCarriageReturn.descriptor.kind).toBe("systemd-user");
      if (systemdWithCarriageReturn.descriptor.kind !== "systemd-user")
        throw new Error("expected systemd");
      expect(systemdWithCarriageReturn.descriptor.contents).toContain(
        'Environment="MULTI=line\\rExecStartPre=/bin/false"',
      );
      const systemdWithDollar = await installDaemon(
        {
          ...common,
          remoteStatePath: join(dir, "pa$USER"),
          env: ["TOKEN=pa$USER"],
        },
        {
          env: testEnv(join(dir, "dollar")),
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      expect(systemdWithDollar.descriptor.kind).toBe("systemd-user");
      if (systemdWithDollar.descriptor.kind !== "systemd-user") throw new Error("expected systemd");
      expect(systemdWithDollar.descriptor.contents).toContain("pa$$USER");
      expect(systemdWithDollar.descriptor.contents).toContain('Environment="TOKEN=pa$USER"');
      expect(systemdWithDollar.descriptor.contents).not.toContain('Environment="TOKEN=pa$$USER"');

      const windows = await installDaemon(common, {
        env: {
          APPDATA: join(dir, "AppData", "Roaming"),
          LOCALAPPDATA: join(dir, "AppData", "Local"),
        },
        home: "C:\\Users\\Alice",
        platform: "win32",
        commandRunner: fakeRunner(),
      });
      expect(windows.descriptor.kind).toBe("windows-scheduled-task");
      if (windows.descriptor.kind !== "windows-scheduled-task") throw new Error("expected task");
      expect(windows.descriptor.taskName).toBe("\\Caplets\\daemon-default");
      expect(windows.descriptor.xml).toContain(windows.descriptor.wrapper.path);
      expect(windows.descriptor.xml).toContain("<LogonTrigger>");
      expect(windows.descriptor.xml).toContain('<Principal id="Author">');
      expect(windows.descriptor.xml).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(windows.descriptor.xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
      expect(windows.descriptor.xml).toContain("<WorkingDirectory>");
      expect(windows.descriptor.wrapper.contents).toContain(">> ");
      expect(windows.descriptor.wrapper.contents).toContain("2>> ");

      const escapedWindows = await installDaemon(
        { ...common, remoteStatePath: join(dir, "pa%USERNAME%ss") },
        {
          env: {
            APPDATA: join(dir, "Escaped", "Roaming"),
            LOCALAPPDATA: join(dir, "Escaped", "Local"),
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );
      expect(escapedWindows.descriptor.kind).toBe("windows-scheduled-task");
      if (escapedWindows.descriptor.kind !== "windows-scheduled-task")
        throw new Error("expected task");
      expect(escapedWindows.descriptor.wrapper.contents).toContain("pa%%USERNAME%%ss");

      await expect(
        installDaemon(
          { ...common, env: ["EMPTY="] },
          {
            env: {
              APPDATA: win32.join(dir, "AppData", "Roaming"),
              LOCALAPPDATA: win32.join(dir, "AppData", "Local"),
            },
            home: "C:\\Users\\Alice",
            platform: "win32",
            commandRunner: fakeRunner(),
          },
        ),
      ).rejects.toThrow(/environment values cannot be empty/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe Windows wrapper environment values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-env-"));
    try {
      await expect(
        installDaemon(
          { env: ["TOKEN=abc\r\nwhoami"], validate: false, dryRun: true },
          {
            env: {
              APPDATA: join(dir, "AppData", "Roaming"),
              LOCALAPPDATA: join(dir, "AppData", "Local"),
            },
            home: "C:\\Users\\Alice",
            platform: "win32",
            commandRunner: fakeRunner(),
          },
        ),
      ).rejects.toThrow(/cannot contain/u);

      await expect(
        installDaemon(
          { env: ['TOKEN=a"b'], validate: false, dryRun: true },
          {
            env: {
              APPDATA: join(dir, "AppData", "Roaming"),
              LOCALAPPDATA: join(dir, "AppData", "Local"),
            },
            home: "C:\\Users\\Alice",
            platform: "win32",
            commandRunner: fakeRunner(),
          },
        ),
      ).rejects.toThrow(/cannot contain/u);

      const descriptor = await installDaemon(
        { env: ["TOKEN=%PATH%"], validate: false, dryRun: true },
        {
          env: {
            APPDATA: join(dir, "AppData", "Roaming"),
            LOCALAPPDATA: join(dir, "AppData", "Local"),
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );
      expect(descriptor.descriptor.kind).toBe("windows-scheduled-task");
      if (descriptor.descriptor.kind !== "windows-scheduled-task") throw new Error("expected task");
      expect(descriptor.descriptor.wrapper.contents).toContain("TOKEN=%%PATH%%");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe Windows wrapper command arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-args-"));
    try {
      await expect(
        installDaemon(
          {
            remoteStatePath: `secret\r\nwhoami`,
            validate: false,
            dryRun: true,
          },
          {
            env: {
              APPDATA: join(dir, "AppData", "Roaming"),
              LOCALAPPDATA: join(dir, "AppData", "Local"),
            },
            home: "C:\\Users\\Alice",
            platform: "win32",
            commandRunner: fakeRunner(),
          },
        ),
      ).rejects.toThrow(/wrapper arguments cannot contain/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quotes inherited Windows shell commands for cmd and PowerShell", () => {
    const cmd = serviceCommand({
      command: {
        executable: "C:\\Program Files\\Caplets\\cli.js",
        args: ["serve", "--remote-state-path", "pa ss"],
        env: { PATH: "C:\\Tools" },
        shell: { executable: "cmd.exe", args: ["/d", "/s", "/c"] },
      },
    });
    expect(cmd.args.at(-1)).toContain('set "PATH=C:\\Tools"&& ');
    expect(cmd.args.at(-1)).toContain('"C:\\Program Files\\Caplets\\cli.js"');
    expect(cmd.args.at(-1)).toContain('"pa ss"');
    expect(cmd.args.at(-1)).not.toContain("'C:\\Program Files");

    const powerShell = serviceCommand({
      command: {
        executable: "C:\\Program Files\\Caplets\\cli.js",
        args: ["serve", "--remote-state-path", "pa ss"],
        env: { PATH: "C:\\Tools" },
        shell: {
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          args: ["-NoProfile", "-Command"],
        },
      },
    });
    expect(powerShell.args.at(-1)).toContain("$env:PATH = 'C:\\Tools'; & ");
    expect(powerShell.args.at(-1)).toContain("& ");
    expect(powerShell.args.at(-1)).toContain("'C:\\Program Files\\Caplets\\cli.js'");

    const bash = serviceCommand({
      command: {
        executable: "/usr/local/bin/caplets",
        args: ["serve"],
        env: { PATH: "/custom/bin" },
        shell: { executable: "/bin/bash", args: ["-lc"] },
      },
    });
    expect(bash.args.at(-1)).toContain("export PATH=/custom/bin; exec ");
    expect(bash.args.at(-1)).toContain(" /usr/local/bin/caplets serve");

    const shellWithSlashC = serviceCommand({
      command: {
        executable: "/usr/local/bin/caplets",
        args: ["serve", "--remote-state-path", "pa ss"],
        env: { TOKEN: "value" },
        shell: { executable: "/usr/bin/custom-shell", args: ["/c"] },
      },
    });
    expect(shellWithSlashC.args.at(-1)).toContain("export TOKEN=value; exec ");
    expect(shellWithSlashC.args.at(-1)).toContain("'pa ss'");

    expect(() =>
      serviceCommand({
        command: {
          executable: "C:\\Program Files\\Caplets\\cli.js",
          args: ["serve"],
          env: { TOKEN: 'a"b' },
          shell: { executable: "cmd.exe", args: ["/d", "/s", "/c"] },
        },
      }),
    ).toThrow(/cannot contain/u);
  });

  it("loads PowerShell profiles when using Windows inherited env fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-powershell-"));
    try {
      const result = await installDaemon(
        { inheritEnv: true, validate: false, dryRun: true },
        {
          env: {
            APPDATA: join(dir, "AppData", "Roaming"),
            LOCALAPPDATA: join(dir, "AppData", "Local"),
            ComSpec: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.shell).toMatchObject({
        executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-Command"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves env-derived public origins in the service environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-public-origin-"));
    try {
      const result = await installDaemon(
        { validate: false, dryRun: true, allowUnauthenticatedHttp: true },
        {
          env: { ...testEnv(dir), CAPLETS_SERVER_URL: "https://caplets.example.com/" },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.serve.publicOrigin).toBe("https://caplets.example.com");
      expect(result.config.command.env.CAPLETS_SERVER_URL).toBe("https://caplets.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves public origins across daemon config updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-update-origin-"));
    try {
      const options = {
        env: { ...testEnv(dir), CAPLETS_SERVER_URL: "https://caplets.example.com/" },
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner(),
      };
      await installDaemon({ validate: false, allowUnauthenticatedHttp: true }, options);

      const updated = await installDaemon(
        { validate: false, env: ["FOO=bar"], noRestart: true },
        {
          ...options,
          env: testEnv(dir),
        },
      );

      expect(updated.config.serve.publicOrigin).toBe("https://caplets.example.com");
      expect(updated.config.command.env.CAPLETS_SERVER_URL).toBe("https://caplets.example.com");
      expect(updated.config.env.values.FOO).toBe("bar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves unauthenticated auth across daemon config updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-update-no-auth-"));
    try {
      const options = {
        env: testEnv(dir),
        home: "/home/alice",
        platform: "linux" as const,
        commandRunner: fakeRunner(),
      };
      await installDaemon({ validate: false, allowUnauthenticatedHttp: true }, options);

      const updated = await installDaemon(
        { validate: false, env: ["FOO=bar"], noRestart: true },
        {
          ...options,
          env: {
            ...testEnv(dir),
            CAPLETS_REMOTE_SERVER_STATE_DIR: join(dir, "remote-state"),
          },
        },
      );

      expect(updated.config.serve.auth.type).toBe("development_unauthenticated");
      expect(updated.config.command.args).not.toContain("--remote-state-path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses non-login inherited shell mode for /bin/sh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-sh-"));
    try {
      const result = await installDaemon(
        { inheritEnv: true, validate: false, dryRun: true },
        {
          env: { ...testEnv(dir), SHELL: "/bin/sh" },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.shell).toMatchObject({ executable: "/bin/sh", args: ["-c"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores POSIX SHELL values for Windows inheritance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-shell-"));
    try {
      const result = await installDaemon(
        { inheritEnv: true, validate: false, dryRun: true },
        {
          env: {
            APPDATA: join(dir, "AppData", "Roaming"),
            LOCALAPPDATA: join(dir, "AppData", "Local"),
            SHELL: "/usr/bin/bash",
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.shell).toMatchObject({
        executable: "cmd.exe",
        args: ["/d", "/s", "/c"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers the POSIX account shell before falling back to sh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-account-shell-"));
    try {
      const result = await installDaemon(
        { inheritEnv: true, validate: false, dryRun: true },
        {
          env: testEnv(dir),
          accountShell: "/bin/zsh",
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.shell).toMatchObject({
        executable: "/bin/zsh",
        args: ["-lc"],
        source: "account",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects temporary CLI runner paths for daemon installs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-runner-"));
    const originalArgv = process.argv[1];
    try {
      const transientCli = join(dir, "dlx-12345", "node_modules", ".bin", "caplets");
      mkdirSync(join(dir, "dlx-12345", "node_modules", ".bin"), { recursive: true });
      writeFileSync(transientCli, "#!/usr/bin/env node\n");
      process.argv[1] = transientCli;

      await expect(
        installDaemon(
          { validate: false, dryRun: true },
          {
            env: testEnv(dir),
            home: "/home/alice",
            platform: "linux",
            commandRunner: fakeRunner(),
          },
        ),
      ).rejects.toThrow(/temporary runner/u);
    } finally {
      if (originalArgv === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the stable caplets command instead of pnpm's versioned package target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-pnpm-stable-bin-"));
    const originalArgv = process.argv[1];
    try {
      const binDir = join(dir, "pnpm", "bin");
      const packageTarget = join(
        dir,
        "pnpm",
        "global",
        "v11",
        "233dbf-19efa214857",
        "node_modules",
        "caplets",
        "dist",
        "index.js",
      );
      const stableBin = join(binDir, "caplets");
      mkdirSync(dirname(packageTarget), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(packageTarget, "#!/usr/bin/env node\n");
      chmodSync(packageTarget, 0o755);
      writeFileSync(stableBin, '#!/bin/sh\nexec node /changed-by-pnpm/global/path "$@"\n');
      chmodSync(stableBin, 0o755);
      process.argv[1] = packageTarget;

      const result = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: { ...testEnv(dir), PATH: binDir },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.executable).toBe(stableBin);
      expect(result.config.command.args[0]).toBe("serve");
      expect(result.descriptor.kind).toBe("systemd-user");
      if (result.descriptor.kind !== "systemd-user") throw new Error("expected systemd");
      expect(result.descriptor.contents).toContain(`ExecStart="${stableBin}" "serve"`);
      expect(result.descriptor.contents).not.toContain(packageTarget);
    } finally {
      if (originalArgv === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks PATH before rejecting a transient runner fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-path-before-runner-"));
    const originalArgv = process.argv[1];
    try {
      const binDir = join(dir, "bin");
      const stableBin = join(binDir, "caplets");
      const transientCli = join(dir, "dlx-12345", "node_modules", ".bin", "caplets");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(dirname(transientCli), { recursive: true });
      writeFileSync(stableBin, "#!/bin/sh\n");
      writeFileSync(transientCli, "#!/usr/bin/env node\n");
      chmodSync(stableBin, 0o755);
      chmodSync(transientCli, 0o755);
      process.argv[1] = transientCli;

      const result = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: { ...testEnv(dir), PATH: binDir },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.executable).toBe(stableBin);
    } finally {
      if (originalArgv === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves PATH when the daemon command uses an installed shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-shim-path-"));
    try {
      const binDir = join(dir, "bin");
      const nodeDir = join(dir, "node");
      const stableBin = join(binDir, "caplets");
      const path = `${binDir}:${nodeDir}`;
      mkdirSync(binDir, { recursive: true });
      writeFileSync(stableBin, '#!/bin/sh\nexec node "$@"\n');
      chmodSync(stableBin, 0o755);

      const result = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: { ...testEnv(dir), PATH: path },
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.executable).toBe(stableBin);
      expect(result.config.command.env.PATH).toBe(path);
      expect(result.descriptor.kind).toBe("systemd-user");
      if (result.descriptor.kind !== "systemd-user") throw new Error("expected systemd");
      expect(result.descriptor.contents).toContain(`Environment="PATH=${path}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses PATHEXT candidates without extensionless commands on Windows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-pathext-"));
    try {
      const binDir = join(dir, "bin");
      const extensionless = join(binDir, "caplets");
      const cmdShim = join(binDir, "caplets.CMD");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(extensionless, "not executable by Windows PATH lookup\n");
      writeFileSync(cmdShim, "@echo off\r\n");

      const result = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: {
            APPDATA: win32.join(dir, "AppData", "Roaming"),
            LOCALAPPDATA: win32.join(dir, "AppData", "Local"),
            PATH: binDir,
            PATHEXT: ".CMD",
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );

      expect(result.config.command.executable).toBe(cmdShim);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back descriptor files when native registration fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-rollback-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(join(dir, "config", "systemd", "user"), { recursive: true });
      writeFileSync(paths.descriptorFile, "old descriptor\n");
      chmodSync(paths.descriptorFile, 0o600);
      const runner: DaemonCommandRunner = {
        async exec() {
          return { stdout: "", stderr: "boom", code: 1 };
        },
      };

      await expect(
        installDaemon(
          { validate: false },
          { env: testEnv(dir), home: "/home/alice", platform: "linux", commandRunner: runner },
        ),
      ).rejects.toThrow(/systemd registration failed/u);

      expect(readFileSync(paths.descriptorFile, "utf8")).toBe("old descriptor\n");
      expect(statSync(paths.descriptorFile).mode & 0o777).toBe(0o600);
      expect(existsSync(paths.configFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back descriptor files when descriptor writing fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-write-rollback-"));
    const runner = fakeRunner();
    const manager = createNativeDaemonManager({ platform: "win32", commandRunner: runner });
    const options = {
      env: testEnv(dir),
      platform: "linux" as const,
      manager,
    };
    const paths = resolveDaemonPaths(options);
    try {
      mkdirSync(dirname(paths.descriptorFile), { recursive: true });
      mkdirSync(paths.logDir, { recursive: true });
      writeFileSync(paths.descriptorFile, "old descriptor\n");
      writeFileSync(paths.stdoutLog, "");
      writeFileSync(paths.stderrLog, "");
      chmodSync(paths.stateDir, 0o500);

      await expect(installDaemon({ validate: false }, options)).rejects.toThrow();

      expect(readFileSync(paths.descriptorFile, "utf8")).toBe("old descriptor\n");
      expect(existsSync(paths.configFile)).toBe(false);
      expect(runner.commands).not.toContainEqual([
        "schtasks",
        "/Create",
        "/TN",
        "\\Caplets\\daemon-default",
        "/XML",
        paths.descriptorFile,
        "/F",
      ]);
    } finally {
      chmodSync(paths.stateDir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces private descriptor modes when rewriting existing descriptors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-descriptor-mode-"));
    try {
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: fakeRunner(),
      };
      const installed = await installDaemon({ validate: false }, options);
      chmodSync(installed.config.paths.descriptorFile, 0o644);

      await installDaemon({ validate: false, env: ["TOKEN=secret"] }, options);

      expect(statSync(installed.config.paths.descriptorFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads systemd after restoring a failed install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-rollback-reload-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(dirname(paths.descriptorFile), { recursive: true });
      writeFileSync(paths.descriptorFile, "old descriptor\n");
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (command === "systemctl" && args.includes("enable")) {
            return { stdout: "", stderr: "boom", code: 1 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };

      await expect(
        installDaemon(
          { validate: false },
          { env: testEnv(dir), home: "/home/alice", platform: "linux", commandRunner: runner },
        ),
      ).rejects.toThrow(/systemd registration failed/u);

      expect(readFileSync(paths.descriptorFile, "utf8")).toBe("old descriptor\n");
      expect(runner.commands.filter((command) => command.includes("daemon-reload"))).toHaveLength(
        2,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back native installs when daemon state persistence fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-state-rollback-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      let uninstalled = false;
      const manager: DaemonManager = {
        descriptor: (config) => ({
          kind: "systemd-user",
          unitName: "caplets-daemon-default.service",
          path: config.paths.descriptorFile,
          contents: "new descriptor\n",
        }),
        status: async () => ({ state: "not_installed", installed: false, running: false }),
        install: async (config) => {
          mkdirSync(dirname(config.paths.descriptorFile), { recursive: true });
          writeFileSync(config.paths.descriptorFile, "new descriptor\n");
          mkdirSync(config.paths.stateFile, { recursive: true });
          return {
            action: "install",
            native: { state: "installed_stopped", installed: true, running: false },
            descriptor: manager.descriptor(config),
          };
        },
        uninstall: async (_config, rollbackPaths) => {
          uninstalled = true;
          rmSync(rollbackPaths.descriptorFile, { force: true });
          return {
            action: "uninstall",
            native: { state: "not_installed", installed: false, running: false },
          };
        },
        start: async () => ({
          action: "start",
          native: { state: "running", installed: true, running: true },
        }),
        restart: async () => ({
          action: "restart",
          native: { state: "running", installed: true, running: true },
        }),
        stop: async () => ({
          action: "stop",
          native: { state: "installed_stopped", installed: true, running: false },
        }),
      };

      await expect(
        installDaemon({ validate: false }, { env: testEnv(dir), manager }),
      ).rejects.toThrow();

      expect(uninstalled).toBe(true);
      expect(existsSync(paths.descriptorFile)).toBe(false);
      expect(existsSync(paths.configFile)).toBe(false);
      expect(existsSync(paths.stateFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores old serve/default artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-ignore-"));
    try {
      const oldConfig = join(dir, "config", "caplets", "serve", "default.json");
      mkdirSync(join(dir, "config", "caplets", "serve"), { recursive: true });
      writeFileSync(oldConfig, "{}\n");
      const status = await daemonStatus({
        env: testEnv(dir),
        platform: "linux",
        commandRunner: fakeRunner(),
      });
      expect(status.installed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon lifecycle and logs", () => {
  it("status succeeds before install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-status-"));
    try {
      const status = await daemonStatus({
        env: testEnv(dir),
        platform: "linux",
        commandRunner: fakeRunner(),
      });
      expect(status.installed).toBe(false);
      expect(status.running).toBe(false);
      expect(status.nativeState).toBe("not_installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports systemd command failures as unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-systemd-unavailable-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(dirname(paths.descriptorFile), { recursive: true });
      writeFileSync(paths.descriptorFile, "unit\n");
      const runner: DaemonCommandRunner = {
        async exec(command, args) {
          if (command === "systemctl" && args.includes("show")) {
            return { stdout: "", stderr: "Failed to connect to bus", code: 1 };
          }
          return { stdout: "", stderr: "", code: 1 };
        },
      };

      const status = await daemonStatus({
        env: testEnv(dir),
        platform: "linux",
        commandRunner: runner,
      });

      expect(status.nativeState).toBe("unavailable");
      expect(status.native.message).toContain("systemd --user is not available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports launchd jobs with a current pid as running despite stale exit status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-launchd-running-after-crash-"));
    try {
      const runner: DaemonCommandRunner = {
        async exec(command, args) {
          if (command === "launchctl" && args[0] === "print") {
            return { stdout: "pid = 4242\nLastExitStatus = 1\n", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        home: dir,
        platform: "darwin" as const,
        uid: 501,
        commandRunner: runner,
      };
      await installDaemon({ validate: false }, options);

      const status = await daemonStatus(options);

      expect(status.nativeState).toBe("running");
      expect(status.running).toBe(true);
      expect(status.native.pid).toBe(4242);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats not-found systemd units as uninstalled when only config remains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-systemd-not-found-"));
    try {
      const installed = await installDaemon(
        { validate: false },
        { env: testEnv(dir), platform: "linux", commandRunner: fakeRunner() },
      );
      rmSync(installed.config.paths.descriptorFile, { force: true });
      const runner: DaemonCommandRunner = {
        async exec(command, args) {
          if (command === "systemctl" && args.includes("show")) {
            return { stdout: "LoadState=not-found\n", stderr: "", code: 0 };
          }
          if (command === "systemctl" && args.includes("is-active")) {
            return { stdout: "inactive\n", stderr: "", code: 3 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };

      const status = await daemonStatus({
        env: testEnv(dir),
        platform: "linux",
        commandRunner: runner,
      });

      expect(status.installed).toBe(false);
      expect(status.nativeState).toBe("not_installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runtime start fails before install with install guidance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-start-"));
    try {
      await expect(
        startDaemon({ env: testEnv(dir), platform: "linux", commandRunner: fakeRunner() }),
      ).rejects.toThrow(/caplets daemon install --start/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops native services when the local descriptor is missing but config remains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-stale-descriptor-stop-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      rmSync(installed.config.paths.descriptorFile, { force: true });
      runner.commands.length = 0;

      await stopDaemon(options);

      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "stop",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops native services when persisted daemon config is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-stale-config-stop-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      rmSync(installed.config.paths.configFile, { force: true });
      runner.commands.length = 0;

      await stopDaemon(options);

      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "stop",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("start restarts when the installed daemon is already running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-restart-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => new Response("ok"),
      };
      await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      const result = await startDaemon(options);

      expect(result.action).toBe("restart");
      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "restart",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("install --start restarts an already-running daemon after updating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-install-start-restart-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => new Response("ok"),
      };
      await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      await installDaemon({ start: true, validate: false, env: ["NAME=new"] }, options);

      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "restart",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails noninteractive running daemon updates before writing service changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-restart-decision-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      const previousConfig = readFileSync(installed.config.paths.configFile, "utf8");
      const previousDescriptor = readFileSync(installed.config.paths.descriptorFile, "utf8");
      runner.commands.length = 0;

      await expect(installDaemon({ validate: false, env: ["NAME=new"] }, options)).rejects.toThrow(
        /rerun with --restart, --start, or --no-restart/u,
      );

      expect(readFileSync(installed.config.paths.configFile, "utf8")).toBe(previousConfig);
      expect(readFileSync(installed.config.paths.descriptorFile, "utf8")).toBe(previousDescriptor);
      expect(runner.commands).not.toContainEqual([
        "systemctl",
        "--user",
        "enable",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails reset updates to running daemons before writing service changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-reset-restart-decision-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ port: "5480", validate: false }, options);
      const previousConfig = readFileSync(installed.config.paths.configFile, "utf8");
      const previousDescriptor = readFileSync(installed.config.paths.descriptorFile, "utf8");
      runner.commands.length = 0;

      await expect(
        installDaemon({ reset: true, validate: false, env: ["NAME=new"] }, options),
      ).rejects.toThrow(/rerun with --restart, --start, or --no-restart/u);

      expect(readFileSync(installed.config.paths.configFile, "utf8")).toBe(previousConfig);
      expect(readFileSync(installed.config.paths.descriptorFile, "utf8")).toBe(previousDescriptor);
      expect(runner.commands).not.toContainEqual([
        "systemctl",
        "--user",
        "enable",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks health after prompted restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-prompt-restart-health-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        isInteractive: true,
        readPrompt: async () => "y",
        fetch: async () => new Response("nope", { status: 503 }),
        healthTimeoutMs: 10,
        healthIntervalMs: 1,
      };
      await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      await expect(installDaemon({ validate: false, env: ["NAME=new"] }, options)).rejects.toThrow(
        /Native daemon health check failed/u,
      );
      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "restart",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails start when the native service does not pass HTTP health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-health-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => new Response("nope", { status: 503 }),
        healthTimeoutMs: 10,
        healthIntervalMs: 1,
      };
      await installDaemon({ validate: false }, options);

      await expect(startDaemon(options)).rejects.toThrow(/Native daemon health check failed/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for native health to become ready after start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-health-retry-"));
    try {
      const runner = fakeRunner({ active: true });
      let healthCalls = 0;
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => {
          healthCalls += 1;
          return new Response(healthCalls < 3 ? "nope" : "ok", {
            status: healthCalls < 3 ? 503 : 200,
          });
        },
        healthTimeoutMs: 1_000,
        healthIntervalMs: 1,
      };
      await installDaemon({ validate: false }, options);

      await startDaemon(options);

      expect(healthCalls).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not bootstrap launchd during plain install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-launchd-install-"));
    try {
      const runner = fakeRunner();
      await installDaemon(
        { validate: false },
        {
          env: testEnv(dir),
          home: dir,
          platform: "darwin",
          uid: 501,
          commandRunner: runner,
        },
      );

      expect(runner.commands).not.toContainEqual([
        "launchctl",
        "bootstrap",
        "gui/501",
        resolveDaemonPaths({ env: testEnv(dir), platform: "darwin" }).descriptorFile,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads already bootstrapped launchd descriptors before start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-launchd-start-"));
    try {
      let bootstrapAttempts = 0;
      let running = false;
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (command === "launchctl" && args[0] === "bootstrap") {
            bootstrapAttempts += 1;
            return bootstrapAttempts === 1
              ? { stdout: "", stderr: "service already loaded", code: 37 }
              : { stdout: "", stderr: "", code: 0 };
          }
          if (command === "launchctl" && args[0] === "print") {
            return running
              ? { stdout: "pid = 4242\n", stderr: "", code: 0 }
              : { stdout: "", stderr: "not found", code: 113 };
          }
          if (command === "launchctl" && args[0] === "kickstart") {
            running = true;
            return { stdout: "", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        home: dir,
        platform: "darwin" as const,
        uid: 501,
        commandRunner: runner,
        fetch: async () => new Response("ok"),
      };
      const installed = await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      await startDaemon(options);

      expect(runner.commands).toContainEqual([
        "launchctl",
        "bootout",
        "gui/501",
        installed.config.paths.descriptorFile,
      ]);
      expect(runner.commands.filter((command) => command[1] === "bootstrap")).toHaveLength(2);
      expect(runner.commands).toContainEqual([
        "launchctl",
        "kickstart",
        "-k",
        "gui/501/dev.caplets.daemon.default",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads launchd descriptors before restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-launchd-restart-"));
    try {
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (command === "launchctl" && args[0] === "print") {
            return { stdout: "pid = 4242\n", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        home: dir,
        platform: "darwin" as const,
        uid: 501,
        commandRunner: runner,
        fetch: async () => new Response("ok"),
      };
      const installed = await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      await restartDaemon(options);

      expect(runner.commands).toContainEqual([
        "launchctl",
        "bootout",
        "gui/501",
        installed.config.paths.descriptorFile,
      ]);
      expect(runner.commands).toContainEqual([
        "launchctl",
        "bootstrap",
        "gui/501",
        installed.config.paths.descriptorFile,
      ]);
      expect(runner.commands).toContainEqual([
        "launchctl",
        "kickstart",
        "-k",
        "gui/501/dev.caplets.daemon.default",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boots out launchd jobs on stop so KeepAlive does not relaunch them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-launchd-stop-"));
    try {
      const runner = fakeRunner();
      const options = {
        env: testEnv(dir),
        home: dir,
        platform: "darwin" as const,
        uid: 501,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      runner.commands.length = 0;

      await stopDaemon(options);

      expect(runner.commands).toContainEqual([
        "launchctl",
        "bootout",
        "gui/501",
        installed.config.paths.descriptorFile,
      ]);
      expect(runner.commands).not.toContainEqual([
        "launchctl",
        "kill",
        "TERM",
        "gui/501/dev.caplets.daemon.default",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boots out launchd by label when the plist is missing but config remains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-launchd-repeat-uninstall-"));
    try {
      const runner = fakeRunner();
      const options = {
        env: testEnv(dir),
        home: dir,
        platform: "darwin" as const,
        uid: 501,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);

      await uninstallDaemon({}, options);
      runner.commands.length = 0;
      const repeated = await uninstallDaemon({}, options);

      expect(repeated.native?.native.state).toBe("not_installed");
      expect(runner.commands).toContainEqual([
        "launchctl",
        "bootout",
        "gui/501/dev.caplets.daemon.default",
      ]);
      expect(existsSync(installed.config.paths.configFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails Windows restart when stopping the running task fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-restart-end-"));
    let paths: ReturnType<typeof resolveDaemonPaths> | undefined;
    try {
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (command === "schtasks" && args.includes("/Query")) {
            return { stdout: "Status: Running\nLast Run Result: 0\n", stderr: "", code: 0 };
          }
          if (command === "schtasks" && args.includes("/End")) {
            return { stdout: "", stderr: "Access is denied.", code: 1 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: {
          APPDATA: join(dir, "AppData", "Roaming"),
          LOCALAPPDATA: join(dir, "AppData", "Local"),
        },
        home: "C:\\Users\\Alice",
        platform: "win32" as const,
        commandRunner: runner,
      };
      paths = resolveDaemonPaths(options);
      await installDaemon({ validate: false }, options);

      await expect(restartDaemon(options)).rejects.toThrow(/Scheduled Task restart failed/u);

      expect(runner.commands).not.toContainEqual([
        "schtasks",
        "/Run",
        "/TN",
        "\\Caplets\\daemon-default",
      ]);
    } finally {
      if (paths) {
        for (const path of [
          paths.descriptorFile,
          paths.wrapperFile,
          paths.configFile,
          paths.stateFile,
          paths.stdoutLog,
          paths.stderrLog,
        ]) {
          rmSync(daemonHostPath(path), { force: true });
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads file-backed logs with stream labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-logs-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(paths.logDir, { recursive: true });
      writeFileSync(paths.stdoutLog, "out1\nout2\n");
      writeFileSync(paths.stderrLog, "err1\nerr2\n");

      expect(daemonLogs({ env: testEnv(dir), platform: "linux", tail: 10 }).entries).toEqual([
        { stream: "stdout", line: "out1" },
        { stream: "stderr", line: "err1" },
        { stream: "stdout", line: "out2" },
        { stream: "stderr", line: "err2" },
      ]);
      expect(daemonLogs({ env: testEnv(dir), platform: "linux", tail: 1 }).entries).toEqual([
        { stream: "stdout", line: "out2" },
        { stream: "stderr", line: "err2" },
      ]);
      expect(
        daemonLogs({ env: testEnv(dir), platform: "linux", stream: "stdout", tail: 10 }).entries,
      ).toEqual([
        { stream: "stdout", line: "out1" },
        { stream: "stdout", line: "out2" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tails daemon logs from the end of large files", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-large-logs-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(paths.logDir, { recursive: true });
      writeFileSync(
        paths.stdoutLog,
        `${Array.from({ length: 7_000 }, (_value, index) => `out${index}`).join("\n")}\nout-last\n`,
      );
      writeFileSync(
        paths.stderrLog,
        `${Array.from({ length: 7_000 }, (_value, index) => `err${index}`).join("\n")}\nerr-last\n`,
      );

      expect(daemonLogs({ env: testEnv(dir), platform: "linux", tail: 1 }).entries).toEqual([
        { stream: "stdout", line: "out-last" },
        { stream: "stderr", line: "err-last" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uninstall purge removes descriptor, config, state, and logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-purge-"));
    try {
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: fakeRunner(),
      };
      const installed = await installDaemon({ validate: false }, options);
      writeFileSync(installed.config.paths.stdoutLog, "out\n");
      writeFileSync(installed.config.paths.stderrLog, "err\n");

      const result = await uninstallDaemon({ purge: true }, options);

      expect(result.purge).toBe(true);
      expect(result.removed).not.toContain(installed.config.paths.wrapperFile);
      expect(existsSync(installed.config.paths.descriptorFile)).toBe(false);
      expect(existsSync(installed.config.paths.configFile)).toBe(false);
      expect(existsSync(installed.config.paths.stateFile)).toBe(false);
      expect(existsSync(installed.config.paths.stdoutLog)).toBe(false);
      expect(existsSync(installed.config.paths.stderrLog)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports Windows wrapper cleanup during purge dry-run", async () => {
    const result = await uninstallDaemon(
      { purge: true, dryRun: true },
      {
        env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
        home: "C:\\Users\\Alice",
        platform: "win32",
        commandRunner: fakeRunner(),
      },
    );
    const paths = resolveDaemonPaths({
      env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
      home: "C:\\Users\\Alice",
      platform: "win32",
    });

    expect(result.removed).toContain(paths.wrapperFile);
  });

  it("stops running native services during uninstall when config is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-uninstall-stale-config-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      rmSync(installed.config.paths.configFile, { force: true });
      runner.commands.length = 0;

      await uninstallDaemon({}, options);

      expect(runner.commands).toContainEqual([
        "systemctl",
        "--user",
        "stop",
        "caplets-daemon-default.service",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sorts timestamped daemon logs across streams", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-timestamp-logs-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(paths.logDir, { recursive: true });
      writeFileSync(
        paths.stdoutLog,
        "2026-06-19T10:00:00.000Z out1\n2026-06-19T10:00:02.000Z out2\n",
      );
      writeFileSync(paths.stderrLog, "2026-06-19T10:00:01.000Z err1\n");

      expect(daemonLogs({ env: testEnv(dir), platform: "linux", tail: 10 }).entries).toEqual([
        { stream: "stdout", line: "2026-06-19T10:00:00.000Z out1" },
        { stream: "stderr", line: "2026-06-19T10:00:01.000Z err1" },
        { stream: "stdout", line: "2026-06-19T10:00:02.000Z out2" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves daemon config on non-purge uninstall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-uninstall-keep-config-"));
    try {
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: fakeRunner(),
      };
      const installed = await installDaemon({ validate: false }, options);

      await uninstallDaemon({}, options);

      expect(existsSync(installed.config.paths.descriptorFile)).toBe(false);
      expect(existsSync(installed.config.paths.configFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails Linux uninstall when systemd unregister fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-linux-uninstall-fail-"));
    try {
      let failDisable = false;
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (failDisable && command === "systemctl" && args.includes("disable")) {
            return { stdout: "", stderr: "access denied", code: 1 };
          }
          if (args.includes("is-active")) return { stdout: "inactive\n", stderr: "", code: 3 };
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      failDisable = true;

      await expect(uninstallDaemon({}, options)).rejects.toThrow(/systemd unregister failed/u);

      expect(existsSync(installed.config.paths.descriptorFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the systemd descriptor when unregister reload fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-linux-uninstall-reload-fail-"));
    try {
      let failReload = false;
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (failReload && command === "systemctl" && args.includes("daemon-reload")) {
            return { stdout: "", stderr: "reload failed", code: 1 };
          }
          if (args.includes("is-active")) return { stdout: "inactive\n", stderr: "", code: 3 };
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon({ validate: false }, options);
      failReload = true;
      runner.commands.length = 0;

      await expect(uninstallDaemon({}, options)).rejects.toThrow(/systemd unregister failed/u);

      expect(existsSync(installed.config.paths.descriptorFile)).toBe(true);
      expect(runner.commands).toEqual([
        ["systemctl", "--user", "show", "caplets-daemon-default.service"],
        ["systemctl", "--user", "is-active", "caplets-daemon-default.service"],
        ["systemctl", "--user", "disable", "caplets-daemon-default.service"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "caplets-daemon-default.service"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats Windows tasks that have not run as installed and stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-ready-"));
    let paths: ReturnType<typeof resolveDaemonPaths> | undefined;
    try {
      const runner: DaemonCommandRunner = {
        async exec(command, args) {
          if (command === "schtasks" && args.includes("/Query")) {
            return { stdout: "Status: Ready\nLast Run Result: 0x41303\n", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: {
          APPDATA: join(dir, "AppData", "Roaming"),
          LOCALAPPDATA: join(dir, "AppData", "Local"),
        },
        home: "C:\\Users\\Alice",
        platform: "win32" as const,
        commandRunner: runner,
      };
      paths = resolveDaemonPaths(options);
      await installDaemon({ validate: false }, options);

      const status = await daemonStatus(options);

      expect(status.nativeState).toBe("installed_stopped");
      expect(status.running).toBe(false);
    } finally {
      if (paths) {
        for (const path of [
          paths.descriptorFile,
          paths.wrapperFile,
          paths.configFile,
          paths.stateFile,
          paths.stdoutLog,
          paths.stderrLog,
        ]) {
          rmSync(daemonHostPath(path), { force: true });
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats stale Windows XML descriptors as uninstalled when schtasks cannot query the task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-stale-xml-"));
    let paths: ReturnType<typeof resolveDaemonPaths> | undefined;
    try {
      const options = {
        env: {
          APPDATA: join(dir, "AppData", "Roaming"),
          LOCALAPPDATA: join(dir, "AppData", "Local"),
        },
        home: "C:\\Users\\Alice",
        platform: "win32" as const,
        commandRunner: fakeRunner(),
      };
      paths = resolveDaemonPaths(options);
      await installDaemon({ validate: false }, options);
      const status = await daemonStatus({
        ...options,
        commandRunner: {
          async exec(command, args) {
            if (command === "schtasks" && args.includes("/Query")) {
              return {
                stdout: "",
                stderr: "ERROR: The system cannot find the file specified.",
                code: 1,
              };
            }
            return { stdout: "", stderr: "", code: 0 };
          },
        },
      });

      expect(status.installed).toBe(false);
      expect(status.nativeState).toBe("not_installed");
    } finally {
      if (paths) {
        for (const path of [
          paths.descriptorFile,
          paths.wrapperFile,
          paths.configFile,
          paths.stateFile,
          paths.stdoutLog,
          paths.stderrLog,
        ]) {
          rmSync(daemonHostPath(path), { force: true });
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes Windows wrapper files and checks unregister failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-windows-uninstall-"));
    let paths: ReturnType<typeof resolveDaemonPaths> | undefined;
    try {
      let failDelete = false;
      const runner: DaemonCommandRunner & { commands: string[][] } = {
        commands: [],
        async exec(command, args) {
          runner.commands.push([command, ...args]);
          if (failDelete && command === "schtasks" && args.includes("/Delete")) {
            return { stdout: "", stderr: "access denied", code: 1 };
          }
          if (command === "schtasks" && args.includes("/Query")) {
            return { stdout: "Status: Ready\nLast Run Result: 0\n", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: {
          APPDATA: join(dir, "AppData", "Roaming"),
          LOCALAPPDATA: join(dir, "AppData", "Local"),
        },
        home: "C:\\Users\\Alice",
        platform: "win32" as const,
        commandRunner: runner,
      };
      paths = resolveDaemonPaths(options);
      const installed = await installDaemon({ validate: false }, options);
      expect(daemonPathExists(installed.config.paths.wrapperFile)).toBe(true);

      failDelete = true;
      await expect(uninstallDaemon({}, options)).rejects.toThrow(
        /Scheduled Task unregister failed/u,
      );
      expect(daemonPathExists(installed.config.paths.wrapperFile)).toBe(true);

      failDelete = false;
      await uninstallDaemon({}, options);

      expect(daemonPathExists(installed.config.paths.descriptorFile)).toBe(false);
      expect(daemonPathExists(installed.config.paths.wrapperFile)).toBe(false);
    } finally {
      if (paths) {
        for (const path of [
          paths.descriptorFile,
          paths.wrapperFile,
          paths.configFile,
          paths.stateFile,
          paths.stdoutLog,
          paths.stderrLog,
        ]) {
          rmSync(daemonHostPath(path), { force: true });
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts daemon remote credential state from status config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-status-redaction-"));
    try {
      const runner: DaemonCommandRunner = {
        async exec(command, args) {
          if (command === "systemctl" && args.includes("show")) {
            return {
              stdout:
                "ExecStart={ path=/node ; argv[]=/node /cli serve --remote-state-path /secret/state ; }\nEnvironment=TOKEN=abc123\n",
              stderr: "",
              code: 0,
            };
          }
          if (command === "systemctl" && args.includes("is-active")) {
            return { stdout: "inactive\n", stderr: "", code: 3 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      await installDaemon(
        {
          remoteStatePath: "/secret/state",
          env: ["TOKEN=abc123"],
          validate: false,
        },
        options,
      );

      const status = await daemonStatus(options);
      const serialized = JSON.stringify(status);

      if (!status.config) throw new Error("expected daemon config");
      expect(status.config.serve.auth.type).toBe("remote_credentials");
      expect(status.config.serve.remoteCredentialStateDir).toBe("[REDACTED]");
      expect(status.config.env.values.TOKEN).toBe("[redacted]");
      expect(status.config.command.env.TOKEN).toBe("[redacted]");
      expect(status.config.command.args).toContain("--remote-state-path");
      expect(status.config.command.args).not.toContain("/secret/state");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts remote state path arguments from native status when config is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-status-stale-redaction-"));
    try {
      const runner: DaemonCommandRunner = {
        async exec(command, args) {
          if (command === "systemctl" && args.includes("show")) {
            return {
              stdout:
                "ExecStart={ path=/node ; argv[]=/node /cli serve --remote-state-path /secret/state ; }\n",
              stderr: "",
              code: 0,
            };
          }
          if (command === "systemctl" && args.includes("is-active")) {
            return { stdout: "inactive\n", stderr: "", code: 3 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
      };
      const installed = await installDaemon(
        {
          remoteStatePath: "/secret/state",
          validate: false,
        },
        options,
      );
      rmSync(installed.config.paths.configFile, { force: true });

      const status = await daemonStatus(options);
      const serialized = JSON.stringify(status);

      expect(status.config).toBeUndefined();
      expect(serialized).toContain("[redacted]");
      expect(serialized).not.toContain("--remote-state-path /secret/state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon validation", () => {
  it("returns a failed health result for spawn errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-spawn-"));
    try {
      const result = await installDaemon(
        { validate: false, dryRun: true, inheritEnv: true },
        {
          env: testEnv(dir),
          accountShell: join(dir, "missing-shell"),
          home: "/home/alice",
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );

      await expect(validateDaemonCommand(result.config, { timeoutMs: 20 })).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not accept health checks from an existing server after the candidate exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-existing-server-"));
    try {
      const candidate = join(dir, "candidate-exits.mjs");
      writeFileSync(candidate, "process.exit(1);\n");
      const result = await installDaemon(
        { validate: false, dryRun: true, host: "127.0.0.1", port: "5480" },
        {
          env: testEnv(dir),
          home: dir,
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      const config = {
        ...result.config,
        command: {
          ...result.config.command,
          executable: process.execPath,
          args: [candidate],
        },
      };

      await expect(
        validateDaemonCommand(config, {
          timeoutMs: 1_000,
          fetch: async () => new Response("ok"),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("validation process exited"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unavailable local bind hosts even when the health URL responds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-bind-host-"));
    try {
      const result = await installDaemon(
        { validate: false, dryRun: true, host: "192.0.2.1", port: "5480" },
        {
          env: testEnv(dir),
          home: dir,
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      const config = {
        ...result.config,
        command: {
          ...result.config.command,
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
        },
      };

      await expect(
        validateDaemonCommand(config, {
          timeoutMs: 1_000,
          fetch: async () => new Response("ok"),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("bind host validation failed"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates with only the configured service environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-env-"));
    try {
      const port = await allocateLoopbackPort();
      const envFile = join(dir, "child-env.json");
      const serverFile = join(dir, "server.mjs");
      writeFileSync(
        serverFile,
        `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
createServer((_request, response) => response.end("ok")).listen(${port}, "127.0.0.1");
`,
      );
      const result = await installDaemon(
        {
          validate: false,
          dryRun: true,
          host: "127.0.0.1",
          port: String(port),
          env: ["SERVICE_ONLY=1"],
        },
        {
          env: { ...testEnv(dir), INSTALLER_ONLY: "1" },
          home: dir,
          platform: "linux",
          commandRunner: fakeRunner(),
        },
      );
      const config = {
        ...result.config,
        command: {
          ...result.config.command,
          executable: process.execPath,
          args: [serverFile],
        },
      };

      await expect(validateDaemonCommand(config, { timeoutMs: 1_000 })).resolves.toMatchObject({
        ok: true,
      });
      const childEnv = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;

      expect(childEnv.SERVICE_ONLY).toBe("1");
      expect(childEnv.INSTALLER_ONLY).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps Windows cmd shims for validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-validation-cmd-"));
    try {
      const result = await installDaemon(
        { validate: false, dryRun: true },
        {
          env: {
            APPDATA: win32.join(dir, "AppData", "Roaming"),
            LOCALAPPDATA: win32.join(dir, "AppData", "Local"),
          },
          home: "C:\\Users\\Alice",
          platform: "win32",
          commandRunner: fakeRunner(),
        },
      );
      const config = {
        ...result.config,
        command: {
          ...result.config.command,
          executable: "C:\\Users\\Alice\\AppData\\Roaming\\pnpm\\caplets.cmd",
          args: ["serve", "--remote-state-path", "pa th"],
        },
      };

      expect(validationSpawnCommand(config)).toEqual({
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          '"C:\\Users\\Alice\\AppData\\Roaming\\pnpm\\caplets.cmd" serve --remote-state-path "pa th"',
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  };
}

function fakeRunner(
  options: { active?: boolean } = {},
): DaemonCommandRunner & { commands: string[][] } {
  const commands: string[][] = [];
  return {
    commands,
    async exec(command, args) {
      commands.push([command, ...args]);
      if (args.includes("is-active")) {
        return options.active
          ? { stdout: "active\n", stderr: "", code: 0 }
          : { stdout: "inactive\n", stderr: "", code: 3 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

function captureRestartManager(restarted: DaemonConfig[]): DaemonManager {
  const native = { state: "running" as const, installed: true, running: true };
  return {
    descriptor: (config) => ({
      kind: "systemd-user",
      unitName: "caplets-daemon-default.service",
      path: config.paths.descriptorFile,
      contents: "",
    }),
    status: async () => native,
    install: async () => ({ action: "install", native }),
    uninstall: async () => ({ action: "uninstall", native }),
    start: async (config) => {
      restarted.push(config);
      return { action: "start", native };
    },
    restart: async (config) => {
      restarted.push(config);
      return { action: "restart", native };
    },
    stop: async () => ({ action: "stop", native }),
  };
}
