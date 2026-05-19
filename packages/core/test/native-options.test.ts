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

  it("uses remote mode in auto when a remote URL is configured", () => {
    expect(
      resolveNativeCapletsServiceOptions({}, { CAPLETS_REMOTE_URL: "http://127.0.0.1:5387/mcp" }),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("http://127.0.0.1:5387/mcp"),
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 30_000,
      },
    });
  });

  it("lets explicit local mode ignore remote env vars", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        { mode: "local" },
        { CAPLETS_REMOTE_URL: "http://127.0.0.1:5387/mcp" },
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
      resolveNativeCapletsServiceOptions({ remote: { url: "http://caplets.example.com/mcp" } }, {}),
    ).toThrow(/https/u);
  });

  it("lets config override env vars", () => {
    const configPassword = ["config", "password"].join("-");
    expect(
      resolveNativeCapletsServiceOptions(
        {
          remote: {
            url: "https://configured.example.com/mcp",
            user: "configured",
            password: configPassword,
          },
        },
        {
          CAPLETS_REMOTE_URL: "https://env.example.com/mcp",
          CAPLETS_REMOTE_USER: "env-user",
          CAPLETS_REMOTE_PASSWORD: ["env", "password"].join("-"),
        },
      ),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("https://configured.example.com/mcp"),
        auth: { enabled: true, user: "configured", password: configPassword },
      },
    });
  });

  it("defaults Basic Auth user when password exists", () => {
    const password = ["remote", "password"].join("-");
    expect(
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/mcp", password } },
        {},
      ),
    ).toMatchObject({
      remote: { auth: { enabled: true, user: "caplets", password } },
    });
  });

  it("rejects user without password", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/mcp", user: "caplets" } },
        {},
      ),
    ).toThrow(/requires a password/u);
  });

  it("builds request headers without logging credentials", () => {
    const password = ["remote", "password"].join("-");
    const resolved = resolveNativeCapletsServiceOptions(
      {
        remote: {
          url: "https://caplets.example.com/mcp",
          user: "caplets",
          password,
        },
      },
      {},
    );
    expect(resolved.mode).toBe("remote");
    expect(resolved.mode === "remote" ? resolved.remote.requestInit.headers : undefined).toEqual({
      Authorization: `Basic ${Buffer.from(`caplets:${password}`).toString("base64")}`,
    });
  });

  it("rejects invalid poll intervals", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/mcp", pollIntervalMs: 999 } },
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/mcp", pollIntervalMs: 1_000.5 } },
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });
});
