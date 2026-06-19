import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { CapletsError } from "../errors";
import type { DaemonOperationOptions, DaemonShellPlan } from "./types";

export function resolveDaemonShell(
  options: Pick<DaemonOperationOptions, "env" | "platform" | "accountShell">,
): DaemonShellPlan {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    const powerShell = firstExisting([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe",
    ]);
    if (powerShell) return shellPlan(platform, powerShell, "fallback");
    const comSpec = nonEmpty(env.ComSpec) ?? nonEmpty(env.COMSPEC) ?? "cmd.exe";
    return shellPlan(platform, comSpec, "fallback");
  }

  const shell = nonEmpty(env.SHELL);
  if (shell) return shellPlan(platform, shell, "SHELL");

  const accountShell = nonEmpty(options.accountShell) ?? discoverAccountShell();
  if (accountShell) return shellPlan(platform, accountShell, "account");
  if (existsSync("/bin/sh")) return shellPlan(platform, "/bin/sh", "fallback");
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "Could not resolve a user shell for --inherit-env. Set SHELL or use --no-inherit-env.",
  );
}

function shellPlan(
  platform: NodeJS.Platform,
  executable: string,
  source: DaemonShellPlan["source"],
): DaemonShellPlan {
  if (platform === "win32") {
    const lower = executable.toLocaleLowerCase();
    return lower.endsWith("powershell.exe") || lower.endsWith("pwsh.exe")
      ? { executable, args: ["-NoProfile", "-Command"], source }
      : { executable, args: ["/d", "/s", "/c"], source };
  }
  if (executable.endsWith("/sh") || executable === "sh")
    return { executable, args: ["-c"], source };
  return { executable, args: ["-lc"], source };
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function discoverAccountShell(): string | undefined {
  try {
    return nonEmpty(userInfo().shell ?? undefined);
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
