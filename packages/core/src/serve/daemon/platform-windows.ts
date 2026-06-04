import type { DaemonCommandPlan, WindowsScheduledTaskDescriptor } from "./types";

export function buildWindowsScheduledTaskDescriptor(
  command: DaemonCommandPlan,
): WindowsScheduledTaskDescriptor {
  const taskName = "Caplets Serve Default";
  const taskRun = commandLine([command.executable, ...command.args]);
  return {
    kind: "windows-scheduled-task",
    taskName,
    commands: {
      register: `schtasks /Create /TN "${taskName}" /SC ONLOGON /TR "${taskRun}" /F`,
      unregister: `schtasks /Delete /TN "${taskName}" /F`,
      query: `schtasks /Query /TN "${taskName}"`,
    },
  };
}

function commandLine(args: string[]): string {
  return args.map((arg) => (arg.includes(" ") ? `\\"${arg}\\"` : arg)).join(" ");
}
