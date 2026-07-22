import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { genericOAuthHeaders } from "../src/auth";
import { runCli } from "../src/cli";
import type { StoredOAuthTokenBundle } from "../src/auth/store";
import { BackendAuthStateStore } from "../src/storage/backend-auth";
import { createHostStorage } from "../src/storage";
import { backendAuthStates, operatorActivity } from "../src/storage/schema/sqlite";

const secretValues = [
  "plain-access-token",
  "plain-refresh-token",
  "plain-id-token",
  "plain-client-secret",
  "plain-metadata-secret",
];

const betaBundle: StoredOAuthTokenBundle = {
  server: "beta",
  authType: "oidc",
  accessToken: secretValues[0]!,
  refreshToken: secretValues[1]!,
  tokenType: "Bearer",
  expiresAt: "2999-01-01T00:00:00.000Z",
  scope: "openid profile",
  idToken: secretValues[2]!,
  issuer: "https://issuer.example",
  subject: "subject-1",
  clientId: "client-1",
  clientSecret: secretValues[3]!,
  protectedResourceOrigin: "https://api.example",
  metadata: { providerExtension: secretValues[4]! },
};

describe("BackendAuthStateStore", () => {
  it("persists token bundles with ordering, CAS, deletion, and sanitized activity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-backend-auth-"));
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const store = new BackendAuthStateStore(storage.database);

    try {
      await expect(
        store.writeTokenBundle(betaBundle, {
          operatorClientId: "operator-1",
        }),
      ).resolves.toEqual({ bundle: betaBundle, generation: 1 });
      await store.writeTokenBundle({ server: "alpha", accessToken: "alpha-token" });

      await expect(store.readTokenBundle("beta")).resolves.toEqual({
        bundle: betaBundle,
        generation: 1,
      });
      await expect(store.listTokenBundles()).resolves.toEqual([
        { bundle: { server: "alpha", accessToken: "alpha-token" }, generation: 1 },
        { bundle: betaBundle, generation: 1 },
      ]);

      const updatedBundle = { ...betaBundle, accessToken: "rotated-access-token" };
      await expect(
        store.writeTokenBundle(updatedBundle, {
          expectedGeneration: 1,
          operatorClientId: "operator-1",
        }),
      ).resolves.toEqual({ bundle: updatedBundle, generation: 2 });

      await expect(
        store.writeTokenBundle(
          { ...betaBundle, accessToken: "stale-overwrite-token" },
          { expectedGeneration: 1, operatorClientId: "operator-1" },
        ),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedGeneration: 1,
          currentGeneration: 2,
        },
      });
      await expect(store.readTokenBundle("beta")).resolves.toEqual({
        bundle: updatedBundle,
        generation: 2,
      });

      await expect(
        store.deleteTokenBundle("alpha", {
          expectedGeneration: 1,
          operatorClientId: "operator-1",
        }),
      ).resolves.toBe(true);
      await expect(store.readTokenBundle("alpha")).resolves.toBeUndefined();
      await expect(store.deleteTokenBundle("alpha")).resolves.toBe(false);
      await expect(store.readState("alpha")).resolves.toEqual({ generation: 2 });
      await expect(store.listTokenBundles()).resolves.toEqual([
        { bundle: updatedBundle, generation: 2 },
      ]);
      await expect(
        store.writeTokenBundle(
          { server: "alpha", accessToken: "stale-alpha-token" },
          { expectedGeneration: 1, operatorClientId: "operator-1" },
        ),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedGeneration: 1,
          currentGeneration: 2,
        },
      });
      const reauthenticatedAlpha = { server: "alpha", accessToken: "new-alpha-token" };
      await expect(
        store.writeTokenBundle(reauthenticatedAlpha, {
          expectedGeneration: 2,
          operatorClientId: "operator-1",
        }),
      ).resolves.toEqual({ bundle: reauthenticatedAlpha, generation: 3 });
      await expect(store.readTokenBundle("alpha")).resolves.toEqual({
        bundle: reauthenticatedAlpha,
        generation: 3,
      });

      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
      expect(storage.database.db.select().from(backendAuthStates).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ server: "alpha", generation: 3 }),
          expect.objectContaining({ server: "beta", generation: 2, tokenBundle: updatedBundle }),
        ]),
      );
      const activity = storage.database.db.select().from(operatorActivity).all();
      expect(activity.map(({ action, metadata }) => ({ action, metadata }))).toEqual([
        { action: "backend_auth_written", metadata: { generation: 1 } },
        { action: "backend_auth_written", metadata: { generation: 2 } },
        { action: "backend_auth_deleted", metadata: { generation: 2 } },
        { action: "backend_auth_written", metadata: { generation: 3 } },
      ]);
      const activityMetadata = JSON.stringify(activity.map((entry) => entry.metadata));
      for (const secret of [
        ...secretValues,
        "alpha-token",
        "rotated-access-token",
        "stale-overwrite-token",
        "stale-alpha-token",
        "new-alpha-token",
      ]) {
        expect(activityMetadata).not.toContain(secret);
      }
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("pages connections after excluding bundle-less state rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-backend-auth-pages-"));
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const store = new BackendAuthStateStore(storage.database);

    try {
      await store.writeTokenBundle({ server: "Aardvark", accessToken: "excluded-token" });
      await store.writeTokenBundle({ server: "Alpha", accessToken: "upper-alpha-token" });
      await store.writeTokenBundle({ server: "Bravo", accessToken: "upper-bravo-token" });
      await store.writeTokenBundle({ server: "alpha", accessToken: "lower-alpha-token" });
      await store.writeTokenBundle({ server: "bravo", accessToken: "lower-bravo-token" });
      await store.deleteTokenBundle("Aardvark");

      const firstPage = await store.listConnectionsPage({ limit: 2 });
      expect(firstPage).toEqual({
        items: [
          {
            bundle: { server: "Alpha", accessToken: "upper-alpha-token" },
            generation: 1,
          },
          {
            bundle: { server: "Bravo", accessToken: "upper-bravo-token" },
            generation: 1,
          },
        ],
        nextKey: { server: "Bravo" },
      });
      await expect(
        store.listConnectionsPage({ limit: 2, after: firstPage.nextKey }),
      ).resolves.toEqual({
        items: [
          {
            bundle: { server: "alpha", accessToken: "lower-alpha-token" },
            generation: 1,
          },
          {
            bundle: { server: "bravo", accessToken: "lower-bravo-token" },
            generation: 1,
          },
        ],
      });
      const descendingFirst = await store.listConnectionsPage({ limit: 2, sort: "desc" });
      expect(descendingFirst.items.map(({ bundle }) => bundle.server)).toEqual(["bravo", "alpha"]);
      const descendingSecond = await store.listConnectionsPage({
        limit: 2,
        sort: "desc",
        after: descendingFirst.nextKey,
      });
      expect(descendingSecond.items.map(({ bundle }) => bundle.server)).toEqual(["Bravo", "Alpha"]);
      await expect(store.listTokenBundles()).resolves.toEqual([
        {
          bundle: { server: "Alpha", accessToken: "upper-alpha-token" },
          generation: 1,
        },
        {
          bundle: { server: "Bravo", accessToken: "upper-bravo-token" },
          generation: 1,
        },
        {
          bundle: { server: "alpha", accessToken: "lower-alpha-token" },
          generation: 1,
        },
        {
          bundle: { server: "bravo", accessToken: "lower-bravo-token" },
          generation: 1,
        },
      ]);
      await expect(
        store.listConnectionsPage({ limit: 1, after: { server: " " } }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shares SQL auth state across CLI and runtime instances without auth files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-backend-auth-integration-"));
    const databasePath = join(directory, "caplets.sqlite3");
    const configPath = join(directory, "config.json");
    const legacyAuthDir = join(directory, "legacy-auth");
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: { type: "sqlite", path: databasePath },
        mcpServers: {
          remote: {
            name: "Remote",
            description: "Remote OAuth server",
            transport: "http",
            url: "https://api.example/mcp",
            auth: { type: "oauth2", clientId: "client" },
          },
        },
      }),
    );

    const seed = await createHostStorage({ type: "sqlite", path: databasePath });
    try {
      await seed.backendAuth.writeTokenBundle({
        server: "remote",
        authType: "oauth2",
        accessToken: "shared-runtime-token",
        tokenType: "Bearer",
        clientId: "client",
        protectedResourceOrigin: "https://api.example",
      });
    } finally {
      await seed.close();
    }

    const runtime = await createHostStorage({ type: "sqlite", path: databasePath });
    try {
      const output: string[] = [];
      await runCli(["auth", "list", "--global", "--json"], {
        env: { CAPLETS_CONFIG: configPath },
        authDir: legacyAuthDir,
        writeOut: (value) => output.push(value),
        writeErr: (value) => output.push(value),
        maybePrintUpdateNotice: async () => undefined,
      });
      expect(JSON.parse(output.join(""))).toEqual([
        { server: "remote", status: "authenticated", source: "global" },
      ]);
      await expect(
        genericOAuthHeaders(
          {
            server: "remote",
            backend: "http",
            url: "https://api.example/mcp",
            auth: { type: "oauth2", clientId: "client" },
          },
          runtime.backendAuth,
        ),
      ).resolves.toEqual({ authorization: "Bearer shared-runtime-token" });

      const logoutOutput: string[] = [];
      await runCli(["auth", "logout", "remote", "--global"], {
        env: { CAPLETS_CONFIG: configPath },
        authDir: legacyAuthDir,
        writeOut: (value) => logoutOutput.push(value),
        writeErr: (value) => logoutOutput.push(value),
        maybePrintUpdateNotice: async () => undefined,
      });
      expect(logoutOutput.join("")).toContain("Deleted OAuth credentials");
      await expect(runtime.backendAuth.readTokenBundle("remote")).resolves.toBeUndefined();
      expect(existsSync(legacyAuthDir)).toBe(false);
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid persisted token payloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-backend-auth-invalid-"));
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const store = new BackendAuthStateStore(storage.database);
    try {
      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
      storage.database.db
        .insert(backendAuthStates)
        .values({
          server: "invalid",
          generation: 1,
          tokenBundle: { server: "invalid", accessToken: 42 },
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        })
        .run();

      await expect(store.readTokenBundle("invalid")).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      await expect(store.listTokenBundles()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
