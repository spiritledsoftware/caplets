import { describe, expect, it } from "vitest";

import { CapletsError } from "../src/errors";
import { RemoteControlClient } from "../src/remote-control/client";
import type { RemoteCliRequest } from "../src/remote-control/types";

const _requestArguments: RemoteCliRequest["arguments"] = {} satisfies Record<string, unknown>;

describe("RemoteControlClient", () => {
  it("posts a structured request to the derived control endpoint with configured headers", async () => {
    const requests: Array<{ input: Parameters<typeof fetch>[0]; init: RequestInit | undefined }> =
      [];
    const fetchStub: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return Response.json({ ok: true, result: { caplets: ["github"] } });
    };
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com/caplets"),
      requestInit: { headers: { Authorization: "Basic fixture-secret" } },
      fetch: fetchStub,
    });

    await expect(client.request("list", { verbose: true })).resolves.toEqual({
      caplets: ["github"],
    });

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe("https://example.com/caplets/v1/admin");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ command: "list", arguments: { verbose: true } }),
    });
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Basic fixture-secret",
    );
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("maps control error payloads to CapletsError", async () => {
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com"),
      requestInit: {},
      fetch: async () =>
        Response.json({
          ok: false,
          error: {
            code: "TOOL_NOT_FOUND",
            message: "Tool missing",
            nextAction: "run_caplets_list_tools",
          },
        }),
    });

    await expect(client.request("describe_tool", { name: "missing" })).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
      message: "Tool missing",
      details: { nextAction: "run_caplets_list_tools" },
    });
  });

  it("throws a safe auth error for 401 without leaking credentials", async () => {
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com/caplets"),
      requestInit: { headers: { Authorization: "Basic super-secret" } },
      fetch: async () => new Response("nope super-secret", { status: 401 }),
    });

    await expect(client.request("list", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message:
        "Caplets remote authentication failed. Run caplets remote login https://example.com/caplets.",
    });

    try {
      await client.request("list", {});
    } catch (error) {
      expect(error).toBeInstanceOf(CapletsError);
      expect(String(error)).not.toContain("super-secret");
      expect(String(JSON.stringify((error as CapletsError).details))).not.toContain("super-secret");
    }
  });

  it("throws a protocol error for malformed JSON and response envelopes", async () => {
    for (const response of [
      new Response("not-json"),
      Response.json(null),
      Response.json({ ok: true }),
      Response.json({ ok: false, error: { code: "TOOL_NOT_FOUND" } }),
      Response.json({ ok: "yes", result: "nope" }),
    ]) {
      const client = new RemoteControlClient({
        baseUrl: new URL("https://example.com/caplets"),
        requestInit: {},
        fetch: async () => response.clone(),
      });

      await expect(client.request("list", {})).rejects.toMatchObject({
        code: "DOWNSTREAM_PROTOCOL_ERROR",
        message: expect.stringContaining("invalid remote control response"),
      });
      await expect(client.request("list", {})).rejects.not.toBeInstanceOf(SyntaxError);
      await expect(client.request("list", {})).rejects.not.toBeInstanceOf(TypeError);
    }
  });

  it("redacts secret-like remote error messages while preserving nextAction", async () => {
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com/caplets"),
      requestInit: {},
      fetch: async () =>
        Response.json({
          ok: false,
          error: {
            code: "AUTH_FAILED",
            message:
              "remote failed with Authorization: Basic abc123 and bearer token bearer secret-token-123 access_token=super-secret",
            nextAction: "run_caplets_auth_login",
          },
        }),
    });

    try {
      await client.request("list", {});
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapletsError);
      expect(error).toMatchObject({
        code: "AUTH_FAILED",
        details: { nextAction: "run_caplets_auth_login" },
      });
      expect((error as CapletsError).message).not.toContain("abc123");
      expect((error as CapletsError).message).not.toContain("secret-token-123");
      expect((error as CapletsError).message).not.toContain("super-secret");
      expect((error as CapletsError).message).toContain("[REDACTED]");
    }
  });

  it("redacts operation-scoped Vault values from remote errors", async () => {
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com/caplets"),
      requestInit: {},
      fetch: async () =>
        Response.json({
          ok: false,
          error: {
            code: "DOWNSTREAM_TOOL_ERROR",
            message: "runtime echoed exact value unlabeled_remote_secret_123",
          },
        }),
    });

    try {
      await client.request("vault_set", {
        name: "GH_TOKEN",
        value: "unlabeled_remote_secret_123",
      });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapletsError);
      expect((error as CapletsError).message).not.toContain("unlabeled_remote_secret_123");
      expect((error as CapletsError).message).toContain("[REDACTED]");
    }
  });

  it("redacts password, client secret, and api key forms from remote error messages", async () => {
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com/caplets"),
      requestInit: {},
      fetch: async () =>
        Response.json({
          ok: false,
          error: {
            code: "AUTH_FAILED",
            message:
              "failed password=pw-123 client_secret: client-secret-123 api_key=api-key-123 password: colon-password api_key: colon-key",
          },
        }),
    });

    try {
      await client.request("list", {});
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapletsError);
      expect((error as CapletsError).message).not.toContain("pw-123");
      expect((error as CapletsError).message).not.toContain("client-secret-123");
      expect((error as CapletsError).message).not.toContain("api-key-123");
      expect((error as CapletsError).message).not.toContain("colon-password");
      expect((error as CapletsError).message).not.toContain("colon-key");
      expect((error as CapletsError).message).toContain("[REDACTED]");
    }
  });

  it("redacts representative credential key variants from remote error messages", async () => {
    const client = new RemoteControlClient({
      baseUrl: new URL("https://example.com/caplets"),
      requestInit: {},
      fetch: async () =>
        Response.json({
          ok: false,
          error: {
            code: "AUTH_FAILED",
            message:
              "failed api-key=api-key-123 clientsecret=client-secret-123 secret=secret-123 credential=credential-123 refresh_token=refresh-123",
          },
        }),
    });

    try {
      await client.request("list", {});
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapletsError);
      expect((error as CapletsError).message).not.toContain("api-key-123");
      expect((error as CapletsError).message).not.toContain("client-secret-123");
      expect((error as CapletsError).message).not.toContain("secret-123");
      expect((error as CapletsError).message).not.toContain("credential-123");
      expect((error as CapletsError).message).not.toContain("refresh-123");
      expect((error as CapletsError).message).toContain("[REDACTED]");
    }
  });
});
