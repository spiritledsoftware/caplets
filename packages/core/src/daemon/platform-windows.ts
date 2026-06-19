import { CapletsError } from "../errors";
import type { DaemonConfig, DaemonDescriptor } from "./types";
import { escapeXml } from "./xml";
import { serviceCommand } from "./shell";

export const WINDOWS_TASK_NAME = "\\Caplets\\daemon-default";

export function buildWindowsTaskDescriptor(config: DaemonConfig): DaemonDescriptor {
  const planned = serviceCommand(config);
  const command = [planned.executable, ...planned.args].map(windowsArg).join(" ");
  const wrapper = {
    path: config.paths.wrapperFile,
    contents: `@echo off\r
cd /d ${windowsArg(config.command.workingDirectory)}\r
${Object.entries(config.command.env)
  .map(([key, value]) => `set "${key}=${windowsEnvValue(value)}"\r`)
  .join(
    "",
  )}${command} >> ${windowsArg(config.paths.stdoutLog)} 2>> ${windowsArg(config.paths.stderrLog)}\r
`,
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(wrapper.path)}</Command><WorkingDirectory>${escapeXml(config.command.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>
`;
  return {
    kind: "windows-scheduled-task",
    taskName: WINDOWS_TASK_NAME,
    path: config.paths.descriptorFile,
    command,
    xml,
    wrapper,
  };
}

function windowsArg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function windowsEnvValue(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Windows daemon environment values cannot contain CR or LF characters.",
    );
  }
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}
