import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CapletsError } from "../src/errors";
import { resolveNativeCapletsServiceOptions } from "../src/native/options";
import { readNativeDefaults, writeNativeDefaults } from "../src/native/user-settings";

describe("resolveNativeCapletsServiceOptions", () => {
  it("defaults to local mode without remote configuration", () => {
    expect(resolveNativeCapletsServiceOptions({}, {})).toEqual({
      mode: "local",
    });
  });

  it("uses remote mode in auto when a server URL is configured", () => {
    expect(
      resolveNativeCapletsServiceOptions({}, { CAPLETS_REMOTE_URL: "http://127.0.0.1:5387" }),
    ).toMatchObject({
      mode: "remote",
      remote: {
        origin: new URL("http://127.0.0.1:5387"),
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 30_000,
      },
    });
  });

  it("uses explicit daemon mode with a credential-free loopback attach URL", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        { mode: "daemon", daemon: { url: "http://127.0.0.1:5387" } },
        {},
      ),
    ).toMatchObject({
      mode: "daemon",
      remote: {
        origin: new URL("http://127.0.0.1:5387"),
        auth: { enabled: false, user: "caplets" },
      },
    });
  });

  it("uses CAPLETS_DAEMON_URL as daemon mode when no explicit non-daemon mode is set", () => {
    expect(
      resolveNativeCapletsServiceOptions({}, { CAPLETS_DAEMON_URL: "http://127.0.0.1:5387" }),
    ).toMatchObject({
      mode: "daemon",
      remote: {
        origin: new URL("http://127.0.0.1:5387"),
        auth: { enabled: false, user: "caplets" },
      },
    });
  });

  it("uses input daemon URL as daemon mode when no explicit non-daemon mode is set", () => {
    expect(
      resolveNativeCapletsServiceOptions({ daemon: { url: "http://127.0.0.1:5387" } }, {}),
    ).toMatchObject({ mode: "daemon" });
  });

  it("rejects daemon mode URLs that are not loopback HTTP", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { mode: "daemon", daemon: { url: "http://192.0.2.10:5387" } },
        {},
      ),
    ).toThrow(/loopback/u);
  });

  it("rejects path-bearing remote and daemon origins before client I/O", () => {
    const fetchStub = () => {
      throw new Error("must not fetch");
    };
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/prefix", fetch: fetchStub } },
        {},
      ),
    ).toThrow(/origin/u);
    expect(() =>
      resolveNativeCapletsServiceOptions(
        {
          mode: "daemon",
          daemon: { url: "http://127.0.0.1:5387/prefix", fetch: fetchStub },
        },
        {},
      ),
    ).toThrow(/origin/u);
  });

  it("treats a former Cloud hostname as an ordinary remote origin", () => {
    expect(
      resolveNativeCapletsServiceOptions({}, { CAPLETS_REMOTE_URL: "https://cloud.caplets.dev" }),
    ).toMatchObject({
      mode: "remote",
      remote: {
        origin: new URL("https://cloud.caplets.dev"),
      },
    });
  });

  it("rejects the removed cloud mode", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions({}, {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
      } as Record<string, string>),
    ).toThrow(/Expected CAPLETS_MODE to be auto, local, or remote/u);
  });

  it("lets explicit local mode ignore server env vars", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        { mode: "local" },
        { CAPLETS_REMOTE_URL: "http://127.0.0.1:5387" },
      ),
    ).toEqual({ mode: "local" });
  });

  it("does not treat server hosting env vars as native remote client settings", () => {
    expect(
      resolveNativeCapletsServiceOptions({}, {
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      } as Record<string, string>),
    ).toEqual({ mode: "local" });
  });

  it("requires a URL in explicit remote mode", () => {
    expect(() => resolveNativeCapletsServiceOptions({ mode: "remote" }, {})).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects non-loopback http URLs", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions({ remote: { url: "http://caplets.example.com" } }, {}),
    ).toThrow(/loopback/u);
  });

  it("does not echo invalid credential-bearing remote URL inputs", () => {
    const rawUrl = "https://caplets:secret@exa mple.com/mcp";

    expect(() => resolveNativeCapletsServiceOptions({ remote: { url: rawUrl } }, {})).toThrowError(
      expect.not.stringContaining(rawUrl),
    );
  });

  it("rejects server URLs with embedded username or password", () => {
    for (const url of [
      "https://caplets:secret@caplets.example.com",
      "http://caplets:secret@127.0.0.1:5387",
    ]) {
      expect(() => resolveNativeCapletsServiceOptions({ remote: { url } }, {})).toThrow(
        /Current Host URL must be an HTTP\(S\) origin/u,
      );
    }
  });

  it("uses the configured remote URL without reading legacy credential env vars", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        {
          remote: {
            url: "https://configured.example.com",
          },
        },
        {
          CAPLETS_REMOTE_URL: "https://env.example.com",
          CAPLETS_REMOTE_USER: "env-user",
          CAPLETS_REMOTE_PASSWORD: ["env", "password"].join("-"),
          CAPLETS_REMOTE_TOKEN: "env-token",
        } as Record<string, string>,
      ),
    ).toMatchObject({
      mode: "remote",
      remote: {
        origin: new URL("https://configured.example.com"),
        auth: { enabled: false, user: "caplets" },
      },
    });
  });

  it("ignores removed Basic Auth fields in remote config objects", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        {
          remote: {
            url: "https://caplets.example.com",
            user: "caplets",
            password: ["remote", "password"].join("-"),
          },
        } as never,
        {},
      ),
    ).toMatchObject({
      remote: { auth: { enabled: false, user: "caplets" } },
    });
  });

  it("does not build Basic Auth request headers from removed credential fields", () => {
    const resolved = resolveNativeCapletsServiceOptions(
      {
        remote: {
          pollIntervalMs: 5_000,
          url: "https://caplets.example.com",
          user: "caplets",
          password: ["remote", "password"].join("-"),
        },
      } as never,
      {},
    );
    expect(resolved.mode).toBe("remote");
    expect(resolved.mode === "remote" ? resolved.remote.origin : undefined).toEqual(
      new URL("https://caplets.example.com"),
    );
    expect(resolved.mode === "remote" ? resolved.remote.pollIntervalMs : undefined).toBe(5_000);
    expect(
      resolved.mode === "remote" ? resolved.remote.requestInit.headers : undefined,
    ).toBeUndefined();
  });

  it("rejects invalid poll intervals", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com", pollIntervalMs: 999 } },
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com", pollIntervalMs: 1_000.5 } },
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });
});

