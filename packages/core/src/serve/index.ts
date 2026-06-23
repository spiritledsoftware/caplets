import type { CapletsEngineOptions } from "../engine";
import {
  buildNativeAttachProjection,
  invokeNativeAttachExport,
  type AttachInvokeRequest,
  type AttachSessionMetadata,
} from "../attach/api";
import { createNativeCapletsService } from "../native/service";
import type { NativeCapletsService } from "../native/service";
import { isCapletsCloudUrl } from "../remote/options";
import { serveHttp, serveHttpWithSessionFactory } from "./http";
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
  await serveHttpWithSessionFactory(
    resolved,
    async () => {
      const service = createUpstreamNativeService(upstreamUrl, engineOptions, writeErr);
      await service.reload();
      return new NativeCapletsMcpSession(service);
    },
    writeErr,
    {
      exposeAttach: true,
      attachSessionFactory: async (metadata) => {
        const service = createUpstreamNativeService(upstreamUrl, engineOptions, writeErr, metadata);
        await service.reload();
        return nativeAttachSession(service);
      },
    },
  );
}

function createUpstreamNativeService(
  upstreamUrl: string,
  engineOptions: CapletsEngineOptions,
  writeErr?: (value: string) => void,
  metadata: AttachSessionMetadata = {},
): NativeCapletsService {
  return createNativeCapletsService({
    ...engineOptions,
    ...(metadata.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
    ...(metadata.projectConfigPath ? { projectConfigPath: metadata.projectConfigPath } : {}),
    mode: isCapletsCloudUrl(upstreamUrl) ? "cloud" : "remote",
    remote: { url: upstreamUrl },
    ...(writeErr ? { writeErr } : {}),
  });
}

function nativeAttachSession(service: NativeCapletsService) {
  return {
    manifest: async () => (await buildNativeAttachProjection(service)).manifest,
    invoke: async (request: AttachInvokeRequest) =>
      await invokeNativeAttachExport(service, await buildNativeAttachProjection(service), request),
    onManifestChanged: (listener: () => void) => service.onToolsChanged(() => listener()),
    close: async () => await service.close(),
  };
}
