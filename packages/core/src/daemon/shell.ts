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
  const shellCommand = direct.map(shellQuote).join(" ");
  const shell = [config.command.shell.executable, ...config.command.shell.args, shellCommand];
  return {
    executable: shell[0]!,
    args: shell.slice(1),
    display: shell.map(shellQuote).join(" "),
  };
}
