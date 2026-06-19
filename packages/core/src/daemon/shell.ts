export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function serviceCommand(config: {
  command: {
    executable: string;
    args: string[];
    shell?: { executable: string; args: string[] };
  };
}): { executable: string; args: string[]; display: string } {
  const direct = [process.execPath, config.command.executable, ...config.command.args];
  if (!config.command.shell) {
    return {
      executable: direct[0]!,
      args: direct.slice(1),
      display: direct.map(shellQuote).join(" "),
    };
  }
  const shellCommand = shellCommandLine(config.command.shell, direct);
  const shell = [config.command.shell.executable, ...config.command.shell.args, shellCommand];
  return {
    executable: shell[0]!,
    args: shell.slice(1),
    display: shell.map(shellQuote).join(" "),
  };
}

function shellCommandLine(shell: { executable: string; args: string[] }, argv: string[]): string {
  if (isPowerShell(shell)) return `& ${argv.map(powerShellQuote).join(" ")}`;
  if (isCmd(shell)) return argv.map(cmdQuote).join(" ");
  return argv.map(shellQuote).join(" ");
}

function isPowerShell(shell: { executable: string }): boolean {
  const executable = shell.executable.replaceAll("\\", "/").toLocaleLowerCase();
  return executable.endsWith("/powershell.exe") || executable.endsWith("/pwsh.exe");
}

function isCmd(shell: { executable: string; args: string[] }): boolean {
  const executable = shell.executable.replaceAll("\\", "/").toLocaleLowerCase();
  return executable.endsWith("/cmd.exe") || executable === "cmd.exe" || shell.args.includes("/c");
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}
