import { escapeXml } from "./xml";
import { serviceCommand } from "./shell";
import type { DaemonConfig, DaemonDescriptor } from "./types";

export const LAUNCHD_LABEL = "dev.caplets.daemon.default";

export function buildLaunchdDescriptor(config: DaemonConfig): DaemonDescriptor {
  const command = [serviceCommand(config).executable, ...serviceCommand(config).args].map(
    escapeXml,
  );
  return {
    kind: "launchd-user-agent",
    label: LAUNCHD_LABEL,
    path: config.paths.descriptorFile,
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((value) => `    <string>${value}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(config.command.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.paths.stderrLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(config.command.env)
  .map(
    ([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
  )
  .join("\n")}
  </dict>
</dict>
</plist>
`,
  };
}
