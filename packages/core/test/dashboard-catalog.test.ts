import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp, type CapletsHttpApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard caplets and catalog APIs", () => {
  it("serves the checked-in official catalog for dashboard browsing", async () => {
    const setup = await authenticatedDashboard();

    const search = await dashboardGet(
      setup,
      "/dashboard/api/catalog/search?source=official&q=github",
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          id: "github",
          name: "GitHub",
          source: expect.objectContaining({ repository: "spiritledsoftware/caplets" }),
          installCommand: expect.objectContaining({
            text: "caplets install spiritledsoftware/caplets github",
          }),
        }),
      ],
    });

    await setup.engine.close();
  });

  it("searches catalog sources and returns detail readiness, warnings, and install metadata", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const search = await dashboardGet(
      setup,
      `/dashboard/api/catalog/search?source=${encodeURIComponent(source)}&q=sample`,
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      entries: [
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
      `/dashboard/api/catalog/detail?source=${encodeURIComponent(source)}&id=sample`,
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

    await setup.engine.close();
  });

  it("installs catalog caplets globally, updates lockfile state, and records activity", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const installed = await dashboardPost(setup, "/dashboard/api/catalog/install", {
      source,
      capletId: "sample",
    });
    expect(installed.status).toBe(200);
    await expect(installed.json()).resolves.toMatchObject({
      installed: [
        expect.objectContaining({
          id: "sample",
          status: "installed",
          lockfile: setup.context.globalLockfilePath,
        }),
      ],
      setupActions: expect.arrayContaining([expect.objectContaining({ kind: "auth" })]),
    });

    expect(existsSync(join(setup.context.globalCapletsRoot, "sample.md"))).toBe(true);
    expect(JSON.parse(readFileSync(setup.context.globalLockfilePath, "utf8"))).toMatchObject({
      entries: [expect.objectContaining({ id: "sample", destination: "sample.md" })],
    });

    const updates = await dashboardGet(setup, "/dashboard/api/catalog/updates");
    expect(updates.status).toBe(200);
    await expect(updates.json()).resolves.toMatchObject({
      updates: [expect.objectContaining({ id: "sample", status: "locked" })],
    });

    const activity = await dashboardGet(setup, "/dashboard/api/activity?action=catalog_installed");
    expect(activity.status).toBe(200);
    const text = await activity.text();
    expect(text).toContain('"action":"catalog_installed"');
    expect(text).toContain('"id":"sample"');
    expect(text).not.toContain(source);

    await setup.engine.close();
  });

  it("rejects acknowledged catalog updates when installed files have local modifications", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const installed = await dashboardPost(setup, "/dashboard/api/catalog/install", {
      source,
      capletId: "sample",
    });
    expect(installed.status).toBe(200);
    const installedPath = join(setup.context.globalCapletsRoot, "sample.md");
    const localContents = "# Local changes\n\n";
    writeFileSync(installedPath, localContents);

    const update = await dashboardPost(setup, "/dashboard/api/catalog/update", {
      capletId: "sample",
      acknowledgeRiskIncrease: true,
    });

    expect(update.status).toBe(409);
    await expect(update.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CONFIG_EXISTS",
        message: expect.stringContaining("local modifications"),
      },
    });
    expect(readFileSync(installedPath, "utf8")).toBe(localContents);

    await setup.engine.close();
  });

  it("does not report unavailable catalog update sources as unauthorized", async () => {
    const setup = await authenticatedDashboard();
    const source = catalogSource();

    const installed = await dashboardPost(setup, "/dashboard/api/catalog/install", {
      source,
      capletId: "sample",
    });
    expect(installed.status).toBe(200);

    rmSync(source, { recursive: true, force: true });

    const update = await dashboardPost(setup, "/dashboard/api/catalog/update", {
      capletId: "sample",
      acknowledgeRiskIncrease: true,
    });
    expect(update.status).toBe(404);
    await expect(update.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "CONFIG_NOT_FOUND" },
    });

    await setup.engine.close();
  });
  it("returns the same redacted catalog failure through dashboard and bearer adapters", async () => {
    const setup = await authenticatedDashboard();
    const source =
      "https://operator:credential@127.0.0.1:1/private-repository?token=transport_secret";

    const dashboardResponse = await dashboardPost(setup, "/dashboard/api/catalog/install", {
      source,
      capletId: "sample",
    });
    expect(dashboardResponse.status).toBe(404);
    const dashboardError = (await dashboardResponse.json()) as {
      error: { code: string; message: string };
    };

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

    expect(dashboardError.error).toEqual({
      code: "CONFIG_NOT_FOUND",
      message: "Could not clone repo [REDACTED]",
    });
    expect(bearerError.error).toEqual(dashboardError.error);
    expect(JSON.stringify({ dashboardError, bearerError })).not.toContain("credential");
    expect(JSON.stringify({ dashboardError, bearerError })).not.toContain("transport_secret");
    expect(JSON.stringify({ dashboardError, bearerError })).not.toContain("127.0.0.1");

    await setup.engine.close();
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
  store: RemoteServerCredentialStore;
  stateDir: string;
  context: DashboardCatalogTestContext;
}

interface AuthenticatedDashboard extends TestAppSetup {
  cookie: string;
  csrfToken: string;
  operatorClientId: string;
}

async function authenticatedDashboard(): Promise<AuthenticatedDashboard> {
  const setup = testApp();
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

function testApp(): TestAppSetup {
  const stateDir = tempDir("caplets-dashboard-catalog-state-");
  const context = testContext();
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    watch: false,
  });
  const store = new RemoteServerCredentialStore({ dir: stateDir });
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: context,
    remoteCredentialStore: store,
  });
  return { app, engine, store, stateDir, context };
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

function testContext(): DashboardCatalogTestContext {
  const dir = tempDir("caplets-dashboard-catalog-");
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  const globalCapletsRoot = join(dir, "global-caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalCapletsRoot, { recursive: true });
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
    globalCapletsRoot,
    globalLockfilePath: join(dir, "remote-state", "caplets.lock.json"),
  };
}

function catalogSource(): string {
  const source = tempDir("caplets-dashboard-catalog-source-");
  const caplets = join(source, "caplets");
  mkdirSync(caplets, { recursive: true });
  writeFileSync(
    join(caplets, "sample.md"),
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
      "      method: POST",
      "      path: /items",
      "---",
      "",
      "# Sample",
      "",
    ].join("\n"),
  );
  return source;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
