import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MiB = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;
const LARGE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_OUTPUT_CHARS = 64 * 1024;
const RSS_ASSET_COUNT = 47;
const RSS_ASSET_BYTES = 4 * MiB;
const RSS_CHUNK_BYTES = 64 * 1024;
const RSS_PARSER_ALLOWANCE_BYTES = 24 * MiB;
const RSS_FIXED_RUNTIME_ALLOWANCE_BYTES = 96 * MiB;
const V1_SUCCESSOR_LINK = '</v2/admin/host>; rel="successor-version"';

export async function verifyPlan000BuiltScenarios({
  repoRoot,
  tempCwd,
  tempConfigPath,
  smokeEnv,
  sdk,
}) {
  const reports = [];
  const children = new Set();
  const stagingRoot = mkdtempSync(join(tmpdir(), "cprt-"));
  const stagingOne = join(stagingRoot, "one");
  const stagingTwo = join(stagingRoot, "two");
  let provider;
  let nodeOne;
  let nodeTwo;
  let scenarioOutcome;
  try {
    provider = await startProvider();
    const nodeOnePort = await availablePort();
    const nodeTwoPort = await availablePort();
    const nodeOneRoot = `http://127.0.0.1:${nodeOnePort}`;
    const nodeTwoRoot = `http://127.0.0.1:${nodeTwoPort}`;

    writeFileSync(
      tempConfigPath,
      `${JSON.stringify(
        {
          options: { exposure: "direct" },
          storage: { type: "sqlite", path: join(tempCwd, "host.sqlite3") },
          httpApis: {
            remote: {
              name: "Remote",
              description: "Deterministic runtime smoke OAuth API.",
              baseUrl: provider.baseUrl,
              auth: {
                type: "oauth2",
                clientId: "runtime-smoke-client",
                authorizationUrl: `${provider.baseUrl}/authorize`,
                tokenUrl: `${provider.baseUrl}/token`,
              },
              actions: { check: { method: "GET", path: "/check" } },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    nodeOne = await startBuiltServer({
      children,
      port: nodeOnePort,
      repoRoot,
      smokeEnv,
      stagingDir: stagingOne,
      tempCwd,
    });
    nodeTwo = await startBuiltServer({
      children,
      port: nodeTwoPort,
      repoRoot,
      smokeEnv,
      stagingDir: stagingTwo,
      tempCwd,
    });

    const access = await createBearerCredential({
      clientLabel: "Runtime Smoke Access",
      repoRoot,
      role: "access",
      sdk,
      serviceRoot: nodeOneRoot,
      smokeEnv,
      tempCwd,
    });
    const operator = await createBearerCredential({
      clientLabel: "Runtime Smoke Operator",
      repoRoot,
      role: "operator",
      sdk,
      serviceRoot: nodeOneRoot,
      smokeEnv,
      tempCwd,
    });
    const accessClient = sdk.createClient({ auth: access.accessToken, baseUrl: nodeOneRoot });
    const operatorClient = sdk.createClient({ auth: operator.accessToken, baseUrl: nodeOneRoot });

    await verifyRoleMatrix({ access, operator, serviceRoot: nodeOneRoot });
    reports.push(
      "PASS GET /v2/admin/host + PUT /v2/admin/vault-values/{key}: missing bearer -> 401 Problem, Access bearer -> 403 Problem, Operator bearer -> direct resource success.",
    );

    const dashboard = await createDashboardSession({
      repoRoot,
      serviceRoot: nodeOneRoot,
      smokeEnv,
      tempCwd,
    });
    await verifyConditionalMutations({
      dashboard,
      operator,
      serviceRoot: nodeOneRoot,
    });
    reports.push(
      "PASS PUT /v2/admin/vault-values/{key} and /dashboard/api/v2/vault-values/{key}: bearer/dashboard conditional idempotent 201 replay, 403/412/428 Problem, direct DTO, ETag, and CSRF.",
    );

    const rss = await verifyLargeBundle({
      operatorClient,
      sdk,
      serverPid: nodeOne.child.pid,
      restartServer: async () => {
        await terminateChild(nodeOne.child);
        nodeOne = await startBuiltServer({
          children,
          port: nodeOnePort,
          repoRoot,
          smokeEnv,
          stagingDir: stagingOne,
          tempCwd,
        });
        return nodeOne.child.pid;
      },
      stagingDir: stagingOne,
    });
    reports.push(
      `PASS PUT/GET /v2/admin/caplet-records/runtime-rss/bundle: Operator bearer streamed ${rss.totalPayloadBytes} payload bytes; upload RSS ${rss.uploadBaselineRss}->${rss.uploadPeakRss} (ceiling ${rss.uploadThresholdRss}), download RSS ${rss.downloadBaselineRss}->${rss.downloadPeakRss} (streaming ceiling ${rss.downloadThresholdRss}); staged payload entries=${rss.stagingEntries}.`,
    );

    await verifyCrossNodeOAuth({
      nodeOneRoot,
      nodeTwoRoot,
      operatorClient,
      provider,
      sdk,
    });
    reports.push(
      "PASS POST /v2/admin/backend-auth-flows on Host Node 1 + public callback on Host Node 2: Operator bearer start, one deterministic token exchange, completed durable state, replay -> 401 Problem.",
    );

    await verifyFrozenV1({ operator, serviceRoot: nodeOneRoot });
    reports.push(
      "PASS POST /v1/admin: Operator bearer retained list succeeds; remote init/add return safe REQUEST_INVALID envelopes; Deprecation and successor Link headers retained.",
    );

    await verifyAttachRuntimeOperation({ accessClient, provider, sdk });
    reports.push(
      "PASS GET /v1/attach/manifest + POST /v1/attach/invoke: Access bearer invoked deterministic remote__check runtime tool through the built Attach adapter.",
    );
    scenarioOutcome = { ok: true };
  } catch (error) {
    scenarioOutcome = { ok: false, error };
  }
  const terminated = await Promise.allSettled(
    [...children].map(async (entry) => {
      await terminateChild(entry.child);
    }),
  );
  let providerCloseError;
  try {
    await provider?.close();
  } catch (error) {
    providerCloseError = error;
  }
  let remainingStagingEntries = -1;
  let stagingInspectionError;
  try {
    remainingStagingEntries = countDirectoryEntries(stagingOne) + countDirectoryEntries(stagingTwo);
  } catch (error) {
    stagingInspectionError = error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  const failedTeardown = terminated.find((result) => result.status === "rejected");
  if (failedTeardown?.status === "rejected") throw failedTeardown.reason;
  if (providerCloseError) throw providerCloseError;
  if (stagingInspectionError) throw stagingInspectionError;
  if (remainingStagingEntries !== 0) {
    throw new Error(
      `Host Node shutdown retained ${remainingStagingEntries} upload staging lease entries.`,
    );
  }

  if (!scenarioOutcome.ok) throw scenarioOutcome.error;

  if (nodeOne?.child.exitCode === null || nodeTwo?.child.exitCode === null) {
    throw new Error("Authenticated smoke Host Node process remained alive after cleanup.");
  }
  return reports;
}

async function verifyRoleMatrix({ access, operator, serviceRoot }) {
  const missing = await request(`${serviceRoot}/v2/admin/host`);
  await expectProblem(missing, 401, "missing bearer Admin read");

  const deniedRead = await request(`${serviceRoot}/v2/admin/host`, {
    headers: bearerHeaders(access.accessToken),
  });
  await expectProblem(deniedRead, 403, "Access bearer Admin read");

  const allowedRead = await request(`${serviceRoot}/v2/admin/host`, {
    headers: bearerHeaders(operator.accessToken),
  });
  assert(allowedRead.status === 200, `Operator bearer Admin read returned ${allowedRead.status}.`);
  assertJsonContentType(allowedRead, "Operator bearer Admin read");
  const host = await allowedRead.json();
  assert(host?.host?.current === true, "Operator bearer Admin read was not a direct Host DTO.");
  assert(
    host.ok === undefined && host.result === undefined,
    "Operator bearer Admin read was wrapped.",
  );

  const deniedMutation = await request(
    `${serviceRoot}/v2/admin/vault-values/ACCESS_ROLE_MUST_NOT_MUTATE`,
    {
      method: "PUT",
      headers: {
        ...bearerHeaders(access.accessToken),
        "content-type": "application/json",
        "idempotency-key": "access-role-denied",
        "if-none-match": "*",
      },
      body: JSON.stringify({ value: "must-not-be-written" }),
    },
  );
  await expectProblem(deniedMutation, 403, "Access bearer Admin mutation");
}

async function verifyConditionalMutations({ dashboard, operator, serviceRoot }) {
  const bearerUrl = `${serviceRoot}/v2/admin/vault-values/RUNTIME_BEARER_SECRET`;
  const bearerBaseHeaders = {
    ...bearerHeaders(operator.accessToken),
    "content-type": "application/json",
  };
  const missingPrecondition = await request(bearerUrl, {
    method: "PUT",
    headers: { ...bearerBaseHeaders, "idempotency-key": "bearer-missing-precondition" },
    body: JSON.stringify({ value: "opaque bearer value" }),
  });
  await expectProblem(missingPrecondition, 428, "bearer missing creation precondition");

  const bearerHeadersWithPolicy = {
    ...bearerBaseHeaders,
    "idempotency-key": "bearer-vault-create",
    "if-none-match": "*",
  };
  const created = await request(bearerUrl, {
    method: "PUT",
    headers: bearerHeadersWithPolicy,
    body: JSON.stringify({ value: "opaque bearer value" }),
  });
  const createdBody = await expectVaultCreated(created, "RUNTIME_BEARER_SECRET", "bearer create");
  const createdEtag = created.headers.get("etag");
  assert(createdEtag?.startsWith('"'), "Bearer Vault create omitted a strong ETag.");

  const replayed = await request(bearerUrl, {
    method: "PUT",
    headers: bearerHeadersWithPolicy,
    body: JSON.stringify({ value: "opaque bearer value" }),
  });
  const replayBody = await expectVaultCreated(replayed, "RUNTIME_BEARER_SECRET", "bearer replay");
  assert(
    JSON.stringify(replayBody) === JSON.stringify(createdBody) &&
      replayed.headers.get("etag") === createdEtag,
    "Bearer idempotency replay changed the direct response or ETag.",
  );

  const existing = await request(bearerUrl, {
    method: "PUT",
    headers: {
      ...bearerBaseHeaders,
      "idempotency-key": "bearer-vault-existing",
      "if-none-match": "*",
    },
    body: JSON.stringify({ value: "must-not-replace" }),
  });
  await expectProblem(existing, 412, "bearer create-only existing resource");

  const dashboardUrl = `${serviceRoot}/dashboard/api/v2/vault-values/RUNTIME_DASHBOARD_SECRET`;
  const dashboardBaseHeaders = {
    cookie: dashboard.cookie,
    "content-type": "application/json",
    "idempotency-key": "dashboard-vault-create",
    "if-none-match": "*",
  };
  const missingCsrf = await request(dashboardUrl, {
    method: "PUT",
    headers: dashboardBaseHeaders,
    body: JSON.stringify({ value: "opaque dashboard value" }),
  });
  await expectProblem(missingCsrf, 403, "dashboard missing CSRF");

  const dashboardHeaders = {
    ...dashboardBaseHeaders,
    "x-caplets-csrf": dashboard.csrfToken,
  };
  const dashboardCreated = await request(dashboardUrl, {
    method: "PUT",
    headers: dashboardHeaders,
    body: JSON.stringify({ value: "opaque dashboard value" }),
  });
  const dashboardBody = await expectVaultCreated(
    dashboardCreated,
    "RUNTIME_DASHBOARD_SECRET",
    "dashboard create",
  );
  const dashboardEtag = dashboardCreated.headers.get("etag");
  assert(dashboardEtag?.startsWith('"'), "Dashboard Vault create omitted a strong ETag.");

  const dashboardReplay = await request(dashboardUrl, {
    method: "PUT",
    headers: dashboardHeaders,
    body: JSON.stringify({ value: "opaque dashboard value" }),
  });
  const dashboardReplayBody = await expectVaultCreated(
    dashboardReplay,
    "RUNTIME_DASHBOARD_SECRET",
    "dashboard replay",
  );
  assert(
    JSON.stringify(dashboardReplayBody) === JSON.stringify(dashboardBody) &&
      dashboardReplay.headers.get("etag") === dashboardEtag,
    "Dashboard idempotency replay changed the direct response or ETag.",
  );
}

async function expectVaultCreated(response, key, label) {
  assert(response.status === 201, `${label} returned ${response.status}.`);
  assertJsonContentType(response, label);
  assert(response.headers.get("cache-control") === "no-store", `${label} omitted no-store.`);
  const body = await response.json();
  assert(
    body?.key === key && body.present === true && Number.isInteger(body.generation),
    `${label} was not a direct Vault Value DTO.`,
  );
  assert(body.ok === undefined && body.result === undefined, `${label} returned a legacy wrapper.`);
  return body;
}

async function verifyLargeBundle({ operatorClient, restartServer, sdk, serverPid, stagingDir }) {
  const document = Buffer.from(
    "---\nname: Runtime RSS Smoke\ndescription: Prove built HTTP bundle streaming.\nmcpServer:\n  command: runtime-rss-smoke\n---\n# Runtime RSS Smoke\n",
  );
  const files = [
    {
      path: "CAPLET.md",
      size: document.byteLength,
      sha256: createHash("sha256").update(document).digest("hex"),
      executable: false,
      value: undefined,
    },
  ];
  for (let index = 0; index < RSS_ASSET_COUNT; index += 1) {
    const value = index + 1;
    files.push({
      path: `assets/payload-${String(index).padStart(3, "0")}.bin`,
      size: RSS_ASSET_BYTES,
      sha256: hashRepeatedByte(value, RSS_ASSET_BYTES),
      executable: index % 7 === 0,
      value,
    });
  }
  const manifestFiles = files.map(({ path, size, sha256, executable }) => ({
    path,
    size,
    sha256,
    executable,
  }));
  const totalPayloadBytes = manifestFiles.reduce((sum, file) => sum + file.size, 0);
  const body = sdk.createOrderedBundleMultipartBody(
    JSON.stringify({ version: 1, files: manifestFiles }),
    files.map((file) => ({
      open: async function* () {
        if (file.value === undefined) {
          yield document;
          return;
        }
        const chunk = Buffer.alloc(RSS_CHUNK_BYTES, file.value);
        for (let offset = 0; offset < file.size; offset += chunk.byteLength) {
          yield chunk.subarray(0, Math.min(chunk.byteLength, file.size - offset));
        }
      },
    })),
    "caplets-built-runtime-rss-boundary",
  );

  await delay(100);
  const baselineRss = sampleRss(serverPid);
  let uploadPeakRss = baselineRss;
  let uploadSampleError;
  const uploadSampler = setInterval(() => {
    try {
      uploadPeakRss = Math.max(uploadPeakRss, sampleRss(serverPid));
    } catch (error) {
      uploadSampleError ??= error;
    }
  }, 20);

  let stagingEntries = -1;
  let downloadBaselineRss = 0;
  let downloadPeakRss = 0;
  let downloadSampleError;
  let downloadSampler;
  try {
    const uploaded = await sdk.adminV2PutCapletRecordBundleStream({
      body: body.body,
      client: operatorClient,
      contentType: body.contentType,
      headers: {
        "Idempotency-Key": "built-runtime-large-bundle",
        "If-None-Match": "*",
      },
      path: { id: "runtime-rss" },
      signal: AbortSignal.timeout(LARGE_REQUEST_TIMEOUT_MS),
    });
    assert(
      uploaded.error === undefined,
      `Large bundle upload failed: ${JSON.stringify(uploaded.error)}.`,
    );
    assert(
      uploaded.response?.status === 201,
      `Large bundle upload returned ${uploaded.response?.status}.`,
    );
    assert(
      uploaded.data?.id === "runtime-rss" && uploaded.data.ok === undefined,
      "Large bundle upload did not return a direct Caplet Record DTO.",
    );
    uploadPeakRss = Math.max(uploadPeakRss, sampleRss(serverPid));

    await waitForNoStagedPayloads(stagingDir);
    stagingEntries = stagedPayloadEntries(stagingDir).length;
    assert(stagingEntries === 0, `Large bundle upload retained ${stagingEntries} payload entries.`);
    clearInterval(uploadSampler);
    if (uploadSampleError) throw uploadSampleError;

    serverPid = await restartServer();
    await delay(100);
    downloadBaselineRss = sampleRss(serverPid);
    downloadPeakRss = downloadBaselineRss;
    downloadSampler = setInterval(() => {
      try {
        downloadPeakRss = Math.max(downloadPeakRss, sampleRss(serverPid));
      } catch (error) {
        downloadSampleError ??= error;
      }
    }, 20);

    const downloaded = await sdk.adminV2GetCapletRecordBundleStream({
      client: operatorClient,
      path: { id: "runtime-rss" },
      signal: AbortSignal.timeout(LARGE_REQUEST_TIMEOUT_MS),
    });
    assert(
      downloaded.error === undefined && downloaded.data,
      "Large bundle download did not stream a body.",
    );
    assert(
      downloaded.response?.status === 200,
      `Large bundle download returned ${downloaded.response?.status}.`,
    );
    const contentType = downloaded.response?.headers.get("content-type") ?? "";
    const parsed = await parseMultipartDownload(downloaded.data, contentType);
    assert(
      JSON.stringify(parsed.manifest.files) === JSON.stringify(manifestFiles),
      "Large bundle download manifest changed file order, metadata, or hashes.",
    );
    assert(parsed.fileCount === files.length, "Large bundle download lost file parts.");
    assert(
      parsed.payloadBytes === totalPayloadBytes,
      "Large bundle download changed payload bytes.",
    );
    assert(
      parsed.wireBytes > parsed.payloadBytes,
      "Large bundle download omitted multipart framing.",
    );
    downloadPeakRss = Math.max(downloadPeakRss, sampleRss(serverPid));
    if (downloadSampleError) throw downloadSampleError;
  } finally {
    clearInterval(uploadSampler);
    clearInterval(downloadSampler);
  }

  const uploadThresholdRss = baselineRss + totalPayloadBytes + RSS_FIXED_RUNTIME_ALLOWANCE_BYTES;
  const payloadPlusBase64Copies = totalPayloadBytes + Math.ceil(totalPayloadBytes / 3) * 4;
  assert(
    uploadThresholdRss < baselineRss + payloadPlusBase64Copies,
    "Upload RSS ceiling does not reject whole-payload plus base64 copies.",
  );
  assert(
    uploadPeakRss <= uploadThresholdRss,
    `Large bundle upload RSS grew from ${baselineRss} to ${uploadPeakRss}, above ${uploadThresholdRss}.`,
  );

  const downloadThresholdRss =
    downloadBaselineRss +
    RSS_PARSER_ALLOWANCE_BYTES +
    RSS_ASSET_BYTES +
    RSS_FIXED_RUNTIME_ALLOWANCE_BYTES;
  assert(
    downloadThresholdRss < downloadBaselineRss + totalPayloadBytes,
    "Download RSS ceiling does not distinguish streaming from whole-bundle buffering.",
  );
  assert(
    downloadPeakRss <= downloadThresholdRss,
    `Large bundle download RSS grew from ${downloadBaselineRss} to ${downloadPeakRss}, above ${downloadThresholdRss}.`,
  );
  return {
    uploadBaselineRss: baselineRss,
    uploadPeakRss,
    uploadThresholdRss,
    downloadBaselineRss,
    downloadPeakRss,
    downloadThresholdRss,
    totalPayloadBytes,
    stagingEntries,
  };
}

async function parseMultipartDownload(stream, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundaryText = match?.[1] ?? match?.[2];
  assert(boundaryText, `Bundle download content type has no boundary: ${contentType}.`);
  const boundary = Buffer.from(`--${boundaryText}`);
  const bodyMarker = Buffer.from(`\r\n--${boundaryText}`);
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);
  let state = "boundary";
  let current;
  let manifest;
  let fileCount = 0;
  let payloadBytes = 0;
  let wireBytes = 0;
  let done = false;

  const consumeBody = (bytes) => {
    if (!bytes.length) return;
    current.hash.update(bytes);
    current.size += bytes.length;
    if (current.name === "manifest") {
      assert(current.size <= MiB, "Bundle download manifest exceeded the smoke parser bound.");
      current.chunks.push(bytes);
    }
  };

  const finishPart = () => {
    const digest = current.hash.digest("hex");
    if (current.name === "manifest") {
      const bytes = Buffer.concat(current.chunks, current.size);
      manifest = JSON.parse(bytes.toString("utf8"));
      assert(manifest?.version === 1 && Array.isArray(manifest.files), "Invalid export manifest.");
    } else if (current.name === "file") {
      assert(manifest, "Bundle export emitted a file before its manifest.");
      const expected = manifest.files[fileCount];
      assert(expected, "Bundle export emitted an extra file.");
      assert(current.size === expected.size, `Bundle export size changed for ${expected.path}.`);
      assert(digest === expected.sha256, `Bundle export hash changed for ${expected.path}.`);
      payloadBytes += current.size;
      fileCount += 1;
    } else {
      throw new Error(`Bundle export emitted unknown part ${JSON.stringify(current.name)}.`);
    }
    current = undefined;
  };

  const processBuffer = () => {
    while (!done) {
      if (state === "boundary") {
        if (buffer.length < boundary.length + 2) return;
        assert(
          buffer.subarray(0, boundary.length).equals(boundary),
          "Invalid bundle boundary framing.",
        );
        const suffix = buffer.subarray(boundary.length, boundary.length + 2).toString("ascii");
        if (suffix === "--") {
          buffer = buffer.subarray(boundary.length + 2);
          if (buffer.subarray(0, 2).toString("ascii") === "\r\n") buffer = buffer.subarray(2);
          done = true;
          return;
        }
        assert(suffix === "\r\n", "Invalid bundle boundary suffix.");
        buffer = buffer.subarray(boundary.length + 2);
        state = "headers";
        continue;
      }
      if (state === "headers") {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          assert(buffer.length <= 16 * 1024, "Bundle part headers exceeded smoke parser bound.");
          return;
        }
        const headerText = buffer.subarray(0, end).toString("utf8");
        const disposition = /content-disposition:[^\r\n]*\bname="([^"]+)"/iu.exec(headerText);
        assert(disposition?.[1], "Bundle part omitted a disposition name.");
        current = {
          name: disposition[1],
          hash: createHash("sha256"),
          size: 0,
          chunks: [],
        };
        buffer = buffer.subarray(end + 4);
        state = "body";
        continue;
      }
      const markerIndex = buffer.indexOf(bodyMarker);
      if (markerIndex >= 0) {
        consumeBody(buffer.subarray(0, markerIndex));
        finishPart();
        buffer = buffer.subarray(markerIndex + 2);
        state = "boundary";
        continue;
      }
      const safeBytes = buffer.length - (bodyMarker.length - 1);
      if (safeBytes <= 0) return;
      consumeBody(buffer.subarray(0, safeBytes));
      buffer = buffer.subarray(safeBytes);
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    wireBytes += chunk.value.byteLength;
    buffer = Buffer.concat([buffer, Buffer.from(chunk.value)]);
    processBuffer();
  }
  processBuffer();
  assert(done, "Bundle export ended before its closing boundary.");
  assert(buffer.length === 0, "Bundle export retained bytes after its closing boundary.");
  assert(
    manifest && fileCount === manifest.files.length,
    "Bundle export file count mismatched manifest.",
  );
  return { manifest, fileCount, payloadBytes, wireBytes };
}

async function verifyCrossNodeOAuth({ nodeOneRoot, nodeTwoRoot, operatorClient, provider, sdk }) {
  const started = await sdk.adminV2StartBackendAuthFlow({
    body: { serverId: "remote" },
    client: operatorClient,
    headers: {
      "Idempotency-Key": "built-cross-node-oauth",
      "If-None-Match": "*",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(started.error === undefined && started.response?.status === 201, "OAuth start failed.");
  assert(
    started.data?.flowId && started.data.authorizationUrl,
    "OAuth start was not a direct flow DTO.",
  );
  const authorizationUrl = new URL(started.data.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state");
  const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
  assert(state && redirectUri, "OAuth authorization URL omitted state or redirect_uri.");
  const redirect = new URL(redirectUri);
  assert(
    redirect.origin === nodeOneRoot &&
      redirect.pathname ===
        `/v2/admin/backend-auth-flows/${encodeURIComponent(started.data.flowId)}/callback`,
    "OAuth start produced the wrong canonical callback.",
  );

  const callback = new URL(`${redirect.pathname}${redirect.search}`, nodeTwoRoot);
  callback.searchParams.set("code", "built-cross-node-provider-code");
  callback.searchParams.set("state", state);
  const completed = await request(callback);
  assert(completed.status === 200, `Cross-node OAuth callback returned ${completed.status}.`);
  assert(completed.headers.get("cache-control") === "no-store", "OAuth callback omitted no-store.");
  const completedText = await completed.text();
  assert(
    JSON.stringify(JSON.parse(completedText)) ===
      JSON.stringify({ server: "remote", authenticated: true }),
    "OAuth callback did not return the direct authenticated representation.",
  );
  for (const secret of ["built-cross-node-provider-code", state, provider.accessToken]) {
    assert(!completedText.includes(secret), "OAuth callback leaked provider material.");
  }
  assert(
    provider.tokenExchanges === 1,
    `OAuth callback made ${provider.tokenExchanges} exchanges.`,
  );

  const flow = await sdk.adminV2GetBackendAuthFlow({
    client: operatorClient,
    path: { flowId: started.data.flowId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(
    flow.error === undefined && flow.data?.status === "completed" && flow.data.server === "remote",
    "Host Node 1 did not observe Host Node 2's durable OAuth completion.",
  );
  const connection = await sdk.adminV2GetBackendAuth({
    client: operatorClient,
    path: { serverId: "remote" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(
    connection.error === undefined && connection.data?.status === "authenticated",
    "Cross-node OAuth did not persist the backend credential.",
  );

  const replay = new URL(callback.pathname + callback.search, nodeOneRoot);
  const replayed = await request(replay);
  await expectProblem(replayed, 401, "cross-node OAuth callback replay");
  assert(provider.tokenExchanges === 1, "OAuth callback replay repeated the provider exchange.");
}

async function verifyFrozenV1({ operator, serviceRoot }) {
  const invoke = async (command, args = {}) => {
    const response = await request(`${serviceRoot}/v1/admin`, {
      method: "POST",
      headers: {
        ...bearerHeaders(operator.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ command, arguments: args }),
    });
    assert(response.status === 200, `Frozen v1 ${command} returned ${response.status}.`);
    assert(
      response.headers.get("deprecation") === "true",
      `Frozen v1 ${command} omitted Deprecation.`,
    );
    assert(
      response.headers.get("link") === V1_SUCCESSOR_LINK,
      `Frozen v1 ${command} omitted successor Link.`,
    );
    return await response.json();
  };

  const listed = await invoke("list");
  assert(listed?.ok === true, "Frozen v1 retained list command failed.");
  for (const [command, args] of [
    ["init", {}],
    ["add", { kind: "http", id: "must-not-touch-files" }],
  ]) {
    const rejected = await invoke(command, args);
    assert(
      rejected?.ok === false &&
        rejected.error?.code === "REQUEST_INVALID" &&
        rejected.error.message ===
          `Remote ${command} is local-only. Run caplets ${command} on the machine whose files should change.`,
      `Frozen v1 ${command} did not return its explicit safe migration error.`,
    );
  }
}

async function verifyAttachRuntimeOperation({ accessClient, provider, sdk }) {
  const manifest = await sdk.getAttachManifest({
    client: accessClient,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(manifest.error === undefined && manifest.data, "Attach runtime manifest failed.");
  const tool = manifest.data.tools.find(
    (candidate) => candidate.downstreamName === "check" || candidate.name === "remote__check",
  );
  assert(tool?.exportId, "Attach manifest did not expose the deterministic remote__check tool.");
  const before = provider.checkRequests;
  const invoked = await sdk.invokeAttachExport({
    body: {
      revision: manifest.data.revision,
      kind: "tool",
      exportId: tool.exportId,
      input: {},
    },
    client: accessClient,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(
    invoked.error === undefined && invoked.response?.status === 200,
    `Attach runtime invoke failed: status=${invoked.response?.status}, error=${JSON.stringify(invoked.error)}.`,
  );
  assert(invoked.data?.ok === true, "Attach runtime invoke did not return success.");
  assert(
    provider.checkRequests === before + 1,
    "Attach runtime invoke did not reach the provider once.",
  );
  assert(
    JSON.stringify(invoked.data).includes("runtime-smoke-provider"),
    "Attach runtime invoke did not return the provider result.",
  );
}

async function createBearerCredential({
  clientLabel,
  repoRoot,
  role,
  sdk,
  serviceRoot,
  smokeEnv,
  tempCwd,
}) {
  const publicClient = sdk.createClient({ baseUrl: serviceRoot });
  const started = await sdk.startRemoteLogin({
    body: { clientLabel },
    client: publicClient,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(
    started.error === undefined && started.data?.operatorCode,
    `Could not start ${role} login.`,
  );
  approveLogin({
    code: started.data.operatorCode,
    repoRoot,
    role,
    smokeEnv,
    tempCwd,
  });
  const completed = await sdk.completeRemoteLogin({
    body: {
      flowId: started.data.flowId,
      pendingCompletionSecret: started.data.pendingCompletionSecret,
    },
    client: publicClient,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(
    completed.error === undefined && completed.data?.role === role && completed.data.accessToken,
    `Could not complete ${role} login: status=${completed.response?.status}, error=${JSON.stringify(completed.error)}, data=${JSON.stringify(completed.data)}.`,
  );

  const replay = await sdk.completeRemoteLogin({
    body: {
      flowId: started.data.flowId,
      pendingCompletionSecret: started.data.pendingCompletionSecret,
    },
    client: publicClient,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert(
    replay.error === undefined &&
      replay.data?.accessToken === completed.data.accessToken &&
      replay.data.refreshToken === completed.data.refreshToken,
    `${role} login completion replay was not idempotent.`,
  );
  return completed.data;
}

async function createDashboardSession({ repoRoot, serviceRoot, smokeEnv, tempCwd }) {
  const started = await request(`${serviceRoot}/dashboard/api/login/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientLabel: "Runtime Smoke Dashboard" }),
  });
  assert(started.status === 200, `Dashboard login start returned ${started.status}.`);
  const body = await started.json();
  const code = /\b(cap_login_[A-Za-z0-9_-]+)\b/u.exec(body.approvalCommand ?? "")?.[1];
  assert(
    body.flowId && body.pendingCompletionSecret && code,
    "Dashboard login start omitted material.",
  );
  approveLogin({ code, repoRoot, role: "operator", smokeEnv, tempCwd });

  const completed = await request(`${serviceRoot}/dashboard/api/login/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flowId: body.flowId,
      pendingCompletionSecret: body.pendingCompletionSecret,
    }),
  });
  assert(completed.status === 200, `Dashboard login complete returned ${completed.status}.`);
  const setCookie = completed.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0];
  const session = await completed.json();
  assert(
    cookie.startsWith("caplets_dashboard_session="),
    "Dashboard login omitted session cookie.",
  );
  assert(
    session.session?.role === "operator" && session.session.csrfToken,
    "Dashboard login omitted Operator CSRF session.",
  );
  return { cookie, csrfToken: session.session.csrfToken };
}

function approveLogin({ code, repoRoot, role, smokeEnv, tempCwd }) {
  const approved = spawnSync(
    process.execPath,
    [
      join(repoRoot, "packages/cli/dist/index.js"),
      "remote",
      "host",
      "approve",
      code,
      "--role",
      role,
      "--yes",
      "--json",
    ],
    {
      cwd: tempCwd,
      encoding: "utf8",
      env: smokeEnv,
      maxBuffer: MAX_DIAGNOSTIC_OUTPUT_CHARS,
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  if (approved.status !== 0) {
    throw new Error(
      `Built CLI could not approve ${role} login: ${appendDiagnosticOutput("", approved.stdout)}${appendDiagnosticOutput("", approved.stderr)}`,
    );
  }
}

async function startProvider() {
  const accessToken = "runtime-smoke-provider-access-token";
  let tokenExchanges = 0;
  let checkRequests = 0;
  const server = createHttpServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (incoming.method === "POST" && url.pathname === "/token") {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => {
        if (body.length < 16 * 1024) body += chunk;
      });
      incoming.on("end", () => {
        tokenExchanges += 1;
        if (!body.includes("code=built-cross-node-provider-code")) {
          outgoing.writeHead(400, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        outgoing.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json",
        });
        outgoing.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: "runtime-smoke-provider-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      });
      return;
    }
    if (incoming.method === "GET" && url.pathname === "/check") {
      checkRequests += 1;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ ok: true, source: "runtime-smoke-provider" }));
      return;
    }
    outgoing.writeHead(404, { "content-type": "text/plain" });
    outgoing.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Provider did not expose a port.");
  return {
    accessToken,
    baseUrl: `http://127.0.0.1:${address.port}`,
    get checkRequests() {
      return checkRequests;
    },
    get tokenExchanges() {
      return tokenExchanges;
    },
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}

