import type { CapletsEngineOptions } from "../engine";
import {
  buildNativeAttachProjection,
  invokeNativeAttachExport,
  type AttachInvokeRequest,
  type AttachSessionMetadata,
} from "../attach/api";
import {
  createInternalNativeCapletsService,
  createActivatedNativeCapletsService,
  type NativeCapletsService,
} from "../native/service";
import { isCapletsCloudUrl } from "../remote/options";
import type { ControlPlaneRuntimeSnapshotLoader } from "../control-plane/snapshot";
import {
  CAPLETS_STACK_CHAIN_HEADER,
  sanitizeRemoteEngineOptions,
  serveHttp,
  serveInternalHttp,
  serveInternalHttpWithSessionFactory,
  serveHttpWithSessionFactory,
} from "./http";
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "./options";
import { NativeCapletsMcpSession } from "./native-session";
import { serveInternalStdio, serveStdio } from "./stdio";

export { serveHttp } from "./http";
export { resolveServeOptions } from "./options";
export type { HttpServeOptions, RawServeOptions, ServeOptions, StdioServeOptions } from "./options";
export { NativeCapletsMcpSession } from "./native-session";
export type { NativeCapletsMcpSessionOptions, NativeToolServer } from "./native-session";
export { serveStdio } from "./stdio";

export type ServeCapletsOptions = {
  raw: RawServeOptions;
  engine?: CapletsEngineOptions;
  env?: NodeJS.ProcessEnv;
  writeErr?: (value: string) => void;
};

export async function serveCaplets(options: ServeCapletsOptions): Promise<void> {
  const resolved = resolveServeOptions(options.raw, options.env ?? process.env);
  await serveResolvedCaplets(resolved, options.engine, options.writeErr);
}

export async function serveInternalCaplets(
  options: ServeCapletsOptions,
  loader: ControlPlaneRuntimeSnapshotLoader,
): Promise<void> {
  const resolved = resolveServeOptions(options.raw, options.env ?? process.env);
  await serveInternalResolvedCaplets(resolved, loader, options.engine, options.writeErr);
}

export async function serveResolvedCaplets(
  resolved: ServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr?: (value: string) => void,
): Promise<void> {
  if (resolved.transport === "stdio") {
    await serveStdio({ ...engineOptions, ...(writeErr ? { writeErr } : {}) });
    return;
  }
  if (resolved.upstreamUrl) {
    await serveHttpWithUpstream(resolved, resolved.upstreamUrl, engineOptions, writeErr);
    return;
  }
  await serveHttp(resolved, { ...engineOptions, ...(writeErr ? { writeErr } : {}) }, writeErr);
}

export async function serveInternalResolvedCaplets(
  resolved: ServeOptions,
  loader: ControlPlaneRuntimeSnapshotLoader,
  engineOptions: CapletsEngineOptions = {},
  writeErr?: (value: string) => void,
): Promise<void> {
  if (resolved.transport === "stdio") {
    await serveInternalStdio({ ...engineOptions, ...(writeErr ? { writeErr } : {}) }, loader);
    return;
  }
  if (resolved.upstreamUrl) {
    await serveHttpWithUpstream(resolved, resolved.upstreamUrl, engineOptions, writeErr, loader);
    return;
  }
  await serveInternalHttp(
    resolved,
    { ...engineOptions, ...(writeErr ? { writeErr } : {}) },
    loader,
    writeErr,
  );
}

async function serveHttpWithUpstream(
  resolved: Extract<ServeOptions, { transport: "http" }>,
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
  loader?: ControlPlaneRuntimeSnapshotLoader,
): Promise<void> {
  const remoteEngineOptions = sanitizeRemoteEngineOptions(engineOptions);
  const stackChain = [serveStackIdentity(resolved)];
  const createSession = async () =>
    new NativeCapletsMcpSession(
      await createReloadedUpstreamService(
        upstreamUrl,
        remoteEngineOptions,
        writeErr,
        {},
        stackChain,
        loader,
      ),
    );
  const io = {
    exposeAttach: true,
    defaultAttachSessionFactory: async (
      _metadata: AttachSessionMetadata,
      context: { stackChain: string[] },
    ) =>
      nativeAttachSession(
        await createReloadedUpstreamService(
          upstreamUrl,
          remoteEngineOptions,
          writeErr,
          {},
          context.stackChain,
          loader,
        ),
      ),
    attachSessionFactory: async (
      metadata: AttachSessionMetadata,
      context: { stackChain: string[] },
    ) =>
      nativeAttachSession(
        await createReloadedUpstreamService(
          upstreamUrl,
          remoteEngineOptions,
          writeErr,
          metadata,
          context.stackChain,
          loader,
        ),
      ),
  };
  if (loader) {
    await serveInternalHttpWithSessionFactory(
      resolved,
      createSession,
      loader,
      writeErr,
      io,
      remoteEngineOptions,
    );
    return;
  }
  await serveHttpWithSessionFactory(resolved, createSession, writeErr, io, remoteEngineOptions);
}

async function createReloadedUpstreamService(
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
  metadata: AttachSessionMetadata = {},
  stackChain: string[] = [],
  loader?: ControlPlaneRuntimeSnapshotLoader,
): Promise<NativeCapletsService> {
  const service = await createUpstreamNativeService(
    upstreamUrl,
    engineOptions,
    writeErr,
    metadata,
    stackChain,
    loader,
  );
  try {
    await service.reload();
    return service;
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
}

async function createUpstreamNativeService(
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
  metadata: AttachSessionMetadata = {},
  stackChain: string[] = [],
  loader?: ControlPlaneRuntimeSnapshotLoader,
): Promise<NativeCapletsService> {
  const options = {
    ...engineOptions,
    ...(metadata.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
    ...(metadata.projectConfigPath ? { projectConfigPath: metadata.projectConfigPath } : {}),
    mode: isCapletsCloudUrl(upstreamUrl) ? ("cloud" as const) : ("remote" as const),
    remote: {
      url: upstreamUrl,
      ...(stackChain.length > 0
        ? { requestHeaders: { [CAPLETS_STACK_CHAIN_HEADER]: stackChain.join(",") } }
        : {}),
    },
    ...(writeErr ? { writeErr } : {}),
  };
  return loader
    ? createInternalNativeCapletsService(options, loader)
    : createActivatedNativeCapletsService(options);
}

function serveStackIdentity(options: Extract<ServeOptions, { transport: "http" }>): string {
  const origin = options.publicOrigin ?? `http://${formatHost(options.host)}:${options.port}`;
  const url = new URL(origin);
  url.pathname = options.path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function nativeAttachSession(service: NativeCapletsService) {
  let cachedProjection: Awaited<ReturnType<typeof buildNativeAttachProjection>> | undefined;
  const getProjection = async () => {
    cachedProjection ??= await buildNativeAttachProjection(service);
    return cachedProjection;
  };
  const unsubscribe = service.onToolsChanged(() => {
    cachedProjection = undefined;
  });
  return {
    manifest: async () => (await getProjection()).manifest,
    invoke: async (request: AttachInvokeRequest) =>
      await invokeNativeAttachExport(service, await getProjection(), request),
    onManifestChanged: (listener: () => void) => service.onToolsChanged(() => listener()),
    close: async () => {
      unsubscribe();
      await service.close();
    },
  };
}
