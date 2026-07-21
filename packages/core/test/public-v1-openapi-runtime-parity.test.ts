import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRootOpenApiDocument } from "../src/admin-api/openapi";
import { type AttachManifest, CAPLETS_ATTACH_SESSION_HEADER } from "../src/attach/api";
import { CapletsError } from "../src/errors";
import { CapletsEngine } from "../src/engine";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { createHostStorage, type HostStorage } from "../src/storage";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public v1 OpenAPI/runtime response parity", () => {
  it("accepts mounted Remote credentials and frozen Admin response shapes", async () => {
    const engine = testEngine();
    const store = new RemoteServerCredentialStore({ dir: tempDir("caplets-v1-remote-store-") });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => undefined,
      remoteCredentialStore: store,
    });

    try {
      const started = await app.request("http://127.0.0.1:5387/v1/remote/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientLabel: "Parity Client", clientFingerprint: "fp_parity" }),
      });
      const pending = await started.json();
      expect(started.status).toBe(200);
      expectResponseMatches("/v1/remote/login/start", "post", 200, pending);

      const invalidPoll = await app.request("http://127.0.0.1:5387/v1/remote/login/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: "missing" }),
      });
      const pollFailure = await invalidPoll.json();
      expect(invalidPoll.status).toBe(400);
      expectResponseMatches("/v1/remote/login/poll", "post", 400, pollFailure);

      const pendingLogin = requirePendingLogin(pending);
      store.approvePendingLogin({ operatorCode: pendingLogin.operatorCode });
      const completed = await app.request("http://127.0.0.1:5387/v1/remote/login/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flowId: pendingLogin.flowId,
          pendingCompletionSecret: pendingLogin.pendingCompletionSecret,
        }),
      });
      const credentialsPayload = await completed.json();
      expect(completed.status).toBe(200);
      expectResponseMatches("/v1/remote/login/complete", "post", 200, credentialsPayload);
      const credentials = requireRemoteCredentials(credentialsPayload);

      const invalidRefresh = await app.request("http://127.0.0.1:5387/v1/remote/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "invalid-refresh-token" }),
      });
      const refreshFailure = await invalidRefresh.json();
      expect(invalidRefresh.status).toBe(401);
      expect(invalidRefresh.headers.get("content-type")).toContain("application/json");
      expectResponseMatches("/v1/remote/refresh", "post", 401, refreshFailure);

      const refreshed = await app.request("http://127.0.0.1:5387/v1/remote/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: credentials.refreshToken }),
      });
      const refreshedPayload = await refreshed.json();
      expect(refreshed.status).toBe(200);
      expectResponseMatches("/v1/remote/refresh", "post", 200, refreshedPayload);
      const refreshedCredentials = requireRemoteCredentials(refreshedPayload);

      const unauthorizedDelete = await app.request("http://127.0.0.1:5387/v1/remote/client", {
        method: "DELETE",
      });
      const unauthorizedText = await unauthorizedDelete.text();
      expect(unauthorizedDelete.status).toBe(401);
      expect(unauthorizedDelete.headers.get("content-type")).toContain("text/plain");
      expectResponseMatches("/v1/remote/client", "delete", 401, unauthorizedText, "text/plain");

      const revokeFailure = vi.spyOn(store, "revokeClient").mockImplementationOnce(() => {
        throw new CapletsError("SERVER_UNAVAILABLE", "Credential store unavailable.");
      });
      const failedDelete = await app.request("http://127.0.0.1:5387/v1/remote/client", {
        method: "DELETE",
        headers: { authorization: `Bearer ${refreshedCredentials.accessToken}` },
      });
      const deleteFailurePayload = await failedDelete.json();
      revokeFailure.mockRestore();
      expect(failedDelete.status).toBe(503);
      expect(failedDelete.headers.get("content-type")).toContain("application/json");
      expectResponseMatches("/v1/remote/client", "delete", 503, deleteFailurePayload);

      const unauthorizedAdmin = await app.request("http://127.0.0.1:5387/v1/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const unauthorizedAdminText = await unauthorizedAdmin.text();
      expect(unauthorizedAdmin.status).toBe(401);
      expectResponseMatches("/v1/admin", "post", 401, unauthorizedAdminText, "text/plain");

      const forbiddenAdmin = await app.request("http://127.0.0.1:5387/v1/admin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${refreshedCredentials.accessToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      const forbiddenAdminText = await forbiddenAdmin.text();
      expect(forbiddenAdmin.status).toBe(403);
      expectResponseMatches("/v1/admin", "post", 403, forbiddenAdminText, "text/plain");

      const operatorCredentials = issueRemoteCredentials(store, "operator");
      const legacyAdmin = await app.request("http://127.0.0.1:5387/v1/admin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorCredentials.accessToken}`,
          "content-type": "application/json",
        },
        body: '{"command":',
      });
      const legacyAdminPayload = await legacyAdmin.json();
      expect(legacyAdmin.status).toBe(200);
      expectResponseMatches("/v1/admin", "post", 200, legacyAdminPayload);

      const revoked = await app.request("http://127.0.0.1:5387/v1/remote/client", {
        method: "DELETE",
        headers: { authorization: `Bearer ${refreshedCredentials.accessToken}` },
      });
      const revokePayload = await revoked.json();
      expect(revoked.status).toBe(200);
      expectResponseMatches("/v1/remote/client", "delete", 200, revokePayload);
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("accepts direct mounted Admin Project Binding and present Vault value resources", async () => {
    const stateDir = tempDir("caplets-admin-parity-state-");
    const storage = await createHostStorage(
      { type: "sqlite", path: join(stateDir, "host.sqlite3") },
      { vaultRoot: join(stateDir, "vault") },
    );
    const engine = testEngine(storage);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => undefined,
      authoritativeStorage: storage,
    });

    try {
      await storage.vaultValues.set("PARITY_TOKEN", "parity-secret", {
        operatorClientId: "parity-operator",
      });

      const binding = await app.request("http://127.0.0.1:5387/v2/admin/project-binding");
      const bindingPayload = await binding.json();
      expect(binding.status).toBe(200);
      expect(binding.headers.get("content-type")).toContain("application/json");
      expectResponseMatches("/v2/admin/project-binding", "get", 200, bindingPayload);

      const vaultValue = await app.request(
        "http://127.0.0.1:5387/v2/admin/vault-values/PARITY_TOKEN",
      );
      const vaultPayload = await vaultValue.json();
      expect(vaultValue.status).toBe(200);
      expect(vaultValue.headers.get("content-type")).toContain("application/json");
      expectResponseMatches("/v2/admin/vault-values/{storedKey}", "get", 200, vaultPayload);
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
      await storage.close();
    }
  });
  it("accepts mounted Attach session, invoke, manifest, and legacy failure payloads", async () => {
    const engine = testEngine();
    const manifest = attachManifest();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => undefined,
      attachSessionFactory: () => ({
        manifest: async () => manifest,
        invoke: async (request) => ({ exportId: request.exportId, result: { open: true } }),
        onManifestChanged: () => () => undefined,
        close: async () => undefined,
      }),
    });

    try {
      const created = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const session = await created.json();
      expect(created.status).toBe(201);
      expectResponseMatches("/v1/attach/sessions", "post", 201, session);

      const sessionId = requireSessionId(session);
      const sessionHeaders = { [CAPLETS_ATTACH_SESSION_HEADER]: sessionId };
      const servedManifest = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
        headers: sessionHeaders,
      });
      const manifestPayload = await servedManifest.json();
      expect(servedManifest.status).toBe(200);
      expectResponseMatches("/v1/attach/manifest", "get", 200, manifestPayload);

      const invoked = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          revision: manifest.revision,
          kind: "caplet",
          exportId: manifest.caplets[0]!.exportId,
          input: { callerPayload: true },
        }),
      });
      const invokePayload = await invoked.json();
      expect(invoked.status).toBe(200);
      expectResponseMatches("/v1/attach/invoke", "post", 200, invokePayload);

      const malformed = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: '{"revision":',
      });
      const failure = await malformed.json();
      expect(malformed.status).toBe(400);
      expectResponseMatches("/v1/attach/invoke", "post", 400, failure);
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
    }
  });
  it("accepts the scoped backend auth status shape returned by frozen Admin auth_list", () => {
    expectResponseMatches("/v1/admin", "post", 200, {
      ok: true,
      result: [
        {
          server: "remote",
          status: "authenticated",
          expiresAt: "2999-01-01T00:00:00.000Z",
          scope: "openid profile",
        },
      ],
    });
  });
});

