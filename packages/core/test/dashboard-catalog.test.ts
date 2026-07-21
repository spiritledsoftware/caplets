import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentHostCatalogInstallSource } from "../src/current-host/catalog";
import { CapletsEngine } from "../src/engine";
import { createHostStorage, type HostStorage } from "../src/storage";
import type { RemoteSecurityStore } from "../src/storage/remote-security";
import { createHttpServeApp, type CapletsHttpApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("dashboard caplets and catalog APIs", () => {
  it("serves the official catalog API for dashboard browsing and detail", async () => {
    const setup = await authenticatedDashboard();
    const officialEntryKey = "github:spiritledsoftware:caplets:github%2FCAPLET.md:github";
    const officialEntry = {
      ...officialCompactEntry(0),
      entryKey: officialEntryKey,
      id: "github",
      name: "GitHub from API",
      description: "Work with GitHub repositories.",
      sourcePath: "github/CAPLET.md",
      tags: ["github"],
      intendedTask: "Work with GitHub repositories.",
      authReadiness: "required",
      installCommand: {
        text: "caplets install spiritledsoftware/caplets github",
        copyable: true,
        revisionBound: false,
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/entries/")) {
        return Response.json({
          version: 1,
          entry: { ...officialEntry, contentMarkdown: "# GitHub from catalog.caplets.dev" },
        });
      }
      return Response.json({
        version: 1,
        view: "compact",
        entries: [officialEntry],
      });
    });

    const search = await dashboardGet(setup, "/dashboard/api/v2/catalog/entries?source=official");
    expect(search.status, await search.clone().text()).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: "github",
          name: "GitHub from API",
          source: expect.objectContaining({ repository: "spiritledsoftware/caplets" }),
        }),
      ],
    });

    const detail = await dashboardGet(
      setup,
      `/dashboard/api/v2/catalog/entries/${encodeURIComponent(officialEntryKey)}?source=official`,
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      entry: {
        id: "github",
        contentMarkdown: "# GitHub from catalog.caplets.dev",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://catalog.caplets.dev/api/v1/catalog?view=compact",
      { signal: expect.any(AbortSignal) },
    );

    await closeDashboard(setup);
  });

  it("returns all 150 compact official entries without the former search ceiling", async () => {
    const setup = await authenticatedDashboard();
    const entries = Array.from({ length: 150 }, (_, index) => officialCompactEntry(index));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ version: 1, view: "compact", entries }),
    );

    const response = await dashboardGet(
      setup,
      "/dashboard/api/v2/catalog/entries?source=official&limit=500",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(150);
    expect(body.items).toContainEqual(expect.objectContaining({ id: "entry-149" }));
    expect(body.items.some((entry) => "contentMarkdown" in entry)).toBe(false);

    await closeDashboard(setup);
  });

  it("honors bounded catalog page limits", async () => {
    const setup = await authenticatedDashboard();
    const entries = Array.from({ length: 5 }, (_, index) => officialCompactEntry(index));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ version: 1, view: "compact", entries }),
    );

    const response = await dashboardGet(
      setup,
      "/dashboard/api/v2/catalog/entries?source=official&limit=2&sort=desc",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(2);
    expect(body.items).toEqual([
      expect.objectContaining({ id: "entry-4" }),
      expect.objectContaining({ id: "entry-3" }),
    ]);

    await closeDashboard(setup);
  });

  it("rejects an official compact index above 10,000 entries as a protocol error", async () => {
    const setup = await authenticatedDashboard();
    const entry = officialCompactEntry(0);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        version: 1,
        view: "compact",
        entries: Array.from({ length: 10_001 }, () => entry),
      }),
    );

    const response = await dashboardGet(setup, "/dashboard/api/v2/catalog/entries?source=official");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });

    await closeDashboard(setup);
  });

  it("rejects overlong compact fields as a protocol error", async () => {
    const setup = await authenticatedDashboard();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        version: 1,
        view: "compact",
        entries: [{ ...officialCompactEntry(0), name: "x".repeat(1_025) }],
      }),
    );

    const response = await dashboardGet(setup, "/dashboard/api/v2/catalog/entries?source=official");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });

    await closeDashboard(setup);
  });

  it.each([
    [
      "missing readiness",
      (entry: Record<string, unknown>) => {
        delete entry.setupReadiness;
      },
    ],
    [
      "missing workflow",
      (entry: Record<string, unknown>) => {
        delete entry.workflow;
      },
    ],
    [
      "null warning",
      (entry: Record<string, unknown>) => {
        entry.warnings = [null];
      },
    ],
    [
      "invalid warning enum",
      (entry: Record<string, unknown>) => {
        entry.warnings = [{ code: "bogus", severity: "info", label: "Warning", message: "Bad." }];
      },
    ],
    [
      "overlong warning",
      (entry: Record<string, unknown>) => {
        entry.warnings = [
          {
            code: "auth_required",
            severity: "info",
            label: "x".repeat(257),
            message: "Bad.",
          },
        ];
      },
    ],
    [
      "substituted repository",
      (entry: Record<string, unknown>) => {
        entry.source = {
          provider: "github",
          owner: "attacker",
          repo: "caplets",
          repository: "attacker/caplets",
          canonicalUrl: "https://github.com/attacker/caplets",
        };
      },
    ],
    [
      "localhost icon",
      (entry: Record<string, unknown>) => {
        entry.icon = { type: "url", url: "https://localhost/icon.png" };
      },
    ],
    [
      "HTTP icon",
      (entry: Record<string, unknown>) => {
        entry.icon = { type: "url", url: "http://example.com/icon.png" };
      },
    ],
  ])("rejects official compact entries with %s", async (_label, mutate) => {
    const setup = await authenticatedDashboard();
    const entry = officialCompactEntry(0) as Record<string, unknown>;
    mutate(entry);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ version: 1, view: "compact", entries: [entry] }),
    );

    const response = await dashboardGet(setup, "/dashboard/api/v2/catalog/entries?source=official");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
    await closeDashboard(setup);
  });

  it("pins official installer input to the inspected revision", () => {
    expect(currentHostCatalogInstallSource("official", "abc123")).toBe(
      "spiritledsoftware/caplets#abc123",
    );
  });

  it("rejects official detail whose returned entryKey differs from the requested key", async () => {
    const setup = await authenticatedDashboard();
    const requested = officialCompactEntry(0);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        version: 1,
        entry: {
          ...requested,
          entryKey: "github:spiritledsoftware:caplets:other%2FCAPLET.md:other",
          id: "other",
          contentMarkdown: "# Other",
          installCommand: {
            text: "caplets install spiritledsoftware/caplets other",
            copyable: true,
            revisionBound: false,
          },
        },
      }),
    );

    const response = await dashboardGet(
      setup,
      `/dashboard/api/v2/catalog/entries/${encodeURIComponent(requested.entryKey)}?source=official`,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
    await closeDashboard(setup);
  });

  it("searches catalog sources and returns detail readiness, warnings, and install metadata", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const search = await dashboardGet(
      setup,
      `/dashboard/api/v2/catalog/entries?source=${encodeURIComponent(source)}`,
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: "sample",
          setupReadiness: "required",
          authReadiness: "required",
          projectBindingReadiness: "required",
          warnings: expect.arrayContaining([
            expect.objectContaining({ code: "auth_required" }),
            expect.objectContaining({ code: "setup_required" }),
            expect.objectContaining({ code: "project_binding_required" }),
          ]),
          installCommand: expect.objectContaining({
            text: expect.stringContaining("caplets install"),
          }),
        }),
      ],
    });

    const detail = await dashboardGet(
      setup,
      `/dashboard/api/v2/catalog/entries/${encodeURIComponent(await localEntryKey(setup, source))}?source=${encodeURIComponent(source)}`,
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      entry: { id: "sample", workflow: { kind: "http" } },
      setupActions: expect.arrayContaining([
        expect.objectContaining({ kind: "auth", required: true }),
        expect.objectContaining({ kind: "project_binding", required: true }),
        expect.objectContaining({ kind: "code_mode", required: false }),
      ]),
      projectScopedInstallAvailable: false,
    });

    await closeDashboard(setup);
  });

  it("installs catalog caplets globally as SQL records and installations", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const installed = await dashboardPost(setup, "/dashboard/api/v2/catalog/installations", {
      source,
      entryKey: await localEntryKey(setup, source),
    });
    expect(installed.status, await installed.clone().text()).toBe(201);
    const installedBody = (await installed.json()) as {
      installed: Array<Record<string, unknown>>;
      setupActions: unknown[];
      installedCount: number;
      setupActionCount: number;
    };
    expect(installedBody).toMatchObject({
      installed: [
        expect.objectContaining({
          kind: "file",
          status: "installed",
        }),
      ],
      installedCount: 1,
      setupActions: expect.arrayContaining([expect.objectContaining({ kind: "auth" })]),
      setupActionCount: expect.any(Number),
    });
    expect(installedBody.installed[0]).not.toHaveProperty("lockfile");
    expect(installedBody.setupActionCount).toBeGreaterThanOrEqual(
      installedBody.setupActions.length,
    );

    const record = await setup.storage.caplets.readBundle("sample", {
      operator: { clientId: setup.operatorClientId, role: "operator" },
    });
    const installation = await setup.storage.installations.getActive("sample");
    const observation = await setup.storage.installations.getLatestObservation("sample");
    expect(record).toMatchObject({
      record: { id: "sample", headGeneration: 1 },
      files: [expect.objectContaining({ path: "CAPLET.md" })],
    });
    expect(installation).toMatchObject({
      capletId: "sample",
      generation: 1,
      status: "active",
      sourceKind: "local",
      sourceIdentity: source,
    });
    expect(observation).toMatchObject({
      status: "current",
      contentHash: expect.stringMatching(/^sha256:/),
    });
    expect(installation?.recordKey).toBe(record?.record.recordKey);
    expect(existsSync(setup.context.globalCapletsRoot)).toBe(false);
    expect(existsSync(setup.context.globalLockfilePath)).toBe(false);
    expect(await setup.storage.installations.listActivity()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operatorClientId: setup.operatorClientId,
          action: "caplet.import",
        }),
      ]),
    );

    const updates = await dashboardGet(setup, "/dashboard/api/v2/catalog/update-candidates");
    expect(updates.status).toBe(200);
    await expect(updates.json()).resolves.toEqual({ items: [] });

    const activity = await dashboardGet(setup, "/dashboard/api/v2/activity");
    expect(activity.status).toBe(200);
    const text = await activity.text();
    expect(text).toContain('"action":"catalog_installed"');
    expect(text).toContain('"id":"sample"');
    expect(text).toContain(setup.operatorClientId);
    expect(text).not.toContain(source);

    await closeDashboard(setup);
  });

  it("requires acknowledgement for SQL catalog updates that increase risk", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const installed = await dashboardPost(setup, "/dashboard/api/v2/catalog/installations", {
      source,
      entryKey: await localEntryKey(setup, source),
    });
    expect(installed.status, await installed.clone().text()).toBe(201);
    makeCatalogSourceDestructive(source);

    const rejected = await dashboardPost(setup, "/dashboard/api/v2/catalog/update-runs", {
      capletIds: ["sample"],
      acknowledgeRiskIncrease: false,
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "REQUEST_INVALID",
      detail: expect.stringContaining("risk profile"),
    });
    await expect(setup.storage.caplets.get("sample")).resolves.toMatchObject({
      headGeneration: 1,
    });
    await expect(setup.storage.installations.getActive("sample")).resolves.toMatchObject({
      generation: 1,
    });

    const updated = await dashboardPost(setup, "/dashboard/api/v2/catalog/update-runs", {
      capletIds: ["sample"],
      acknowledgeRiskIncrease: true,
    });
    expect(updated.status).toBe(201);
    await expect(updated.json()).resolves.toMatchObject({
      installed: [
        expect.objectContaining({
          kind: "file",
          status: "updated",
        }),
      ],
      installedCount: 1,
    });
    await expect(setup.storage.caplets.get("sample")).resolves.toMatchObject({
      headGeneration: 2,
    });
    await expect(setup.storage.installations.getActive("sample")).resolves.toMatchObject({
      generation: 2,
    });
    await expect(setup.storage.installations.getLatestObservation("sample")).resolves.toMatchObject(
      {
        status: "current",
        risk: expect.objectContaining({ destructive: true }),
      },
    );
    expect(existsSync(setup.context.globalCapletsRoot)).toBe(false);
    expect(existsSync(setup.context.globalLockfilePath)).toBe(false);

    await closeDashboard(setup);
  });

  it("does not report unavailable catalog update sources as unauthorized", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const installed = await dashboardPost(setup, "/dashboard/api/v2/catalog/installations", {
      source,
      entryKey: await localEntryKey(setup, source),
    });
    expect(installed.status, await installed.clone().text()).toBe(201);

    rmSync(source, { recursive: true, force: true });

    const update = await dashboardPost(setup, "/dashboard/api/v2/catalog/update-runs", {
      capletIds: ["sample"],
      acknowledgeRiskIncrease: true,
    });
    expect(update.status).toBe(404);
    await expect(update.json()).resolves.toMatchObject({
      code: "CONFIG_NOT_FOUND",
    });
    await expect(setup.storage.installations.getLatestObservation("sample")).resolves.toMatchObject(
      {
        status: "source-unavailable",
      },
    );

    await closeDashboard(setup);
  });
  it("rejects dashboard install before an unvalidated source reaches installation", async () => {
    const setup = await authenticatedDashboard();
    const source =
      "https://operator:credential@127.0.0.1:1/private-repository?token=transport_secret";

    const dashboardResponse = await dashboardPost(
      setup,
      "/dashboard/api/v2/catalog/installations",
      {
        source,
        entryKey: "github:local:source:caplets%2Fsample.md:sample",
      },
    );
    expect(dashboardResponse.status).toBe(404);
    const dashboardError = (await dashboardResponse.json()) as {
      code: string;
      detail: string;
    };

    const pending = await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
    });
    await setup.store.approvePendingLogin({
      operatorClientId: "bootstrap_bearer_test",
      operatorCode: pending.operatorCode,
      grantedRole: "operator",
    });
    const operator = await setup.store.completePendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
    });
    const bearerResponse = await setup.app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "install",
        arguments: { repo: source, capletIds: ["sample"] },
      }),
    });
    expect(bearerResponse.status).toBe(200);
    const bearerError = (await bearerResponse.json()) as {
      error: { code: string; message: string };
    };

    expect(dashboardError).toMatchObject({ code: "CONFIG_NOT_FOUND" });
    expect(bearerError.error).toMatchObject({
      code: "CONFIG_NOT_FOUND",
      message: "Could not clone repo [REDACTED]",
    });
    expect(JSON.stringify({ dashboardError, bearerError })).not.toContain("credential");
    expect(JSON.stringify({ dashboardError, bearerError })).not.toContain("transport_secret");
    expect(JSON.stringify({ dashboardError, bearerError })).not.toContain("127.0.0.1");

    await closeDashboard(setup);
  });
});

