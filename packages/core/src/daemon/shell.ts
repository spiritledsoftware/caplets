import { CapletsError } from "../errors";

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function serviceCommand(config: {
  command: {
    executable: string;
    args: string[];
    env?: Record<string, string>;
    shell?: { executable: string; args: string[] };
  };
}): { executable: string; args: string[]; display: string } {
  const direct = [config.command.executable, ...config.command.args];
  if (!config.command.shell) {
    return {
      executable: direct[0]!,
      args: direct.slice(1),
      display: direct.map(shellQuote).join(" "),
    };
  }
  const shellCommand = shellCommandLine(config.command.shell, direct, config.command.env ?? {});
  const shell = [config.command.shell.executable, ...config.command.shell.args, shellCommand];
  return {
    executable: shell[0]!,
    args: shell.slice(1),
    display: shell.map(shellQuote).join(" "),
  };
}

export function shellCommandLine(
  shell: { executable: string; args: string[] },
  argv: string[],
  env: Record<string, string> = {},
): string {
  if (isPowerShell(shell)) {
    const exports = Object.entries(env)
      .map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
      .join("; ");
    return [exports, `& ${argv.map(powerShellQuote).join(" ")}`].filter(Boolean).join("; ");
  }
  if (isCmd(shell)) {
    const exports = Object.entries(env)
      .map(([key, value]) => `set "${key}=${cmdEnvValue(value)}"`)
      .join("&& ");
    return [exports, argv.map(cmdQuote).join(" ")].filter(Boolean).join("&& ");
  }
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("; ");
  return [exports, `exec ${argv.map(shellQuote).join(" ")}`].filter(Boolean).join("; ");
}

function isPowerShell(shell: { executable: string }): boolean {
  const executable = shell.executable.replaceAll("\\", "/").toLocaleLowerCase();
  return executable.endsWith("/powershell.exe") || executable.endsWith("/pwsh.exe");
}

function isCmd(shell: { executable: string; args: string[] }): boolean {
  const executable = shell.executable.replaceAll("\\", "/").toLocaleLowerCase();
  const executableName = executable.split("/").at(-1) ?? executable;
  const isCmdExe = executableName === "cmd.exe" || executableName === "cmd";
  return isCmdExe && shell.args.some((arg) => arg.toLocaleLowerCase() === "/c");
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function cmdEnvValue(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      'Windows daemon environment values used with cmd.exe cannot contain ", CR, or LF characters.',
    );
  }
  return value.replaceAll("%", "%%");
}
