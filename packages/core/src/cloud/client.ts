import type { ProjectSyncFile } from "./sync";

export type CapletsCloudClientOptions = {
  baseUrl: URL;
  accessToken: string;
  fetch?: typeof fetch;
};

export type RegisterPresenceInput = {
  workspaceId: string;
  projectRoot: string;
  projectFingerprint: string;
  allowedCapletIds: string[];
  projectFiles?: ProjectSyncFile[] | undefined;
  fallbackConsent?: "allow" | "deny" | undefined;
};

export type RegisterPresenceResult = {
  presenceId: string;
  expiresAt: string;
};

export type HeartbeatPresenceResult = RegisterPresenceResult;

export class CapletsCloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CapletsCloudClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async registerPresence(input: RegisterPresenceInput): Promise<RegisterPresenceResult> {
    const response = await this.fetchImpl(this.endpoint("api/project-bindings"), {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        projectRoot: input.projectRoot,
        projectFingerprint: input.projectFingerprint,
        state: "ready",
        syncState: "idle",
        allowedCapletIds: input.allowedCapletIds,
        fallbackConsent: input.fallbackConsent ?? "deny",
        projectFiles: input.projectFiles ?? [],
      }),
    });
    if (!response.ok) {
      throw new Error(`Caplets Cloud Project Binding registration failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { binding?: { bindingId?: string } };
    return {
      presenceId: body.binding?.bindingId ?? `${input.workspaceId}:${input.projectFingerprint}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async stopPresence(presenceId: string): Promise<void> {
    const response = await this.fetchImpl(
      this.endpoint(`api/project-bindings/${encodeURIComponent(presenceId)}`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ state: "offline" }),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Caplets Cloud Project Binding stop failed: HTTP ${response.status}`);
    }
  }

  async heartbeatPresence(presenceId: string): Promise<HeartbeatPresenceResult> {
    const response = await this.fetchImpl(
      this.endpoint(`api/project-bindings/${encodeURIComponent(presenceId)}`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ state: "ready", syncState: "idle" }),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Project Binding heartbeat failed: HTTP ${response.status}`);
    }
    return {
      presenceId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async updatePresenceCaplets(presenceId: string, allowedCapletIds: string[]): Promise<void> {
    const response = await this.fetchImpl(
      this.endpoint(`api/project-bindings/${encodeURIComponent(presenceId)}`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ allowedCapletIds }),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Project Binding update failed: HTTP ${response.status}`);
    }
  }

  private headers(options: { json?: boolean } = {}): Headers {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${this.options.accessToken}`);
    if (options.json) headers.set("content-type", "application/json");
    return headers;
  }

  private endpoint(path: string): URL {
    const url = new URL(this.options.baseUrl.href);
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
    url.pathname = `${basePath}/${path.replace(/^\/+/u, "")}`;
    return url;
  }
}
