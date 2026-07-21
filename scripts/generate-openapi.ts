import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRootOpenApiJson } from "../packages/core/src/admin-api/openapi-representation";

const EXPECTED_GENERATOR_DEPENDENCIES = {
  "@hey-api/openapi-ts": "0.99.0",
  typescript: "6.0.3",
} as const;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const schemaPath = join(repoRoot, "schemas/caplets-http.openapi.json");
const generatedSdkPath = join(repoRoot, "packages/sdk/src/generated");
const generatorRoot = join(repoRoot, "tools/sdk-generator");
const generatorPackagePath = join(generatorRoot, "package.json");
const generatorConfigPath = join(repoRoot, "openapi-ts.config.ts");

const GENERATED_AUTH_EXISTENCE_CHECK = `  for (const auth of options.security ?? []) {
    if (checkForExistence(options, auth.name)) {
      continue;
    }`;
const NORMALIZED_AUTH_EXISTENCE_CHECK = `  for (const auth of options.security ?? []) {
    const name = auth.name ?? "Authorization";
    if (checkForExistence(options, name)) {
      continue;
    }`;
const GENERATED_AUTH_NAME = `
    const name = auth.name ?? "Authorization";

    switch (auth.in) {`;
const GENERATED_AUTH_NAME_SINGLE_QUOTED = `
    const name = auth.name ?? 'Authorization';

    switch (auth.in) {`;
const NORMALIZED_AUTH_NAME = `
    switch (auth.in) {`;
const GENERATED_HEADER_ITERATOR =
  "    const iterator = header instanceof Headers ? headersEntries(header) : Object.entries(header);";
const NORMALIZED_HEADER_ITERATOR = `    const iterator =
      header instanceof Headers
        ? headersEntries(header)
        : Array.isArray(header)
          ? header
          : Object.entries(header);`;

const GENERATED_CLIENT_SSE_SETUP = `  const makeSseFn = (method: Uppercase<HttpMethod>) => async (options: RequestOptions) => {
    const { opts, url } = await beforeRequest(options);
    return createSseClient({
      ...opts,
      body: opts.body as BodyInit | null | undefined,
      method,
      onRequest: async (url, init) => {
        let request = new Request(url, init);
        for (const fn of interceptors.request.fns) {
          if (fn) {
            request = await fn(request, opts);
          }
        }
        return request;
      },
      serializedBody: getValidRequestBody(opts) as BodyInit | null | undefined,
      url,
    });
  };`;
const NORMALIZED_CLIENT_SSE_SETUP = `  const makeSseFn = (method: Uppercase<HttpMethod>) => async (options: RequestOptions) => {
    const signal = options.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    const setup = beforeRequest(options);
    let prepared: Awaited<typeof setup>;
    if (!signal) {
      prepared = await setup;
    } else {
      const aborted = Promise.withResolvers<never>();
      const abortHandler = () => {
        aborted.reject(
          signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
        );
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      try {
        prepared = await Promise.race([setup, aborted.promise]);
      } finally {
        signal.removeEventListener("abort", abortHandler);
      }
    }

    const { opts, url } = prepared;
    return createSseClient({
      ...opts,
      body: opts.body as BodyInit | null | undefined,
      method,
      onRequest: async (url, init) => {
        let request = new Request(url, init);
        for (const fn of interceptors.request.fns) {
          if (fn) {
            request = await fn(request, opts);
          }
        }
        return request;
      },
      serializedBody: getValidRequestBody(opts) as BodyInit | null | undefined,
      url,
    });
  };`;

