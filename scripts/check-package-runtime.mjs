import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const serviceRoot = `http://127.0.0.1:${port}`;
    const dashboard = await waitForResponse(`${serviceRoot}/dashboard`);
    const dashboardHtml = await dashboard.text();
    if (dashboardHtml.includes("Dashboard assets have not been built yet")) {
      throw new Error("Packaged dashboard still falls back to the build-missing shell.");
    }

    const icon = await fetch(`${serviceRoot}/dashboard/favicon.png`, {
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

    const client = sdk.createClient({ baseUrl: serviceRoot });
    const discovery = await sdk.getServiceDiscovery({
      client,
      signal: AbortSignal.timeout(5000),
    });
    const expectedDiscoveryUrl = `${serviceRoot}/`;
    if (discovery.error !== undefined) {
      throw new Error(
        `Generated SDK discovery operation returned an error: ${JSON.stringify(discovery.error)}`,
      );
    }
    if (
      !(discovery.request instanceof Request) ||
      discovery.request.url !== expectedDiscoveryUrl ||
      !(discovery.response instanceof Response) ||
      discovery.response.status !== 200 ||
      discovery.response.url !== expectedDiscoveryUrl
    ) {
      throw new Error("Generated SDK discovery operation used the wrong route or response.");
    }
    if (
      !discovery.data ||
      discovery.data.name !== "caplets" ||
      discovery.data.transport !== "http" ||
      discovery.data.base !== "/" ||
      !Array.isArray(discovery.data.versions) ||
      discovery.data.versions.length === 0 ||
      typeof discovery.data.auth?.type !== "string"
    ) {
      throw new Error("Generated SDK discovery operation returned an invalid service contract.");
    }
    await verifyOpenApiCaching(serviceRoot);

    const projectFingerprint = verifyProjectRootFingerprint(
      projectBindingNode.fingerprintProjectRoot,
    );
    await verifyMigratedBuiltProtocols({
      client,
      projectBinding,
      projectFingerprint,
      sdk,
      serviceRoot,
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
        "PASS GET / and /openapi.json: unauthenticated discovery plus strong ETag conditional 304.",
        "PASS GET /v1/attach/manifest and GET /v2/admin/host: built SDK direct responses on loopback development auth.",
        "PASS WS /v1/attach/project-bindings/connect + GET session: ready, abort/finalize, and unreachable cleanup.",
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

async function verifyOpenApiCaching(serviceRoot) {
  const url = `${serviceRoot}/openapi.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (
    response.status !== 200 ||
    response.url !== url ||
    !(response.headers.get("content-type") ?? "").includes("application/vnd.oai.openapi+json")
  ) {
    throw new Error("Built server did not expose the unauthenticated root OpenAPI document.");
  }
  const etag = response.headers.get("etag");
  if (!etag || !/^"[^"]+"$/u.test(etag)) {
    throw new Error("Built root OpenAPI response omitted its strong ETag.");
  }
  const document = await response.json();
  if (
    document?.info?.title !== "Caplets HTTP API" ||
    document?.openapi !== "3.1.0" ||
    !document?.paths?.["/v2/admin/host"] ||
    !document?.paths?.["/v1/attach/invoke"]
  ) {
    throw new Error("Built root OpenAPI response did not contain the canonical public contract.");
  }

  const conditional = await fetch(url, {
    headers: { "if-none-match": etag },
    signal: AbortSignal.timeout(5000),
  });
  if (conditional.status !== 304 || (await conditional.text()) !== "") {
    throw new Error("Built root OpenAPI conditional GET did not return an empty 304.");
  }
}

async function verifyMigratedBuiltProtocols({
  client,
  projectBinding,
  projectFingerprint,
  sdk,
  serviceRoot,
}) {
  await verifyAttachManifest(sdk, client, serviceRoot);
  await verifyDevelopmentAdminRead(sdk, client, serviceRoot);
  await verifyProjectBindingAbortCleanup({
    client,
    projectBinding,
    projectFingerprint,
    sdk,
    serviceRoot,
  });
}

async function verifyAttachManifest(sdk, client, serviceRoot) {
  const result = await sdk.getAttachManifest({
    client,
    signal: AbortSignal.timeout(5000),
  });
  const expectedUrl = `${serviceRoot}/v1/attach/manifest`;
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

async function verifyDevelopmentAdminRead(sdk, client, serviceRoot) {
  const result = await sdk.adminV2GetHost({
    client,
    signal: AbortSignal.timeout(5000),
  });
  const expectedUrl = `${serviceRoot}/v2/admin/host`;
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
  projectBinding,
  projectFingerprint,
  sdk,
  serviceRoot,
}) {
  const webSocketUrl = `ws://${new URL(serviceRoot).host}/v1/attach/project-bindings/connect`;
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
  const expectedUrl = `${serviceRoot}/v1/attach/project-bindings/${encodeURIComponent(
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
