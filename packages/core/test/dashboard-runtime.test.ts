import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import { createHostStorage } from "../src/storage";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard runtime, diagnostics, logs, and events APIs", () => {
  it("returns safe runtime, logs, diagnostics, and disabled restart state", async () => {
    const setup = await authenticatedDashboard();

    const runtime = await dashboardGet(setup, "/api/v2/admin/runtime");
    expect(runtime.status).toBe(200);
    await expect(runtime.json()).resolves.toMatchObject({
      runtime: { status: "ok", bind: "127.0.0.1:5387" },
      daemon: { restartAvailable: false, stopAvailable: false, uninstallAvailable: false },
    });

    const logs = await dashboardGet(setup, "/api/v2/admin/logs?limit=5");
    expect(logs.status).toBe(200);
    await expect(logs.json()).resolves.toEqual({ items: [] });

    const diagnostics = await dashboardGet(setup, "/api/v2/admin/diagnostics");
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({ status: "ok", diagnostics: [] });

    const restart = await dashboardPost(setup, "/api/v2/admin/runtime-restarts", {});
    expect(restart.status).toBe(503);
    expect(restart.headers.get("content-type")).toBe("application/problem+json");
    await expect(restart.json()).resolves.toMatchObject({
      type: "urn:caplets:problem:service-unavailable",
      status: 503,
      code: "SERVER_UNAVAILABLE",
    });

    await setup.engine.close();
    await setup.storage.close();
  });

  it("suppresses unchanged reload snapshots and closes the event stream during Host shutdown", async () => {
    const setup = await authenticatedDashboard();
    const response = await dashboardGet(setup, "/api/v2/admin/events?after=0");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected dashboard event stream body");
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    expect(firstText).toContain("event: runtime\n");
    expect(firstText).toContain('"type":"runtime_health"');
    expect(firstText).toContain('"state":"disconnected"');
    const afterReload = reader.read();

    writeFileSync(
      setup.context.configPath,
      JSON.stringify({
        httpApis: {
          status: {
            name: "Reloaded Status",
            description: "Reloaded Status API.",
            baseUrl: "http://127.0.0.1:1",
            auth: { type: "none" },
            actions: { check: { method: "GET", path: "/check" } },
          },
        },
      }),
    );
    await expect(setup.engine.reload()).resolves.toBe(true);
    await setup.app.closeCapletsSessions();
    await expect(afterReload).resolves.toEqual({ done: true, value: undefined });
    await setup.engine.close();
    await setup.storage.close();
  });
});
type Setup = Awaited<ReturnType<typeof authenticatedDashboard>>;

async function authenticatedDashboard() {
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

async function dashboardGet(setup: Setup, path: string) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie, "sec-fetch-site": "same-origin" },
  });
}

async function dashboardPost(setup: Setup, path: string, body: unknown) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      cookie: setup.cookie,
      "sec-fetch-site": "same-origin",
      "x-caplets-csrf": setup.csrfToken,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "if-none-match": "*",
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

async function testApp() {
  const stateDir = tempDir("caplets-dashboard-runtime-state-");
  const context = testContext();
  const storage = await createHostStorage(
    { type: "sqlite", path: join(stateDir, "host.sqlite3") },
    { vaultRoot: join(stateDir, "vault") },
  );
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    authDir: context.authDir,
    hostStorage: storage,
    watch: false,
  });
  const store = storage.remoteSecurity;
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    currentHostLogState: { listPage: () => ({ items: [] }) },
    control: context,
    authoritativeStorage: storage,
  });
  return { app, engine, store, storage, stateDir, context };
}

function httpOptions(stateDir: string): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
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

function testContext(): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
  globalCapletsRoot: string;
  globalLockfilePath: string;
  authDir: string;
} {
  const dir = tempDir("caplets-dashboard-catalog-");
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  const globalCapletsRoot = join(dir, "global-caplets");
  const authDir = join(dir, "auth");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalCapletsRoot, { recursive: true });
  mkdirSync(authDir, { recursive: true });
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
    authDir,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
