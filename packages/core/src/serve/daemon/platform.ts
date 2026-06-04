import { buildLaunchdUserAgentDescriptor } from "./platform-darwin";
import { buildLinuxServiceDescriptor } from "./platform-linux";
import { buildWindowsScheduledTaskDescriptor } from "./platform-windows";
import type { DaemonCommandPlan, DaemonPlatformDescriptor, ServeDaemonPaths } from "./types";

export type BuildDaemonPlatformDescriptorOptions = {
  platform?: NodeJS.Platform;
  serviceAvailable?: boolean;
  paths: ServeDaemonPaths;
  command: DaemonCommandPlan;
};

export function buildDaemonPlatformDescriptor(
  options: BuildDaemonPlatformDescriptorOptions,
): DaemonPlatformDescriptor {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return buildLaunchdUserAgentDescriptor(options.paths, options.command);
  }
  if (platform === "linux") {
    return buildLinuxServiceDescriptor(options.paths, options.command, options.serviceAvailable);
  }
  if (platform === "win32") {
    return buildWindowsScheduledTaskDescriptor(options.command);
  }
  return {
    kind: "manual",
    reason: `Automatic user service descriptors are not available on ${platform}.`,
    command: options.command,
  };
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