interface DashboardCatalogTestContext {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
  globalCapletsRoot: string;
  globalLockfilePath: string;
}

interface TestAppSetup {
  app: CapletsHttpApp;
  engine: CapletsEngine;
  store: RemoteSecurityStore;
  storage: HostStorage;
  stateDir: string;
  context: DashboardCatalogTestContext;
}

interface AuthenticatedDashboard extends TestAppSetup {
  cookie: string;
  csrfToken: string;
  operatorClientId: string;
}

async function authenticatedDashboard(): Promise<AuthenticatedDashboard> {
  const setup = await testApp();
  const started = await appPost(setup, "/dashboard/api/login/start", { clientLabel: "Browser" });
  const startBody = (await started.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    approvalCommand: string;
  };
  await setup.store.approvePendingLogin({
    operatorClientId: "bootstrap_test",
    operatorCode: approvalCode(startBody.approvalCommand),
    grantedRole: "operator",
  });
  const completed = await appPost(setup, "/dashboard/api/login/complete", {
    flowId: startBody.flowId,
    pendingCompletionSecret: startBody.pendingCompletionSecret,
  });
  expect(completed.status).toBe(200);
  const cookie = completed.headers.get("set-cookie") ?? "";
  const body = (await completed.json()) as {
    session: { csrfToken: string; operatorClientId: string };
  };
  return {
    ...setup,
    cookie,
    csrfToken: body.session.csrfToken,
    operatorClientId: body.session.operatorClientId,
  };
}

