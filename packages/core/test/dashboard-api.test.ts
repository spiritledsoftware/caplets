declare global {
  type HeadersInit = Headers | [string, string][] | Record<string, string>;
  interface HTMLMetaElement {
    content: string;
  }
  var document:
    | {
        querySelector<T>(selector: string): T | null;
      }
    | undefined;
  var location: { pathname: string } | undefined;
}
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp } from "../src/serve/http";
import { createPortableArtifactReference } from "../src/media/artifacts";
import type { HttpServeOptions } from "../src/serve/options";
import { FileVaultStore } from "../src/vault";
import type {
  CurrentHostManagementDependencies,
  CurrentHostOperationReceipt,
} from "../src/current-host/operations";
import type { CurrentHostPortableOperations } from "../src/current-host/operations";
import {
  dashboardPortableDownload,
  dashboardPortableOperation,
  dashboardPortableStatus,
  dashboardPortableUploadChunk,
  setDashboardSession,
} from "../../../apps/dashboard/src/lib/api";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setDashboardSession(undefined);
  Reflect.deleteProperty(globalThis, "location");
});

describe("dashboard API read model", () => {
  it("returns Current Host summary, attention, counts, and redacted section links", async () => {
    const setup = await authenticatedDashboard();
    setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Waiting Browser",
    });

    const response = await dashboardGet(setup, "/dashboard/api/summary");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      host: {
        current: true,
        baseUrl: "http://127.0.0.1:5387/",
        dashboardUrl: "http://127.0.0.1:5387/dashboard",
        version: expect.any(String),
      },
      attention: [expect.objectContaining({ kind: "pending-login", severity: "warning" })],
      sections: expect.objectContaining({
        caplets: expect.objectContaining({ count: 1, href: "/dashboard#caplets" }),
        access: expect.objectContaining({ pending: 1 }),
        vault: expect.objectContaining({ count: 1 }),
        settings: expect.objectContaining({ href: "/dashboard#settings" }),
      }),
    });
    expect(
      JSON.stringify(await (await dashboardGet(setup, "/dashboard/api/summary")).json()),
    ).not.toContain(setup.context.configPath);

    await setup.engine.close();
  });

  it("serializes SQL session authority outages on live routes as structured 503s", async () => {
    const context = testContext();
    const stateDir = tempDir("caplets-dashboard-api-");
    const engine = CapletsEngine.unactivatedForTests({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions(stateDir), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: new RemoteServerCredentialStore({ dir: stateDir }),
      controlPlaneSecurity: {
        async validate() {
          throw new CapletsError("SERVER_UNAVAILABLE", "SQL security authority is unavailable.");
        },
      } as never,
    });

    const response = await app.request(
      "http://127.0.0.1:5387/dashboard/api/management?resource=caplet",
      { headers: { cookie: "caplets_dashboard_session=session.secret" } },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "SERVER_UNAVAILABLE" },
    });

    await engine.close();
  });

  it("relays availability-independent redacted SQL health without a dashboard session", async () => {
    const setup = await authenticatedDashboard();
    vi.spyOn(setup.engine, "controlPlaneHealth").mockResolvedValue({
      backend: "postgres",
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      authorityToken: { authorityGeneration: 7, effectiveGeneration: 9 },
      bootstrapCompatibility: "current",
      staleAgeMs: 1_250,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    });

    const response = await setup.app.request("http://127.0.0.1:5387/dashboard/api/storage-health");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      backend: "postgres",
      readiness: "stale-read-only",
      connectivity: "unavailable",
      migration: "current",
      authorityToken: { authorityGeneration: 7, effectiveGeneration: 9 },
      bootstrapCompatibility: "current",
      staleAgeMs: 1_250,
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    });
    expect(text).not.toMatch(
      /storeId|fingerprint|keyId|material|backup|path|caplets|hostSettings/u,
    );

    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/dashboard/caplets" },
    });
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      setup.app.request(new URL(String(input), "http://127.0.0.1:5387").toString(), init),
    );
    await expect(dashboardPortableStatus()).resolves.toEqual({
      kind: "portable_status",
      status: "stale-read-only",
      health: JSON.parse(text),
      guidanceCode: "storage-unavailable",
    });

    await setup.engine.close();
  });

  it("lists clients, pending logins, and Vault metadata without credential or raw Vault values", async () => {
    const setup = await authenticatedDashboard();
    setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Waiting Browser",
      clientFingerprint: "fp_waiting",
    });

    const clients = await dashboardGet(setup, "/dashboard/api/access/clients");
    expect(clients.status).toBe(200);
    const clientsText = await clients.text();
    expect(clientsText).toContain('"role":"operator"');
    expect(clientsText).not.toContain("cap_remote_access_");
    expect(clientsText).not.toContain("cap_remote_refresh_");

    const pending = await dashboardGet(setup, "/dashboard/api/access/pending-logins");
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({
      pendingLogins: [
        expect.objectContaining({ requestedRole: "operator", clientFingerprint: "fp_waiting" }),
      ],
    });

    const vault = await dashboardGet(setup, "/dashboard/api/vault");
    expect(vault.status).toBe(200);
    const vaultText = await vault.text();
    expect(vaultText).toContain('"key":"GH_TOKEN"');
    expect(vaultText).toContain('"capletId":"status"');
    expect(vaultText).not.toContain("super-secret-token");

    await setup.engine.close();
  });

  it("returns Project Binding and runtime placeholders as mobile-friendly objects", async () => {
    const setup = await authenticatedDashboard();

    const runtime = await dashboardGet(setup, "/dashboard/api/runtime");
    expect(runtime.status).toBe(200);
    await expect(runtime.json()).resolves.toMatchObject({
      runtime: {
        status: "ok",
        bind: "127.0.0.1:5387",
        baseUrl: "http://127.0.0.1:5387/",
      },
      daemon: { restartAvailable: false, stopAvailable: false },
    });

    const binding = await dashboardGet(setup, "/dashboard/api/project-binding");
    expect(binding.status).toBe(200);
    await expect(binding.json()).resolves.toMatchObject({
      projectBinding: {
        state: "disconnected",
        affectedCaplets: [],
        actions: expect.any(Array),
      },
    });

    await setup.engine.close();
  });
  it("maps authenticated collaborator faults to internal errors without ending the session", async () => {
    const setup = await authenticatedDashboard();
    vi.spyOn(setup.engine, "enabledServers").mockImplementation(() => {
      throw new Error("collaborator failed with cap_remote_access_sensitive_value");
    });

    const response = await dashboardGet(setup, "/dashboard/api/caplets");

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(body).not.toContain("collaborator failed");
    expect(body).not.toContain("cap_remote_access_sensitive_value");
    expect(response.headers.get("set-cookie")).toBeNull();

    await setup.engine.close();
  });

  it("keeps injected SQL management behind operator cookie and CSRF checks with target-pinned receipts", async () => {
    const management = dashboardManagementFixture();
    const setup = await authenticatedDashboard(management.dependencies);

    const listed = await dashboardGet(setup, "/dashboard/api/management?resource=host-setting");
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).toContain('"owner":"filesystem"');
    expect(listText).toContain('"underlyingSqlAvailable":true');
    expect(listText).not.toContain("/private/global/config.json");
    expect(management.events).toContain("target-query");
    expect(management.events).not.toContain("source-read");
    const unavailable = await dashboardGet(setup, "/dashboard/api/management/status");
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "SERVER_UNAVAILABLE" },
    });

    const operation = {
      operationId: "operation-dashboard-u9",
      requestIdentity: "request-dashboard-u9",
      mutation: {
        kind: "host-setting-set",
        key: "telemetry",
        value: false,
        selector: "underlying-sql",
      },
    };
    const csrfRejected = await setup.app.request(
      "http://127.0.0.1:5387/dashboard/api/management/mutate",
      {
        method: "POST",
        headers: { cookie: setup.cookie, "content-type": "application/json" },
        body: JSON.stringify(operation),
      },
    );
    expect(csrfRejected.status).toBe(403);
    expect(management.events).not.toContain("reserve");

    const preview = await dashboardPost(setup, "/dashboard/api/management/preview", operation);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      status: "preview",
      target: {
        owner: "sql",
        selector: "underlying-sql",
        consequence: "no-effective-change-while-shadowed",
      },
    });

    const mutated = await dashboardPost(setup, "/dashboard/api/management/mutate", operation);
    expect(mutated.status).toBe(200);
    await expect(mutated.json()).resolves.toMatchObject({
      status: "committed",
      receipt: {
        binding: {
          operationId: operation.operationId,
          logicalHostId: "host-dashboard-u9",
          storeId: "store-dashboard-u9",
          operationNamespace: "namespace-dashboard-u9",
        },
        management: {
          owner: "sql",
          selector: "underlying-sql",
          consequence: "no-effective-change-while-shadowed",
        },
      },
    });

    setup.store.revokeClient(setup.session.operatorClientId);
    const eventCount = management.events.length;
    const revoked = await dashboardGet(setup, "/dashboard/api/management?resource=host-setting");
    expect(revoked.status).toBe(401);
    expect(management.events).toHaveLength(eventCount);

    await setup.engine.close();
  });

  it("keeps an authenticated live dashboard ready when management status is healthy", async () => {
    const management = dashboardManagementFixture();
    const setup = await authenticatedDashboard(management.dependencies);
    const requireLive = vi.spyOn(setup.engine, "requireLiveControlPlane").mockResolvedValue();
    vi.spyOn(setup.engine, "controlPlaneHealth").mockResolvedValue({
      backend: "sqlite",
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      authorityToken: { authorityGeneration: 1, effectiveGeneration: 2 },
      bootstrapCompatibility: "current",
      convergence: "single-node",
      guidanceCode: "ok",
    });
    const response = await dashboardGet(setup, "/dashboard/api/management/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      health: {
        readiness: "ready",
        connectivity: "connected",
        convergence: "single-node",
      },
    });
    expect(requireLive).toHaveBeenCalledTimes(2);

    await setup.engine.close();
  });

  it("fails status closed when live authority is lost after the health sample", async () => {
    const setup = await authenticatedDashboard(dashboardManagementFixture().dependencies);
    const requireLive = vi
      .spyOn(setup.engine, "requireLiveControlPlane")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new CapletsError("SERVER_UNAVAILABLE", "Live authority changed."));
    vi.spyOn(setup.engine, "controlPlaneHealth").mockResolvedValue({
      backend: "sqlite",
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      authorityToken: { authorityGeneration: 1, effectiveGeneration: 2 },
      bootstrapCompatibility: "current",
      convergence: "single-node",
      guidanceCode: "ok",
    });

    const response = await dashboardGet(setup, "/dashboard/api/management/status");
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(requireLive).toHaveBeenCalledTimes(2);
    expect(body).not.toContain("authorityToken");
    expect(body).not.toContain('"readiness":"ready"');

    await setup.engine.close();
  });
  it("carries one operation through multi-MiB upload, 409 rejection, and bounded range download", async () => {
    const management = dashboardManagementFixture();
    const seenOperations: Array<{ kind: string; operationId: string; byteLength?: number }> = [];
    const rangeReads: Array<{ start: number; endExclusive: number }> = [];
    const downloadBytes = new Uint8Array(2 * 1024 * 1024 + 17);
    downloadBytes.fill(7);
    let expectedByteLength = 0;
    let expectedSha256 = "";
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const portable: CurrentHostPortableOperations = {
      async execute(principal, operation) {
        seenOperations.push({
          kind: operation.kind,
          operationId: operation.binding.operationId,
          ...("bytes" in operation ? { byteLength: operation.bytes.byteLength } : {}),
        });
        const session = {
          sessionId: "portable-session",
          artifactId: "portable-upload",
          actorId: principal.clientId,
          operationId: operation.binding.operationId,
          direction: "upload" as const,
          state: "uploading" as const,
          nextOffset: expectedByteLength,
          expectedByteLength,
          expectedSha256,
          mimeType: "application/vnd.caplets.portable",
          providerIdentityId: "provider-dashboard",
          expiresAt,
        };
        switch (operation.kind) {
          case "portable_import_session_create":
            expectedByteLength = operation.expectedByteLength;
            expectedSha256 = operation.expectedSha256;
            return {
              kind: operation.kind,
              status: "created",
              session: {
                ...session,
                nextOffset: 0,
                expectedByteLength,
                expectedSha256,
              },
            };
          case "portable_import_session_append":
            return {
              kind: operation.kind,
              status: "accepted",
              session: { ...session, nextOffset: operation.offset + operation.bytes.byteLength },
            };
          case "portable_import_session_finalize": {
            const reference = createPortableArtifactReference({
              artifactId: "portable-upload",
              logicalHostId: operation.binding.logicalHostId,
              storeId: operation.binding.storeId,
              providerIdentityId: "provider-dashboard",
              actorId: principal.clientId,
              operationId: operation.binding.operationId,
              direction: "upload",
              byteLength: expectedByteLength,
              sha256: expectedSha256,
              mimeType: "application/vnd.caplets.portable",
              expiresAt,
            });
            return {
              kind: operation.kind,
              status: "finalized",
              session: { ...session, state: "finalized", finalizedAt: expiresAt },
              artifact: {
                reference,
                sha256: expectedSha256,
                byteLength: expectedByteLength,
                mimeType: "application/vnd.caplets.portable",
              },
            };
          }
          case "portable_import_preview":
            return {
              kind: operation.kind,
              status: "previewed",
              proposal: {
                proposalId: "portable-proposal",
                artifactId: operation.artifactReference.artifactId,
                actorId: principal.clientId,
                operationId: operation.binding.operationId,
                capletId: "portable-caplet",
                proposalHash: "b".repeat(64),
                expectedAuthorityGeneration: 1,
                expectedEffectiveGeneration: 2,
                expectedAggregateVersion: 1,
                expectedSecurityEpoch: 3,
                expectedRuntimeFingerprint: "runtime-fingerprint",
                collisionPolicy: operation.collisionPolicy,
                replacementConfirmed: operation.replacementConfirmed,
                consequence: "effective-runtime-changes",
                differences: [],
                setupDependencies: [],
                state: "previewed",
                expiresAt,
              },
            };
          case "portable_import_activate":
            return { kind: operation.kind, status: "rejected", reason: "stale" };
          case "portable_artifact_download_range":
            rangeReads.push({ start: operation.start, endExclusive: operation.endExclusive });
            return {
              kind: operation.kind,
              status: "ok",
              bytes: downloadBytes.slice(operation.start, operation.endExclusive),
              start: operation.start,
              endExclusive: operation.endExclusive,
              totalLength: downloadBytes.byteLength,
            };
          default:
            throw new Error(`Unexpected portable operation ${operation.kind}`);
        }
      },
    };
    const setup = await authenticatedDashboard(management.dependencies, portable);
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/dashboard/caplets" },
    });
    setDashboardSession({
      sessionId: "dashboard-session",
      operatorClientId: setup.session.operatorClientId,
      csrfToken: setup.session.csrfToken,
    });
    vi.stubGlobal("fetch", (input: string | URL | Request, init: RequestInit = {}) => {
      const target =
        input instanceof Request ? input.url : new URL(String(input), "http://127.0.0.1:5387").href;
      const headers = new Headers(init.headers);
      headers.set("cookie", setup.cookie);
      return setup.app.request(target, { ...init, headers });
    });

    const operationId = "portable-dashboard-integration";
    const uploadBytes = new Uint8Array(2 * 1024 * 1024 + 17);
    uploadBytes.fill(3);
    const wholeSha256 = createHash("sha256").update(uploadBytes).digest("hex");
    const created = await dashboardPortableOperation(
      {
        kind: "portable_import_session_create",
        expectedByteLength: uploadBytes.byteLength,
        expectedSha256: wholeSha256,
        mimeType: "application/vnd.caplets.portable",
      },
      operationId,
    );
    if (created.kind !== "portable_import_session_create") {
      throw new Error("Expected portable upload session.");
    }
    for (let offset = 0; offset < uploadBytes.byteLength; offset += 1024 * 1024) {
      const bytes = uploadBytes.slice(offset, offset + 1024 * 1024);
      await dashboardPortableUploadChunk({
        sessionId: created.session.sessionId,
        operationId,
        offset,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      });
    }
    const finalized = await dashboardPortableOperation(
      { kind: "portable_import_session_finalize", sessionId: created.session.sessionId },
      operationId,
    );
    if (finalized.kind !== "portable_import_session_finalize") {
      throw new Error("Expected finalized portable upload.");
    }
    const previewed = await dashboardPortableOperation(
      {
        kind: "portable_import_preview",
        artifactReference: finalized.artifact.reference,
        collisionPolicy: "reject",
        replacementConfirmed: false,
      },
      operationId,
    );
    if (previewed.kind !== "portable_import_preview" || previewed.status !== "previewed") {
      throw new Error("Expected portable preview.");
    }
    await expect(
      dashboardPortableOperation(
        {
          kind: "portable_import_activate",
          proposalId: previewed.proposal.proposalId,
          proposalHash: previewed.proposal.proposalHash,
        },
        operationId,
      ),
    ).resolves.toEqual({
      kind: "portable_import_activate",
      status: "rejected",
      reason: "stale",
    });

    expect(seenOperations.map(({ operationId: seen }) => seen)).toEqual(
      Array(seenOperations.length).fill(operationId),
    );
    expect(
      seenOperations
        .filter(({ kind }) => kind === "portable_import_session_append")
        .map(({ byteLength }) => byteLength),
    ).toEqual([1024 * 1024, 1024 * 1024, 17]);

    const downloadReference = createPortableArtifactReference({
      artifactId: "portable-download",
      logicalHostId: management.dependencies.storage.identity.logicalHostId,
      storeId: management.dependencies.storage.identity.storeId,
      providerIdentityId: "provider-dashboard",
      actorId: setup.session.operatorClientId,
      operationId,
      direction: "download",
      byteLength: downloadBytes.byteLength,
      sha256: createHash("sha256").update(downloadBytes).digest("hex"),
      mimeType: "application/vnd.caplets.portable",
      expiresAt,
    });
    const downloadUrl = dashboardPortableDownload(downloadReference.uri);
    const streamed = await fetch(downloadUrl);
    expect(streamed.status).toBe(200);
    expect(
      createHash("sha256")
        .update(new Uint8Array(await streamed.arrayBuffer()))
        .digest("hex"),
    ).toBe(createHash("sha256").update(downloadBytes).digest("hex"));
    expect(rangeReads).toEqual([
      { start: 0, endExclusive: 1024 * 1024 },
      { start: 1024 * 1024, endExclusive: 2 * 1024 * 1024 },
      { start: 2 * 1024 * 1024, endExclusive: 2 * 1024 * 1024 + 17 },
    ]);

    rangeReads.length = 0;
    const ranged = await fetch(downloadUrl, { headers: { range: "bytes=1048570-1048590" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 1048570-1048590/${downloadBytes.byteLength}`,
    );
    expect((await ranged.arrayBuffer()).byteLength).toBe(21);
    expect(rangeReads).toEqual([{ start: 1_048_570, endExclusive: 1_048_591 }]);

    await setup.engine.close();
  });

  it("synthesizes remote management bindings from canonical top-level DTOs", async () => {
    const management = dashboardManagementFixture();
    const setup = await authenticatedDashboard(management.dependencies);
    const requireLive = vi.spyOn(setup.engine, "requireLiveControlPlane").mockResolvedValue();
    const pending = setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
    });
    setup.store.approvePendingLogin({ operatorCode: pending.operatorCode });
    const operator = setup.store.completePendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
    });
    const remoteRequest = async (
      command: string,
      argumentsValue: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const response = await setup.app.request("http://127.0.0.1:5387/v1/admin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${operator.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command, arguments: argumentsValue }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const requestIdentity = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const mutation = {
      kind: "host-setting-set",
      key: "telemetry",
      value: false,
      selector: "underlying-sql",
    };
    const commands = [
      {
        command: "current_host_list",
        canonical: { action: "list", resource: "host-setting" },
        arguments: { resource: "host-setting" },
      },
      {
        command: "current_host_inspect",
        canonical: {
          action: "inspect",
          resource: "host-setting",
          id: "telemetry",
          selector: "underlying-sql",
        },
        arguments: { resource: "host-setting", id: "telemetry", selector: "underlying-sql" },
      },
      {
        command: "current_host_preview",
        canonical: mutation,
        arguments: { mutation },
      },
      {
        command: "current_host_mutate",
        canonical: mutation,
        arguments: { mutation },
      },
      {
        command: "current_host_status",
        canonical: { action: "status" },
        arguments: {},
      },
    ] as const;
    let committedBinding: Record<string, unknown> | undefined;
    for (const [index, command] of commands.entries()) {
      const operationId = `remote-management-${index}`;
      const response = await remoteRequest(command.command, {
        ...command.arguments,
        operationId,
        requestIdentity: requestIdentity(command.canonical),
        binding: {
          operationId: "attacker-operation",
          target: "global",
          logicalHostId: "attacker-host",
          storeId: "attacker-store",
          operationNamespace: "attacker-namespace",
          actorId: "attacker",
          requestIdentity: "0".repeat(64),
          operationClass: "maintenance",
        },
      });
      expect(response.ok).toBe(true);
      const result = response.result as Record<string, unknown>;
      const resultBinding =
        command.command === "current_host_mutate"
          ? ((result.receipt as Record<string, unknown>).binding as Record<string, unknown>)
          : (result.binding as Record<string, unknown>);
      expect(resultBinding).toMatchObject({
        operationId,
        target: "remote",
        logicalHostId: "host-dashboard-u9",
        storeId: "store-dashboard-u9",
        operationNamespace: "namespace-dashboard-u9",
        actorId: operator.clientId,
        requestIdentity: requestIdentity(command.canonical),
        operationClass: "logical-state",
      });
      if (command.command === "current_host_mutate") committedBinding = resultBinding;
    }
    if (!committedBinding) throw new Error("Remote mutation binding was not returned.");
    await expect(
      remoteRequest("current_host_operation_lookup", { binding: committedBinding }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      remoteRequest("current_host_operation_lookup", {
        binding: { ...committedBinding, target: "global" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED" },
    });
    await expect(
      remoteRequest("current_host_list", {
        resource: "host-setting",
        operationId: "remote-management-tampered",
        requestIdentity: "0".repeat(64),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "requestIdentity does not match the canonical Current Host command.",
      },
    });

    const pairing = setup.store.createPairingCode({ hostUrl: "http://127.0.0.1:5387/" });
    const access = setup.store.exchangePairingCode({
      hostUrl: "http://127.0.0.1:5387/",
      code: pairing.code,
    });
    const denied = await setup.app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "current_host_status",
        arguments: {
          operationId: "remote-management-denied",
          requestIdentity: requestIdentity({ action: "status" }),
        },
      }),
    });
    expect(denied.status).toBe(403);
    expect(requireLive).toHaveBeenCalled();

    await setup.engine.close();
  });
});

async function authenticatedDashboard(
  currentHostManagement?: CurrentHostManagementDependencies | undefined,
  currentHostPortable?: CurrentHostPortableOperations | undefined,
) {
  const setup = testApp(currentHostManagement, currentHostPortable);
  const vault = new FileVaultStore({ root: join(setup.authDir, "vault") });
  vault.set("GH_TOKEN", "super-secret-token");
  vault.grantAccess({
    storedKey: "GH_TOKEN",
    referenceName: "GH_TOKEN",
    capletId: "status",
    origin: { kind: "global-config", path: setup.context.configPath },
  });
  const started = await appPost(setup, "/dashboard/api/login/start", { clientLabel: "Browser" });
  const startBody = (await started.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    approvalCommand: string;
  };
  setup.store.approvePendingLogin({ operatorCode: approvalCode(startBody.approvalCommand) });
  const completed = await appPost(setup, "/dashboard/api/login/complete", {
    flowId: startBody.flowId,
    pendingCompletionSecret: startBody.pendingCompletionSecret,
  });
  expect(completed.status).toBe(200);
  const completedBody = (await completed.json()) as {
    authenticated: boolean;
    session: { operatorClientId: string; csrfToken: string };
  };
  const cookie = completed.headers.get("set-cookie") ?? "";
  return { ...setup, cookie, session: completedBody.session };
}

async function dashboardGet(
  setup: { app: ReturnType<typeof createHttpServeApp>; cookie: string },
  path: string,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie },
  });
}

async function dashboardPost(
  setup: {
    app: ReturnType<typeof createHttpServeApp>;
    cookie: string;
    session: { csrfToken: string };
  },
  path: string,
  body: unknown,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      cookie: setup.cookie,
      "content-type": "application/json",
      "x-caplets-csrf": setup.session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

async function appPost(
  setup: { app: ReturnType<typeof createHttpServeApp> },
  path: string,
  body: unknown,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function approvalCode(command: string): string {
  const code = command.match(/approve\s+(cap_login_[^\s]+)/u)?.[1];
  if (!code) throw new Error(`Could not find approval code in ${command}`);
  return code;
}

function testApp(
  currentHostManagement?: CurrentHostManagementDependencies | undefined,
  currentHostPortable?: CurrentHostPortableOperations | undefined,
) {
  const stateDir = tempDir("caplets-dashboard-api-state-");
  const authDir = tempDir("caplets-dashboard-api-auth-");
  const context = testContext();
  const engine = CapletsEngine.unactivatedForTests({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    authDir,
    watch: false,
  });
  (engine as unknown as { runtimeSnapshot: { securityEpoch: number } }).runtimeSnapshot = {
    securityEpoch: 1,
  };
  const store = new RemoteServerCredentialStore({ dir: stateDir });
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: { ...context, authDir },
    remoteCredentialStore: store,
    currentHostManagement,
    currentHostPortable,
  });
  return { app, engine, store, stateDir, authDir, context };
}

function httpOptions(stateDir: string): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    auth: { type: "remote_credentials" },
    remoteCredentialStateDir: stateDir,
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
  };
}

function testContext(): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
} {
  const dir = tempDir("caplets-dashboard-api-");
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        status: {
          name: "Status",
          description: "Status API.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  return { configPath, projectConfigPath, projectCapletsRoot: projectRoot };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function dashboardManagementFixture(): {
  dependencies: CurrentHostManagementDependencies;
  events: string[];
} {
  const events: string[] = [];
  const identity = {
    logicalHostId: "host-dashboard-u9",
    storeId: "store-dashboard-u9",
    operationNamespace: "namespace-dashboard-u9",
  };
  const snapshot = {
    identity,
    versions: { authorityGeneration: 1, effectiveGeneration: 2, securityEpoch: 3 },
    caplets: [],
    hostSettings: [
      { version: 1, key: "telemetry", value: true, updatedAt: "2026-07-15T00:00:00.000Z" },
    ],
    hostSettingVersions: { telemetry: 1 },
    encodedBytes: 0,
    normalizedRows: 1,
  } as const;
  const target = {
    resource: "host-setting",
    id: "telemetry",
    selector: "underlying-sql",
    owner: "sql",
    source: { kind: "sql" },
    effective: true,
    effectiveChanged: false,
    shadowChain: [
      { owner: "sql", source: { kind: "sql" } },
      { owner: "filesystem", source: { kind: "global-config" } },
    ],
    underlyingSqlAvailable: true,
    consequence: "no-effective-change-while-shadowed",
  } as const;
  const reservations = new Set<string>();
  const dependencies: CurrentHostManagementDependencies = {
    storage: {
      identity,
      async reserveOperation(binding) {
        events.push("reserve");
        reservations.add(binding.operationId);
        return { status: "reserved", binding };
      },
      async loadSnapshot(binding) {
        events.push("source-read");
        return { status: "ok", binding, snapshot };
      },
      async mutateCaplet() {
        throw new Error("unexpected Caplet mutation");
      },
      async mutateHostSetting(input) {
        events.push("mutate");
        const receipt: CurrentHostOperationReceipt = {
          status: "committed",
          binding: input.binding,
          aggregateVersion: 2,
          authorityToken: { authorityGeneration: 1, effectiveGeneration: 2 },
          localApplication: "not-applicable",
          convergence: { kind: "single-node" },
          management: target,
        };
        return { status: "committed", receipt };
      },
      async lookupOperation(binding) {
        events.push("lookup");
        return reservations.has(binding.operationId)
          ? { status: "unknown", binding }
          : {
              status: "not_committed",
              binding,
              retryReservationId: `retry_${binding.operationId}`,
            };
      },
      async status(binding) {
        return { status: "unavailable", binding };
      },
    },
    async loadRuntimeSnapshot() {
      events.push("target-query");
      return {
        identity,
        authorityGeneration: 1,
        effectiveGeneration: 2,
        securityEpoch: 3,
        caplets: {},
        hostSettings: {
          telemetry: {
            key: "telemetry",
            owner: "filesystem",
            source: { kind: "global-config", path: "/private/global/config.json" },
            effective: true,
            shadowChain: [
              { owner: "sql", source: { kind: "sql", path: "sql://private" } },
              {
                owner: "filesystem",
                source: { kind: "global-config", path: "/private/global/config.json" },
              },
            ],
            underlyingSql: {
              owner: "sql",
              source: { kind: "sql", path: "sql://private" },
            },
          },
        },
      } as never;
    },
  };
  return { dependencies, events };
}
