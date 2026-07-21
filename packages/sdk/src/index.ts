import {
  adminV2GetCapletRecordBundle,
  adminV2GetCapletRecordRevisionBundle,
  adminV2PutCapletRecordBundle,
} from "./generated/sdk.gen";
import { createClient as createGeneratedClient } from "./generated/client";
import type { Client, Config, RequestResult } from "./generated/client";
import type {
  AdminV2PutCapletRecordBundleErrors,
  AdminV2PutCapletRecordBundleResponses,
  Problem,
} from "./generated/types.gen";

export * from "./generated";
export type {
  Auth,
  Client,
  ClientMeta,
  Config,
  CreateClientConfig,
  Options,
  RequestOptions,
  RequestResult,
  ResolvedRequestOptions,
  ResponseStyle,
  TDataShape,
} from "./generated/client";

export type CapletsClientConfig = Omit<Config, "baseUrl"> & {
  baseUrl: string;
};

/**
 * Creates an isolated client for an HTTP(S) service root.
 * Deployment-prefix paths are URL-normalized; credentials, queries, and fragments are rejected.
 */
export function createClient(config: CapletsClientConfig): Client {
  let serviceRoot: URL;
  try {
    serviceRoot = new URL(config.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (
    (serviceRoot.protocol !== "http:" && serviceRoot.protocol !== "https:") ||
    serviceRoot.host.length === 0
  ) {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (
    serviceRoot.username.length > 0 ||
    serviceRoot.password.length > 0 ||
    serviceRoot.href.includes("?") ||
    serviceRoot.href.includes("#")
  ) {
    throw new TypeError("baseUrl must not include credentials, a query, or a fragment");
  }
  const servicePath = serviceRoot.pathname.replace(/\/+$/u, "");
  const normalizedBaseUrl = `${serviceRoot.origin}${servicePath}`;

  return createGeneratedClient({
    responseStyle: "fields",
    throwOnError: false,
    ...config,
    baseUrl: normalizedBaseUrl,
  });
}

export type BundleStreamResult =
  | {
      data: ReadableStream<Uint8Array> | null;
      error: undefined;
      request?: Request;
      response?: Response;
    }
  | {
      data: undefined;
      error: Problem;
      request?: Request;
      response?: Response;
    };

export type CurrentBundleStreamOptions = Omit<
  Parameters<typeof adminV2GetCapletRecordBundle>[0],
  "parseAs" | "responseStyle" | "throwOnError"
>;

export type RevisionBundleStreamOptions = Omit<
  Parameters<typeof adminV2GetCapletRecordRevisionBundle>[0],
  "parseAs" | "responseStyle" | "throwOnError"
>;

/** Returns the network response body without buffering or multipart parsing. */
export async function adminV2GetCapletRecordBundleStream(
  options: CurrentBundleStreamOptions,
): Promise<BundleStreamResult> {
  return adminV2GetCapletRecordBundle({
    ...options,
    parseAs: "stream",
    responseStyle: "fields",
    throwOnError: false,
  }) as unknown as Promise<BundleStreamResult>;
}

/** Returns an immutable revision bundle body without buffering or multipart parsing. */
export async function adminV2GetCapletRecordRevisionBundleStream(
  options: RevisionBundleStreamOptions,
): Promise<BundleStreamResult> {
  return adminV2GetCapletRecordRevisionBundle({
    ...options,
    parseAs: "stream",
    responseStyle: "fields",
    throwOnError: false,
  }) as unknown as Promise<BundleStreamResult>;
}

export type OrderedBundleFile = Blob | File;

/** Builds the manifest-first, repeated-file FormData sequence for in-memory callers. */
export function createOrderedBundleFormData(
  manifest: string,
  files: ReadonlyArray<OrderedBundleFile>,
): FormData {
  const formData = new FormData();
  formData.append("manifest", manifest);
  for (const file of files) formData.append("file", file);
  return formData;
}

export type BundleFormDataUploadOptions = Omit<
  Parameters<typeof adminV2PutCapletRecordBundle>[0],
  "body" | "bodySerializer" | "responseStyle" | "throwOnError"
> & {
  body: FormData;
};

/** Sends caller-ordered FormData verbatim so Fetch owns the multipart boundary. */
export function adminV2PutCapletRecordBundleFormData(
  options: BundleFormDataUploadOptions,
): RequestResult<AdminV2PutCapletRecordBundleResponses, AdminV2PutCapletRecordBundleErrors, false> {
  const { body, ...requestOptions } = options;
  return adminV2PutCapletRecordBundle({
    ...requestOptions,
    body: body as never,
    bodySerializer: () => body,
    responseStyle: "fields",
    throwOnError: false,
  });
}

export type OrderedBundleFileStream = {
  /**
   * Opens a fresh chunk source. The source must stop pending reads and release
   * its resources when the signal is aborted.
   */
  open: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
};

export type OrderedBundleMultipartBody = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
};

/** Builds a manifest-first multipart stream without buffering file bodies. */
export function createOrderedBundleMultipartBody(
  manifest: string,
  files: ReadonlyArray<OrderedBundleFileStream>,
  boundary: string,
): OrderedBundleMultipartBody {
  const sourceController = new AbortController();
  const iterator = encodeOrderedBundleMultipart(manifest, files, boundary, sourceController.signal);
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (canceled) return;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        if (!canceled) controller.error(error);
      }
    },
    cancel(reason) {
      if (canceled) return;
      canceled = true;
      sourceController.abort(reason);
      void iterator.return?.().catch(() => undefined);
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function* encodeOrderedBundleMultipart(
  manifest: string,
  files: ReadonlyArray<OrderedBundleFileStream>,
  boundary: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, void> {
  const encoder = new TextEncoder();
  yield encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n`,
  );
  for (const file of files) {
    yield encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    for await (const chunk of file.open(signal)) yield chunk;
    yield encoder.encode("\r\n");
  }
  yield encoder.encode(`--${boundary}--\r\n`);
}

export type BundleStreamUploadOptions = Omit<
  Parameters<typeof adminV2PutCapletRecordBundle>[0],
  "body" | "bodySerializer" | "headers" | "responseStyle" | "throwOnError"
> & {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  headers: NonNullable<ConstructorParameters<typeof Headers>[0]>;
};

/** Sends an operation-local multipart stream with Node Fetch's required half-duplex mode. */
export function adminV2PutCapletRecordBundleStream(
  options: BundleStreamUploadOptions,
): RequestResult<AdminV2PutCapletRecordBundleResponses, AdminV2PutCapletRecordBundleErrors, false> {
  const { body, contentType, headers: callerHeaders, ...requestOptions } = options;
  const headers = new Headers(callerHeaders);
  headers.set("Content-Type", contentType);
  const streamRequest = {
    ...requestOptions,
    body: body as never,
    bodySerializer: () => body as never,
    headers: Object.fromEntries(headers.entries()),
    duplex: "half",
    responseStyle: "fields",
    throwOnError: false,
  };
  return adminV2PutCapletRecordBundle(
    streamRequest as unknown as Parameters<typeof adminV2PutCapletRecordBundle>[0],
  ) as RequestResult<
    AdminV2PutCapletRecordBundleResponses,
    AdminV2PutCapletRecordBundleErrors,
    false
  >;
}
