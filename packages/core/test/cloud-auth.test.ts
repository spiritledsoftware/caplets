import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudAuthStore,
  cloudAuthPath,
  redactedCloudAuthStatus,
  type CloudAuthCredentials,
} from "../src/cloud-auth/store";
import { runCli } from "../src/cli";

const tempDirs: string[] = [];
const credentials: CloudAuthCredentials = {
  version: 2,
  cloudUrl: "https://cloud.caplets.dev",
  workspaceId: "ws_123",
  workspaceSlug: "team",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: "2099-06-02T12:00:00.000Z",
  scope: ["project_binding:read", "project_binding:write"],
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
    });
  });

  it("prints authenticated status and stored workspace as JSON", async () => {
    const path = tempAuthPath();
    await new CloudAuthStore({ path }).save(credentials);
    const out: string[] = [];

    await runCli(["cloud", "auth", "status", "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual({
      authenticated: true,
      status: "authenticated",
      cloudUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      expiresAt: "2099-06-02T12:00:00.000Z",
      scope: ["project_binding:read", "project_binding:write"],
      tokenType: "Bearer",
      credentialFamilyId: "family_123",
      deviceName: "Test Device",
      createdAt: "2026-06-03T12:00:00.000Z",
      lastRefreshAt: "2026-06-03T12:00:00.000Z",
    });
  });

  it("lists the stored workspace as JSON", async () => {
    const path = tempAuthPath();
    await new CloudAuthStore({ path }).save(credentials);
    const out: string[] = [];

    await runCli(["cloud", "auth", "workspaces", "--json"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual({
      workspaces: [{ workspaceId: "ws_123", slug: "team", selected: true }],
    });
  });

  it("logs out by deleting stored Cloud Auth credentials", async () => {
    const path = tempAuthPath();
    await new CloudAuthStore({ path }).save(credentials);

    await runCli(["cloud", "auth", "logout"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: () => undefined,
    });

    expect(existsSync(path)).toBe(false);
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
  const dir = mkdtempSync(join(tmpdir(), "caplets-cloud-auth-"));
  tempDirs.push(dir);
  return join(dir, "cloud-auth.json");
}
