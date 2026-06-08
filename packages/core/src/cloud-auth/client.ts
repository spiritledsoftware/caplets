import { CapletsError } from "../errors";
import { redactCloudAuthSecrets, type CloudAuthRecovery, type CloudAuthErrorCode } from "./errors";
import type {
  CloudAuthLoginPollResult,
  CloudAuthLoginStart,
  CloudAuthTokenResponse,
  CloudAuthWorkspace,
} from "./types";
import { HOSTED_CLOUD_AUTH_SCOPES } from "./types";

export type CloudAuthClientOptions = {
  cloudUrl: string;
  fetch?: typeof fetch;
};

export type StartLoginInput = {
  requestedWorkspace?: string | undefined;
  deviceName?: string | undefined;
  scope?: string[] | undefined;
};

export type ExchangeTokenInput = {
  loginId: string;
  oneTimeCode: string;
};

export type RefreshTokenInput = {
  refreshToken: string;
};

export type CloudAddCapletsInput = {
  accessToken: string;
  workspace: string;
  bundle: { files: Array<{ path: string; content: string }> };
};

export type CloudAddCapletsResult = {
  caplet?: unknown;
  caplets: unknown[];
};

export type CloudAuthClientCredentials = Required<
  Pick<
    CloudAuthTokenResponse,
    "workspaceId" | "accessToken" | "expiresAt" | "tokenType" | "credentialFamilyId"
  >
> &
  Pick<CloudAuthTokenResponse, "workspaceSlug" | "refreshToken" | "deviceName" | "requestId"> & {
    cloudUrl: string;
    scope: string[];
    redacted: Record<string, unknown>;
  };

export class CloudAuthClient {
  private readonly cloudUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudAuthClientOptions) {
    this.cloudUrl = new URL(options.cloudUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async startLogin(input: StartLoginInput = {}): Promise<CloudAuthLoginStart> {
    return await this.requestJson<CloudAuthLoginStart>("/api/cloud-client/login/start", {
      method: "POST",
      body: JSON.stringify({
        ...(input.requestedWorkspace ? { requestedWorkspace: input.requestedWorkspace } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        scope: input.scope ?? [...HOSTED_CLOUD_AUTH_SCOPES],
      }),
    });
  }

  async pollLogin(loginId: string): Promise<CloudAuthLoginPollResult> {
    return await this.requestJson<CloudAuthLoginPollResult>(`/api/cloud-client/login/${loginId}`);
  }

  async exchangeToken(input: ExchangeTokenInput): Promise<CloudAuthClientCredentials> {
    const response = await this.requestJson<CloudAuthTokenResponse>("/api/cloud-client/token", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return normalizeCredentials(response, this.cloudUrl.origin);
  }

  async refresh(input: RefreshTokenInput): Promise<CloudAuthClientCredentials> {
    const response = await this.requestJson<CloudAuthTokenResponse>("/api/cloud-client/refresh", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return normalizeCredentials(response, this.cloudUrl.origin);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.requestJson("/api/cloud-client/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  }

  async workspaces(accessToken: string): Promise<{ workspaces: CloudAuthWorkspace[] }> {
    return await this.requestJson<{ workspaces: CloudAuthWorkspace[] }>(
      "/api/cloud-client/workspaces",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  }

  async switchWorkspace(input: {
    accessToken: string;
    workspace: string;
    refreshToken?: string | undefined;
    deviceName?: string | undefined;
  }): Promise<CloudAuthClientCredentials> {
    const response = await this.requestJson<CloudAuthTokenResponse>("/api/cloud-client/switch", {
      method: "POST",
      headers: { Authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({
        workspace: input.workspace,
        ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      }),
    });
    return normalizeCredentials(response, this.cloudUrl.origin);
  }

  async addCaplets(input: CloudAddCapletsInput): Promise<CloudAddCapletsResult> {
    const response = await this.requestJson<CloudAddCapletsResult>(
      `/api/workspaces/${encodeURIComponent(input.workspace)}/caplets/custom`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        body: JSON.stringify({ bundle: input.bundle }),
      },
    );
    return {
      ...response,
      caplets: Array.isArray(response.caplets) ? response.caplets : [],
    };
  }

  private async requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await this.fetchImpl(new URL(path, this.cloudUrl), { ...init, headers });
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === "string" ? body.error : "endpoint_unavailable";
      const message =
        typeof body.message === "string"
          ? body.message
          : `Cloud Auth request failed (${response.status}).`;
      const recovery: CloudAuthRecovery = {
        code: code as CloudAuthErrorCode,
        message,
        recoveryCommand:
          code === "workspace_switch_required"
            ? "caplets cloud auth switch <workspace>"
            : "caplets cloud auth login",
        requestId,
      };
      throw new CapletsError("AUTH_FAILED", message, redactCloudAuthSecrets(recovery));
    }
    return { ...body, ...(requestId && !body.requestId ? { requestId } : {}) } as T;
  }
}

function normalizeCredentials(
  response: CloudAuthTokenResponse,
  fallbackCloudUrl: string,
): CloudAuthClientCredentials {
  const scope = Array.isArray(response.scope)
    ? response.scope.map(String)
    : typeof response.scope === "string"
      ? response.scope.split(/\s+/u).filter(Boolean)
      : [...HOSTED_CLOUD_AUTH_SCOPES];
  const credentialFamilyId = response.credentialFamilyId ?? "cloud_client_credential_family";
  const tokenType = response.tokenType ?? "Bearer";
  const credentials: CloudAuthClientCredentials = {
    cloudUrl: response.cloudUrl ?? fallbackCloudUrl,
    workspaceId: response.workspaceId,
    ...(response.workspaceSlug ? { workspaceSlug: response.workspaceSlug } : {}),
    accessToken: response.accessToken,
    ...(response.refreshToken ? { refreshToken: response.refreshToken } : {}),
    expiresAt: response.expiresAt,
    scope,
    tokenType,
    credentialFamilyId,
    ...(response.deviceName ? { deviceName: response.deviceName } : {}),
    ...(response.requestId ? { requestId: response.requestId } : {}),
    redacted: {
      cloudUrl: response.cloudUrl ?? fallbackCloudUrl,
      workspaceId: response.workspaceId,
      ...(response.workspaceSlug ? { workspaceSlug: response.workspaceSlug } : {}),
      expiresAt: response.expiresAt,
      scope,
      tokenType,
      credentialFamilyId,
      ...(response.deviceName ? { deviceName: response.deviceName } : {}),
      ...(response.requestId ? { requestId: response.requestId } : {}),
    },
  };
  return credentials;
}
