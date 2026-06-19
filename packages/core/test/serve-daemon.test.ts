import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import type { CapletsError } from "../src/errors";
import {
  daemonServeArgs,
  daemonLogs,
  daemonStatus,
  installDaemon,
  resolveDaemonHttpServeOptions,
  resolveDaemonPaths,
  restartDaemon,
  startDaemon,
  uninstallDaemon,
  type DaemonCommandRunner,
} from "../src/daemon";

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

  it("installs with HTTP serve config, env overrides, and home working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-install-"));
    try {
      const runner = fakeRunner();
      const result = await installDaemon(
        {
          host: "127.0.0.1",
          port: "5480",
          path: "/caplets",
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

  it("does not emit auth flags for default unauthenticated loopback serve", () => {
    const serve = resolveDaemonHttpServeOptions({});

    expect(daemonServeArgs(serve)).not.toContain("--user");
    expect(daemonServeArgs(serve)).not.toContain("--password");
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
            return { ok: true, url: `http://127.0.0.1:${config.serve.port}/v1/healthz` };
          },
        },
      );

      expect(validatedPorts).toHaveLength(1);
      expect(validatedPorts[0]).not.toBe(5480);
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
              ? { ok: false, url: `http://127.0.0.1:${config.serve.port}/v1/healthz` }
              : { ok: true, url: `http://127.0.0.1:${config.serve.port}/v1/healthz` };
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
      expect(systemd.descriptor.contents).toContain('WorkingDirectory="/home/alice with space"');
      expect(systemd.descriptor.contents).toContain('Environment="PATH=/custom/bin"');
      expect(systemd.descriptor.contents).toContain(
        'Environment="MULTI=line\\nExecStartPre=/bin/false"',
      );
      expect(systemd.descriptor.contents).not.toContain("\nExecStartPre=/bin/false");

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
      expect(windows.descriptor.xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
      expect(windows.descriptor.xml).toContain("<WorkingDirectory>");
      expect(windows.descriptor.wrapper.contents).toContain(">> ");
      expect(windows.descriptor.wrapper.contents).toContain("2>> ");
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
      ).rejects.toThrow(/cannot contain CR, LF, or %/u);

      await expect(
        installDaemon(
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
        ),
      ).rejects.toThrow(/cannot contain CR, LF, or %/u);
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

  it("rolls back descriptor files when native registration fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-rollback-"));
    try {
      const paths = resolveDaemonPaths({ env: testEnv(dir), platform: "linux" });
      mkdirSync(join(dir, "config", "systemd", "user"), { recursive: true });
      writeFileSync(paths.descriptorFile, "old descriptor\n");
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
      expect(existsSync(paths.configFile)).toBe(false);
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

  it("fails start when the native service does not pass HTTP health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-health-"));
    try {
      const runner = fakeRunner({ active: true });
      const options = {
        env: testEnv(dir),
        platform: "linux" as const,
        commandRunner: runner,
        fetch: async () => new Response("nope", { status: 503 }),
      };
      await installDaemon({ validate: false }, options);

      await expect(startDaemon(options)).rejects.toThrow(/Native daemon health check failed/u);
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
      expect(existsSync(installed.config.paths.descriptorFile)).toBe(false);
      expect(existsSync(installed.config.paths.configFile)).toBe(false);
      expect(existsSync(installed.config.paths.stateFile)).toBe(false);
      expect(existsSync(installed.config.paths.stdoutLog)).toBe(false);
      expect(existsSync(installed.config.paths.stderrLog)).toBe(false);
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
