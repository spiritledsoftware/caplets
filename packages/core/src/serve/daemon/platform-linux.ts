import type {
  DaemonCommandPlan,
  ManualServiceDescriptor,
  ServeDaemonPaths,
  SystemdUserServiceDescriptor,
} from "./types";

export function buildLinuxServiceDescriptor(
  paths: ServeDaemonPaths,
  command: DaemonCommandPlan,
  serviceAvailable = true,
): SystemdUserServiceDescriptor | ManualServiceDescriptor {
  if (!serviceAvailable) {
    return {
      kind: "manual",
      reason: "Linux systemd user service is not available; run the daemon command manually.",
      command,
    };
  }

  return {
    kind: "systemd-user",
    unitName: "caplets-serve-default.service",
    path: `${paths.configFile}.service`,
    unit: [
      "[Unit]",
      "Description=Caplets HTTP daemon (default)",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${shellJoin([command.executable, ...command.args])}`,
      "Restart=on-failure",
      `StandardOutput=append:${paths.stdoutLog}`,
      `StandardError=append:${paths.stderrLog}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  };
}

function shellJoin(args: string[]): string {
  return args
    .map((arg) => (/^[A-Za-z0-9_./:=@-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
}
