import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { defaultConfigBaseDir, defaultStateBaseDir } from "../config/paths";
import type { DaemonOperationOptions, DaemonPaths } from "./types";

export function resolveDaemonPaths(
  options: Pick<DaemonOperationOptions, "env" | "home" | "platform"> = {},
): DaemonPaths {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const configBase = defaultConfigBaseDir(env as NodeJS.ProcessEnv, home, platform);
  const stateBase = defaultStateBaseDir(env as NodeJS.ProcessEnv, home, platform);

  if (platform === "win32") {
    const stateDir = path.join(stateBase, "Caplets", "State", "daemon", "default");
    const logDir = path.join(stateDir, "logs");
    return {
      instance: "default",
      stateDir,
      logDir,
      stateFile: path.join(stateDir, "state.json"),
      stdoutLog: path.join(logDir, "stdout.log"),
      stderrLog: path.join(logDir, "stderr.log"),
      configFile: path.join(configBase, "Caplets", "daemon", "default.json"),
      descriptorFile: path.join(configBase, "Caplets", "daemon", "default-task.xml"),
      wrapperFile: path.join(stateDir, "caplets-daemon-default.cmd"),
    };
  }

  const stateDir = path.join(stateBase, "caplets", "daemon", "default");
  const logDir = path.join(stateDir, "logs");
  const descriptorFile =
    platform === "darwin"
      ? path.join(home, "Library", "LaunchAgents", "dev.caplets.daemon.default.plist")
      : path.join(configBase, "systemd", "user", "caplets-daemon-default.service");
  return {
    instance: "default",
    stateDir,
    logDir,
    stateFile: path.join(stateDir, "state.json"),
    stdoutLog: path.join(logDir, "stdout.log"),
    stderrLog: path.join(logDir, "stderr.log"),
    configFile: path.join(configBase, "caplets", "daemon", "default.json"),
    descriptorFile,
    wrapperFile: path.join(stateDir, "caplets-daemon-default.sh"),
  };
}
