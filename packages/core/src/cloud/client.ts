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
    const response = await this.fetchImpl(this.endpoint("api/presence"), {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Caplets Cloud presence registration failed: HTTP ${response.status}`);
    }
    return (await response.json()) as RegisterPresenceResult;
  }

  async stopPresence(presenceId: string): Promise<void> {
    const response = await this.fetchImpl(
      this.endpoint(`api/presence/${encodeURIComponent(presenceId)}`),
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Caplets Cloud presence stop failed: HTTP ${response.status}`);
    }
  }

  async heartbeatPresence(presenceId: string): Promise<HeartbeatPresenceResult> {
    const response = await this.fetchImpl(
      this.endpoint(`api/presence/${encodeURIComponent(presenceId)}/heartbeat`),
      {
        method: "POST",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud presence heartbeat failed: HTTP ${response.status}`);
    }
    return (await response.json()) as HeartbeatPresenceResult;
  }

  async updatePresenceCaplets(presenceId: string, allowedCapletIds: string[]): Promise<void> {
    const response = await this.fetchImpl(
      this.endpoint(`api/presence/${encodeURIComponent(presenceId)}/caplets`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ allowedCapletIds }),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud presence update failed: HTTP ${response.status}`);
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
