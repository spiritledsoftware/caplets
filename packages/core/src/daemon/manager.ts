import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CapletsError } from "../errors";
import { buildLaunchdDescriptor, LAUNCHD_LABEL } from "./platform-darwin";
import { buildSystemdDescriptor, SYSTEMD_UNIT } from "./platform-linux";
import { buildWindowsTaskDescriptor, WINDOWS_TASK_NAME } from "./platform-windows";
import type {
  DaemonCommandRunner,
  DaemonDescriptor,
  DaemonManager,
  DaemonManagerAction,
  DaemonOperationOptions,
  NativeDaemonStatus,
} from "./types";

export function createNativeDaemonManager(options: DaemonOperationOptions = {}): DaemonManager {
  const platform = options.platform ?? process.platform;
  const runner = options.commandRunner ?? nodeCommandRunner();
  if (platform === "darwin") return launchdManager(runner, options.uid);
  if (platform === "linux") return systemdManager(runner, options.serviceAvailable);
  if (platform === "win32") return windowsTaskManager(runner);
  return unsupportedManager(platform);
}

function launchdManager(
  runner: DaemonCommandRunner,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
): DaemonManager {
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const domain = `gui/${uid}`;
  return {
    descriptor: buildLaunchdDescriptor,
    status: async (config, paths) => {
      if (!existsSync(paths.descriptorFile) && !config) return notInstalled();
      const result = await runner.exec("launchctl", ["print", target]);
      if (result.code !== 0)
        return existsSync(paths.descriptorFile)
          ? stopped({ stderr: result.stderr })
          : notInstalled({ stderr: result.stderr });
      const pid = parseNumberMatch(result.stdout, /\bpid\s*=\s*(\d+)/u);
      const failed = /\b(?:last exit code|LastExitStatus)\s*=\s*(?!0\b)(\d+)/iu.test(result.stdout);
      return failed
        ? failedStatus({ stdout: result.stdout, stderr: result.stderr, pid })
        : runningOrStopped(pid, { stdout: result.stdout, stderr: result.stderr });
    },
    install: async (config) => {
      const descriptor = buildLaunchdDescriptor(config);
      const commands = [["launchctl", "bootstrap", domain, descriptor.path]];
      const result = await writeDescriptorForInstall(descriptor, async () => {
        const bootstrap = await runner.exec(commands[0]![0]!, commands[0]!.slice(1));
        if (
          bootstrap.code !== 0 &&
          !/already bootstrapped|service already loaded/iu.test(bootstrap.stderr)
        ) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            `launchd registration failed: ${bootstrap.stderr || bootstrap.stdout || bootstrap.code}`,
          );
        }
        return bootstrap;
      });
      return {
        action: "install",
        native: stopped({ stdout: result.stdout, stderr: result.stderr }),
        commands,
        descriptor,
      };
    },
    uninstall: async (_config, paths) => {
      const commands = [["launchctl", "bootout", domain, paths.descriptorFile]];
      const result = await runner.exec(commands[0]![0]!, commands[0]!.slice(1));
      if (
        result.code !== 0 &&
        !/No such process|not found|Could not find service/iu.test(result.stderr)
      ) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `launchd unregister failed: ${result.stderr || result.stdout || result.code}`,
        );
      }
      rmSync(paths.descriptorFile, { force: true });
      return {
        action: "uninstall",
        native: notInstalled({ stdout: result.stdout, stderr: result.stderr }),
        commands,
      };
    },
    start: async () => launchdLifecycle(runner, "start", ["launchctl", "kickstart", "-k", target]),
    restart: async (config) =>
      launchdRestartLifecycle(runner, domain, target, config.paths.descriptorFile),
    stop: async () => {
      const command = ["launchctl", "kill", "TERM", target];
      const result = await runner.exec(command[0]!, command.slice(1));
      if (
        result.code !== 0 &&
        !/No such process|not running|Could not find service/iu.test(result.stderr)
      ) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `launchd stop failed: ${result.stderr || result.stdout || result.code}`,
        );
      }
      return { action: "stop", native: stopped(), commands: [command] };
    },
  };
}