const GENERATED_SSE_FUNCTION_START = "export function createSseClient<TData = unknown>({";
const NORMALIZED_SSE_SUPPORT = `type ServerSentEventsData<TData> = TData extends Record<string, unknown>
  ? TData[keyof TData]
  : TData;

const SSE_MAX_PENDING_EVENT_BYTES = 1024 * 1024;
const sseTextEncoder = new TextEncoder();

class NonRetryableSseError extends Error {}

function isValidSseRetryDelay(
  value: number | undefined,
  maximum: number,
): value is number {
  return (
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function defaultSseSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const abortHandler = () => {
    clearTimeout(timer);
    resolve();
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  void promise.then(() => signal.removeEventListener("abort", abortHandler));
  return promise;
}

async function waitForSseRetry(
  sleep: ((ms: number) => Promise<void>) | undefined,
  delay: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const { promise: aborted, resolve: abortHandler } = Promise.withResolvers<void>();
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    await Promise.race([sleep?.(delay) ?? defaultSseSleep(delay, signal), aborted]);
    return !signal.aborted;
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

const sseAborted = Symbol("sse-aborted");

async function raceSseAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof sseAborted> {
  if (signal.aborted) return sseAborted;
  const aborted = Promise.withResolvers<typeof sseAborted>();
  const abortHandler = () => aborted.resolve(sseAborted);
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

function createAbortableSseStream<TData>(
  createStream: (
    signal: AbortSignal,
  ) => AsyncGenerator<ServerSentEventsData<TData>, void, unknown>,
  callerSignal: AbortSignal | null | undefined,
): AsyncGenerator<ServerSentEventsData<TData>, void, unknown> {
  const controller = new AbortController();
  let callerAbortAttached = false;
  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else if (callerSignal) {
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    callerAbortAttached = true;
  }
  const detachCallerAbort = () => {
    if (!callerAbortAttached || !callerSignal) return;
    callerSignal.removeEventListener("abort", abortFromCaller);
    callerAbortAttached = false;
  };

  const stream = createStream(controller.signal);
  const nextStream = stream.next.bind(stream);
  const returnStream = stream.return.bind(stream);
  const throwStream = stream.throw.bind(stream);
  stream.next = (value) => {
    const result = nextStream(value);
    void result.then((iteration) => {
      if (iteration.done) detachCallerAbort();
    }, detachCallerAbort);
    return result;
  };
  stream.return = (value) => {
    controller.abort();
    detachCallerAbort();
    return returnStream(value);
  };
  stream.throw = (error) => {
    controller.abort();
    detachCallerAbort();
    return throwStream(error);
  };
  return stream;
}`;
const FORMATTED_NORMALIZED_SSE_SUPPORT = NORMALIZED_SSE_SUPPORT.replace(
  `type ServerSentEventsData<TData> = TData extends Record<string, unknown>
  ? TData[keyof TData]
  : TData;`,
  `type ServerSentEventsData<TData> =
  TData extends Record<string, unknown> ? TData[keyof TData] : TData;`,
)
  .replace(
    `function isValidSseRetryDelay(
  value: number | undefined,
  maximum: number,
): value is number {
  return (
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}`,
    `function isValidSseRetryDelay(value: number | undefined, maximum: number): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}`,
  )
  .replace(
    `function createAbortableSseStream<TData>(
  createStream: (
    signal: AbortSignal,
  ) => AsyncGenerator<ServerSentEventsData<TData>, void, unknown>,`,
    `function createAbortableSseStream<TData>(
  createStream: (signal: AbortSignal) => AsyncGenerator<ServerSentEventsData<TData>, void, unknown>,`,
  );
const NORMALIZED_SSE_SUPPORT_ALTERNATIVES = [
  NORMALIZED_SSE_SUPPORT,
  FORMATTED_NORMALIZED_SSE_SUPPORT,
] as const;
const GENERATED_SSE_SLEEP =
  "  const sleep = sseSleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));";
const NORMALIZED_SSE_SLEEP = "  const sleep = sseSleepFn;";
const GENERATED_SSE_ABORT_CHECK = `    while (true) {
      if (signal.aborted) break;`;
const NORMALIZED_SSE_ABORT_CHECK = `    while (true) {
      if (signal.aborted) return;`;
const GENERATED_SSE_STREAM_SETUP = `  const createStream = async function* () {
    let retryDelay: number = sseDefaultRetryDelay ?? 3000;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;`;
const NORMALIZED_SSE_STREAM_SETUP = `  const createStream = async function* (signal: AbortSignal) {
    const maximumRetryDelay =
      sseMaxRetryDelay !== undefined &&
      Number.isSafeInteger(sseMaxRetryDelay) &&
      sseMaxRetryDelay >= 0
        ? sseMaxRetryDelay
        : 30_000;
    let retryDelay = isValidSseRetryDelay(sseDefaultRetryDelay, maximumRetryDelay)
      ? sseDefaultRetryDelay
      : Math.min(3_000, maximumRetryDelay);
    let attempt = 0;`;
const GENERATED_SSE_STREAM_CREATION = "  const stream = createStream();";
const NORMALIZED_SSE_STREAM_CREATION =
  "  const stream = createAbortableSseStream<TData>(createStream, options.signal);";
const GENERATED_SSE_RESPONSE_CHECK =
  "        if (!response.ok) throw new Error(`SSE failed: ${response.status} ${response.statusText}`);";
