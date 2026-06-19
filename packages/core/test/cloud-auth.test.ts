import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudAuthStore,
  cloudAuthPath,
  redactedCloudAuthStatus,
  type CloudAuthCredentials,
} from "../src/cloud-auth/store";
import { runCli } from "../src/cli";
import { FileRemoteProfileStore } from "../src/remote/profile-store";

const tempDirs: string[] = [];
const credentials: CloudAuthCredentials = {
  version: 2,
  cloudUrl: "https://cloud.caplets.dev",
  workspaceId: "ws_123",
  workspaceSlug: "team",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: "2099-06-02T12:00:00.000Z",
  scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
  tokenType: "Bearer",
  credentialFamilyId: "family_123",
  deviceName: "Test Device",
  createdAt: "2026-06-03T12:00:00.000Z",
  lastRefreshAt: "2026-06-03T12:00:00.000Z",
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("caplets cloud auth CLI", () => {
  it("shows Cloud Auth help", async () => {
    const out: string[] = [];

    await runCli(["cloud", "auth", "--help"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toContain("Authenticate this Caplets client to hosted Caplets Cloud.");
    expect(out.join("")).toContain("login");
    expect(out.join("")).toContain("status");
    expect(out.join("")).toContain("logout");
    expect(out.join("")).toContain("workspaces");
  });

  it("prints unauthenticated status as JSON when no credentials are stored", async () => {
    const out: string[] = [];

    await runCli(["cloud", "auth", "status", "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: tempAuthPath() },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual({
      authenticated: false,
      status: "unauthenticated",
      hostUrl: "https://cloud.caplets.dev/",
      kind: "cloud",
    });
  });

  it("prints authenticated status and stored workspace as JSON", async () => {
    const path = tempAuthPath();
    await saveRemoteProfile(path);
    const out: string[] = [];

    await runCli(["cloud", "auth", "status", "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toMatchObject({
      authenticated: true,
      kind: "cloud",
      hostUrl: "https://cloud.caplets.dev/",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      selected: true,
      clientLabel: "Test Device",
      expiresAt: "2099-06-02T12:00:00.000Z",
      scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
      tokenType: "Bearer",
      createdAt: "2026-06-03T12:00:00.000Z",
      updatedAt: "2026-06-03T12:00:00.000Z",
    });
  });

  it("lists the stored workspace as JSON", async () => {
    const path = tempAuthPath();
    await saveRemoteProfile(path);
    const out: string[] = [];

    await runCli(["cloud", "auth", "workspaces", "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual({
      workspaces: [{ workspaceId: "ws_123", slug: "team", selected: true }],
    });
  });

  it("logs out by deleting stored Remote Profile credentials", async () => {
    const path = tempAuthPath();
    await saveRemoteProfile(path);

    await runCli(["cloud", "auth", "logout"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: () => undefined,
    });

    const out: string[] = [];
    await runCli(["cloud", "auth", "status", "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: (value) => out.push(value),
    });
    expect(JSON.parse(out.join(""))).toMatchObject({ authenticated: false });
  });

  it("uploads local caplet-files to the selected Cloud workspace", async () => {
    const authPath = tempAuthPath();
    await saveRemoteProfile(authPath);
    const root = tempDir("caplets-cloud-add-");
    mkdirSync(join(root, "search"), { recursive: true });
    writeFileSync(
      join(root, "search", "CAPLET.md"),
      `---
name: Search
description: Search API.
openapiEndpoint:
  specPath: ./openapi.yaml
  auth:
    type: none
---

# Search
`,
    );
    writeFileSync(join(root, "search", "openapi.yaml"), "openapi: 3.0.3\ninfo:\n  title: Search\n");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const out: string[] = [];

    await runCli(["cloud", "add", root, "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: authPath },
      fetch: (async (url, init) => {
        requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        return Response.json(
          {
            caplet: { id: "search", name: "Search" },
            caplets: [{ id: "search", name: "Search" }],
          },
          { status: 201 },
        );
      }) as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cloud.caplets.dev/api/workspaces/team/caplets/custom");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer access");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      bundle: {
        files: [
          expect.objectContaining({
            path: "search/CAPLET.md",
            content: expect.stringContaining("Search"),
          }),
          { path: "search/openapi.yaml", content: "openapi: 3.0.3\ninfo:\n  title: Search\n" },
        ],
      },
    });
    expect(JSON.parse(out.join(""))).toEqual({
      caplets: [{ id: "search", name: "Search" }],
      workspace: "team",
    });
  });
});

describe("CloudAuthStore", () => {
  it("stores refreshable Cloud Auth credentials with restrictive file permissions", async () => {
    const path = tempAuthPath();
    const store = new CloudAuthStore({ path });

    await store.save(credentials);

    expect(await store.load()).toEqual(credentials);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("classifies expired credentials with a refresh token as refreshable without exposing secrets", () => {
    const status = redactedCloudAuthStatus(
      {
        ...credentials,
        accessToken: "secret_access",
        refreshToken: "secret_refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
      },
      new Date("2026-06-04T00:00:00.000Z"),
    );

    expect(status).toMatchObject({
      authenticated: false,
      status: "refreshable",
      workspaceId: "ws_123",
    });
    expect(JSON.stringify(status)).not.toContain("secret_access");
    expect(JSON.stringify(status)).not.toContain("secret_refresh");
  });

  it("uses platform config directories for the default path", () => {
    expect(
      cloudAuthPath({
        env: { XDG_CONFIG_HOME: "/config" },
        home: "/home/alice",
        platform: "linux",
      }),
    ).toBe("/config/caplets/cloud-auth.json");
    expect(
      cloudAuthPath({
        env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
        home: "C:\\Users\\Alice",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\Alice\\AppData\\Roaming\\Caplets\\cloud-auth.json");
  });
});

function tempAuthPath(): string {
  return join(tempDir("caplets-cloud-auth-"), "cloud-auth.json");
}

async function saveRemoteProfile(cloudAuthPath: string): Promise<void> {
  await new FileRemoteProfileStore({
    root: join(dirname(cloudAuthPath), "remote-profiles"),
  }).saveCloudProfile({
    hostUrl: credentials.cloudUrl,
    workspaceId: credentials.workspaceId,
    ...(credentials.workspaceSlug ? { workspaceSlug: credentials.workspaceSlug } : {}),
    clientLabel: credentials.deviceName,
    credentials: {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      scope: credentials.scope,
      tokenType: credentials.tokenType,
    },
    now: new Date(credentials.createdAt ?? "2026-06-03T12:00:00.000Z"),
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