async function localEntryKey(setup: AuthenticatedDashboard, source: string): Promise<string> {
  const response = await dashboardGet(
    setup,
    `/dashboard/api/v2/catalog/entries?source=${encodeURIComponent(source)}`,
  );
  const body = (await response.json()) as { items: Array<{ entryKey: string }> };
  const entryKey = body.items[0]?.entryKey;
  if (!entryKey) throw new Error("Missing local catalog entry");
  return entryKey;
}

async function dashboardGet(setup: AuthenticatedDashboard, path: string) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie },
  });
}

async function dashboardPost(setup: AuthenticatedDashboard, path: string, body: unknown) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      cookie: setup.cookie,
      "x-caplets-csrf": setup.csrfToken,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "if-none-match": "*",
    },
    body: JSON.stringify(body),
  });
}

async function appPost(setup: { app: CapletsHttpApp }, path: string, body: unknown) {
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

async function testApp(): Promise<TestAppSetup> {
  const stateDir = tempDir("caplets-dashboard-catalog-state-");
  const context = testContext();
  const storage = await createHostStorage(
    { type: "sqlite", path: join(stateDir, "host.sqlite3") },
    { vaultRoot: join(stateDir, "vault") },
  );
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    hostStorage: storage,
    watch: false,
  });
  const store = storage.remoteSecurity;
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: context,
    authoritativeStorage: storage,
  });
  return { app, engine, store, storage, stateDir, context };
}
async function closeDashboard(setup: TestAppSetup): Promise<void> {
  await setup.engine.close();
  await setup.storage.close();
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
    adminUploads: {
      stagingDir: join(tmpdir(), "caplets-uploads"),
      maxConcurrent: 1,
      maxStagedBytes: 400_000_000,
    },
  };
}