const NORMALIZED_SSE_RESPONSE_CHECK = `        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            // Preserve the HTTP failure when stream cancellation itself fails.
          }
          const error = new Error(\`SSE failed: \${response.status} \${response.statusText}\`);
          if (response.status >= 400 && response.status < 500) {
            throw new NonRetryableSseError(error.message);
          }
          throw error;
        }`;
const GENERATED_SSE_REQUEST_HOOK = `        let request = new Request(url, requestInit);
        if (onRequest) {
          request = await onRequest(url, requestInit);
        }`;
const NORMALIZED_SSE_REQUEST_HOOK = `        let request = new Request(url, requestInit);
        if (onRequest) {
          const preparedRequest = await raceSseAbort(onRequest(url, requestInit), signal);
          if (preparedRequest === sseAborted) return;
          request = preparedRequest;
        }
        if (signal.aborted) return;`;
const GENERATED_SSE_READER_SETUP = `        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

        let buffer = '';

        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {
            // noop
          }
        };

        signal.addEventListener('abort', abortHandler);`;
const NORMALIZED_SSE_READER_SETUP = `        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

        let buffer = "";
        let pendingCarriageReturn = false;
        let pendingEventBytes = 0;
        let readerDone = false;
        let cancelReaderPromise: Promise<void> | undefined;
        const cancelReader = (): Promise<void> => {
          cancelReaderPromise ??= reader.cancel().catch(() => undefined);
          return cancelReaderPromise;
        };
        const abortHandler = () => {
          void cancelReader();
        };

        signal.addEventListener("abort", abortHandler);`;
const GENERATED_SSE_READER_DONE = `            if (done) break;
            buffer += value;
            buffer = buffer.replace(/\\r\\n?/g, '\\n'); // normalize line endings`;
const NORMALIZED_SSE_READER_DONE = `            let normalizedValue: string;
            if (done) {
              readerDone = true;
              if (!pendingCarriageReturn) break;
              pendingCarriageReturn = false;
              normalizedValue = "\\n";
            } else {
              normalizedValue = value;
              if (pendingCarriageReturn) {
                normalizedValue = \`\\r\${normalizedValue}\`;
                pendingCarriageReturn = false;
              }
              if (normalizedValue.endsWith("\\r")) {
                pendingCarriageReturn = true;
                normalizedValue = normalizedValue.slice(0, -1);
              }
              normalizedValue = normalizedValue.replace(/\\r\\n?/g, "\\n");
            }
            buffer += normalizedValue;`;
const GENERATED_SSE_PENDING_BUFFER = `            const chunks = buffer.split('\\n\\n');
            buffer = chunks.pop() ?? '';

            for (const chunk of chunks) {`;
const NORMALIZED_SSE_PENDING_BUFFER = `            const chunks = buffer.split("\\n\\n");
            buffer = chunks.pop() ?? "";
            pendingEventBytes =
              chunks.length === 0
                ? pendingEventBytes + sseTextEncoder.encode(normalizedValue).byteLength
                : sseTextEncoder.encode(buffer).byteLength;
            if (pendingEventBytes > SSE_MAX_PENDING_EVENT_BYTES) {
              throw new NonRetryableSseError("SSE pending event data exceeded 1 MiB.");
            }

            for (const chunk of chunks) {
              if (sseTextEncoder.encode(chunk).byteLength > SSE_MAX_PENDING_EVENT_BYTES) {
                throw new NonRetryableSseError("SSE event data exceeded 1 MiB.");
              }`;
const GENERATED_SSE_YIELD = "                yield data as any;";
const NORMALIZED_SSE_YIELD = "                yield data as ServerSentEventsData<TData>;";
const GENERATED_SSE_READER_CLEANUP = `        } finally {
          signal.removeEventListener('abort', abortHandler);
          reader.releaseLock();
        }

        break; // exit loop on normal completion`;
const NORMALIZED_SSE_READER_CLEANUP = `        } finally {
          signal.removeEventListener("abort", abortHandler);
          if (!readerDone) await cancelReader();
          else if (cancelReaderPromise) await cancelReaderPromise;
          reader.releaseLock();
        }

        if (signal.aborted) return;
        throw new Error("SSE connection closed.");`;
const GENERATED_SSE_RETRY_FIELD = `                } else if (line.startsWith('retry:')) {
                  const parsed = Number.parseInt(line.replace(/^retry:\\s*/, ''), 10);
                  if (!Number.isNaN(parsed)) {
                    retryDelay = parsed;
                  }
                }`;
