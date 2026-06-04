import { escapeXml } from "./platform";
import type { DaemonCommandPlan, LaunchdUserAgentDescriptor, ServeDaemonPaths } from "./types";

export function buildLaunchdUserAgentDescriptor(
  paths: ServeDaemonPaths,
  command: DaemonCommandPlan,
): LaunchdUserAgentDescriptor {
  const label = "dev.caplets.serve.default";
  return {
    kind: "launchd-user-agent",
    label,
    path: `${paths.configFile}.plist`,
    plist: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>${label}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      `    <string>${escapeXml(command.executable)}</string>`,
      ...command.args.map((arg) => `    <string>${escapeXml(arg)}</string>`),
      "  </array>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      "  <true/>",
      "  <key>StandardOutPath</key>",
      `  <string>${escapeXml(paths.stdoutLog)}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${escapeXml(paths.stderrLog)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  };
}
