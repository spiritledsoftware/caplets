import type {
  ProjectBindingSocketEvent,
  ProjectBindingSocketEventType,
  ProjectBindingSocketListener,
  ProjectBindingWebSocket,
} from "@caplets/sdk/project-binding";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { attachProjectOnce, attachProjectSession } from "../src/project-binding/attach";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

describe("hosted Cloud Auth refresh before attach", () => {
  it("refreshes expired hosted credentials, persists rotation, and attaches with the new access token", async () => {
    const path = tempCloudAuthPath();
    const store = new CloudAuthStore({ path });
    await store.save(
      hostedCredentials({
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
      }),
    );
    const authorizationHeaders: string[] = [];

    await expect(
      attachProjectOnce(
        {
          projectRoot: "/repo",
          fetch: async (url, init) => {
            if (String(url).endsWith("/api/cloud-client/refresh")) {
              expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old_refresh" });
              return Response.json({
                status: "authenticated",
                cloudUrl: "https://cloud.caplets.dev",
                workspaceId: "workspace_personal",
                workspaceSlug: "personal",
                accessToken: "new_access",
                refreshToken: "new_refresh",
                expiresAt: "2999-01-01T00:00:00.000Z",
                scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
                tokenType: "Bearer",
                credentialFamilyId: "family_123",
              });
            }
            authorizationHeaders.push(headerValue(init?.headers, "authorization"));
            return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
          },
        },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(store.load()).resolves.toMatchObject({
      accessToken: "old_access",
      refreshToken: "old_refresh",
      expiresAt: "2026-06-03T00:00:00.000Z",
    });
    const profileStore = new FileRemoteProfileStore({
      root: join(dirname(path), "remote-profiles"),
    });
    const status = await profileStore.getCloudProfileStatus({
      hostUrl: "https://cloud.caplets.dev",
    });
    expect(status).toMatchObject({
      hostUrl: "https://cloud.caplets.dev/",
      workspaceSlug: "personal",
    });
    await expect(profileStore.credentials.load(status?.key ?? "")).resolves.toMatchObject({
      accessToken: "new_access",
      refreshToken: "new_refresh",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(authorizationHeaders).toEqual(["Bearer new_access"]);
  });

  it("fails closed when the saved refresh token is revoked", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        expiresAt: "2026-06-03T00:00:00.000Z",
        refreshToken: "revoked_refresh",
      }),
    );

    await expect(
      attachProjectOnce(
        {
          projectRoot: "/repo",
          fetch: async () =>
            Response.json(
              { error: "invalid_refresh_token", message: "Refresh token was revoked." },
              { status: 401 },
            ),
        },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refreshes the bearer before an unexpected WebSocket reconnect", async () => {
    const authDir = dirname(tempCloudAuthPath());
    const profileStore = new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    });
    await profileStore.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_personal",
      workspaceSlug: "personal",
      credentials: {
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });
    const sockets: ReconnectingProjectBindingSocket[] = [];
    const socketProtocols: string[][] = [];
    let projectFingerprint = "";
    let resolveFirstHeartbeat!: () => void;
    const firstHeartbeat = new Promise<void>((resolve) => {
      resolveFirstHeartbeat = resolve;
    });
    let resolveReconnected!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      resolveReconnected = resolve;
    });
    const binding = (state: "attaching" | "ended" = "attaching") => ({
      bindingId: "binding_1",
      state,
      syncState: "pending" as const,
      projectFingerprint,
      serverProjectRoot: "/srv/repo",
      updatedAt: "2026-07-20T12:00:00.000Z",
      expiresAt: "2026-07-20T12:01:00.000Z",
    });

    const session = attachProjectSession(
      {
        authDir,
        remoteUrl: "https://cloud.caplets.dev",
        projectRoot: "/repo",
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path.endsWith("/api/cloud-client/refresh")) {
            expect(await request.clone().json()).toEqual({ refreshToken: "old_refresh" });
            return Response.json({
              status: "authenticated",
              cloudUrl: "https://cloud.caplets.dev",
              workspaceId: "workspace_personal",
              workspaceSlug: "personal",
              accessToken: "new_access",
              refreshToken: "new_refresh",
              expiresAt: "2999-01-01T00:00:00.000Z",
              scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
              tokenType: "Bearer",
              credentialFamilyId: "family_123",
            });
          }
          if (path.endsWith("/project-bindings/sessions")) {
            const body = await request.clone().json();
            projectFingerprint =
              typeof body === "object" &&
              body !== null &&
              "projectFingerprint" in body &&
              typeof body.projectFingerprint === "string"
                ? body.projectFingerprint
                : "";
            return Response.json({ binding: binding(), sessionId: "session_1" }, { status: 201 });
          }
          if (path.endsWith("/heartbeat")) {
            return Response.json({ ok: true, binding: binding() });
          }
          if (request.method === "DELETE") {
            return Response.json({ ok: true, binding: binding("ended") });
          }
          throw new Error(`Unexpected Project Binding request: ${request.method} ${path}`);
        },
      },
      { CAPLETS_MODE: "cloud" },
      {
        webSocketFactory: (_url, protocols) => {
          socketProtocols.push(typeof protocols === "string" ? [protocols] : [...protocols]);
          const socket = new ReconnectingProjectBindingSocket();
          sockets.push(socket);
          queueMicrotask(() => socket.open());
          if (sockets.length === 2) resolveReconnected();
          return socket;
        },
        onEvent: (event) => {
          if (event.type === "heartbeat" && sockets.length === 1) resolveFirstHeartbeat();
        },
      },
    );

    await firstHeartbeat;
    await profileStore.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_personal",
      workspaceSlug: "personal",
      credentials: {
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });
    sockets[0]!.unexpectedClose();
    await reconnected;

    expect(socketProtocols).toEqual([
      ["caplets.project-binding.v1", "caplets.bearer.b2xkX2FjY2Vzcw"],
      ["caplets.project-binding.v1", "caplets.bearer.bmV3X2FjY2Vzcw"],
    ]);
    sockets[1]!.receive({
      type: "ended",
      reason: { code: "completed", message: "Session completed." },
    });
    await expect(session).resolves.toMatchObject({ ok: true, ended: true });
  });

  it("does not implicitly use saved Cloud Auth without cloud mode or a Cloud remote URL", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(hostedCredentials());

    await expect(
      attachProjectOnce({ projectRoot: "/repo" }, { CAPLETS_CLOUD_AUTH_PATH: path }),
    ).rejects.toThrow(/CAPLETS_REMOTE_URL/u);
  });
});

function headerValue(headers: RequestInit["headers"] | undefined, name: string): string {
  return new Headers(headers).get(name) ?? "";
}

class ReconnectingProjectBindingSocket implements ProjectBindingWebSocket {
  readyState = 0;
  private readonly listeners = new Map<
    ProjectBindingSocketEventType,
    Set<ProjectBindingSocketListener>
  >();

  addEventListener(
    type: ProjectBindingSocketEventType,
    listener: ProjectBindingSocketListener,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<ProjectBindingSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: ProjectBindingSocketEventType,
    listener: ProjectBindingSocketListener,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  receive(message: unknown): void {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  unexpectedClose(): void {
    this.readyState = 3;
    this.dispatch("close", { code: 1006, reason: "network" });
  }

  private dispatch(type: ProjectBindingSocketEventType, event: ProjectBindingSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
