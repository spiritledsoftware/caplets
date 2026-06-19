import { describe, expect, it } from "vitest";

import type { CapletsError } from "../src/errors";
import { resolveNativeCapletsServiceOptions } from "../src/native/options";

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
        url: new URL("http://127.0.0.1:5387/v1/attach"),
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 30_000,
      },
    });
  });

  it("uses cloud mode in auto when CAPLETS_REMOTE_URL points at Caplets Cloud", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        {},
        {
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_REMOTE_WORKSPACE: "personal",
        },
      ),
    ).toMatchObject({
      mode: "cloud",
      remote: {
        url: new URL("https://cloud.caplets.dev/v1/ws/personal/attach"),
      },
    });
  });

  it("rejects cloud mode without a workspace", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        {},
        {
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        },
      ),
    ).toThrow(/workspace/u);
  });

  it("uses cloud mode when CAPLETS_MODE=cloud is explicit", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        {},
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_REMOTE_WORKSPACE: "personal",
        },
      ),
    ).toMatchObject({ mode: "cloud" });
  });

  it("rejects CAPLETS_MODE=cloud with a self-hosted remote URL", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        {},
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        },
      ),
    ).toThrow(/Caplets Cloud/u);
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
    ).toThrow(/https/u);
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
        /must not include username, password, query string, or fragment/u,
      );
    }
  });

  it("uses the configured remote URL without reading legacy credential env vars", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        {
          remote: {
            url: "https://configured.example.com/caplets",
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
        url: new URL("https://configured.example.com/caplets/v1/attach"),
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
          url: "https://caplets.example.com/caplets",
          user: "caplets",
          password: ["remote", "password"].join("-"),
        },
      } as never,
      {},
    );
    expect(resolved.mode).toBe("remote");
    expect(resolved.mode === "remote" ? resolved.remote.url : undefined).toEqual(
      new URL("https://caplets.example.com/caplets/v1/attach"),
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