const NORMALIZED_SSE_RETRY_FIELD = `                } else if (line.startsWith("retry:")) {
                  const retryField = line.startsWith("retry: ") ? line.slice(7) : line.slice(6);
                  if (/^[0-9]+$/.test(retryField)) {
                    const parsed = Number(retryField);
                    if (isValidSseRetryDelay(parsed, maximumRetryDelay)) {
                      retryDelay = parsed;
                    }
                  }
                }`;
const GENERATED_SSE_BACKOFF =
  "        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), sseMaxRetryDelay ?? 30000);";
const NORMALIZED_SSE_BACKOFF =
  "        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maximumRetryDelay);";
const GENERATED_SSE_CATCH = `      } catch (error) {
        // connection failed or aborted; retry after delay
        onSseError?.(error);`;
const NORMALIZED_SSE_CATCH = `      } catch (error) {
        if (signal.aborted) return;
        onSseError?.(error);
        if (error instanceof NonRetryableSseError) throw error;`;
const GENERATED_SSE_RETRY_EXHAUSTION = `        if (sseMaxRetryAttempts !== undefined && attempt >= sseMaxRetryAttempts) {
          break; // stop after firing error
        }`;
const NORMALIZED_SSE_RETRY_EXHAUSTION = `        if (sseMaxRetryAttempts !== undefined && attempt >= sseMaxRetryAttempts) {
          throw error;
        }`;
const GENERATED_SSE_RETRY_SLEEP = "        await sleep(backoff);";
const NORMALIZED_SSE_RETRY_SLEEP =
  "        if (!(await waitForSseRetry(sleep, backoff, signal))) return;";
const GENERATED_SSE_REPLACEMENTS = [
  [GENERATED_SSE_SLEEP, NORMALIZED_SSE_SLEEP, "SSE sleep"],
  [GENERATED_SSE_STREAM_SETUP, NORMALIZED_SSE_STREAM_SETUP, "SSE stream setup"],
  [GENERATED_SSE_ABORT_CHECK, NORMALIZED_SSE_ABORT_CHECK, "SSE abort check"],
  [GENERATED_SSE_RESPONSE_CHECK, NORMALIZED_SSE_RESPONSE_CHECK, "SSE response check"],
  [GENERATED_SSE_REQUEST_HOOK, NORMALIZED_SSE_REQUEST_HOOK, "SSE request hook"],
  [GENERATED_SSE_READER_SETUP, NORMALIZED_SSE_READER_SETUP, "SSE reader setup"],
  [GENERATED_SSE_READER_DONE, NORMALIZED_SSE_READER_DONE, "SSE reader completion"],
  [GENERATED_SSE_PENDING_BUFFER, NORMALIZED_SSE_PENDING_BUFFER, "SSE pending buffer"],
  [GENERATED_SSE_RETRY_FIELD, NORMALIZED_SSE_RETRY_FIELD, "SSE retry field"],
  [GENERATED_SSE_BACKOFF, NORMALIZED_SSE_BACKOFF, "SSE retry backoff"],
  [GENERATED_SSE_YIELD, NORMALIZED_SSE_YIELD, "SSE yield"],
  [GENERATED_SSE_READER_CLEANUP, NORMALIZED_SSE_READER_CLEANUP, "SSE reader cleanup"],
  [GENERATED_SSE_CATCH, NORMALIZED_SSE_CATCH, "SSE catch"],
  [GENERATED_SSE_RETRY_EXHAUSTION, NORMALIZED_SSE_RETRY_EXHAUSTION, "SSE retry exhaustion"],
  [GENERATED_SSE_RETRY_SLEEP, NORMALIZED_SSE_RETRY_SLEEP, "SSE retry sleep"],
  [GENERATED_SSE_STREAM_CREATION, NORMALIZED_SSE_STREAM_CREATION, "SSE stream creation"],
] as const;

