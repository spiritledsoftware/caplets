---
title: Native Daemon Management Belongs Behind an Install-Time Service Contract
date: 2026-06-19
category: architecture-patterns
module: Caplets daemon
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "Moving a foreground CLI server into a native per-user service"
  - "Service install flags persist configuration but runtime lifecycle commands should not mutate it"
  - "Supporting launchd, systemd user services, and Windows Scheduled Tasks from one CLI surface"
tags: [daemon, native-services, launchd, systemd, scheduled-tasks, cli]
---

# Native Daemon Management Belongs Behind an Install-Time Service Contract

## Context

The Caplets daemon work moved lifecycle management out of `caplets serve` and into a top-level `caplets daemon` surface. Foreground `serve` remains the process entrypoint, while `daemon install` writes persistent service configuration and registers a per-user native service through launchd, systemd user services, or Windows Scheduled Tasks.

The product requirement looked simple at first: create `install`, `start`, `restart`, `stop`, `uninstall`, `status`, and `logs`. The hard part was that each command has different ownership. `install` is allowed to mutate service configuration, descriptors, environment settings, validation behavior, and optional restart decisions. Runtime lifecycle commands should only operate on the already-installed service. Session history also surfaced review failures when this boundary was blurred: partial registration could leave stale artifacts, platform descriptors could misquote commands, and launchd could report an already-loaded job while still running the old descriptor.

## Guidance

Model the daemon as an install-time service contract, not as a detached variant of the foreground server.

The public CLI should expose daemon lifecycle under the daemon noun:

```text
caplets daemon install
caplets daemon uninstall
caplets daemon start
caplets daemon restart
caplets daemon stop
caplets daemon status
caplets daemon logs
```

Keep `caplets serve` focused on foreground serving. If old daemon subcommands existed under `serve`, leave migration guidance there, but do not keep a second daemon implementation alive.

Separate configuration mutation from lifecycle mutation:

```ts
// install owns config merge, validation, descriptor writing, and registration
await installDaemon({
  host,
  port,
  env,
  inheritEnv,
  start,
  restart,
  noRestart,
});

// lifecycle commands only read the installed service
await startDaemon();
await restartDaemon();
await stopDaemon();
```

Build a native manager seam that normalizes the service lifecycle while preserving raw platform details for troubleshooting:

```ts
type NativeDaemonStatus = {
  state: "not_installed" | "installed_stopped" | "running" | "failed" | "unavailable" | "unknown";
  installed: boolean;
  running: boolean;
  pid?: number;
  message?: string;
  raw?: Record<string, unknown>;
};

type DaemonManager = {
  descriptor(config: DaemonConfig): DaemonDescriptor;
  install(config: DaemonConfig): Promise<DaemonManagerAction>;
  uninstall(config: DaemonConfig | undefined, paths: DaemonPaths): Promise<DaemonManagerAction>;
  start(config: DaemonConfig): Promise<DaemonManagerAction>;
  restart(config: DaemonConfig): Promise<DaemonManagerAction>;
  stop(config: DaemonConfig): Promise<DaemonManagerAction>;
  status(config: DaemonConfig | undefined, paths: DaemonPaths): Promise<NativeDaemonStatus>;
};
```

Treat native registration as transactional. Write descriptor artifacts before invoking the native manager, but back them up and restore them if registration fails. Only write installed Caplets config/state after the native install succeeds. This avoids claiming the daemon is installed when the OS service manager rejected it.

Render service commands as argv for each platform, not as a reused display string. The managed process may still invoke `caplets serve --transport http` internally, but public `daemon install` should not accept `--transport` because the daemon is intentionally HTTP-only. Quote descriptors per platform:

- systemd units need escaped `%`, quotes, backslashes, and newlines in `Environment=`, `WorkingDirectory=`, and `ExecStart=`.
- Windows Scheduled Tasks need a wrapper when argument handling, working directory, and file-backed logs cannot be represented safely in the task XML alone.
- launchd restart/update needs an explicit reload path, such as `bootout`, `bootstrap`, then `kickstart`, when a changed plist must become active.

Make logs file-backed and manager-independent. Service descriptors or wrappers should redirect stdout and stderr into Caplets-managed files, and `caplets daemon logs` should read those files with tail-like options. This keeps logs readable after uninstall when logs are preserved.

## Why This Matters

Native service managers are not interchangeable process launchers. launchd has loaded-job semantics, systemd unit files have their own quoting rules, and Windows Scheduled Tasks are XML plus command-line interpretation. A daemon abstraction that hides all platform detail too early will either lose useful status information or silently produce descriptors that pass validation but fail after installation.

The install/lifecycle split also protects user intent. Users expect `install --env FOO=bar --inherit-env --port 5388` to change persistent service configuration. They do not expect `start` or `restart` to change those values. Keeping that boundary strict makes failures easier to explain: if the service is missing, lifecycle commands fail with the install command; if the config changed while running, install updates the service and then requires an explicit restart decision.

## When to Apply

- Use this pattern when a CLI has both a foreground server mode and a persistent daemon/service mode.
- Use it when service configuration must survive terminal exits and login restarts.
- Use it when more than one native service manager must be supported behind one command surface.
- Use it when shell environment inheritance is product behavior, not an incidental launcher detail.
- Do not use this pattern for one-off detached processes that are intentionally not managed by the operating system.

## Examples

Fail closed on transport selection at the daemon boundary:

```ts
export function resolveDaemonHttpServeOptions(raw: RawDaemonServeOptions): HttpServeOptions {
  if ((raw as RawServeOptions).transport !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "caplets daemon install does not accept --transport.",
    );
  }

  return resolveServeOptions({ ...raw, transport: "http" }) as HttpServeOptions;
}
```

Make lifecycle commands read the installed service and verify health after native start/restart:

```ts
async function daemonLifecycle(
  action: "start" | "restart" | "stop",
  options: DaemonOperationOptions,
) {
  const config = readDaemonConfig(paths);
  if (!config || !existsSync(paths.descriptorFile)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplets daemon is not installed. Run caplets daemon install${action === "stop" ? "" : " --start"} first.`,
    );
  }

  const before = await manager.status(config, paths);
  const effectiveAction = action === "start" && before.running ? "restart" : action;
  const native = await runNativeLifecycle(effectiveAction, config);
  const status = await daemonStatus({ ...options, manager });

  if (effectiveAction !== "stop") {
    assertDaemonHealth(status.health, "Native daemon health check");
  }

  return { action: effectiveAction, native, status };
}
```

Regression coverage should include the platform behaviors that are easiest to miss:

```ts
it("rolls back descriptor artifacts when native registration fails", async () => {
  await expect(installDaemon({}, { manager: failingManager })).rejects.toThrow(
    /registration failed/u,
  );

  expect(readDaemonConfig(paths)).toBeUndefined();
  expect(readFileSync(paths.descriptorFile, "utf8")).toBe(previousDescriptor);
});

it("reloads launchd descriptors before restart", async () => {
  await restartDaemon(options);

  expect(commands).toContainEqual(["launchctl", "bootout", "gui/501", descriptorPath]);
  expect(commands).toContainEqual(["launchctl", "bootstrap", "gui/501", descriptorPath]);
  expect(commands).toContainEqual([
    "launchctl",
    "kickstart",
    "-k",
    "gui/501/dev.caplets.daemon.default",
  ]);
});
```

## Related

- [Caplets daemon service requirements](../../brainstorms/2026-06-19-caplets-daemon-service-requirements.md)
- [Caplets daemon implementation plan](../../plans/2026-06-19-001-feat-caplets-daemon-service-plan.md)
