import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import type { CapletsRemoteAuth } from "../remote/options";
import { createSdkRemoteCapletsClient } from "../native/remote";
import { createNativeCapletsService } from "../native/service";
import type { NativeRemoteAuthOptions } from "../native/options";
import { serveHttpWithSessionFactory } from "../serve/http";
import { NativeCapletsMcpSession } from "../serve/native-session";
import type { AttachServeOptions } from "./options";

export type AttachServeIo = {
  writeErr?: (value: string) => void;
};

export async function attachResolvedCaplets(
  options: AttachServeOptions,
  io: AttachServeIo = {},
): Promise<void> {
  if (options.transport === "stdio") {
    const service = createAttachNativeService(options, io);
    const session = new NativeCapletsMcpSession(service);
    await service.reload();
    await session.connect(new StdioServerTransport());
    return;
  }

  await serveHttpWithSessionFactory(
    options,
    async () => {
      const service = createAttachNativeService(options, io);
      await service.reload();
      return new NativeCapletsMcpSession(service);
    },
    io.writeErr,
  );
}

function createAttachNativeService(options: AttachServeOptions, io: AttachServeIo) {
  return createNativeCapletsService({
    mode: options.selection.kind === "hosted_cloud" ? "cloud" : "remote",
    configPath: options.configPath,
    projectConfigPath: options.projectConfigPath,
    remote: {
      url: options.selection.remote.baseUrl.toString(),
      ...(options.selection.remote.fetch ? { fetch: options.selection.remote.fetch } : {}),
      ...(options.selection.kind === "hosted_cloud"
        ? {
            cloud: {
              url: options.selection.cloudPresence.url.toString(),
              accessToken: options.selection.cloudPresence.accessToken,
              workspaceId: options.selection.cloudPresence.workspaceId,
              projectRoot: options.projectRoot,
            },
          }
        : {}),
    },
    remoteClientFactory: (resolved) =>
      createSdkRemoteCapletsClient({
        ...resolved,
        requestInit: options.selection.remote.requestInit,
        auth: nativeAuthFromRemoteAuth(options.selection.remote.auth),
        url: options.selection.remote.attachUrl,
        ...(options.selection.remote.fetch ? { fetch: options.selection.remote.fetch } : {}),
      }),
    exposeLocalArtifactPaths: false,
    ...(io.writeErr ? { writeErr: io.writeErr } : {}),
  });
}

function nativeAuthFromRemoteAuth(auth: CapletsRemoteAuth): NativeRemoteAuthOptions {
  if (auth.type === "basic") {
    return { enabled: true, user: auth.user, password: auth.password };
  }
  if (auth.type === "none") {
    return { enabled: false, user: auth.user };
  }
  return { enabled: false, user: "caplets" };
}