function systemdManager(runner: DaemonCommandRunner, serviceAvailable = true): DaemonManager {
  return {
    descriptor: buildSystemdDescriptor,
    status: async (config, paths) => {
      if (!serviceAvailable) return unavailable("systemd --user is not available.");
      if (!existsSync(paths.descriptorFile) && !config) return notInstalled();
      const show = await runner.exec("systemctl", ["--user", "show", SYSTEMD_UNIT]);
      const active = await runner.exec("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
      if (show.code !== 0 && !existsSync(paths.descriptorFile))
        return notInstalled({ stderr: show.stderr });
      if (active.stdout.trim() === "active")
        return {
          state: "running",
          installed: true,
          running: true,
          raw: parseSystemdShow(show.stdout),
        };
      if (active.stdout.trim() === "failed")
        return failedStatus({
          active: active.stdout.trim(),
          raw: parseSystemdShow(show.stdout),
          stderr: active.stderr,
        });
      return stopped({
        active: active.stdout.trim(),
        raw: parseSystemdShow(show.stdout),
        stderr: active.stderr,
      });
    },
    install: async (config) => {
      if (!serviceAvailable)
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "systemd --user is not available; install a user service manager before using caplets daemon.",
        );
      const descriptor = buildSystemdDescriptor(config);
      const commands = [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", SYSTEMD_UNIT],
      ];
      await writeDescriptorForInstall(descriptor, async () => {
        for (const command of commands)
          await assertExec(runner, command, "systemd registration failed");
      });
      return { action: "install", native: stopped(), commands, descriptor };
    },
    uninstall: async (_config, paths) => {
      if (!serviceAvailable)
        throw new CapletsError("SERVER_UNAVAILABLE", "systemd --user is not available.");
      const commands = [
        ["systemctl", "--user", "disable", SYSTEMD_UNIT],
        ["systemctl", "--user", "daemon-reload"],
      ];
      await assertExecUnless(
        runner,
        commands[0]!,
        "systemd unregister failed",
        /not loaded|not found|No such file|does not exist/iu,
      );
      rmSync(paths.descriptorFile, { force: true });
      await assertExec(runner, commands[1]!, "systemd unregister failed");
      return { action: "uninstall", native: notInstalled(), commands };
    },
    start: async () => systemdLifecycle(runner, "start", "start"),
    restart: async () => systemdLifecycle(runner, "restart", "restart"),
    stop: async () => systemdLifecycle(runner, "stop", "stop", false),
  };
}

function windowsTaskManager(runner: DaemonCommandRunner): DaemonManager {
  return {
    descriptor: buildWindowsTaskDescriptor,
    status: async (config, paths) => {
      if (!existsSync(paths.descriptorFile) && !config) return notInstalled();
      const result = await runner.exec("schtasks", [
        "/Query",
        "/TN",
        WINDOWS_TASK_NAME,
        "/FO",
        "LIST",
        "/V",
      ]);
      if (result.code !== 0)
        return existsSync(paths.descriptorFile)
          ? stopped({ stderr: result.stderr })
          : notInstalled({ stderr: result.stderr });
      const raw = parseWindowsList(result.stdout);
      const status = String(raw.Status ?? "");
      const lastRun = String(raw["Last Run Result"] ?? "");
      if (/running/iu.test(status))
        return { state: "running", installed: true, running: true, raw };
      if (lastRun && !/0x0|\b0\b/iu.test(lastRun)) return failedStatus(raw);
      return stopped(raw);
    },
    install: async (config) => {
      const descriptor = buildWindowsTaskDescriptor(config);
      const command = [
        "schtasks",
        "/Create",
        "/TN",
        WINDOWS_TASK_NAME,
        "/XML",
        descriptor.path,
        "/F",
      ];
      await writeDescriptorForInstall(descriptor, async () => {
        await assertExec(runner, command, "Scheduled Task registration failed");
      });
      return { action: "install", native: stopped(), commands: [command], descriptor };
    },
    uninstall: async (_config, paths) => {
      const command = ["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"];
      await assertExecUnless(
        runner,
        command,
        "Scheduled Task unregister failed",
        /cannot find|does not exist|not found/iu,
      );
      rmSync(paths.descriptorFile, { force: true });
      rmSync(paths.wrapperFile, { force: true });
      return { action: "uninstall", native: notInstalled(), commands: [command] };
    },
    start: async () => windowsLifecycle(runner, "start", ["/Run", "/TN", WINDOWS_TASK_NAME]),
    restart: async () => {
      await runner.exec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
      return windowsLifecycle(runner, "restart", ["/Run", "/TN", WINDOWS_TASK_NAME]);
    },
    stop: async () => {
      const command = ["schtasks", "/End", "/TN", WINDOWS_TASK_NAME];
      const result = await runner.exec(command[0]!, command.slice(1));
      if (
        result.code !== 0 &&
        !/not currently running|cannot be stopped|not running/iu.test(result.stderr)
      ) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `Scheduled Task stop failed: ${result.stderr || result.stdout || result.code}`,
        );
      }
      return { action: "stop", native: stopped(), commands: [command] };
    },
  };
}