function testContext(): DashboardCatalogTestContext {
  const dir = tempDir("caplets-dashboard-catalog-");
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
  return {
    configPath,
    projectConfigPath,
    projectCapletsRoot: projectRoot,
    globalCapletsRoot: join(dir, "global-caplets"),
    globalLockfilePath: join(dir, "remote-state", "caplets.lock.json"),
  };
}

function catalogSource(): string {
  const source = tempDir("caplets-dashboard-catalog-source-");
  mkdirSync(join(source, "caplets"), { recursive: true });
  writeCatalogSource(source, "POST");
  return source;
}

function makeCatalogSourceDestructive(source: string): void {
  writeCatalogSource(source, "DELETE");
}

function writeCatalogSource(source: string, method: "POST" | "DELETE"): void {
  writeFileSync(
    join(source, "caplets", "sample.md"),
    [
      "---",
      "name: Sample",
      "description: Sample Caplet.",
      "tags: [sample, dashboard]",
      "setup:",
      "  commands:",
      "    - label: Install deps",
      "      command: pnpm",
      "      args: [install]",
      "projectBinding:",
      "  required: true",
      "httpApi:",
      "  baseUrl: https://api.example.test",
      "  auth:",
      "    type: bearer",
      "    token: $env:SAMPLE_TOKEN",
      "  actions:",
      "    create:",
      `      method: ${method}`,
      "      path: /items",
      "---",
      "",
      "# Sample",
      "",
    ].join("\n"),
  );
}

function officialCompactEntry(index: number) {
  const id = `entry-${index}`;
  return {
    entryKey: `github:spiritledsoftware:caplets:${id}%2Fcaplet.md:${id}`,
    id,
    name: `Entry ${index}`,
    description: "Catalog entry.",
    source: {
      provider: "github",
      owner: "spiritledsoftware",
      repo: "caplets",
      repository: "spiritledsoftware/caplets",
      canonicalUrl: "https://github.com/spiritledsoftware/caplets",
    },
    sourcePath: `${id}/CAPLET.md`,
    trustLevel: "official",
    tags: ["test"],
    intendedTask: "Test catalog behavior.",
    setupReadiness: "ready",
    authReadiness: "ready",
    projectBindingReadiness: "ready",
    warnings: [],
    installCommand: {
      text: `caplets install spiritledsoftware/caplets ${id}`,
      copyable: true,
      revisionBound: false,
    },
    workflow: { kind: "code_mode", label: "Code Mode" },
    installCount: 0,
    installCountDisplay: "<10",
    rankScore: 0,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
