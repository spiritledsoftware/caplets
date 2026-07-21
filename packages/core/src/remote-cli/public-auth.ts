import { CapletsError } from "../errors";
import { adminV2CompleteBackendAuthFlowCallback, createClient } from "@caplets/sdk";
import type { RemoteCliCommandAdapter, ResolvedRemoteCliConnection } from "./client";

/** Uses the unauthenticated, flow-authoritative backend OAuth callback operation. */
export function createRemotePublicAuthAdapter(
  resolved: ResolvedRemoteCliConnection,
): RemoteCliCommandAdapter {
  const client = createClient({
    baseUrl: resolved.baseUrl.toString(),
    fetch: resolved.fetch ?? fetch,
    responseStyle: "fields",
    throwOnError: false,
  });
  return {
    async request(command, args) {
      if (command !== "auth_login_complete") {
        throw new CapletsError(
          "UNKNOWN_OPERATION",
          `Remote command ${command} is not a public auth self-service operation.`,
        );
      }
      const flowId = typeof args.flowId === "string" ? args.flowId : "";
      const callbackUrl = typeof args.callbackUrl === "string" ? args.callbackUrl : "";
      if (!flowId || !callbackUrl) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Remote backend auth completion requires flowId and callbackUrl.",
        );
      }
      let callback: URL;
      try {
        callback = new URL(callbackUrl);
      } catch {
        throw new CapletsError("REQUEST_INVALID", "Remote backend auth callback URL is invalid.");
      }
      const result = await adminV2CompleteBackendAuthFlowCallback({
        client,
        path: { flowId },
        query: {
          ...(callback.searchParams.get("code")
            ? { code: callback.searchParams.get("code")! }
            : {}),
          ...(callback.searchParams.get("state")
            ? { state: callback.searchParams.get("state")! }
            : {}),
          ...(callback.searchParams.get("error")
            ? { error: callback.searchParams.get("error")! }
            : {}),
        },
      });
      if (result.error !== undefined) {
        throw new CapletsError(
          result.response?.status === 401 || result.response?.status === 403
            ? "AUTH_FAILED"
            : "DOWNSTREAM_TOOL_ERROR",
          result.error.detail,
        );
      }
      return result.data;
    },
  };
}
