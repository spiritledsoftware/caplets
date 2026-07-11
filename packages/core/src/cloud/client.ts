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

export type PresenceRequestOptions = {
  signal?: AbortSignal;
};

export type RegisterPresenceResult = {
  presenceId: string;
  expiresAt: string;
};

export type HeartbeatPresenceResult = RegisterPresenceResult;

export type CloudVaultValueStatus = {
  key: string;
  present: boolean;
  valueBytes?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type CloudVaultAccessGrant = {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin?: { kind: string; path: string } | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type CloudVaultSetInput = {
  workspace: string;
  name: string;
  value: string;
  force?: boolean | undefined;
  grant?: string | undefined;
  referenceName?: string | undefined;
};

export type CloudVaultNameInput = {
  workspace: string;
  name: string;
};

export type CloudVaultGetInput = CloudVaultNameInput & {
  reveal?: boolean | undefined;
  revealContext?: "human-cli" | undefined;
};

export type CloudVaultAccessGrantInput = CloudVaultNameInput & {
  capletId: string;
  referenceName?: string | undefined;
};

export type CloudVaultAccessListInput = {
  workspace: string;
  name?: string | undefined;
  capletId?: string | undefined;
};

export class CapletsCloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CapletsCloudClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async registerPresence(
    input: RegisterPresenceInput,
    options: PresenceRequestOptions = {},
  ): Promise<RegisterPresenceResult> {
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
      ...(options.signal ? { signal: options.signal } : {}),
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

  async stopPresence(presenceId: string, options: PresenceRequestOptions = {}): Promise<void> {
    const response = await this.fetchImpl(
      this.endpoint(`api/project-bindings/${encodeURIComponent(presenceId)}`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ state: "offline" }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Caplets Cloud Project Binding stop failed: HTTP ${response.status}`);
    }
  }

  async heartbeatPresence(
    presenceId: string,
    options: PresenceRequestOptions = {},
  ): Promise<HeartbeatPresenceResult> {
    const response = await this.fetchImpl(
      this.endpoint(`api/project-bindings/${encodeURIComponent(presenceId)}`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ state: "ready", syncState: "idle" }),
        ...(options.signal ? { signal: options.signal } : {}),
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

  async updatePresenceCaplets(
    presenceId: string,
    allowedCapletIds: string[],
    options: PresenceRequestOptions = {},
  ): Promise<void> {
    const response = await this.fetchImpl(
      this.endpoint(`api/project-bindings/${encodeURIComponent(presenceId)}`),
      {
        method: "PATCH",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ allowedCapletIds }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Project Binding update failed: HTTP ${response.status}`);
    }
  }

  async setVaultValue(input: CloudVaultSetInput): Promise<CloudVaultValueStatus> {
    const response = await this.fetchImpl(
      this.endpoint(
        `api/workspaces/${encodeURIComponent(input.workspace)}/vault/values/${encodeURIComponent(input.name)}`,
      ),
      {
        method: "PUT",
        headers: this.headers({ json: true }),
        body: JSON.stringify({
          value: input.value,
          force: Boolean(input.force),
          ...(input.grant ? { grant: input.grant } : {}),
          ...(input.referenceName ? { referenceName: input.referenceName } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault set failed: HTTP ${response.status}`);
    }
    return (await response.json()) as CloudVaultValueStatus;
  }

  async getVaultValue(
    input: CloudVaultGetInput,
  ): Promise<CloudVaultValueStatus | { key: string; value: string }> {
    const url = this.endpoint(
      `api/workspaces/${encodeURIComponent(input.workspace)}/vault/values/${encodeURIComponent(input.name)}`,
    );
    if (input.reveal) {
      url.searchParams.set("reveal", "true");
      url.searchParams.set("revealContext", input.revealContext ?? "human-cli");
    }
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault get failed: HTTP ${response.status}`);
    }
    return (await response.json()) as CloudVaultValueStatus | { key: string; value: string };
  }

  async listVaultValues(input: { workspace: string }): Promise<CloudVaultValueStatus[]> {
    const response = await this.fetchImpl(
      this.endpoint(`api/workspaces/${encodeURIComponent(input.workspace)}/vault/values`),
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault list failed: HTTP ${response.status}`);
    }
    return (await response.json()) as CloudVaultValueStatus[];
  }

  async deleteVaultValue(
    input: CloudVaultNameInput,
  ): Promise<{ key: string; deleted: boolean; grantsRetained?: number | undefined }> {
    const response = await this.fetchImpl(
      this.endpoint(
        `api/workspaces/${encodeURIComponent(input.workspace)}/vault/values/${encodeURIComponent(input.name)}`,
      ),
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault delete failed: HTTP ${response.status}`);
    }
    return (await response.json()) as {
      key: string;
      deleted: boolean;
      grantsRetained?: number | undefined;
    };
  }

  async grantVaultAccess(input: CloudVaultAccessGrantInput): Promise<CloudVaultAccessGrant> {
    const response = await this.fetchImpl(
      this.endpoint(
        `api/workspaces/${encodeURIComponent(input.workspace)}/vault/access/${encodeURIComponent(input.name)}/${encodeURIComponent(input.capletId)}`,
      ),
      {
        method: "PUT",
        headers: this.headers({ json: true }),
        body: JSON.stringify({ referenceName: input.referenceName ?? input.name }),
      },
    );
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault access grant failed: HTTP ${response.status}`);
    }
    return (await response.json()) as CloudVaultAccessGrant;
  }

  async listVaultAccess(input: CloudVaultAccessListInput): Promise<CloudVaultAccessGrant[]> {
    const url = this.endpoint(`api/workspaces/${encodeURIComponent(input.workspace)}/vault/access`);
    if (input.name) url.searchParams.set("name", input.name);
    if (input.capletId) url.searchParams.set("capletId", input.capletId);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault access list failed: HTTP ${response.status}`);
    }
    return (await response.json()) as CloudVaultAccessGrant[];
  }

  async revokeVaultAccess(input: CloudVaultAccessGrantInput): Promise<CloudVaultAccessGrant[]> {
    const url = this.endpoint(
      `api/workspaces/${encodeURIComponent(input.workspace)}/vault/access/${encodeURIComponent(input.name)}/${encodeURIComponent(input.capletId)}`,
    );
    if (input.referenceName) url.searchParams.set("referenceName", input.referenceName);
    const response = await this.fetchImpl(url, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Caplets Cloud Vault access revoke failed: HTTP ${response.status}`);
    }
    return (await response.json()) as CloudVaultAccessGrant[];
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