function replaceGeneratedSourceOnce(
  source: string,
  generated: string,
  normalized: string,
  label: string,
): string {
  const first = source.indexOf(generated);
  if (first === -1 || source.indexOf(generated, first + generated.length) !== -1) {
    throw new Error(`Expected exactly one generated ${label} block.`);
  }
  return `${source.slice(0, first)}${normalized}${source.slice(first + generated.length)}`;
}
function replaceGeneratedSourceAlternativeOnce(
  source: string,
  generatedAlternatives: readonly string[],
  normalized: string,
  label: string,
): string {
  const matches = generatedAlternatives.filter((generated) => source.includes(generated));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one generated ${label} block.`);
  }
  return replaceGeneratedSourceOnce(source, matches[0]!, normalized, label);
}

function replaceGeneratedSourceOrValidateNormalizedOnce(
  source: string,
  generated: string,
  normalized: string,
  label: string,
): string {
  const generatedFirst = source.indexOf(generated);
  const normalizedFirst = source.indexOf(normalized);
  const generatedUnique =
    generatedFirst !== -1 && source.indexOf(generated, generatedFirst + generated.length) === -1;
  const normalizedUnique =
    normalizedFirst !== -1 &&
    source.indexOf(normalized, normalizedFirst + normalized.length) === -1;
  if (normalizedUnique) {
    const withoutNormalized = `${source.slice(0, normalizedFirst)}${source.slice(
      normalizedFirst + normalized.length,
    )}`;
    if (!withoutNormalized.includes(generated)) return source;
  }
  if (generatedUnique && normalizedFirst === -1) {
    return replaceGeneratedSourceOnce(source, generated, normalized, label);
  }
  throw new Error(`Expected exactly one generated or normalized ${label} block.`);
}

function insertGeneratedSourceSupportOnce(
  source: string,
  marker: string,
  supportAlternatives: readonly string[],
  label: string,
): string {
  const matches = supportAlternatives.filter((support) => source.includes(support));
  if (matches.length === 1) {
    const support = matches[0]!;
    const first = source.indexOf(support);
    if (source.indexOf(support, first + support.length) !== -1) {
      throw new Error(`Expected exactly one normalized ${label} block.`);
    }
    replaceGeneratedSourceOnce(source, marker, marker, `${label} marker`);
    return source;
  }
  if (matches.length > 1) {
    throw new Error(`Expected exactly one normalized ${label} block.`);
  }
  return replaceGeneratedSourceOnce(
    source,
    marker,
    `${supportAlternatives[0]}\n\n${marker}`,
    label,
  );
}

export function normalizeGeneratedServerSentEvents(source: string): string {
  let normalized = insertGeneratedSourceSupportOnce(
    source,
    GENERATED_SSE_FUNCTION_START,
    NORMALIZED_SSE_SUPPORT_ALTERNATIVES,
    "SSE support",
  );
  for (const [generated, replacement, label] of GENERATED_SSE_REPLACEMENTS) {
    normalized = replaceGeneratedSourceOrValidateNormalizedOnce(
      normalized,
      generated,
      replacement,
      label,
    );
  }
  return normalized;
}

export function normalizeGeneratedClientHeaders(source: string): string {
  const withAuthPrecedence = replaceGeneratedSourceOnce(
    source,
    GENERATED_AUTH_EXISTENCE_CHECK,
    NORMALIZED_AUTH_EXISTENCE_CHECK,
    "auth existence",
  );
  const withoutDuplicateAuthName = replaceGeneratedSourceAlternativeOnce(
    withAuthPrecedence,
    [GENERATED_AUTH_NAME, GENERATED_AUTH_NAME_SINGLE_QUOTED],
    NORMALIZED_AUTH_NAME,
    "auth name",
  );
  return replaceGeneratedSourceOnce(
    withoutDuplicateAuthName,
    GENERATED_HEADER_ITERATOR,
    NORMALIZED_HEADER_ITERATOR,
    "header iterator",
  );
}

export function normalizeGeneratedClientSseSetup(source: string): string {
  const normalizedMarkers = [
    "    const setup = beforeRequest(options);",
    "        prepared = await Promise.race([setup, aborted.promise]);",
  ] as const;
  if (
    normalizedMarkers.every((marker) => source.includes(marker)) &&
    !source.includes(GENERATED_CLIENT_SSE_SETUP)
  ) {
    for (const marker of normalizedMarkers) {
      replaceGeneratedSourceOnce(source, marker, marker, "client SSE setup marker");
    }
    return source;
  }
  return replaceGeneratedSourceOnce(
    source,
    GENERATED_CLIENT_SSE_SETUP,
    NORMALIZED_CLIENT_SSE_SETUP,
    "client SSE setup",
  );
}

async function normalizeGeneratedSdk(output: string): Promise<void> {
  const clientUtilsPath = join(output, "client", "utils.gen.ts");
  const clientPath = join(output, "client", "client.gen.ts");
  const serverSentEventsPath = join(output, "core", "serverSentEvents.gen.ts");
  const [clientUtilsSource, clientSource, serverSentEventsSource] = await Promise.all([
    readFile(clientUtilsPath, "utf8"),
    readFile(clientPath, "utf8"),
    readFile(serverSentEventsPath, "utf8"),
  ]);
  await Promise.all([
    writeFile(clientUtilsPath, normalizeGeneratedClientHeaders(clientUtilsSource)),
    writeFile(clientPath, normalizeGeneratedClientSseSetup(clientSource)),
    writeFile(serverSentEventsPath, normalizeGeneratedServerSentEvents(serverSentEventsSource)),
  ]);
}

async function assertPinnedGenerator(): Promise<void> {
  const packageJson = JSON.parse(await readFile(generatorPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const [dependency, expectedVersion] of Object.entries(EXPECTED_GENERATOR_DEPENDENCIES)) {
    const installedVersion = packageJson.dependencies?.[dependency];
    if (installedVersion !== expectedVersion) {
      throw new Error(
        `Expected ${dependency} ${expectedVersion}, found ${installedVersion ?? "no pinned dependency"}`,
      );
    }
  }
}

function runHeyApi(input: string, output: string): void {
  const result = spawnSync(
    "pnpm",
    [
      "--dir",
      generatorRoot,
      "exec",
      "openapi-ts",
      "--file",
      generatorConfigPath,
      "--silent",
      "--no-log-file",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CAPLETS_OPENAPI_INPUT: input,
        CAPLETS_SDK_OUTPUT: output,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        `HeyAPI generation failed with status ${result.status ?? "unknown"}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function formatArtifacts(paths: readonly string[]): void {
  const result = spawnSync("pnpm", ["exec", "oxfmt", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      ["OpenAPI artifact formatting failed.", result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

async function compareFile(expected: string, actual: string, label: string): Promise<string[]> {
  try {
    const [expectedContents, actualContents] = await Promise.all([
      readFile(expected),
      readFile(actual),
    ]);
    return expectedContents.equals(actualContents) ? [] : [label];
  } catch {
    return [label];
  }
}

async function compareDirectories(expected: string, actual: string): Promise<string[]> {
  let expectedFiles: string[];
  let actualFiles: string[];
  try {
    [expectedFiles, actualFiles] = await Promise.all([filesUnder(expected), filesUnder(actual)]);
  } catch {
    return [relative(repoRoot, actual)];
  }

  const paths = [...new Set([...expectedFiles, ...actualFiles])].sort();
  const drift: string[] = [];
  for (const path of paths) {
    if (!expectedFiles.includes(path) || !actualFiles.includes(path)) {
      drift.push(join(relative(repoRoot, actual), path));
      continue;
    }
    drift.push(
      ...(await compareFile(
        join(expected, path),
        join(actual, path),
        join(relative(repoRoot, actual), path),
      )),
    );
  }
  return drift;
}

async function generate(check: boolean): Promise<void> {
  await assertPinnedGenerator();
  const canonicalDocument = canonicalRootOpenApiJson();

  if (!check) {
    await mkdir(dirname(schemaPath), { recursive: true });
    await writeFile(schemaPath, canonicalDocument);
    runHeyApi(schemaPath, generatedSdkPath);
    await normalizeGeneratedSdk(generatedSdkPath);
    await rm(join(generatedSdkPath, "client.gen.ts"), { force: true });
    formatArtifacts([generatedSdkPath]);
    process.stdout.write("Generated canonical OpenAPI and SDK artifacts.\n");
    return;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "caplets-openapi-"));
  try {
    const temporarySchema = join(temporaryRoot, "caplets-http.openapi.json");
    const temporarySdk = join(temporaryRoot, "sdk");
    await writeFile(temporarySchema, canonicalDocument);
    runHeyApi(temporarySchema, temporarySdk);
    await normalizeGeneratedSdk(temporarySdk);
    await rm(join(temporarySdk, "client.gen.ts"), { force: true });
    formatArtifacts([temporarySdk]);

    const drift = [
      ...(await compareFile(temporarySchema, schemaPath, relative(repoRoot, schemaPath))),
      ...(await compareDirectories(temporarySdk, generatedSdkPath)),
    ];
    if (drift.length > 0) {
      throw new Error(
        `OpenAPI artifacts are stale:\n${drift.map((path) => `  - ${path}`).join("\n")}\nRun pnpm openapi:generate.`,
      );
    }
    process.stdout.write("OpenAPI and generated SDK artifacts are current.\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await generate(process.argv.includes("--check"));
}
