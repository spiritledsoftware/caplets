import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { defaultConfigBaseDir, defaultStateBaseDir } from "../../config/paths";
import type { ServeDaemonOperationOptions, ServeDaemonPaths } from "./types";

export function resolveServeDaemonPaths(
  options: Pick<ServeDaemonOperationOptions, "env" | "home" | "platform"> = {},
): ServeDaemonPaths {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const configBase = defaultConfigBaseDir(env as NodeJS.ProcessEnv, home, platform);
  const stateBase = defaultStateBaseDir(env as NodeJS.ProcessEnv, home, platform);

  if (platform === "win32") {
    const stateDir = path.join(stateBase, "Caplets", "State", "serve", "default");
    const logDir = path.join(stateDir, "logs");
    return {
      instance: "default",
      stateDir,
      logDir,
      stateFile: path.join(stateDir, "state.json"),
      pidFile: path.join(stateDir, "server.pid"),
      stdoutLog: path.join(logDir, "stdout.log"),
      stderrLog: path.join(logDir, "stderr.log"),
      configFile: path.join(configBase, "Caplets", "serve", "default.json"),
    };
  }

  const stateDir = path.join(stateBase, "caplets", "serve", "default");
  const logDir = path.join(stateDir, "logs");
  return {
    instance: "default",
    stateDir,
    logDir,
    stateFile: path.join(stateDir, "state.json"),
    pidFile: path.join(stateDir, "server.pid"),
    stdoutLog: path.join(logDir, "stdout.log"),
    stderrLog: path.join(logDir, "stderr.log"),
    configFile: path.join(configBase, "caplets", "serve", "default.json"),
  };
}

export function daemonServiceDescriptorPath(
  paths: ServeDaemonPaths,
  platform: NodeJS.Platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  if (platform === "darwin") {
    return path.join(
      dirname(dirname(paths.configFile)),
      "launchd",
      "dev.caplets.serve.default.plist",
    );
  }
  if (platform === "linux") {
    return path.join(
      dirname(dirname(paths.configFile)),
      "systemd",
      "user",
      "caplets-serve-default.service",
    );
  }
  return paths.configFile;
}