function expectResponseMatches(
  path: string,
  method: "delete" | "get" | "post",
  status: number,
  payload: unknown,
  mediaType = "application/json",
): void {
  const document = createRootOpenApiDocument();
  const pathItem = document.paths?.[path];
  const operation =
    method === "get" ? pathItem?.get : method === "post" ? pathItem?.post : pathItem?.delete;
  const response = operation?.responses?.[String(status)];
  if (!response || "$ref" in response) {
    throw new Error(`${method.toUpperCase()} ${path} ${status} has no inline response.`);
  }
  const schema = response.content?.[mediaType]?.schema;
  if (!schema) {
    throw new Error(
      `${method.toUpperCase()} ${path} ${status} has no ${mediaType} response schema.`,
    );
  }
  const validate = new Ajv({
    strict: false,
    formats: { "date-time": true, uri: true },
  }).compile({
    components: document.components,
    ...schema,
  });
  expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
}

function requirePendingLogin(value: unknown): {
  flowId: string;
  operatorCode: string;
  pendingCompletionSecret: string;
} {
  if (
    !isRecord(value) ||
    typeof value.flowId !== "string" ||
    typeof value.operatorCode !== "string" ||
    typeof value.pendingCompletionSecret !== "string"
  ) {
    throw new Error("Remote Login start response is missing completion material.");
  }
  return {
    flowId: value.flowId,
    operatorCode: value.operatorCode,
    pendingCompletionSecret: value.pendingCompletionSecret,
  };
}

