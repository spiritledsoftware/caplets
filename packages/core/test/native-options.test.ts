import { Buffer } from "node:buffer";
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
      resolveNativeCapletsServiceOptions({}, { CAPLETS_SERVER_URL: "http://127.0.0.1:5387" }),
    ).toEqual({ mode: "local" });
  });

  it("requires a URL in explicit remote mode", () => {
    expect(() => resolveNativeCapletsServiceOptions({ mode: "remote" }, {})).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects non-loopback http URLs", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions({ server: { url: "http://caplets.example.com" } }, {}),
    ).toThrow(/https/u);
  });

  it("does not echo invalid credential-bearing remote URL inputs", () => {
    const rawUrl = "https://caplets:secret@exa mple.com/mcp";

    expect(() => resolveNativeCapletsServiceOptions({ server: { url: rawUrl } }, {})).toThrowError(
      expect.not.stringContaining(rawUrl),
    );
  });

  it("rejects server URLs with embedded username or password", () => {
    for (const url of [
      "https://caplets:secret@caplets.example.com",
      "http://caplets:secret@127.0.0.1:5387",
    ]) {
      expect(() => resolveNativeCapletsServiceOptions({ server: { url } }, {})).toThrow(
        /must not include username, password, query string, or fragment/u,
      );
    }
  });

  it("lets config override env vars", () => {
    const configPassword = ["config", "password"].join("-");
    expect(
      resolveNativeCapletsServiceOptions(
        {
          server: {
            url: "https://configured.example.com/caplets",
            user: "configured",
            password: configPassword,
          },
        },
        {
          CAPLETS_REMOTE_URL: "https://env.example.com",
          CAPLETS_REMOTE_USER: "env-user",
          CAPLETS_REMOTE_PASSWORD: ["env", "password"].join("-"),
        },
      ),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("https://configured.example.com/caplets/v1/attach"),
        auth: { enabled: true, user: "configured", password: configPassword },
      },
    });
  });

  it("defaults Basic Auth user when password exists", () => {
    const password = ["remote", "password"].join("-");
    expect(
      resolveNativeCapletsServiceOptions(
        { server: { url: "https://caplets.example.com", password } },
        {},
      ),
    ).toMatchObject({
      remote: { auth: { enabled: true, user: "caplets", password } },
    });
  });

  it("rejects user without password", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { server: { url: "https://caplets.example.com", user: "caplets" } },
        {},
      ),
    ).toThrow(/requires a password/u);
  });

  it("builds request headers without logging credentials", () => {
    const password = ["remote", "password"].join("-");
    const resolved = resolveNativeCapletsServiceOptions(
      {
        remote: {
          pollIntervalMs: 5_000,
        },
        server: {
          url: "https://caplets.example.com/caplets",
          user: "caplets",
          password,
        },
      },
      {},
    );
    expect(resolved.mode).toBe("remote");
    expect(resolved.mode === "remote" ? resolved.remote.url : undefined).toEqual(
      new URL("https://caplets.example.com/caplets/v1/attach"),
    );
    expect(resolved.mode === "remote" ? resolved.remote.pollIntervalMs : undefined).toBe(5_000);
    expect(resolved.mode === "remote" ? resolved.remote.requestInit.headers : undefined).toEqual({
      Authorization: `Basic ${Buffer.from(`caplets:${password}`).toString("base64")}`,
    });
  });

  it("rejects invalid poll intervals", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { server: { url: "https://caplets.example.com" }, remote: { pollIntervalMs: 999 } },
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

    expect(() =>
      resolveNativeCapletsServiceOptions(
        { server: { url: "https://caplets.example.com" }, remote: { pollIntervalMs: 1_000.5 } },
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });
});
