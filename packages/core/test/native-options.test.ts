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
      resolveNativeCapletsServiceOptions({}, { CAPLETS_SERVER_URL: "http://127.0.0.1:5387" }),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("http://127.0.0.1:5387/mcp"),
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 30_000,
      },
    });
  });

  it("lets explicit local mode ignore server env vars", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        { mode: "local" },
        { CAPLETS_SERVER_URL: "http://127.0.0.1:5387" },
      ),
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
          CAPLETS_SERVER_URL: "https://env.example.com",
          CAPLETS_SERVER_USER: "env-user",
          CAPLETS_SERVER_PASSWORD: ["env", "password"].join("-"),
        },
      ),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("https://configured.example.com/caplets/mcp"),
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
      new URL("https://caplets.example.com/caplets/mcp"),
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
