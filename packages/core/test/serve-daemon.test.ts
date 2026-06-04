import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import type { CapletsError } from "../src/errors";
import {
  buildDaemonPlatformDescriptor,
  daemonStatus,
  disableDaemon,
  enableDaemon,
  resolveServeDaemonPaths,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type DaemonProcessRunner,
} from "../src/serve";

describe("caplets serve daemon CLI", () => {
  it("shows daemon subcommand help", async () => {
    const out: string[] = [];

    await runCli(["serve", "start", "--help"], { writeOut: (value) => out.push(value) });
    await runCli(["serve", "status", "--help"], { writeOut: (value) => out.push(value) });

    const text = out.join("");
    expect(text).toContain("Start the default Caplets HTTP daemon.");
    expect(text).toContain("Show the default Caplets HTTP daemon status.");
    expect(text).toContain("--transport <transport>");
  });

  it("rejects stdio daemon start", async () => {
    await expect(
      runCli(["serve", "start", "--transport", "stdio"], { writeErr: () => {} }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "REQUEST_INVALID",
        message: "Daemonized serve requires --transport http.",
      }) as CapletsError,
    );
  });

  it("defaults daemon start to HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-"));
    const out: string[] = [];
    try {
      await runCli(["serve", "start"], {
        env: { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") },
        writeOut: (value) => out.push(value),
        daemon: {
          process: fakeProcessRunner({ running: false, pid: 1200 }),
        },
      });

      expect(out.join("")).toContain("Started Caplets HTTP daemon on 127.0.0.1:5387.");
      const config = JSON.parse(
        readFileSync(join(dir, "config", "caplets", "serve", "default.json"), "utf8"),
      ) as { serve: { transport: string } };
      expect(config.serve.transport).toBe("http");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints redacted JSON status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-cli-"));
    const out: string[] = [];
    try {
      await startDaemon(
        { password: "super-secret-password" },
        {
          env: { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") },
          process: fakeProcessRunner({ running: false, pid: 1300 }),
        },
      );

      await runCli(["serve", "status", "--json"], {
        env: { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") },
        writeOut: (value) => out.push(value),
        daemon: {
          process: fakeProcessRunner({ running: true, pid: 1300 }),
        },
      });

      const status = JSON.parse(out.join("")) as {
        config: { serve: { auth: { password: string } } };
      };
      expect(status.config.serve.auth.password).toBe("[REDACTED]");
      expect(out.join("")).not.toContain("super-secret-password");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("serve daemon paths", () => {
  it("uses XDG state and config roots for macOS and Linux", () => {
    const paths = resolveServeDaemonPaths({
      env: { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" },
      home: "/home/alice",
      platform: "linux",
    });

    expect(paths.stateFile).toBe(posix.join("/state", "caplets", "serve", "default", "state.json"));
    expect(paths.pidFile).toBe(posix.join("/state", "caplets", "serve", "default", "server.pid"));
    expect(paths.stdoutLog).toBe(
      posix.join("/state", "caplets", "serve", "default", "logs", "stdout.log"),
    );
    expect(paths.stderrLog).toBe(
      posix.join("/state", "caplets", "serve", "default", "logs", "stderr.log"),
    );
    expect(paths.configFile).toBe(posix.join("/config", "caplets", "serve", "default.json"));
  });

  it("uses LOCALAPPDATA state and APPDATA config roots for Windows", () => {
    const paths = resolveServeDaemonPaths({
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
        "serve",
        "default",
        "state.json",
      ),
    );
    expect(paths.pidFile).toBe(
      win32.join(
        "C:\\Users\\Alice\\AppData\\Local",
        "Caplets",
        "State",
        "serve",
        "default",
        "server.pid",
      ),
    );
    expect(paths.stdoutLog).toBe(
      win32.join(
        "C:\\Users\\Alice\\AppData\\Local",
        "Caplets",
        "State",
        "serve",
        "default",
        "logs",
        "stdout.log",
      ),
    );
    expect(paths.configFile).toBe(
      win32.join("C:\\Users\\Alice\\AppData\\Roaming", "Caplets", "serve", "default.json"),
    );
  });
});

describe("serve daemon lifecycle", () => {
  it("starts, reports status, and stops the default instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-"));
    const process = fakeProcessRunner({ running: false, pid: 1400 });
    try {
      const options = {
        env: { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") },
        process,
      };

      const started = await startDaemon({ port: "5480", password: "secret-password" }, options);
      expect(started.status.running).toBe(true);
      expect(started.status.pid).toBe(1400);
      expect(process.starts[0]?.args).toEqual([
        "serve",
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        "5480",
        "--path",
        "/",
        "--user",
        "caplets",
        "--password",
        "secret-password",
      ]);

      const status = await daemonStatus({
        ...options,
        process: fakeProcessRunner({ running: true, pid: 1400 }),
      });
      expect(status.running).toBe(true);
      expect(status.config?.serve.port).toBe(5480);

      const stopped = await stopDaemon({
        ...options,
        process: fakeProcessRunner({ running: true, pid: 1400 }),
      });
      expect(stopped.status.running).toBe(false);
      expect(stopped.status.pid).toBeUndefined();

      const afterStop = await daemonStatus({
        ...options,
        process: fakeProcessRunner({ running: true, pid: 1400 }),
      });
      expect(afterStop.running).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails start when already running and lets restart apply config changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-"));
    try {
      const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
      await startDaemon(
        { port: "5480" },
        { env, process: fakeProcessRunner({ running: false, pid: 1400 }) },
      );

      await expect(
        startDaemon(
          { port: "5481" },
          { env, process: fakeProcessRunner({ running: true, pid: 1400 }) },
        ),
      ).rejects.toThrow("Caplets HTTP daemon is already running.");

      const process = fakeProcessRunner({ running: true, pid: 1400, nextPid: 1401 });
      const restarted = await restartDaemon({ port: "5481" }, { env, process });

      expect(restarted.status.running).toBe(true);
      expect(restarted.status.pid).toBe(1401);
      expect(process.stops).toEqual([1400]);
      expect(process.starts[0]?.args).toContain("5481");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables and disables the platform service without installing in tests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-"));
    try {
      const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
      await startDaemon(
        { port: "5482" },
        { env, process: fakeProcessRunner({ running: false, pid: 1400 }) },
      );

      const enabled = await enableDaemon({ env, platform: "linux", serviceAvailable: true });
      expect(enabled.enabled).toBe(true);
      expect(enabled.descriptor.kind).toBe("systemd-user");

      const disabled = await disableDaemon({ env, platform: "linux", serviceAvailable: true });
      expect(disabled.enabled).toBe(false);
      expect(disabled.descriptor.kind).toBe("systemd-user");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("serve daemon platform descriptors", () => {
  it("describes a macOS launchd user agent", () => {
    const descriptor = buildDaemonPlatformDescriptor({
      platform: "darwin",
      paths: resolveServeDaemonPaths({
        env: { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" },
        home: "/Users/alice",
        platform: "darwin",
      }),
      command: { executable: "/usr/local/bin/caplets", args: ["serve", "--transport", "http"] },
    });

    expect(descriptor.kind).toBe("launchd-user-agent");
    if (descriptor.kind !== "launchd-user-agent") throw new Error("expected launchd descriptor");
    expect(descriptor.label).toBe("dev.caplets.serve.default");
    expect(descriptor.plist).toContain("<key>Label</key>");
    expect(descriptor.plist).toContain("dev.caplets.serve.default");
    expect(descriptor.plist).toContain("/usr/local/bin/caplets");
  });

  it("describes a Linux systemd user service when available", () => {
    const descriptor = buildDaemonPlatformDescriptor({
      platform: "linux",
      serviceAvailable: true,
      paths: resolveServeDaemonPaths({
        env: { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" },
        home: "/home/alice",
        platform: "linux",
      }),
      command: { executable: "/usr/bin/caplets", args: ["serve", "--transport", "http"] },
    });

    expect(descriptor.kind).toBe("systemd-user");
    if (descriptor.kind !== "systemd-user") throw new Error("expected systemd descriptor");
    expect(descriptor.unitName).toBe("caplets-serve-default.service");
    expect(descriptor.unit).toContain("[Service]");
    expect(descriptor.unit).toContain("ExecStart=/usr/bin/caplets serve --transport http");
  });

  it("describes a Linux fallback when systemd user services are unavailable", () => {
    const descriptor = buildDaemonPlatformDescriptor({
      platform: "linux",
      serviceAvailable: false,
      paths: resolveServeDaemonPaths({
        env: { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" },
        home: "/home/alice",
        platform: "linux",
      }),
      command: { executable: "/usr/bin/caplets", args: ["serve", "--transport", "http"] },
    });

    expect(descriptor.kind).toBe("manual");
    if (descriptor.kind !== "manual") throw new Error("expected manual descriptor");
    expect(descriptor.reason).toContain("systemd user service is not available");
  });

  it("describes a Windows per-user Scheduled Task command plan", () => {
    const descriptor = buildDaemonPlatformDescriptor({
      platform: "win32",
      paths: resolveServeDaemonPaths({
        env: {
          APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
        },
        home: "C:\\Users\\Alice",
        platform: "win32",
      }),
      command: {
        executable: "C:\\Program Files\\nodejs\\caplets.cmd",
        args: ["serve", "--transport", "http"],
      },
    });

    expect(descriptor.kind).toBe("windows-scheduled-task");
    if (descriptor.kind !== "windows-scheduled-task")
      throw new Error("expected scheduled task descriptor");
    expect(descriptor.taskName).toBe("Caplets Serve Default");
    expect(descriptor.commands.register).toContain("schtasks");
    expect(descriptor.commands.register).toContain("/SC ONLOGON");
    expect(descriptor.commands.register).toContain("caplets.cmd");
  });
});

function fakeProcessRunner(initial: {
  running: boolean;
  pid: number;
  nextPid?: number;
}): DaemonProcessRunner & {
  starts: Array<{ args: string[]; stdoutLog: string; stderrLog: string }>;
  stops: number[];
} {
  let running = initial.running;
  let pid = initial.pid;
  const starts: Array<{ args: string[]; stdoutLog: string; stderrLog: string }> = [];
  const stops: number[] = [];
  return {
    starts,
    stops,
    isRunning: async (candidate) => running && candidate === pid,
    start: async (command) => {
      pid = initial.nextPid ?? pid;
      running = true;
      starts.push(command);
      return pid;
    },
    stop: async (candidate) => {
      stops.push(candidate);
      running = false;
    },
  };
}