function requireRemoteCredentials(value: unknown): {
  accessToken: string;
  refreshToken: string;
} {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string"
  ) {
    throw new Error("Remote credentials response is missing access or refresh material.");
  }
  return { accessToken: value.accessToken, refreshToken: value.refreshToken };
}

function issueRemoteCredentials(
  store: RemoteServerCredentialStore,
  grantedRole: "access" | "operator",
): { accessToken: string } {
  const pending = store.createPendingLogin({
    hostUrl: "http://127.0.0.1:5387/",
    requestedRole: grantedRole,
    clientLabel: `Parity ${grantedRole}`,
  });
  store.approvePendingLogin({ operatorCode: pending.operatorCode, grantedRole });
  return store.completePendingLogin({
    hostUrl: "http://127.0.0.1:5387/",
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
  });
}
function requireSessionId(value: unknown): string {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Attach session response is missing a session ID.");
  }
  return value.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachManifest(): AttachManifest {
  return {
    version: 1,
    revision: "parity-revision",
    generatedAt: "2026-07-21T00:00:00.000Z",
    caplets: [
      {
        stableId: "progressive:parity",
        exportId: "parity-export",
        kind: "caplet",
        name: "parity",
        schemaHash: null,
        capletId: "parity",
        shadowing: "forbid",
      },
    ],
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    completions: [],
    codeModeCaplets: [],
    diagnostics: [],
  };
}

function testEngine(hostStorage?: HostStorage): CapletsEngine {
  const root = tempDir("caplets-v1-parity-");
  const userRoot = join(root, "user");
  const projectRoot = join(root, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        parity: {
          name: "Parity",
          description: "Runtime parity fixture.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  writeFileSync(projectConfigPath, "{}");
  return new CapletsEngine({
    configPath,
    projectConfigPath,
    ...(hostStorage === undefined ? {} : { hostStorage }),
    watch: false,
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    publicOrigin: undefined,
    auth: { type: "development_unauthenticated" },
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    adminUploads: {
      stagingDir: join(tmpdir(), "caplets-v1-parity-uploads"),
      maxConcurrent: 1,
      maxStagedBytes: 400_000_000,
    },
    ...overrides,
  };
}
