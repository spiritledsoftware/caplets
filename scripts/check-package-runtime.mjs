import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyPlan000BuiltScenarios } from "./package-runtime-plan-000-smoke.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempCwd = mkdtempSync(join(repoRoot, ".tmp-package-runtime-"));
const MAX_DIAGNOSTIC_OUTPUT_CHARS = 64 * 1024;

const tempConfigPath = join(tempCwd, "runtime-smoke-config.json");
writeFileSync(
  tempConfigPath,
  `${JSON.stringify(
    {
      storage: { type: "sqlite", path: join(tempCwd, "host.sqlite3") },
      httpApis: {
        status: {
          name: "Status",
          description: "Runtime smoke API.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    },
    null,
    2,
  )}\n`,
);
const smokeEnv = isolatedRuntimeEnvironment();

async function main() {
  const versionResult = spawnSync(
    process.execPath,
    [join(repoRoot, "packages/cli/dist/index.js"), "--version"],
    {
      cwd: tempCwd,
      encoding: "utf8",
      env: smokeEnv,
    },
  );

  if (versionResult.status !== 0) {
    process.stderr.write("Built Caplets CLI failed to start with --version.\n");
    if (versionResult.stdout) process.stderr.write(versionResult.stdout);
    if (versionResult.stderr) process.stderr.write(versionResult.stderr);
    process.exitCode = versionResult.status ?? 1;
    return;
  }

  const version = versionResult.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
    process.stderr.write(
      `Built Caplets CLI printed an invalid version: ${JSON.stringify(version)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "packages/cli/dist/index.js"),
      "serve",
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--allow-unauthenticated-http",
    ],
    {
      cwd: tempCwd,
      env: smokeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = appendDiagnosticOutput(stderr, chunk);
  });
  child.stdout.on("data", (chunk) => {
    stdout = appendDiagnosticOutput(stdout, chunk);
  });

  try {
    const currentHostOrigin = `http://127.0.0.1:${port}`;
    const dashboard = await waitForResponse(`${currentHostOrigin}/dashboard`);
    const dashboardHtml = await dashboard.text();
    if (dashboardHtml.includes("Dashboard assets have not been built yet")) {
      throw new Error("Packaged dashboard still falls back to the build-missing shell.");
    }

    const icon = await fetch(`${currentHostOrigin}/dashboard/favicon.png`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!icon.ok || icon.headers.get("content-type") !== "image/png") {
      throw new Error("Packaged dashboard favicon is missing or has the wrong content type.");
    }

    const [sdk, projectBinding, projectBindingNode] = await Promise.all([
      import(pathToFileURL(join(repoRoot, "packages/sdk/dist/index.js")).href),
      import(pathToFileURL(join(repoRoot, "packages/sdk/dist/project-binding.js")).href),
      import(pathToFileURL(join(repoRoot, "packages/sdk/dist/project-binding/node.js")).href),
    ]);
    if (projectBinding.PROJECT_BINDING_SOCKET_PROTOCOL !== "caplets.project-binding.v1") {
      throw new Error("Built Project Binding bundle has an invalid protocol contract.");
    }

    verifySdkOriginValidation(sdk, currentHostOrigin);
    const client = sdk.createClient({ baseUrl: `${currentHostOrigin}/` });
    await verifyRootRedirect(currentHostOrigin);
    await verifyWellKnownCaching(currentHostOrigin);
    await verifyApiDiscovery(sdk, client, currentHostOrigin);
    await verifyOpenApiCaching(currentHostOrigin);
    await verifyMcpLifecycle(currentHostOrigin);
    await verifyStrictRouteFailures(currentHostOrigin);

    const projectFingerprint = verifyProjectRootFingerprint(
      projectBindingNode.fingerprintProjectRoot,
    );
    await verifyMigratedBuiltProtocols({
      client,
      currentHostOrigin,
      projectBinding,
      projectFingerprint,
      sdk,
    });
    await terminateChild(child);
    const planReports = await verifyPlan000BuiltScenarios({
      repoRoot,
      tempCwd,
      tempConfigPath,
      smokeEnv,
      sdk,
    });
    process.stdout.write(
      [
        "PASS SDK Current Host input: root slash normalizes to the origin; non-root paths fail before network I/O.",
        "PASS GET /: exact no-store 302 to /dashboard.",
        "PASS GET /.well-known/caplets + /api + /api/v1 + /api/openapi.json: exact canonical discovery, checked-artifact parity, strong ETags, and conditional 304.",
        "PASS GET /api/v1/attach/manifest + GET /api/v2/admin/host: canonical built SDK responses on loopback development auth.",
        "PASS WS /api/v1/attach/project-bindings/connect + GET canonical session: ready, abort/finalize, and unreachable cleanup.",
        "PASS POST/GET/DELETE /mcp: initialize, initialized exchange, tools/list, SSE stream, session deletion, and deleted-session 404.",
        "PASS strict route cutover: representative old, trailing-slash, and prefix paths return exact no-store JSON 404 without redirect or migration headers.",
        ...planReports,
        "Cleanup: all Host Nodes/provider stopped; isolated SQLite/config/staging root scheduled for recursive removal.",
        "Command: node scripts/check-package-runtime.mjs",
      ].join("\n") + "\n",
    );
  } catch (error) {
    process.stderr.write("Built Caplets CLI failed package runtime smoke check.\n");
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await terminateChild(child);
    } catch (error) {
      process.stderr.write(
        `Built Caplets CLI teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}

await main().finally(() => {
  rmSync(tempCwd, { recursive: true, force: true });
});

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine runtime-check port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function verifyProjectRootFingerprint(fingerprintProjectRoot) {
  const markerPath = join(tempCwd, "package.json");
  writeFileSync(markerPath, '{"name":"runtime-smoke","version":"1.0.0"}\n');
  const first = fingerprintProjectRoot(tempCwd);
  const repeated = fingerprintProjectRoot(tempCwd);
  if (!/^sha256:[a-f0-9]{64}$/u.test(first) || repeated !== first) {
    throw new Error("Built Node Project Binding fingerprint is invalid or unstable.");
  }

  writeFileSync(markerPath, '{"name":"runtime-smoke","version":"2.0.0"}\n');
  const changed = fingerprintProjectRoot(tempCwd);
  if (!/^sha256:[a-f0-9]{64}$/u.test(changed) || changed === first) {
    throw new Error("Built Node Project Binding fingerprint ignored project-root changes.");
  }
  return changed;
}

function verifySdkOriginValidation(sdk, currentHostOrigin) {
  let rejected = false;
  try {
    sdk.createClient({ baseUrl: `${currentHostOrigin}/tenant/tools` });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("Built SDK accepted a path-bearing Current Host input.");
  }
}

async function verifyRootRedirect(currentHostOrigin) {
  const response = await fetch(`${currentHostOrigin}/`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (
    response.status !== 302 ||
    response.headers.get("location") !== "/dashboard" ||
    response.headers.get("cache-control") !== "no-store"
  ) {
    throw new Error("Built server root did not return the exact canonical dashboard redirect.");
  }
}

async function verifyWellKnownCaching(currentHostOrigin) {
  const url = `${currentHostOrigin}/.well-known/caplets`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");
  const etag = response.headers.get("etag");
  const expectedBody = `${JSON.stringify({
    schemaVersion: 1,
    links: {
      api: "/api",
      openapi: "/api/openapi.json",
      mcp: "/mcp",
      dashboard: "/dashboard",
    },
  })}\n`;
  if (
    response.status !== 200 ||
    response.url !== url ||
    contentType !== "application/json; charset=utf-8" ||
    cacheControl !== "public, max-age=0, must-revalidate" ||
    !etag ||
    !/^"[^"]+"$/u.test(etag) ||
    (await response.text()) !== expectedBody
  ) {
    throw new Error("Built well-known response did not match its exact canonical representation.");
  }

  const conditional = await fetch(url, {
    headers: { "if-none-match": etag },
    signal: AbortSignal.timeout(5000),
  });
  if (
    conditional.status !== 304 ||
    conditional.headers.get("content-type") !== contentType ||
    conditional.headers.get("cache-control") !== cacheControl ||
    conditional.headers.get("etag") !== etag ||
    (await conditional.text()) !== ""
  ) {
    throw new Error("Built well-known conditional GET did not retain headers on its empty 304.");
  }
}

async function verifyApiDiscovery(sdk, client, currentHostOrigin) {
  const discovery = await sdk.getServiceDiscovery({
    client,
    signal: AbortSignal.timeout(5000),
  });
  const expectedUrl = `${currentHostOrigin}/api`;
  const expectedData = {
    name: "caplets",
    protocol: "caplets-http",
    schemaVersion: 1,
    links: {
      self: "/api",
      openapi: "/api/openapi.json",
      v1: "/api/v1",
      admin: "/api/v2/admin/host",
    },
  };
  if (
    discovery.error !== undefined ||
    !(discovery.request instanceof Request) ||
    discovery.request.url !== expectedUrl ||
    !(discovery.response instanceof Response) ||
    discovery.response.status !== 200 ||
    discovery.response.url !== expectedUrl ||
    discovery.response.headers.get("cache-control") !== "no-store" ||
    JSON.stringify(discovery.data) !== JSON.stringify(expectedData)
  ) {
    throw new Error("Generated SDK discovery operation did not match canonical /api discovery.");
  }

  const version = await sdk.getVersionDiscovery({
    client,
    signal: AbortSignal.timeout(5000),
  });
  const expectedVersionUrl = `${currentHostOrigin}/api/v1`;
  const expectedLinks = {
    health: "/api/v1/healthz",
    ...(version.data?.links?.attachSessions === undefined
      ? {}
      : { attachSessions: "/api/v1/attach/sessions" }),
    attachManifest: "/api/v1/attach/manifest",
    attachEvents: "/api/v1/attach/events",
    attachInvoke: "/api/v1/attach/invoke",
  };
  if (
    version.error !== undefined ||
    !(version.request instanceof Request) ||
    version.request.url !== expectedVersionUrl ||
    !(version.response instanceof Response) ||
    version.response.status !== 200 ||
    version.response.url !== expectedVersionUrl ||
    version.response.headers.get("cache-control") !== "no-store" ||
    JSON.stringify(version.data) !==
      JSON.stringify({ version: 1, path: "/api/v1", links: expectedLinks })
  ) {
    throw new Error("Generated SDK version discovery did not match canonical /api/v1 discovery.");
  }
}

async function verifyOpenApiCaching(currentHostOrigin) {
  const url = `${currentHostOrigin}/api/openapi.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");
  const etag = response.headers.get("etag");
  if (
    response.status !== 200 ||
    response.url !== url ||
    !(contentType ?? "").includes("application/vnd.oai.openapi+json") ||
    cacheControl !== "public, max-age=0, must-revalidate" ||
    !etag ||
    !/^"[^"]+"$/u.test(etag)
  ) {
    throw new Error("Built server did not expose canonical OpenAPI with its cache contract.");
  }
  const runtimeBytes = Buffer.from(await response.arrayBuffer());
  const checkedBytes = readFileSync(join(repoRoot, "schemas/caplets-http.openapi.json"));
  if (!runtimeBytes.equals(checkedBytes)) {
    throw new Error("Built runtime OpenAPI bytes differ from the checked artifact.");
  }
  const document = JSON.parse(runtimeBytes.toString("utf8"));
  if (
    document?.info?.title !== "Caplets HTTP API" ||
    document?.openapi !== "3.1.0" ||
    JSON.stringify(document?.servers) !== JSON.stringify([{ url: "/" }]) ||
    !document?.paths?.["/api"] ||
    !document?.paths?.["/api/v1/attach/invoke"] ||
    !document?.paths?.["/api/v2/admin/host"] ||
    document?.paths?.["/api/openapi.json"] ||
    document?.paths?.["/.well-known/caplets"] ||
    document?.paths?.["/mcp"] ||
    document?.paths?.["/dashboard"]
  ) {
    throw new Error("Built OpenAPI did not preserve the canonical public API boundary.");
  }

  const conditional = await fetch(url, {
    headers: { "if-none-match": etag },
    signal: AbortSignal.timeout(5000),
  });
  if (
    conditional.status !== 304 ||
    conditional.headers.get("content-type") !== contentType ||
    conditional.headers.get("cache-control") !== cacheControl ||
    conditional.headers.get("etag") !== etag ||
    (await conditional.text()) !== ""
  ) {
    throw new Error("Built OpenAPI conditional GET did not retain headers on its empty 304.");
  }
}

async function verifyMcpLifecycle(currentHostOrigin) {
  const url = `${currentHostOrigin}/mcp`;
  const protocolVersion = "2025-03-26";
  const commonHeaders = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const initialized = await fetch(url, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "package-runtime-smoke", version: "1.0.0" },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  if (initialized.status !== 200 || !sessionId) {
    throw new Error("Built MCP initialize did not create a canonical session.");
  }
  const sessionHeaders = {
    ...commonHeaders,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  };
  const notification = await fetch(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(5000),
  });
  if (notification.status !== 200 && notification.status !== 202) {
    throw new Error("Built MCP session rejected the initialized notification.");
  }
  const listed = await fetch(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(5000),
  });
  if (listed.status !== 200 || !(await listed.text()).includes('"jsonrpc":"2.0"')) {
    throw new Error("Built MCP session did not exchange a tools/list response.");
  }

  const stream = await fetch(url, {
    headers: {
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": protocolVersion,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (
    stream.status !== 200 ||
    !(stream.headers.get("content-type") ?? "").includes("text/event-stream")
  ) {
    throw new Error("Built MCP session did not open its canonical GET stream.");
  }
  await stream.body?.cancel();

  const deleted = await fetch(url, {
    method: "DELETE",
    headers: {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": protocolVersion,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (deleted.status !== 200) {
    throw new Error("Built MCP session DELETE did not complete cleanup.");
  }
  const afterDelete = await fetch(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(5000),
  });
  if (afterDelete.status !== 404) {
    throw new Error("Built MCP session remained reachable after DELETE.");
  }
}

async function verifyStrictRouteFailures(currentHostOrigin) {
  const fixtures = [
    ["GET", "/openapi.json"],
    ["GET", "/v1"],
    ["GET", "/v1/healthz"],
    ["POST", "/v1/remote/login/start"],
    ["GET", "/v1/attach/manifest"],
    ["POST", "/v1/admin"],
    ["GET", "/v1/admin/auth/callback/example"],
    ["POST", "/v1/mcp"],
    ["GET", "/v2"],
    ["GET", "/v2/admin/host"],
    ["GET", "/api/"],
    ["GET", "/api/v1/"],
    ["POST", "/api/v1/admin"],
    ["GET", "/api/v2"],
    ["GET", "/api/v2/admin/host/"],
    ["POST", "/mcp/"],
    ["GET", "/dashboard/"],
    ["GET", "/dashboard/api/v2/host"],
    ["GET", "/_astro/example.js"],
    ["GET", "/tenant/tools/api"],
    ["POST", "/tenant/tools/mcp"],
    ["GET", "/tenant/tools/dashboard"],
  ];
  for (const [method, path] of fixtures) {
    const response = await fetch(`${currentHostOrigin}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Removed route ${method} ${path} did not return JSON.`);
    }
    if (
      response.status !== 404 ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      response.headers.get("cache-control") !== "no-store" ||
      response.headers.has("location") ||
      response.headers.has("deprecation") ||
      response.headers.has("link") ||
      JSON.stringify(body) !== JSON.stringify({ error: "not_found" })
    ) {
      throw new Error(`Removed route ${method} ${path} did not return the exact cutover 404.`);
    }
  }
}

async function verifyMigratedBuiltProtocols({
  client,
  currentHostOrigin,
  projectBinding,
  projectFingerprint,
  sdk,
}) {
  await verifyAttachManifest(sdk, client, currentHostOrigin);
  await verifyDevelopmentAdminRead(sdk, client, currentHostOrigin);
  await verifyProjectBindingAbortCleanup({
    client,
    currentHostOrigin,
    projectBinding,
    projectFingerprint,
    sdk,
  });
}

async function verifyAttachManifest(sdk, client, currentHostOrigin) {
  const result = await sdk.getAttachManifest({
    client,
    signal: AbortSignal.timeout(5000),
  });
  const expectedUrl = `${currentHostOrigin}/api/v1/attach/manifest`;
  if (
    result.error !== undefined ||
    !(result.request instanceof Request) ||
    result.request.url !== expectedUrl ||
    !(result.response instanceof Response) ||
    result.response.status !== 200 ||
    result.response.url !== expectedUrl
  ) {
    throw new Error("Generated SDK Attach manifest operation used the wrong route or response.");
  }
  if (
    result.data?.version !== 1 ||
    typeof result.data.revision !== "string" ||
    result.data.revision.length === 0 ||
    !Number.isFinite(Date.parse(result.data.generatedAt)) ||
    ![
      result.data.caplets,
      result.data.tools,
      result.data.resources,
      result.data.resourceTemplates,
      result.data.prompts,
      result.data.completions,
      result.data.diagnostics,
    ].every(Array.isArray)
  ) {
    throw new Error("Generated SDK Attach manifest operation returned an invalid manifest.");
  }
}

async function verifyDevelopmentAdminRead(sdk, client, currentHostOrigin) {
  const result = await sdk.adminV2GetHost({
    client,
    signal: AbortSignal.timeout(5000),
  });
  const expectedUrl = `${currentHostOrigin}/api/v2/admin/host`;
  if (
    result.error !== undefined ||
    !(result.request instanceof Request) ||
    result.request.url !== expectedUrl ||
    result.request.headers.has("authorization") ||
    !(result.response instanceof Response) ||
    result.response.status !== 200 ||
    result.response.url !== expectedUrl
  ) {
    throw new Error(
      "Generated SDK Admin read did not use the loopback development-safe operator route.",
    );
  }
  if (
    result.data?.host?.current !== true ||
    result.data.host.roleModel !== "current-host" ||
    result.data.sections?.runtime?.status !== "ok"
  ) {
    throw new Error("Generated SDK Admin read returned an invalid Current Host resource.");
  }
}

async function verifyProjectBindingAbortCleanup({
  client,
  currentHostOrigin,
  projectBinding,
  projectFingerprint,
  sdk,
}) {
  const webSocketUrl = `ws://${new URL(currentHostOrigin).host}/api/v1/attach/project-bindings/connect`;
  const controller = new AbortController();
  let readyEvent;
  const deadline = setTimeout(() => controller.abort(), 5000);
  let result;
  try {
    result = await projectBinding.runProjectBindingSession({
      client,
      webSocketUrl,
      projectRoot: tempCwd,
      projectFingerprint,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type !== "ready" || readyEvent) return;
        readyEvent = event;
        controller.abort();
      },
    });
  } finally {
    clearTimeout(deadline);
  }

  if (
    !readyEvent ||
    readyEvent.projectRoot !== tempCwd ||
    readyEvent.projectFingerprint !== projectFingerprint ||
    readyEvent.webSocketUrl !== webSocketUrl
  ) {
    throw new Error("Built Project Binding session did not become ready before its deadline.");
  }
  if (
    result.data !== undefined ||
    result.error?.kind !== "aborted" ||
    result.error.cleanup !== undefined
  ) {
    throw new Error("Built Project Binding session did not finalize a clean abort.");
  }

  const cleanup = await sdk.getProjectBindingSession({
    client,
    path: { bindingId: readyEvent.bindingId },
    signal: AbortSignal.timeout(5000),
  });
  const expectedUrl = `${currentHostOrigin}/api/v1/attach/project-bindings/${encodeURIComponent(
    readyEvent.bindingId,
  )}/session`;
  if (
    cleanup.error === undefined ||
    !(cleanup.request instanceof Request) ||
    cleanup.request.url !== expectedUrl ||
    !(cleanup.response instanceof Response) ||
    cleanup.response.status !== 404 ||
    cleanup.response.url !== expectedUrl
  ) {
    throw new Error("Built Project Binding abort left its server session reachable.");
  }
}

function isolatedRuntimeEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^CAPLETS_(?:AUTH|CLOUD|DAEMON|POSTHOG|PROJECT|REMOTE|SENTRY|SERVER)(?:_|$)/u.test(name)) {
      delete env[name];
    }
  }
  return {
    ...env,
    CAPLETS_CONFIG: tempConfigPath,
    CAPLETS_DISABLE_CATALOG_INDEXING: "1",
    CAPLETS_DISABLE_TELEMETRY: "1",
    HOME: tempCwd,
    NO_COLOR: "1",
    XDG_CACHE_HOME: join(tempCwd, ".cache"),
    XDG_CONFIG_HOME: join(tempCwd, ".config"),
    XDG_DATA_HOME: join(tempCwd, ".local/share"),
    XDG_STATE_HOME: join(tempCwd, ".local/state"),
  };
}

function appendDiagnosticOutput(current, chunk) {
  const remaining = MAX_DIAGNOSTIC_OUTPUT_CHARS - current.length;
  return remaining > 0 ? current + chunk.slice(0, remaining) : current;
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5000)) return;

  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5000))) {
    throw new Error("server did not exit after SIGKILL");
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(
      () => finish(child.exitCode !== null || child.signalCode !== null),
      timeoutMs,
    );
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}

async function waitForResponse(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {
      // retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
