import { serviceCommand } from "./shell";
import type { DaemonConfig, DaemonDescriptor } from "./types";

export const SYSTEMD_UNIT = "caplets-daemon-default.service";

export function buildSystemdDescriptor(config: DaemonConfig): DaemonDescriptor {
  const command = serviceCommand(config);
  const env = Object.entries(config.command.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`, false)}`)
    .join("\n");
  return {
    kind: "systemd-user",
    unitName: SYSTEMD_UNIT,
    path: config.paths.descriptorFile,
    contents: `[Unit]
Description=Caplets daemon

[Service]
Type=simple
WorkingDirectory=${systemdEscape(config.command.workingDirectory, true)}
${env ? `${env}\n` : ""}ExecStart=${[command.executable, ...command.args].map((value) => systemdQuote(value)).join(" ")}
Restart=on-failure
StandardOutput=append:${systemdEscape(config.paths.stdoutLog, true)}
StandardError=append:${systemdEscape(config.paths.stderrLog, true)}

[Install]
WantedBy=default.target
`,
  };
}

function systemdQuote(value: string, escapeDollar = true): string {
  return `"${systemdEscape(value, escapeDollar)}"`;
}

function systemdEscape(value: string, escapeDollar: boolean): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  return escapeDollar ? escaped.replaceAll("$", "$$$$") : escaped;
}
