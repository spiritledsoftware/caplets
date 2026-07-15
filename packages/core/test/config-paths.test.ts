import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import {
  defaultAuthDir,
  defaultCapletsLockfilePath,
  defaultConfigBaseDir,
  defaultConfigPath,
  defaultStateBaseDir,
  defaultStorageArtifactDir,
  defaultStorageDatabasePath,
  defaultStorageKeyProviderManifestPath,
  defaultStorageStateDir,
  defaultUpdateCheckCacheDir,
  defaultUpdateCheckStateDir,
  resolveProjectLockfilePath,
} from "../src/config/paths";

describe("config paths", () => {
  it("uses XDG-compatible Unix defaults", () => {
    const env = {};
    const home = "/home/alex";

    expect(defaultConfigBaseDir(env, home, "linux")).toBe(posix.join(home, ".config"));
    expect(defaultStateBaseDir(env, home, "linux")).toBe(posix.join(home, ".local", "state"));
    expect(defaultConfigPath(env, home, "linux")).toBe(
      posix.join(home, ".config", "caplets", "config.json"),
    );
    expect(defaultAuthDir(env, home, "linux")).toBe(
      posix.join(home, ".local", "state", "caplets", "auth"),
    );
    expect(defaultCapletsLockfilePath(env, home, "linux")).toBe(
      posix.join(home, ".local", "state", "caplets", "caplets.lock.json"),
    );
    expect(defaultStorageStateDir(env, home, "linux")).toBe(
      posix.join(home, ".local", "state", "caplets", "control-plane"),
    );
    expect(defaultStorageDatabasePath(env, home, "linux")).toBe(
      posix.join(home, ".local", "state", "caplets", "control-plane", "control-plane.sqlite"),
    );
    expect(defaultStorageArtifactDir(env, home, "linux")).toBe(
      posix.join(home, ".local", "state", "caplets", "control-plane", "artifacts"),
    );
    expect(defaultStorageKeyProviderManifestPath(env, home, "linux")).toBe(
      posix.join(
        home,
        ".local",
        "state",
        "caplets",
        "control-plane",
        "key-provider",
        "manifests",
        "online.json",
      ),
    );
  });

  it("uses absolute Unix XDG overrides", () => {
    const env = {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_STATE_HOME: "/xdg/state",
    };

    expect(defaultConfigPath(env, "/home/alex", "darwin")).toBe(
      posix.join("/xdg/config", "caplets", "config.json"),
    );
    expect(defaultAuthDir(env, "/home/alex", "darwin")).toBe(
      posix.join("/xdg/state", "caplets", "auth"),
    );
    expect(defaultCapletsLockfilePath(env, "/home/alex", "darwin")).toBe(
      posix.join("/xdg/state", "caplets", "caplets.lock.json"),
    );
    expect(defaultStorageStateDir(env, "/home/alex", "darwin")).toBe(
      posix.join("/xdg/state", "caplets", "control-plane"),
    );
  });

  it("ignores relative Unix XDG overrides", () => {
    const env = {
      XDG_CONFIG_HOME: "relative/config",
      XDG_STATE_HOME: "relative/state",
    };
    const home = "/Users/alex";

    expect(defaultConfigPath(env, home, "darwin")).toBe(
      posix.join(home, ".config", "caplets", "config.json"),
    );
    expect(defaultAuthDir(env, home, "darwin")).toBe(
      posix.join(home, ".local", "state", "caplets", "auth"),
    );
    expect(defaultStorageStateDir(env, home, "darwin")).toBe(
      posix.join(home, ".local", "state", "caplets", "control-plane"),
    );
  });

  it("uses absolute Windows app data environment directories", () => {
    const env = {
      APPDATA: "C:\\Users\\Alex\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Alex\\AppData\\Local",
    };

    expect(defaultConfigPath(env, "C:\\Users\\Alex", "win32")).toBe(
      win32.join(env.APPDATA, "caplets", "config.json"),
    );
    expect(defaultAuthDir(env, "C:\\Users\\Alex", "win32")).toBe(
      win32.join(env.LOCALAPPDATA, "caplets", "auth"),
    );
    expect(defaultCapletsLockfilePath(env, "C:\\Users\\Alex", "win32")).toBe(
      win32.join(env.LOCALAPPDATA, "caplets", "caplets.lock.json"),
    );
    expect(defaultStorageStateDir(env, "C:\\Users\\Alex", "win32")).toBe(
      win32.join(env.LOCALAPPDATA, "caplets", "control-plane"),
    );
  });

  it("falls back to Windows home app data directories when env vars are missing or relative", () => {
    const env = {
      APPDATA: "AppData\\Roaming",
      LOCALAPPDATA: "AppData\\Local",
    };
    const home = "C:\\Users\\Alex";

    expect(defaultConfigPath(env, home, "win32")).toBe(
      win32.join(home, "AppData", "Roaming", "caplets", "config.json"),
    );
    expect(defaultAuthDir({}, home, "win32")).toBe(
      win32.join(home, "AppData", "Local", "caplets", "auth"),
    );
    expect(defaultAuthDir(env, home, "win32")).toBe(
      win32.join(home, "AppData", "Local", "caplets", "auth"),
    );
    expect(defaultCapletsLockfilePath(env, home, "win32")).toBe(
      win32.join(home, "AppData", "Local", "caplets", "caplets.lock.json"),
    );
  });

  it("resolves project lockfiles next to the project root instead of inside .caplets", () => {
    expect(resolveProjectLockfilePath("/workspace/project")).toBe(
      posix.join("/workspace/project", ".caplets.lock.json"),
    );
  });

  it("uses Caplets-owned update-check state and cache directories", () => {
    expect(defaultUpdateCheckStateDir({}, "/home/alex", "linux")).toBe(
      posix.join("/home/alex", ".local", "state", "caplets", "update-check"),
    );
    expect(defaultUpdateCheckCacheDir({}, "/home/alex", "linux")).toBe(
      posix.join("/home/alex", ".cache", "caplets", "update-check"),
    );
    expect(defaultUpdateCheckCacheDir({}, "/Users/alex", "darwin")).toBe(
      posix.join("/Users/alex", "Library", "Caches", "caplets", "update-check"),
    );
    expect(defaultUpdateCheckCacheDir({}, "C:\\Users\\Alex", "win32")).toBe(
      win32.join("C:\\Users\\Alex", "AppData", "Local", "caplets", "cache", "update-check"),
    );
  });
});