function unsupportedManager(platform: NodeJS.Platform): DaemonManager {
  const error = () =>
    new CapletsError(
      "SERVER_UNAVAILABLE",
      `caplets daemon requires launchd, systemd --user, or Windows Scheduled Tasks; ${platform} is unsupported.`,
    );
  return {
    descriptor: () => {
      throw error();
    },
    status: async () => unavailable(error().message),
    install: async () => {
      throw error();
    },
    uninstall: async () => {
      throw error();
    },
    start: async () => {
      throw error();
    },
    restart: async () => {
      throw error();
    },
    stop: async () => {
      throw error();
    },
  };
}

function writeDescriptor(descriptor: DaemonDescriptor): void {
  mkdirSync(dirname(descriptor.path), { recursive: true, mode: 0o700 });
  writeFileSync(
    descriptor.path,
    descriptor.kind === "windows-scheduled-task" ? descriptor.xml : descriptor.contents,
    { mode: 0o600 },
  );
  if (descriptor.kind === "windows-scheduled-task") {
    mkdirSync(dirname(descriptor.wrapper.path), { recursive: true, mode: 0o700 });
    writeFileSync(descriptor.wrapper.path, descriptor.wrapper.contents, { mode: 0o700 });
  }
}

async function writeDescriptorForInstall<T>(
  descriptor: DaemonDescriptor,
  register: () => Promise<T>,
): Promise<T> {
  const backups = backupDescriptorFiles(descriptor);
  writeDescriptor(descriptor);
  try {
    return await register();
  } catch (error) {
    restoreDescriptorFiles(backups);
    throw error;
  }
}

type DescriptorBackup = { path: string; existed: boolean; contents?: Buffer };

function backupDescriptorFiles(descriptor: DaemonDescriptor): DescriptorBackup[] {
  const paths =
    descriptor.kind === "windows-scheduled-task"
      ? [descriptor.path, descriptor.wrapper.path]
      : [descriptor.path];
  return paths.map((path) => ({
    path,
    existed: existsSync(path),
    ...(existsSync(path) ? { contents: readFileSync(path) } : {}),
  }));
}

function restoreDescriptorFiles(backups: DescriptorBackup[]): void {
  for (const backup of backups) {
    if (backup.existed && backup.contents) {
      mkdirSync(dirname(backup.path), { recursive: true, mode: 0o700 });
      writeFileSync(backup.path, backup.contents);
    } else {
      rmSync(backup.path, { force: true });
    }
  }
}

async function assertExec(
  runner: DaemonCommandRunner,
  command: string[],
  message: string,
): Promise<void> {
  const result = await runner.exec(command[0]!, command.slice(1));
  if (result.code !== 0) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `${message}: ${result.stderr || result.stdout || result.code}`,
    );
  }
}

async function assertExecUnless(
  runner: DaemonCommandRunner,
  command: string[],
  message: string,
  tolerated: RegExp,
): Promise<void> {
  const result = await runner.exec(command[0]!, command.slice(1));
  if (result.code !== 0 && !tolerated.test(`${result.stderr}\n${result.stdout}`)) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `${message}: ${result.stderr || result.stdout || result.code}`,
    );
  }
}

