export interface WorkspaceSummary {
  workspaceId: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceResponse {
  workspace: WorkspaceSummary;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export class CloudApiClient {
  private readonly accessToken: string | undefined;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor({
    accessToken,
    baseUrl,
    fetchImpl,
  }: {
    accessToken?: string;
    baseUrl: string | URL;
    fetchImpl?: typeof fetch;
  }) {
    this.accessToken = accessToken;
    this.baseUrl = new URL(baseUrl);
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getWorkspace(slug: string, init: { signal?: AbortSignal } = {}): Promise<WorkspaceSummary> {
    const response = await this.fetchJson<WorkspaceResponse>(
      `api/workspaces/${encodeURIComponent(slug)}`,
      init,
    );
    return response.workspace;
  }

  workspaceMcpEndpoint(slug: string): string {
    return new URL(`ws/${encodeURIComponent(slug)}/mcp`, withTrailingSlash(this.baseUrl)).href;
  }

  private async fetchJson<T>(path: string, init: { signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(path, withTrailingSlash(this.baseUrl));
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const response = await this.fetchImpl(url, {
      headers,
      signal: init.signal,
    });

    if (!response.ok) {
      throw new CloudApiError(
        `Caplets Cloud API request failed: HTTP ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

function withTrailingSlash(url: URL): URL {
  const next = new URL(url);
  if (!next.pathname.endsWith("/")) next.pathname = `${next.pathname}/`;
  return next;
}
