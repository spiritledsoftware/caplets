import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import {
  defaultAuthDir,
  defaultConfigBaseDir,
  defaultConfigPath,
  defaultStateBaseDir,
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
  });
});
