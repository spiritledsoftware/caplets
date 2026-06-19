import { serviceCommand } from "./shell";
import type { DaemonConfig, DaemonDescriptor } from "./types";

export const SYSTEMD_UNIT = "caplets-daemon-default.service";

export function buildSystemdDescriptor(config: DaemonConfig): DaemonDescriptor {
  const command = serviceCommand(config);
  const env = Object.entries(config.command.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return {
    kind: "systemd-user",
    unitName: SYSTEMD_UNIT,
    path: config.paths.descriptorFile,
    contents: `[Unit]
Description=Caplets daemon

[Service]
Type=simple
WorkingDirectory=${systemdQuote(config.command.workingDirectory)}
${env ? `${env}\n` : ""}ExecStart=${[command.executable, ...command.args].map(systemdQuote).join(" ")}
Restart=on-failure
StandardOutput=append:${systemdEscape(config.paths.stdoutLog)}
StandardError=append:${systemdEscape(config.paths.stderrLog)}

[Install]
WantedBy=default.target
`,
  };
}

function systemdQuote(value: string): string {
  return `"${systemdEscape(value)}"`;
}

function systemdEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n");
}