async function launchdLifecycle(
  runner: DaemonCommandRunner,
  action: string,
  command: string[],
  running = true,
): Promise<DaemonManagerAction> {
  await assertExec(runner, command, `launchd ${action} failed`);
  return {
    action,
    native: running ? { state: "running", installed: true, running: true } : stopped(),
    commands: [command],
  };
}

async function launchdRestartLifecycle(
  runner: DaemonCommandRunner,
  domain: string,
  target: string,
  descriptorPath: string,
): Promise<DaemonManagerAction> {
  const bootout = ["launchctl", "bootout", domain, descriptorPath];
  const bootstrap = ["launchctl", "bootstrap", domain, descriptorPath];
  const kickstart = ["launchctl", "kickstart", "-k", target];
  const bootoutResult = await runner.exec(bootout[0]!, bootout.slice(1));
  if (
    bootoutResult.code !== 0 &&
    !/No such process|not found|Could not find service/iu.test(bootoutResult.stderr)
  ) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `launchd restart failed: ${bootoutResult.stderr || bootoutResult.stdout || bootoutResult.code}`,
    );
  }
  await assertExec(runner, bootstrap, "launchd restart failed");
  await assertExec(runner, kickstart, "launchd restart failed");
  return {
    action: "restart",
    native: { state: "running", installed: true, running: true },
    commands: [bootout, bootstrap, kickstart],
  };
}

async function systemdLifecycle(
  runner: DaemonCommandRunner,
  action: string,
  systemdAction: string,
  running = true,
): Promise<DaemonManagerAction> {
  const command = ["systemctl", "--user", systemdAction, SYSTEMD_UNIT];
  await assertExec(runner, command, `systemd ${action} failed`);
  return {
    action,
    native: running ? { state: "running", installed: true, running: true } : stopped(),
    commands: [command],
  };
}

async function windowsLifecycle(
  runner: DaemonCommandRunner,
  action: string,
  args: string[],
  running = true,
): Promise<DaemonManagerAction> {
  const command = ["schtasks", ...args];
  await assertExec(runner, command, `Scheduled Task ${action} failed`);
  return {
    action,
    native: running ? { state: "running", installed: true, running: true } : stopped(),
    commands: [command],
  };
}

function notInstalled(raw?: Record<string, unknown>): NativeDaemonStatus {
  return { state: "not_installed", installed: false, running: false, ...(raw ? { raw } : {}) };
}

function stopped(raw?: Record<string, unknown>): NativeDaemonStatus {
  return { state: "installed_stopped", installed: true, running: false, ...(raw ? { raw } : {}) };
}

function unavailable(message: string): NativeDaemonStatus {
  return { state: "unavailable", installed: false, running: false, message };
}

function failedStatus(raw?: Record<string, unknown>): NativeDaemonStatus {
  return { state: "failed", installed: true, running: false, ...(raw ? { raw } : {}) };
}

function runningOrStopped(
  pid: number | undefined,
  raw: Record<string, unknown>,
): NativeDaemonStatus {
  return pid === undefined
    ? stopped(raw)
    : { state: "running", installed: true, running: true, pid, raw };
}

function parseNumberMatch(value: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(value);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseSystemdShow(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/u)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function parseWindowsList(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/u)
      .map((line) => line.match(/^\s*([^:]+):\s*(.*)\s*$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1]!.trim(), match[2]!.trim()]),
  );
}

function nodeCommandRunner(): DaemonCommandRunner {
  return {
    async exec(command, args) {
      const { spawn } = await import("node:child_process");
      return await new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        let timeout: NodeJS.Timeout;
        const finish = (result: { stdout: string; stderr: string; code: number }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        };
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          finish({ stdout: "", stderr: "native service command timed out", code: 124 });
        }, 15_000);
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error) => {
          finish({ stdout: "", stderr: error.message, code: 1 });
        });
        child.on("close", (code) => {
          finish({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code: code ?? 0,
          });
        });
      });
    },
  };
}