describe("native defaults store", () => {
  it("writes and reads setup-owned daemon defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-native-defaults-"));
    const path = join(dir, "native-defaults.json");
    try {
      writeNativeDefaults(
        { daemon: { url: "http://127.0.0.1:5387" }, source: "setup" },
        { path, now: new Date("2026-06-30T00:00:00.000Z") },
      );

      expect(readNativeDefaults({ path })).toEqual({
        version: 1,
        source: "setup",
        updatedAt: "2026-06-30T00:00:00.000Z",
        daemon: { url: "http://127.0.0.1:5387" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe daemon defaults before writing settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-native-defaults-rejected-"));
    const path = join(dir, "native-defaults.json");
    try {
      for (const url of ["http://127.0.0.1:5387/prefix", "https://caplets.example.com"]) {
        expect(() => writeNativeDefaults({ daemon: { url }, source: "setup" }, { path })).toThrow(
          /loopback HTTP origin|Current Host URL/u,
        );
        expect(existsSync(path)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and ignores malformed native defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-native-defaults-bad-"));
    const path = join(dir, "native-defaults.json");
    const warnings: string[] = [];
    try {
      writeFileSync(path, "{ not json");
      expect(
        readNativeDefaults({ path, writeWarning: (message) => warnings.push(message) }),
      ).toBeUndefined();
      expect(warnings.join("\n")).toContain("Ignoring Caplets native defaults");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and ignores native defaults with non-loopback daemon URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-native-defaults-unsafe-"));
    const path = join(dir, "native-defaults.json");
    const warnings: string[] = [];
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          source: "setup",
          updatedAt: "2026-06-30T00:00:00.000Z",
          daemon: { url: "https://caplets.example.com" },
        }),
      );
      expect(
        readNativeDefaults({ path, writeWarning: (message) => warnings.push(message) }),
      ).toBeUndefined();
      expect(warnings.join("\n")).toContain("loopback HTTP origin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
