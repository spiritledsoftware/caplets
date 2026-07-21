import type { CapletsEngineOptions } from "../engine";
import { canonicalizeCurrentHostOrigin } from "../current-host/origin";
import {
  buildNativeAttachProjection,
  invokeNativeAttachExport,
  type AttachInvokeRequest,
  type AttachSessionMetadata,
} from "../attach/api";
import { createNativeCapletsService } from "../native/service";
import type { NativeCapletsService } from "../native/service";
import {
  CAPLETS_STACK_CHAIN_HEADER,
  sanitizeRemoteEngineOptions,
  serveHttp,
  serveHttpWithSessionFactory,
} from "./http";
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "./options";
import { NativeCapletsMcpSession } from "./native-session";
import { serveStdio } from "./stdio";

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

async function serveHttpWithUpstream(
  resolved: Extract<ServeOptions, { transport: "http" }>,
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
): Promise<void> {
  const remoteEngineOptions = sanitizeRemoteEngineOptions(engineOptions);
  const stackChain = [serveStackIdentity(resolved)];
  await serveHttpWithSessionFactory(
    resolved,
    async () =>
      new NativeCapletsMcpSession(
        await createReloadedUpstreamService(
          upstreamUrl,
          remoteEngineOptions,
          writeErr,
          {},
          stackChain,
        ),
      ),
    writeErr,
    {
      exposeAttach: true,
      defaultAttachSessionFactory: async (_metadata, context) =>
        nativeAttachSession(
          await createReloadedUpstreamService(
            upstreamUrl,
            remoteEngineOptions,
            writeErr,
            {},
            context.stackChain,
          ),
        ),
      attachSessionFactory: async (metadata, context) => {
        return nativeAttachSession(
          await createReloadedUpstreamService(
            upstreamUrl,
            remoteEngineOptions,
            writeErr,
            metadata,
            context.stackChain,
          ),
        );
      },
    },
    remoteEngineOptions,
  );
}

async function createReloadedUpstreamService(
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
  metadata: AttachSessionMetadata = {},
  stackChain: string[] = [],
): Promise<NativeCapletsService> {
  const service = createUpstreamNativeService(
    upstreamUrl,
    engineOptions,
    writeErr,
    metadata,
    stackChain,
  );
  try {
    await service.reload();
    return service;
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
}

function createUpstreamNativeService(
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
  metadata: AttachSessionMetadata = {},
  stackChain: string[] = [],
): NativeCapletsService {
  return createNativeCapletsService({
    ...engineOptions,
    ...(metadata.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
    ...(metadata.projectConfigPath ? { projectConfigPath: metadata.projectConfigPath } : {}),
    mode: "remote",
    remote: {
      url: upstreamUrl,
      ...(stackChain.length > 0
        ? { requestHeaders: { [CAPLETS_STACK_CHAIN_HEADER]: stackChain.join(",") } }
        : {}),
    },
    ...(writeErr ? { writeErr } : {}),
  });
}

function serveStackIdentity(options: Extract<ServeOptions, { transport: "http" }>): string {
  return canonicalizeCurrentHostOrigin(
    options.publicOrigin ?? `http://${formatHost(options.host)}:${options.port}`,
  );
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