async function startBuiltServer({ children, port, repoRoot, smokeEnv, stagingDir, tempCwd }) {
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
      "--admin-upload-staging-dir",
      stagingDir,
    ],
    {
      cwd: tempCwd,
      env: smokeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const entry = { child, stderr: "", stdout: "" };
  children.add(entry);
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    entry.stderr = appendDiagnosticOutput(entry.stderr, chunk);
  });
  child.stdout.on("data", (chunk) => {
    entry.stdout = appendDiagnosticOutput(entry.stdout, chunk);
  });
  try {
    await waitForResponse(`http://127.0.0.1:${port}/v1/healthz`);
  } catch (error) {
    throw new Error(
      `Built authenticated Host Node failed to start: ${entry.stdout}${entry.stderr}${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return entry;
}

async function expectProblem(response, status, label) {
  assert(response.status === status, `${label} returned ${response.status}, expected ${status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  assert(contentType.includes("application/problem+json"), `${label} was not Problem Details.`);
  assert(response.headers.get("cache-control") === "no-store", `${label} omitted no-store.`);
  const body = await response.json();
  assert(
    body?.status === status &&
      typeof body.type === "string" &&
      typeof body.title === "string" &&
      typeof body.code === "string",
    `${label} returned an invalid Problem representation.`,
  );
  assert(
    body.stack === undefined && body.cause === undefined,
    `${label} leaked internal diagnostics.`,
  );
  return body;
}

function assertJsonContentType(response, label) {
  assert(
    (response.headers.get("content-type") ?? "").includes("application/json"),
    `${label} did not return JSON.`,
  );
}

function bearerHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

async function request(input, init = {}) {
  return await fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function hashRepeatedByte(value, size) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(RSS_CHUNK_BYTES, size), value);
  for (let offset = 0; offset < size; offset += chunk.byteLength) {
    hash.update(chunk.subarray(0, Math.min(chunk.byteLength, size - offset)));
  }
  return hash.digest("hex");
}

function sampleRss(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kibibytes = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1];
    if (kibibytes) return Number(kibibytes) * 1024;
  } catch {
    // Fall back to the POSIX process reporter when /proc is unavailable.
  }
  const sampled = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  const kibibytes = Number(sampled.stdout.trim());
  assert(
    sampled.status === 0 && Number.isFinite(kibibytes),
    `Could not sample RSS for PID ${pid}.`,
  );
  return kibibytes * 1024;
}

async function waitForNoStagedPayloads(path) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (stagedPayloadEntries(path).length === 0) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for staged bundle payload cleanup in ${path}.`);
}

function stagedPayloadEntries(path) {
  return directoryEntries(path).filter((entry) => {
    if (entry.includes("/") || entry.includes("\\")) return true;
    return (
      !/^caplets-admin-upload-h[a-f0-9]{16}-/u.test(entry) &&
      !/^\.p(?:[a-f0-9]{16}|u)[a-f0-9]{32}$/u.test(entry)
    );
  });
}

function countDirectoryEntries(path) {
  return directoryEntries(path).length;
}

function directoryEntries(path) {
  try {
    return readdirSync(path, { recursive: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine smoke port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForResponse(url) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5000)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5000))) {
    throw new Error(`Host Node PID ${child.pid} did not exit after SIGKILL.`);
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

function appendDiagnosticOutput(current, chunk) {
  const remaining = MAX_DIAGNOSTIC_OUTPUT_CHARS - current.length;
  return remaining > 0 ? current + String(chunk).slice(0, remaining) : current;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
