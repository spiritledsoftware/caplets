import { describe, expect, it, vi } from "vitest";

import { createRemotePublicAuthAdapter } from "../src/remote-cli/public-auth";

describe("remote CLI public auth adapter", () => {
  it("uses the public SDK callback operation without an Authorization header", async () => {
    let callbackRequest: Request | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      callbackRequest = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        flowId: "flow-1",
        server: "github",
        status: "completed",
        createdAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-07-20T00:10:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
      });
    });
    const adapter = createRemotePublicAuthAdapter({
      baseUrl: new URL("https://host.example"),
      attachUrl: new URL("https://host.example/api/v1/attach"),
      requestInit: { headers: { Authorization: "Bearer paired-operator-token" } },
      fetch,
    });

    await expect(
      adapter.request("auth_login_complete", {
        flowId: "flow-1",
        callbackUrl: "https://host.example/callback?code=provider-code&state=opaque-state",
      }),
    ).resolves.toMatchObject({ flowId: "flow-1", status: "completed" });

    expect(callbackRequest?.url).toBe(
      "https://host.example/api/v2/admin/backend-auth-flows/flow-1/callback?code=provider-code&state=opaque-state",
    );
    expect(callbackRequest?.headers.get("authorization")).toBeNull();
  });
});
